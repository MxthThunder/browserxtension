/**
 * Regression: agent_loop.digestElements must be sensitive to scroll position.
 *
 * Background: a reading task on a long article scrolls the page through five
 * or six productive scroll steps, each of which exposes *zero* new
 * interactive elements (no buttons or inputs appear in the static
 * element digest just because the viewport moved). Before the fix the FNV-1a
 * hash was identical across every step, so the no-op detector flagged
 * each scroll as noOp=true and the unproductive-step counter tripped after
 * three of them — aborting a perfectly productive run with "stopped after
 * 3 steps with no progress". Folding scrollY into the hash fixes that.
 *
 * Run: node scripts/test-digest-scroll-position.mjs
 */
import fs from 'node:fs';

const SRC = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension/agent_loop.js';
const src = fs.readFileSync(SRC, 'utf8');

// Lift digestElements out of the module (it imports browser-only deps).
const slice = src.slice(src.indexOf('function digestElements'),
                        src.indexOf('\n}\n', src.indexOf('function digestElements')) + 3);
const harness = `${slice}\nreturn digestElements;`;
const digestElements = new Function(harness)();

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  PASS  ' : '  FAIL  ') + name); };

// Empty element list at different scroll positions must differ — the original
// failure mode on a long-form article is exactly this: no elements change but
// every step used to hash the same.
const empty0 = digestElements([], 0);
const empty500 = digestElements([], 500);
const empty1500 = digestElements([], 1500);
check('empty list at scrollY=0 produces a digest', typeof empty0 === 'string' && empty0.length > 0);
check('empty list at scrollY=0 differs from scrollY=500', empty0 !== empty500);
check('empty list at scrollY=500 differs from scrollY=1500', empty500 !== empty1500);

// Non-empty element list must still change when scrollY changes.
const el = { id: 'e1', tagName: 'button', value: '', text: 'Submit' };
const fixedAt0 = digestElements([el], 0);
const fixedAt900 = digestElements([el], 900);
check('same elements, different scrollY produce different digests', fixedAt0 !== fixedAt900);

// A non-trivial element change must still register on top of scrollY change —
// both axes of "the page moved" need to be detectable.
const el2 = { id: 'e2', tagName: 'input', value: '', text: 'Email' };
const newElementAt0 = digestElements([el, el2], 0);
const newElementAt900 = digestElements([el, el2], 900);
check('different elements at the same scrollY produce different digests', newElementAt0 !== fixedAt0);
check('different elements at different scrollY produce different digests', newElementAt900 !== fixedAt0);
check('same elements at same scrollY produce identical digests (deterministic)',
      digestElements([el], 350) === digestElements([el], 350));

// Backwards compatibility: the old one-arg call shape must keep working.
const legacy = digestElements([el]);
check('the one-arg call shape still returns a digest (default scrollY=0)',
      typeof legacy === 'string' && legacy.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
