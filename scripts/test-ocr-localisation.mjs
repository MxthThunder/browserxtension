/**
 * Verifies that an OCR hit redacts only the matched phrase, not the whole
 * region — the regression that blacked out an entire page-sized figure.
 *
 * Run: node scripts/test-ocr-localisation.mjs
 */
import fs from 'node:fs';

const SRC = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension/offscreen.js';
const src = fs.readFileSync(SRC, 'utf8');

// Lift the pure pieces out of the module (it imports browser-only deps).
const patterns = src.slice(src.indexOf('const OCR_PII_PATTERNS = ['),
                           src.indexOf('];', src.indexOf('const OCR_PII_PATTERNS = [')) + 2);
const extract = src.slice(src.indexOf('function extractOcrWords'),
                          src.indexOf('\n}\n', src.indexOf('function extractOcrWords')) + 3);
const ocrFn = src.slice(src.indexOf('async function ocrRegion'),
                        src.indexOf('\n}\n', src.indexOf('async function ocrRegion')) + 3);

const harness = `
let tessWorker = null, tessReady = true;
const logEvent = () => {};
${patterns}
${extract}
${ocrFn}
return { setWorker: (w) => { tessWorker = w; }, ocrRegion };
`;
const { setWorker, ocrRegion } = new Function(harness)();

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
