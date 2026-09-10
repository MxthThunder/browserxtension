/**
 * Layer G3: verifies the Ollama name-candidate resolver honours its
 * additive-only contract - every failure mode (unreachable, timeout,
 * malformed JSON, missing verdict) must resolve to "no change", never throw
 * and never remove a detection the caller already made.
 *
 * Run: node scripts/test-g3-name-disambiguation.mjs
 */
import { LocalPrivacyReasoner } from '../pii-agent-extension/local_reasoner.js';

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  PASS  ' : '  FAIL  ') + name); };

function mockFetch(handler) {
  global.fetch = async (url, opts) => handler(url, opts);
}

/** Skips the /api/tags model-detection round trip - out of scope for these tests. */
function reasonerWithCachedModel(config) {
  const r = new LocalPrivacyReasoner(config);
  r._cachedOllamaModel = 'test-model';
  return r;
}

/** A test must never hang the whole suite even if the code under test regresses. */
async function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true, label }), ms);
  });
  const result = await Promise.race([promise, deadline]);
  clearTimeout(timer);
  return result;
}

console.log('G3: happy path');
{
  const reasoner = reasonerWithCachedModel({ nameCandidateTimeoutMs: 200 });
  mockFetch(async () => ({
    ok: true,
    json: async () => ({
      response: JSON.stringify({ verdicts: [{ id: 1, is_name: true }, { id: 2, is_name: false }] }),
    }),
  }));
  const { verdicts, engine } = await reasoner.resolveNameCandidates([
    { text: 'Whitfield', contextBefore: 'Dr.', contextAfter: '' },
    { text: 'Rose Gold', contextBefore: 'in', contextAfter: '128GB' },
  ]);
  check('a true verdict is returned for the first candidate', verdicts[0] === true);
  check('a false verdict is returned for the second candidate', verdicts[1] === false);
  check('engine is reported as ollama-<model>', engine.startsWith('ollama-'));
}

console.log('\nG3: additive-only on failure (must never throw, must resolve false)');
{
  const reasoner = reasonerWithCachedModel({ nameCandidateTimeoutMs: 200 });
  mockFetch(async () => { throw new Error('ECONNREFUSED'); });
  const { verdicts, engine } = await reasoner.resolveNameCandidates([{ text: 'Zhang' }]);
  check('unreachable Ollama resolves to false, not an exception', verdicts[0] === false);
  check('engine is reported as unavailable', engine === 'unavailable');
}

console.log('\nG3: timeout must not hang the caller past the configured budget');
{
  const reasoner = reasonerWithCachedModel({ nameCandidateTimeoutMs: 150 });
  mockFetch((url, opts) => new Promise((resolve, reject) => {
    // Simulates a stuck Ollama: never resolves on its own, only the
    // AbortController's own timeout (wired by resolveNameCandidates) should
    // end this.
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const t0 = Date.now();
  const result = await withDeadline(reasoner.resolveNameCandidates([{ text: 'Zhang' }]), 3000, 'resolveNameCandidates');
  const elapsed = Date.now() - t0;
  check('the call does not hang past a generous safety deadline', result.__timedOut !== true);
  check('a hung Ollama resolves to false', result.verdicts?.[0] === false);
  check('the call returns close to the configured timeout, not later', elapsed < 1000);
}

console.log('\nG3: malformed JSON resolves to false, not a crash');
{
  const reasoner = reasonerWithCachedModel({ nameCandidateTimeoutMs: 200 });
  mockFetch(async () => ({ ok: true, json: async () => ({ response: 'not valid json {{{' }) }));
  const { verdicts } = await reasoner.resolveNameCandidates([{ text: 'Zhang' }]);
  check('malformed model output resolves to false', verdicts[0] === false);
}

console.log('\nG3: a candidate the model never mentions is left unresolved, not assumed true');
{
  const reasoner = reasonerWithCachedModel({ nameCandidateTimeoutMs: 200 });
  mockFetch(async () => ({
    ok: true,
    json: async () => ({ response: JSON.stringify({ verdicts: [{ id: 1, is_name: true }] }) }),
  }));
  const { verdicts } = await reasoner.resolveNameCandidates([
    { text: 'Whitfield' },
    { text: 'Sharma' },
  ]);
  check('the mentioned candidate gets its verdict', verdicts[0] === true);
  check('the unmentioned candidate defaults to false, not true', verdicts[1] === false);
}

console.log('\nG3: caching avoids re-querying the same span text');
{
  const reasoner = reasonerWithCachedModel({ nameCandidateTimeoutMs: 200 });
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return { ok: true, json: async () => ({ response: JSON.stringify({ verdicts: [{ id: 1, is_name: true }] }) }) };
  });
  await reasoner.resolveNameCandidates([{ text: 'Whitfield' }]);
  const second = await reasoner.resolveNameCandidates([{ text: 'whitfield' }]); // different casing, same span
  check('a repeated span (case-insensitive) is served from cache, not re-queried', calls === 1);
  check('the cached verdict is still correct', second.verdicts[0] === true);
  check('a cache hit reports engine "cache"', second.engine === 'cache');
}

console.log('\nG3: batch size is bounded so worst-case latency is predictable');
{
  const reasoner = reasonerWithCachedModel({ nameCandidateTimeoutMs: 200, maxNameCandidatesPerBatch: 2 });
  let sentCount = 0;
  mockFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    sentCount = (body.prompt.match(/^\d+\. "/gm) || []).length;
    return { ok: true, json: async () => ({ response: JSON.stringify({ verdicts: [] }) }) };
  });
  await reasoner.resolveNameCandidates([{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }]);
  check('only maxNameCandidatesPerBatch spans are sent in one prompt', sentCount === 2);
}

console.log('\nG3: empty candidate list is a no-op, no network call');
{
  const reasoner = reasonerWithCachedModel({ nameCandidateTimeoutMs: 200 });
  mockFetch(async () => { throw new Error('should not be called'); });
  const { verdicts, engine } = await reasoner.resolveNameCandidates([]);
  check('empty input returns an empty verdict list', verdicts.length === 0);
  check('empty input never touches the network', engine === 'none');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
