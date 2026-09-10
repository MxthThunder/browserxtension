/**
 * RELEASE GATE for Layer D.
 *
 * page_content is a new text egress channel: unlike the element digest, it
 * carries free-form copy lifted straight off the page. The whole project rests
 * on the claim that cloud models only ever receive sanitized content, so a
 * failure here is release-blocking, not a quality issue.
 *
 * The sanitizer is exercised through the SAME call agent_client.js makes, so a
 * regression in semantic_redactor is caught here even if the mapping code is
 * untouched.
 *
 * Run: node scripts/test-page-content-egress.mjs
 */
import { semanticRedactor } from '../pii-agent-extension/semantic_redactor.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || !detail ? '' : `\n           ${detail}`));
};

/** Mirrors the page_content mapping in agent_client.js requestAction(). */
function toWirePageContent(rows) {
  return (rows || []).slice(0, 24).map((r) => ({
    ref: typeof r.ref === 'number' ? r.ref : null,
    on_screen: Boolean(r.onScreen),
    title: semanticRedactor.sanitizeText(String(r.title || '')).slice(0, 120),
    price: semanticRedactor.sanitizeText(String(r.price || '')).slice(0, 24),
    rating: String(r.rating || '').slice(0, 8),
    reviews: String(r.reviews || '').slice(0, 16),
    delivery: semanticRedactor.sanitizeText(String(r.delivery || '')).slice(0, 60),
    badge: semanticRedactor.sanitizeText(String(r.badge || '')).slice(0, 40),
  }));
}

// A results page that also leaked account details into its cards — the realistic
// worst case for an order-history or saved-address listing.
const ROWS = [
  {
    title: 'boAt Stone 1200F ordered by Priya Nair',
    price: '₹2,499', rating: '4.3', reviews: '12,455',
    delivery: 'Delivery by Fri to 560001', badge: 'Assured', ref: 3, onScreen: true,
  },
  {
    title: 'Invoice for daniels@meridiancap.com',
    price: '₹3,490', rating: '4.4', reviews: '5,003',
    delivery: 'Contact (415) 555-0123', badge: '', ref: 4, onScreen: true,
  },
  {
    title: 'Card 4111 1111 1111 1111 on file',
    price: '₹999', rating: '', reviews: '',
    delivery: 'Aadhaar 1234 5678 9012', badge: 'PAN ABCDE1234F', ref: 5, onScreen: false,
  },
  {
    title: 'Dr. Whitfield consultation record',
    price: '', rating: '', reviews: '',
    delivery: 'SSN 123-45-6789', badge: 'Passport A1234567', ref: 6, onScreen: false,
  },
];

semanticRedactor.resetSession();
const wire = toWirePageContent(ROWS);
const blob = JSON.stringify(wire);

console.log('raw PII must not survive the mapping');
const FORBIDDEN = [
  ['email address', 'daniels@meridiancap.com'],
  ['phone number', '555-0123'],
  ['credit card', '4111 1111 1111 1111'],
  ['Aadhaar', '1234 5678 9012'],
  ['SSN', '123-45-6789'],
  ['PAN', 'ABCDE1234F'],
  ['passport', 'A1234567'],
  ['person name (gazetteer)', 'Priya Nair'],
  ['person name (cue)', 'Whitfield'],
  // A bare 6-digit run next to a delivery cue is the user's own pincode.
  ['delivery pincode', '560001'],
];
for (const [label, raw] of FORBIDDEN) {
  check(`${label} is removed`, !blob.includes(raw), `still present: ${raw}`);
}

console.log('\nplaceholders replace them');
check('an email placeholder is present', /\[EMAIL_\d+\]/.test(blob));
check('a phone placeholder is present', /\[PHONE_\d+\]/.test(blob));
check('a card placeholder is present', /\[CARD_\d+\]/.test(blob));
check('gov-id placeholders are present', /\[GOV_ID_\d+\]/.test(blob));
check('person placeholders are present', /\[PERSON_\d+\]/.test(blob));

console.log('\nuseful signal must survive');
check('prices survive', blob.includes('2,499') && blob.includes('3,490'));
check('ratings survive', wire[0].rating === '4.3' && wire[1].rating === '4.4');
check('review counts survive', wire[0].reviews === '12,455');
check('product identity survives', wire[0].title.includes('boAt Stone 1200F'));
check('the Assured badge survives', wire[0].badge.includes('Assured'));
check('refs survive', wire.map((r) => r.ref).join(',') === '3,4,5,6');
check('on_screen survives', wire[0].on_screen === true && wire[2].on_screen === false);

console.log('\nstructural guarantees');
check('row count is capped at 24', toWirePageContent(new Array(200).fill(ROWS[0])).length === 24);
check('every title is length-capped',
  toWirePageContent([{ title: 'x'.repeat(500) }])[0].title.length <= 120);
check('missing fields become empty strings, not undefined',
  Object.values(toWirePageContent([{}])[0]).every((v) => v !== undefined));
check('null input is safe', toWirePageContent(null).length === 0);
check('non-string fields are coerced, not crashed',
  toWirePageContent([{ title: 42, price: null, delivery: {} }]).length === 1);

console.log('\nplaceholder stability within a session');
const again = toWirePageContent(ROWS);
check('the same value maps to the same placeholder', again[1].title === wire[1].title);

semanticRedactor.resetSession();
const afterReset = toWirePageContent([ROWS[1]]);
check('a new session restarts numbering', /\[EMAIL_1\]/.test(JSON.stringify(afterReset)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nRELEASE BLOCKED: raw PII can leave the device via page_content.');
process.exit(fail ? 1 : 0);
