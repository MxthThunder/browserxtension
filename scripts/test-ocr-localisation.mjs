/**
 * Verifies that an OCR hit redacts only the matched phrase, not the whole
 * region — the regression that blacked out an entire page-sized figure.
 *
 * Run: node scripts/test-ocr-localisation.mjs
 */
import fs from 'node:fs';
import { findNames, findNameCandidates } from '../pii-agent-extension/name_detector.js';

const SRC = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension/offscreen.js';
const src = fs.readFileSync(SRC, 'utf8');

// Lift the pure pieces out of the module (it imports browser-only deps).
const patterns = src.slice(src.indexOf('const OCR_PII_PATTERNS = ['),
                           src.indexOf('];', src.indexOf('const OCR_PII_PATTERNS = [')) + 2);
const extract = src.slice(src.indexOf('function extractOcrWords'),
                          src.indexOf('\n}\n', src.indexOf('function extractOcrWords')) + 3);
// One contiguous block: joinWordsWithOffsets, mapHitsToWordRanges, matchOcrNames
// (G2) and matchNameCandidates (G3 candidate extraction) all sit together.
const nameFns = src.slice(src.indexOf('function joinWordsWithOffsets'),
                          src.indexOf('\n}\n', src.indexOf('function matchNameCandidates')) + 3);
const fullMatchFn = src.slice(src.indexOf('function fullMatch'),
                              src.indexOf('\n}\n', src.indexOf('function fullMatch')) + 3);
const ocrFn = src.slice(src.indexOf('async function ocrRegion'),
                        src.indexOf('\n}\n', src.indexOf('async function ocrRegion')) + 3);

// findNames/findNameCandidates are passed in rather than re-declared, so the
// harness exercises the real shared detector instead of a copy that could drift.
const harness = `
let tessWorker = null, tessReady = true;
const logEvent = () => {};
${patterns}
${extract}
${nameFns}
${fullMatchFn}
${ocrFn}
return { setWorker: (w) => { tessWorker = w; }, ocrRegion };
`;
const { setWorker, ocrRegion: ocrRegionRaw } = new Function('findNames', 'findNameCandidates', harness)(findNames, findNameCandidates);
// Most existing assertions expect a plain array of redaction boxes (the old
// return shape); ocrRegion now also returns G3 candidates alongside them.
const ocrRegion = async (...args) => (await ocrRegionRaw(...args)).matched;

// A figure 900x600 in page coords, with an email and phone rendered inside it.
const word = (text, x0, y0, x1, y1) => ({ text, bbox: { x0, y0, x1, y1 } });
const WORDS = [
  word('Meridian_notes.pdf', 20, 20, 240, 40),
  word('Person', 20, 80, 90, 100),
  word('Daniel', 200, 80, 270, 100),
  word('Whitfield', 275, 80, 380, 100),
  word('Email', 20, 140, 80, 160),
  word('daniels@meridiancap.com', 200, 140, 480, 160),
  word('Phone', 20, 200, 80, 220),
  word('(415)', 200, 200, 250, 220),
  word('555-0123', 255, 200, 350, 220),
];

setWorker({
  recognize: async () => ({
    data: {
      text: WORDS.map((w) => w.text).join(' '),
      blocks: [{ paragraphs: [{ lines: [{ words: WORDS }] }] }],
    },
  }),
});

const REGION = { x: 500, y: 300, w: 900, h: 600 };
const hits = await ocrRegion({ toDataURL: () => 'data:,' }, REGION, {});

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  PASS  ' : '  FAIL  ') + name); };

console.log('OCR localisation');
check('found at least the email and the phone', hits.length >= 2);

const regionArea = REGION.w * REGION.h;
check('no hit covers the whole region',
  hits.every((h) => h.w * h.h < regionArea * 0.5));
check('nothing is flagged unlocalised',
  hits.every((h) => !h.label.includes('unlocalised')));

const email = hits.find((h) => h.label.includes('Email'));
check('email box is offset into page coordinates',
  !!email && email.x === REGION.x + 197 && email.y === REGION.y + 137);
check('email box is roughly the width of the address',
  !!email && email.w > 270 && email.w < 300);

const phone = hits.find((h) => h.label.includes('Phone'));
check('phone spans both of its words',
  !!phone && phone.w >= 150 && phone.w < 200);

check('every box sits inside the region',
  hits.every((h) => h.x >= REGION.x && h.y >= REGION.y
    && h.x + h.w <= REGION.x + REGION.w + 6
    && h.y + h.h <= REGION.y + REGION.h + 6));

// International phone formats: the old 3-3-4-only pattern missed the Indian
// mobile format (5+5, e.g. "98765 43210") and Korean-style numbers
// (3-4-4, e.g. "010-1000-0001") — both verified misses on a live test, the
// Indian one especially significant since it is this product's primary market.
console.log('\nOCR international phone formats');
async function phoneBoxFor(numberText, otherWords = []) {
  const parts = numberText.split(' ');
  const words = [];
  let x = 200;
  for (const part of parts) {
    words.push(word(part, x, 300, x + part.length * 9, 320));
    x += part.length * 9 + 6;
  }
  setWorker({
    recognize: async () => ({
      data: {
        text: [...otherWords.map((w) => w.text), ...words.map((w) => w.text)].join(' '),
        blocks: [{ paragraphs: [{ lines: [{ words: [...otherWords, ...words] }] }] }],
      },
    }),
  });
  const hits = await ocrRegion({ toDataURL: () => 'data:,' }, REGION, {});
  return hits.find((h) => h.label.includes('Phone'));
}

const korean = await phoneBoxFor('010-1000-0001');
check('Korean-style 3-4-4 grouping is detected', Boolean(korean));

const indian = await phoneBoxFor('98765 43210');
check('Indian mobile 5+5 grouping is detected', Boolean(indian));
check('the Indian number is boxed as ONE unit, not split across two words',
  !!indian && indian.w > 60);

const indianWithCC = await phoneBoxFor('+91 98765 43210');
check('Indian mobile with +91 country code is detected', Boolean(indianWithCC));

// The extension-widening fix, specifically: an area code split into its own
// OCR word must not be left unboxed just because the rest of the number
// happens to independently satisfy the (now more permissive) phone pattern.
const areaCode = word('(415)', 200, 300, 250, 320);
const localNum = word('555-0123', 256, 300, 340, 320);
setWorker({
  recognize: async () => ({
    data: {
      text: '(415) 555-0123',
      blocks: [{ paragraphs: [{ lines: [{ words: [areaCode, localNum] }] }] }],
    },
  }),
});
const split = (await ocrRegion({ toDataURL: () => 'data:,' }, REGION, {}))
  .find((h) => h.label.includes('Phone'));
check('a phone number split across two OCR words is boxed as one unit',
  !!split && split.x <= REGION.x + areaCode.bbox.x0 && split.x + split.w >= REGION.x + localNum.bbox.x1);

// Growing must not over-extend into an unrelated neighbouring word.
const orderLabel = word('Order#1234', 100, 300, 190, 320);
const realNumber = word('555-0123', 256, 300, 340, 320);
setWorker({
  recognize: async () => ({
    data: {
      text: 'Order#1234 555-0123',
      blocks: [{ paragraphs: [{ lines: [{ words: [orderLabel, realNumber] }] }] }],
    },
  }),
});
const guarded = (await ocrRegion({ toDataURL: () => 'data:,' }, REGION, {}))
  .find((h) => h.label.includes('Phone'));
check('extension does not swallow an unrelated neighbouring word',
  !!guarded && guarded.x >= REGION.x + realNumber.bbox.x0 - 5);

// The same number quoted twice on one screen (asked, then echoed back in a
// confirmation) is a real, verified miss: the pattern loop used to stop at
// the FIRST occurrence per category per region and never look for a second.
const askedNumber = word('98765-43210', 200, 60, 300, 80);
const confirmLabel = word('Confirmed:', 200, 400, 280, 420);
const echoedNumber = word('98765-43210', 285, 400, 385, 420);
setWorker({
  recognize: async () => ({
    data: {
      text: 'My number is 98765-43210 ... Confirmed: 98765-43210',
      blocks: [{ paragraphs: [{ lines: [{
        words: [askedNumber, confirmLabel, echoedNumber],
      }] }] }],
    },
  }),
});
const repeated = (await ocrRegion({ toDataURL: () => 'data:,' }, REGION, {}))
  .filter((h) => h.label.includes('Phone'));
check('a phone number repeated twice in one region is boxed both times', repeated.length === 2);
check('both boxes sit at their own occurrence, not both on the first', (() => {
  if (repeated.length !== 2) return false;
  const xs = repeated.map((h) => h.x).sort((a, b) => a - b);
  return xs[0] < REGION.x + askedNumber.bbox.x0 + 10 && xs[1] > REGION.x + confirmLabel.bbox.x1;
})());

// Layer G2: the name in this fixture is the case the user reported — "there are
// some names in the screen, but the capture didnt capture it at all".
console.log('\nOCR person names');
const nameHits = hits.filter((h) => h.category === 'names');
check('the name is detected at all', nameHits.length >= 1);

const person = nameHits[0];
check('the name box covers the name, not the whole region',
  !!person && person.w * person.h < regionArea * 0.2);
check('the name box starts at the name, not its "Person" label',
  !!person && person.x >= REGION.x + 190);
check('the name box spans both given and family name',
  !!person && person.w >= 170 && person.w < 230);
check('the name is labelled with how it was found',
  !!person && /OCR: Person Name \((cue|gazetteer)\)/.test(person.label));
check('name boxes do not overlap the email box', (() => {
  const e = hits.find((h) => h.label.includes('Email'));
  if (!e || !person) return false;
  return person.x + person.w <= e.x || e.x + e.w <= person.x
      || person.y + person.h <= e.y || e.y + e.h <= person.y;
})());
check('the filename in the fixture is not mistaken for a name',
  !nameHits.some((h) => h.x < REGION.x + 100 && h.y < REGION.y + 60));

// A page with no names must not manufacture one.
setWorker({
  recognize: async () => ({
    data: {
      text: 'Add to Cart Free Delivery Best Sellers',
      blocks: [{ paragraphs: [{ lines: [{ words: [
        word('Add', 10, 10, 40, 25), word('to', 45, 10, 60, 25), word('Cart', 65, 10, 100, 25),
        word('Free', 10, 40, 45, 55), word('Delivery', 50, 40, 120, 55),
        word('Best', 10, 70, 45, 85), word('Sellers', 50, 70, 110, 85),
      ] }] }] }],
    },
  }),
});
const chrome = await ocrRegion({ toDataURL: () => 'data:,' }, REGION, {});
check('UI chrome produces no name detections',
  chrome.filter((h) => h.category === 'names').length === 0);

// The category toggle must actually gate the layer.
setWorker({
  recognize: async () => ({
    data: {
      text: WORDS.map((w) => w.text).join(' '),
      blocks: [{ paragraphs: [{ lines: [{ words: WORDS }] }] }],
    },
  }),
});
const namesOff = await ocrRegion({ toDataURL: () => 'data:,' }, REGION, { names: false });
check('names:false disables the layer',
  namesOff.filter((h) => h.category === 'names').length === 0);
check('names:false leaves the other patterns working',
  namesOff.some((h) => h.label.includes('Email')));

// Unlocalisable case must still fail closed.
setWorker({
  recognize: async () => ({ data: { text: 'contact me at a@b.com', blocks: [] } }),
});
const coarse = await ocrRegion({ toDataURL: () => 'data:,' }, REGION, {});
check('unlocalisable hit still redacts (fail closed)', coarse.length === 1);
check('unlocalisable hit is labelled as such', coarse[0].label.includes('unlocalised'));

// Empty page must not produce phantom boxes.
setWorker({ recognize: async () => ({ data: { text: '   ', blocks: [] } }) });
check('blank OCR yields nothing',
  (await ocrRegion({ toDataURL: () => 'data:,' }, REGION, {})).length === 0);

// Layer G3: candidates are spans G1+G2 could NOT confirm - a cue-less,
// non-gazetteer name ("Whitfield" alone) must surface as a candidate for
// Ollama, while an already-confirmed name (from the WORDS fixture, "Daniel
// Whitfield" behind "Person") must NOT be re-offered as a candidate too.
console.log('\nOCR G3 candidates');
setWorker({
  recognize: async () => ({
    data: {
      text: WORDS.map((w) => w.text).join(' '),
      blocks: [{ paragraphs: [{ lines: [{ words: WORDS }] }] }],
    },
  }),
});
const fullResult = await ocrRegionRaw({ toDataURL: () => 'data:,' }, REGION, {});
check('a confirmed name is not also offered as a G3 candidate',
  !fullResult.candidates.some((c) => c.text === 'Daniel Whitfield' || c.text.includes('Whitfield')));

const unconfirmedWord = word('Zhang', 600, 260, 660, 280);
setWorker({
  recognize: async () => ({
    data: {
      text: 'Uploaded by Zhang yesterday',
      blocks: [{ paragraphs: [{ lines: [{ words: [
        word('Uploaded', 200, 260, 280, 280),
        word('by', 285, 260, 305, 280),
        unconfirmedWord,
        word('yesterday', 665, 260, 760, 280),
      ] }] }] }],
    },
  }),
});
const candidateResult = await ocrRegionRaw({ toDataURL: () => 'data:,' }, REGION, {});
check('a cue-less, non-gazetteer capitalised name surfaces as a G3 candidate',
  candidateResult.candidates.some((c) => c.text === 'Zhang'));
check('the G3 candidate is not ALSO redacted outright (additive layer, not a third detector)',
  candidateResult.matched.filter((h) => h.category === 'names').length === 0);
check('the G3 candidate carries surrounding-word context for the model prompt',
  candidateResult.candidates.some((c) => c.text === 'Zhang' && c.contextBefore.includes('by') && c.contextAfter.includes('yesterday')));

setWorker({
  recognize: async () => ({
    data: {
      text: 'Add to Cart Free Delivery Best Sellers',
      blocks: [{ paragraphs: [{ lines: [{ words: [
        word('Add', 10, 10, 40, 25), word('to', 45, 10, 60, 25), word('Cart', 65, 10, 100, 25),
        word('Free', 10, 40, 45, 55), word('Delivery', 50, 40, 120, 55),
        word('Best', 10, 70, 45, 85), word('Sellers', 50, 70, 110, 85),
      ] }] }] }],
    },
  }),
});
const chromeResult = await ocrRegionRaw({ toDataURL: () => 'data:,' }, REGION, {});
check('UI chrome produces no G3 candidates either', chromeResult.candidates.length === 0);

setWorker({
  recognize: async () => ({
    data: {
      text: WORDS.map((w) => w.text).join(' '),
      blocks: [{ paragraphs: [{ lines: [{ words: WORDS }] }] }],
    },
  }),
});
const namesOffResult = await ocrRegionRaw({ toDataURL: () => 'data:,' }, REGION, { names: false });
check('names:false disables G3 candidate extraction too', namesOffResult.candidates.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
