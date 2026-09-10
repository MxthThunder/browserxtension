/**
 * Layer G: person-name detection.
 *
 * Recall matters most (the user's report was "there are some names in the
 * screen, but the capture didnt capture it at all"), but precision is what
 * decides whether the feature can be on by default — a detector that redacts
 * navigation bars is worse than none.
 *
 * Run: node scripts/test-name-detection.mjs
 */
import { findNames, isNameField, NAME_DETECTION_LIMITS } from
  '../pii-agent-extension/name_detector.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name);
};
const found = (text, opts) => findNames(text, opts).map((h) => h.text);
const hit = (text, want, opts) => found(text, opts).some((t) => t === want);

console.log('cue-anchored names (must be caught)');
const CUED = [
  ['Name: Daniel Whitfield', 'Daniel Whitfield'],
  ['Full Name  Rajesh Kumar', 'Rajesh Kumar'],
  ['Deliver to Priya Nair, 3rd Cross', 'Priya Nair'],
  ['Ordered by Arjun Mehta', 'Arjun Mehta'],
  ['Dear Sarah,', 'Sarah'],
  ['Dr. Whitfield will see you', 'Whitfield'],
  ['Mr Ramesh Iyer', 'Ramesh Iyer'],
  ['Cardholder: Michael Chen', 'Michael Chen'],
  ['Patient  Ananya Rao', 'Ananya Rao'],
  ['Account Holder - Vikram Singh', 'Vikram Singh'],
];
for (const [text, want] of CUED) {
  check(`"${text}" -> ${want}`, hit(text, want));
}

console.log('\ngazetteer names (no cue present)');
check('bare given + surname is caught', hit('Priya Nair placed an order', 'Priya Nair'));
check('single known given name is caught', hit('Assigned to Rahul', 'Rahul'));
check('accented name is caught', hit('Contact: José Álvarez', 'José Álvarez'));

console.log('\nprecision: UI chrome must NOT be redacted');
const CHROME = [
  'Home Search Cart Login',
  'Sort by Popularity',
  'Free Delivery Available',
  'Add to Cart',
  'Best Sellers in Electronics',
  'Filter Price Brand Rating',
  'Deliver to Home',
  'View All Offers',
  'Returns and Exchange Policy',
  'Sign In to continue',
];
for (const text of CHROME) {
  const names = found(text);
  check(`"${text}" -> no names (${names.join(', ') || 'none'})`, names.length === 0);
}

console.log('\nprecision: product listings must survive');
const LISTINGS = [
  'boAt Stone 1200F 14W Bluetooth Speaker',
  'Sony SRS-XB100 Extra Bass Portable Speaker',
  'JBL Go 4 Portable Bluetooth Speaker',
  'Samsung Galaxy M14 5G Dark Blue 128 GB',
];
for (const text of LISTINGS) {
  const names = found(text);
  check(`"${text.slice(0, 40)}..." -> no names (${names.join(', ') || 'none'})`, names.length === 0);
}

console.log('\nstructural rules');
check('all-caps styling is not a name', found('DANIEL WHITFIELD RESUME').length === 0);
check('runs longer than 3 tokens are rejected',
  !hit('Name: One Two Three Four Five', 'One Two Three Four Five'));
check('matches do not overlap', (() => {
  const hits = findNames('Deliver to Priya Nair');
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].index < hits[i - 1].index + hits[i - 1].length) return false;
  }
  return true;
})());
check('cue match wins over gazetteer for the same span', (() => {
  const hits = findNames('Deliver to Priya Nair');
  return hits.length === 1 && hits[0].via === 'cue' && hits[0].text === 'Priya Nair';
})());
check('gazetteer can be disabled independently',
  found('Priya Nair ordered', { useGazetteer: false }).length === 0);
check('cue branch still fires with the gazetteer off',
  hit('Ordered by Priya Nair', 'Priya Nair', { useGazetteer: false }));
check('indices point at the real substring', (() => {
  const text = 'Invoice for Name: Daniel Whitfield only';
  const h = findNames(text).find((x) => x.text === 'Daniel Whitfield');
  return h && text.slice(h.index, h.index + h.length) === 'Daniel Whitfield';
})());

console.log('\nrobustness');
check('empty input is safe', findNames('').length === 0);
check('null input is safe', findNames(null).length === 0);
check('non-string input is safe', findNames(42).length === 0);
check('very long input does not hang', findNames('Word '.repeat(5000)).length >= 0);
check('limits are documented', NAME_DETECTION_LIMITS.length >= 3);

console.log('\nisNameField (Layer G1)');
check('autocomplete=name', isNameField({ autocomplete: 'name' }));
check('autocomplete=given-name', isNameField({ autocomplete: 'given-name' }));
check('scoped autocomplete "shipping family-name"',
  isNameField({ autocomplete: 'shipping family-name' }));
check('placeholder "Full Name"', isNameField({ placeholder: 'Full Name' }));
check('name attribute "customer_name"', isNameField({ name: 'customer_name' }));
check('aria-label "Recipient"', isNameField({ ariaLabel: 'Recipient' }));
check('label "Deliver To"', isNameField({ label: 'Deliver To' }));
check('itemprop=name', isNameField({ itemprop: 'name' }));
check('autocomplete=email is not a name field', !isNameField({ autocomplete: 'email' }));
check('placeholder "Search products" is not a name field',
  !isNameField({ placeholder: 'Search products' }));
check('empty descriptors are safe', !isNameField({}) && !isNameField());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
