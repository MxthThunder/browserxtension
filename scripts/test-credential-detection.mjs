/**
 * Regression: an "Authentication / extremely sensitive" block — username,
 * password, OTP, PIN, security answer, recovery code, API key — was detected by
 * NOTHING. The `passwords` category and REDACTION_TYPES.PASSWORD both already
 * existed (privacy_engine maps passwords -> BLOCK), but no scanner ever
 * produced them from text: `<input type=password>` was covered by the
 * PASSWORD_FIELD role, while the literal words rendered in a <pre> were
 * invisible. That meant the block reached the cloud as RAW TEXT on the
 * page_content channel, not merely as unblacked pixels.
 *
 * A credential has no shape of its own, so detection is label-driven and the
 * mandatory [:=] is the entire safety margin — these tests pin both directions:
 * every labelled secret is caught, and ordinary prose about passwords is not.
 *
 * Run: node scripts/test-credential-detection.mjs
 */
import fs from 'node:fs';
import { SemanticRedactor, CREDENTIAL_LABELS } from '../pii-agent-extension/semantic_redactor.js';

const ROOT = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension';
// Normalised to LF: git renormalises the extension files to CRLF on a Windows
// checkout, which breaks every '\n'-anchored slice below.
const readSrc = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const contentSrc = readSrc(`${ROOT}/content.js`);

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  PASS  ' : '  FAIL  ') + name); };

const clean = (s) => new SemanticRedactor().sanitizeText(s);

// ── the exact block from the reported page ──────────────────────────────────
const AUTH_BLOCK = [
  'Username: aarav_test',
  'Password: TestPassword!4829',
  'OTP: 739214',
  'PIN: 4829',
  'Security Answer: Blue Mountain',
  'Recovery Code: 8F7K-29LM-QP41',
  'API Key: sk-test-7f91a82c4d6e5b3a',
].join('\n');

const SECRETS = ['aarav_test', 'TestPassword!4829', '739214', '4829',
                 'Blue Mountain', '8F7K-29LM-QP41', 'sk-test-7f91a82c4d6e5b3a'];

console.log('the reported authentication block');
{
  const out = clean(AUTH_BLOCK);
  const leaked = SECRETS.filter((s) => out.includes(s));
  check('no credential value survives sanitizeText', leaked.length === 0);
  if (leaked.length) console.log('        leaked:', leaked);
  check('every line produced a placeholder', (out.match(/\[PASSWORD_\d+\]/g) || []).length === 7);

  // The label must SURVIVE: the model still needs to know a password lives
  // here to reason about a login form. Only the value is replaced.
  check('the "Password" label is preserved', out.includes('Password: [PASSWORD'));
  check('the "OTP" label is preserved', out.includes('OTP: [PASSWORD'));
  check('the "API Key" label is preserved', out.includes('API Key: [PASSWORD'));

  // Multi-word values must be taken whole, not truncated at the first space.
  check('a two-word security answer is fully consumed', !out.includes('Mountain'));
}

console.log('\nprose about credentials must NOT be redacted');
{
  // The [:=] requirement is what makes the label list safe to be this broad.
  const cases = [
    'Please choose a strong password before you continue.',
    'Your PIN is stored securely and we never see it.',
    'Login to Pinterest and check your pinned items.',
    'Enter the access code shown on your device.',
    'This article explains how session tokens work.',
  ];
  for (const s of cases) check(`untouched: "${s.slice(0, 42)}..."`, clean(s) === s);
}

console.log('\nunlabelled vendor keys are caught by shape');
{
  const keys = {
    'AWS':     'AKIAIOSFODNN7EXAMPLE',
    'GitHub':  'ghp_' + 'a'.repeat(36),
    'Google':  'AIza' + 'b'.repeat(35),
    'Slack':   'xoxb-1234567890-abcdefghij',
    'Stripe':  'sk_live_' + 'c'.repeat(24),
    'JWT':     'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  };
  for (const [vendor, key] of Object.entries(keys)) {
    const out = clean(`token is ${key} here`);
    check(`${vendor} key is redacted without any label`, !out.includes(key));
  }
}

console.log('\nUPI handles (no dot-TLD, so EMAIL can never match them)');
{
  const out = clean('UPI ID: aarav.krishnan92@upi');
  check('a UPI handle is redacted', !out.includes('aarav.krishnan92@upi'));

  // Must not become an "any @word" matcher that eats social handles.
  const mention = 'Ask @team about it, cc @support';
  check('@mentions are left alone', clean(mention) === mention);
}

console.log('\nexisting patterns still work (ordering regression)');
{
  // Credentials now run FIRST. Confirm they did not steal spans from the
  // financial patterns that used to claim them.
  const out = clean('Credit Card: 4111 1111 1111 1111\nCVV: 123\nIFSC Code: TEST0001234');
  check('a card is still typed as CARD, not PASSWORD', out.includes('[CARD_'));
  check('IFSC is still typed as GOV_ID', out.includes('[GOV_ID_'));
  check('CVV is now caught at all', !out.includes('123'));

  const prose = 'Hi, I am Aarav Krishnan, reach me at a.k@example.com or +91 98765 43210';
  const p = clean(prose);
  check('names still detected in prose', p.includes('[PERSON_'));
  check('emails still detected in prose', p.includes('[EMAIL_'));
  check('phones still detected in prose', p.includes('[PHONE_'));
}

console.log('\nthe two copies of the label list must not drift');
{
  // content.js is a classic content script and cannot import, so the list is
  // duplicated. This is the guard that keeps the duplicate honest.
  const m = contentSrc.match(/const CREDENTIAL_LABELS = \[([\s\S]*?)\]\.join\("\|"\)/);
  check('content.js still defines CREDENTIAL_LABELS', Boolean(m));
  if (m) {
    const contentLabels = eval(`[${m[1]}]`).join('|');
    check('content.js and semantic_redactor.js label lists are identical',
      contentLabels === CREDENTIAL_LABELS);
  }
}

console.log('\ncategory routing');
{
  const m = contentSrc.match(/function categoryForPattern[\s\S]*?\n}\n/);
  check('categoryForPattern exists as a single source of truth', Boolean(m));
  const fn = new Function(`${m[0]}\nreturn categoryForPattern;`)();

  check('CREDENTIAL routes to passwords (-> BLOCK)', fn('CREDENTIAL') === 'passwords');
  check('API_KEY_TOKEN routes to passwords', fn('API_KEY_TOKEN') === 'passwords');
  check('JWT routes to passwords', fn('JWT') === 'passwords');
  check('PRIVATE_KEY_BLOCK routes to passwords', fn('PRIVATE_KEY_BLOCK') === 'passwords');
  check('UPI_ID routes to creditCards', fn('UPI_ID') === 'creditCards');
  check('CREDIT_CARD still routes to creditCards', fn('CREDIT_CARD') === 'creditCards');
  check('AADHAAR still routes to govIds', fn('AADHAAR') === 'govIds');
  check('CONSOLE_ID still routes to opsSecurity', fn('CONSOLE_ID') === 'opsSecurity');
  check('an unknown pattern falls back to contactInfo', fn('EMAIL') === 'contactInfo');

  // The mapping is only useful if the DOM walker actually calls it.
  check('the visible-text walker uses categoryForPattern',
    /category: categoryForPattern\(patternName\)/.test(contentSrc));
  check('the element-value check uses categoryForPattern',
    /category: categoryForPattern\(patternName\),/.test(contentSrc));
  check('no copy-pasted category if-chain remains',
    !/if \(patternName === "CREDIT_CARD"\) category =/.test(contentSrc));
}

console.log('\nOCR sees credentials too (text baked into an image)');
{
  // The third copy of the pattern list. A screenshot of a login form has no
  // text node at all, so the DOM scanner is structurally blind to it and this
  // list is the only thing standing between those pixels and the cloud.
  const offscreenSrc = readSrc(`${ROOT}/offscreen.js`);
  const block = offscreenSrc.slice(
    offscreenSrc.indexOf('const OCR_PII_PATTERNS'),
    offscreenSrc.indexOf('\n];', offscreenSrc.indexOf('const OCR_PII_PATTERNS')) + 3);

  check('OCR_PII_PATTERNS has a Credential entry', /label: "Credential"/.test(block));
  check('OCR_PII_PATTERNS has an API Key entry', /label: "API Key \/ Token"/.test(block));
  check('OCR_PII_PATTERNS has a UPI entry', /label: "UPI ID"/.test(block));
  check('the credential entry routes to the passwords category',
    /category: "passwords"/.test(block));

  // Exercise the actual regexes, not just their presence.
  const patterns = new Function(`${block}\nreturn OCR_PII_PATTERNS;`)();
  const find = (text) => patterns.filter((p) => p.re.test(text)).map((p) => p.label);

  for (const line of AUTH_BLOCK.split('\n')) {
    check(`OCR would flag: "${line.slice(0, 34)}"`, find(line).length > 0);
  }
  check('OCR does not flag ordinary prose',
    find('Please choose a strong password before you continue.').length === 0);
}

console.log('\nthe DOM scanner has patterns for the block at all');
{
  for (const p of ['CREDENTIAL', 'API_KEY_TOKEN', 'JWT', 'PRIVATE_KEY_BLOCK', 'UPI_ID']) {
    check(`INLINE_PII_PATTERNS defines ${p}`, new RegExp(`\\n  ${p}:`).test(contentSrc));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
