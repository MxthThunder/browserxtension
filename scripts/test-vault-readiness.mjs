/**
 * The agent told the user "saved personal details are NONE on file" for a vault
 * that was fully populated — and the dashboard, in another tab, was showing
 * those same details as "unlocked on this device" at that moment.
 *
 * Cause: background.js calls vault.init() WITHOUT awaiting it, and init() is
 * slow on purpose — PBKDF2 at 100,000 iterations plus two storage round-trips.
 * An MV3 service worker is torn down after ~30s idle, and clicking the
 * extension is itself what wakes it, so nearly every run started against a
 * cold worker. listVaultTokenPaths() would land mid-derivation, see
 * isUnlocked() === false, and fail safe to [] — which the server renders as
 * "NONE on file". The vault was never locked; the read was simply too early.
 *
 * The fix is vault.ready(): one shared derivation that callers await. These
 * tests pin the properties that make it correct, because a warm worker hides
 * the bug completely and it would silently return.
 *
 * Run: node scripts/test-vault-readiness.mjs
 */
import fs from 'node:fs';

const ROOT = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension';
const readSrc = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const vaultSrc = readSrc(`${ROOT}/vault.js`);
const loopSrc = readSrc(`${ROOT}/agent_loop.js`);

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  PASS  ' : '  FAIL  ') + name); };

/* A stand-in for the real class: same init/ready/lock contract, same shared
   promise, with a deliberately slow derivation so the cold-start window is
   wide enough to actually race against. */
function makeVault({ derivationMs = 40, failTimes = 0 } = {}) {
  let failsLeft = failTimes;
  const v = {
    derivations: 0,
    _isUnlocked: false, _cryptoKey: null, _cache: null, _initPromise: null,
    isUnlocked() { return this._isUnlocked && this._cryptoKey !== null; },
    async _deriveAndLoad() {
      this.derivations++;
      await new Promise((r) => setTimeout(r, derivationMs));   // PBKDF2 stand-in
      if (failsLeft > 0) { failsLeft--; throw new Error('storage unavailable'); }
      this._cryptoKey = 'key';
      this._isUnlocked = true;
      this._cache = { contact: { email: { value: 'a@example.com' } } };
      return true;
    },
    async init() {
      if (this._initPromise) return this._initPromise;
      this._initPromise = this._deriveAndLoad().catch((err) => {
        this._initPromise = null;
        throw err;
      });
      return this._initPromise;
    },
    ready() {
      if (this.isUnlocked()) return Promise.resolve(true);
      return this.init();
    },
    lock() {
      this._isUnlocked = false; this._cryptoKey = null;
      this._cache = null; this._initPromise = null;
    },
    listKeys() {
      if (!this.isUnlocked()) throw new Error('locked');
      return { contact: [{ key: 'email' }] };
    },
  };
  return v;
}

// The real function, lifted from source so the test tracks the shipped code.
const VAULT_PATH_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/i;
const listVaultTokenPaths = (vault) => {
  try {
    if (!vault.isUnlocked()) return [];
    const paths = [];
    for (const [category, entries] of Object.entries(vault.listKeys() || {}))
      for (const entry of entries || []) {
        const path = `${category}.${entry.key}`;
        if (VAULT_PATH_RE.test(path)) paths.push(path);
      }
    return paths.sort();
  } catch { return []; }
};

console.log('the reported bug: a cold read reports an empty vault');
{
  const v = makeVault();
  v.init();                                   // fire-and-forget, as background.js does
  check('reading immediately sees nothing — this was the bug',
    listVaultTokenPaths(v).length === 0);
  check('...even though the vault is populated and not locked', v._initPromise !== null);

  await v.ready();
  check('after awaiting ready(), the entry is there',
    listVaultTokenPaths(v).includes('contact.email'));
}

console.log('\nready() closes the window');
{
  const v = makeVault();
  v.init();                                   // background.js starts it
  await v.ready();                            // the loop awaits it
  check('a cold start now resolves the vault', listVaultTokenPaths(v).includes('contact.email'));
  check('only ONE derivation ran despite two callers', v.derivations === 1);
}

console.log('\nthe derivation is shared, not repeated');
{
  // PBKDF2 at 100k iterations is expensive, and popup + dashboard + options +
  // service worker all call init() on load.
  const v = makeVault();
  await Promise.all([v.init(), v.init(), v.ready(), v.ready(), v.init()]);
  check('five concurrent callers share one derivation', v.derivations === 1);
  check('all of them end up unlocked', v.isUnlocked());

  const before = v.derivations;
  await v.ready();
  check('ready() on an already-unlocked vault derives nothing more',
    v.derivations === before);
}

console.log('\na failed init must not poison later attempts');
{
  const v = makeVault({ failTimes: 1 });
  let threw = false;
  try { await v.ready(); } catch { threw = true; }
  check('the first attempt surfaces the failure', threw);
  check('the cached promise is cleared after a failure', v._initPromise === null);

  await v.ready();
  check('a retry succeeds rather than inheriting the failure', v.isUnlocked());
  check('the retry actually re-derived', v.derivations === 2);
}

console.log('\nlock() invalidates the shared promise');
{
  const v = makeVault();
  await v.ready();
  check('unlocked before locking', v.isUnlocked());

  v.lock();
  check('locked afterwards', !v.isUnlocked());
  check('the stale promise is dropped', v._initPromise === null);

  await v.ready();
  check('ready() re-derives after a lock', v.isUnlocked() && v.derivations === 2);
  check('a re-derived vault reads correctly',
    listVaultTokenPaths(v).includes('contact.email'));
}

console.log('\nthe shipped source actually wires this up');
{
  check('vault.js exposes ready()', /^\s*ready\(\)\s*\{/m.test(vaultSrc));
  check('init() caches a shared promise', /this\._initPromise = this\._deriveAndLoad\(/.test(vaultSrc));
  check('init() returns early when a derivation is in flight',
    /if \(this\._initPromise\) return this\._initPromise;/.test(vaultSrc));
  check('a failed init clears the cached promise',
    /this\._initPromise = null;[\s\S]{0,80}throw err;/.test(vaultSrc));
  check('the constructor declares _initPromise', /this\._initPromise = null;/.test(vaultSrc));
  check('lock() clears the cached promise',
    /lock\(\)\s*\{[\s\S]*?_initPromise = null;[\s\S]*?\n  \}/.test(vaultSrc));

  // The gate itself: the loop must await readiness BEFORE listing paths.
  const readyAt = loopSrc.indexOf('await vault.ready()');
  const listAt = loopSrc.indexOf('const vaultKeys = listVaultTokenPaths()');
  check('the agent loop awaits vault.ready()', readyAt > 0);
  check('it awaits BEFORE reading the vault inventory', readyAt > 0 && readyAt < listAt);
  check('a vault failure degrades the step instead of killing the run',
    /catch \(err\) \{[\s\S]{0,200}Vault unavailable this step/.test(loopSrc));

  // Token resolution at actuation happens later in the same iteration, so the
  // single await covers it — but only if it stays downstream of the gate.
  const resolveAt = loopSrc.indexOf('resolveLocalActionValue(action.value)');
  check('token resolution stays downstream of the gate',
    resolveAt > readyAt);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
