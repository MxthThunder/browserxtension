// Focused test of the L2D opacity guard + trace summariser, extracted from source.
import fs from 'node:fs';

const OFF = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension/offscreen.js';
const src = fs.readFileSync(OFF, 'utf8');

// Pull the guard function out of the module (it has no imports of its own).
const start = src.indexOf('function verifyRedactionOpacity');
const end = src.indexOf('function iou(a, b)');
const fnSrc = src.slice(start, end);
const verifyRedactionOpacity = new Function(`${fnSrc}; return verifyRedactionOpacity;`)();

// Mock 2D context: a canvas that is black except for a "leak" rect.
function makeCtx(leak) {
  return {
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const gx = x + px, gy = y + py;
          const inLeak = leak && gx >= leak.x && gx < leak.x + leak.w && gy >= leak.y && gy < leak.y + leak.h;
          const i = (py * w + px) * 4;
          const v = inLeak ? 255 : 0;
          data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
        }
      }
      return { data };
    },
  };
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

console.log('L2D opacity guard');
{
  const r = verifyRedactionOpacity(makeCtx(null), [{ x: 10, y: 10, w: 50, h: 20 }], 200, 200);
  check('fully black box passes', r.residualFound === false && r.checked === 1);
}
{
  const r = verifyRedactionOpacity(makeCtx({ x: 15, y: 12, w: 20, h: 10 }), [{ x: 10, y: 10, w: 50, h: 20 }], 200, 200);
  check('unsealed box is caught', r.residualFound === true && r.failures.length === 1);
}
{
  const r = verifyRedactionOpacity(makeCtx(null), [{ x: 500, y: 500, w: 50, h: 20 }], 200, 200);
  check('off-canvas box is caught', r.residualFound === true && r.failures[0].reason === 'off-canvas');
}
{
  // Box that starts inside but overflows the right edge: must clamp, not throw.
  const r = verifyRedactionOpacity(makeCtx(null), [{ x: 180, y: 10, w: 100, h: 20 }], 200, 200);
  check('overflowing box is clamped and passes', r.residualFound === false && r.checked === 1);
}
{
  const r = verifyRedactionOpacity(makeCtx(null), [], 200, 200);
  check('no boxes → no residual', r.residualFound === false && r.checked === 0);
}
{
  // A tainted canvas must read as "cannot verify", never as "leak found" —
  // otherwise fail-closed would block every single frame.
  const taintedCtx = { getImageData() { throw new Error('SecurityError: tainted canvas'); } };
  const r = verifyRedactionOpacity(taintedCtx, [{ x: 10, y: 10, w: 50, h: 20 }], 200, 200);
  check('tainted canvas does not report a leak', r.residualFound === false && r.unreadable === true);
}

// summarizeRedactions, extracted from storage.js
const STORE = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension/storage.js';
const ssrc = fs.readFileSync(STORE, 'utf8');
const s0 = ssrc.indexOf('export function summarizeRedactions');
const s1 = ssrc.indexOf('export function newTraceId');
const sumSrc = ssrc.slice(s0, s1).replace('export function', 'function');
const summarizeRedactions = new Function(`${sumSrc}; return summarizeRedactions;`)();

console.log('\nsummarizeRedactions');
{
  const { counts, categories } = summarizeRedactions([
    { source: 'DOM', category: 'passwords' },
    { source: 'OWL-ViT', category: 'creditCards' },
    { source: 'OCR', sources: ['OCR', 'OWL-ViT'], category: 'govIds' },
  ]);
  check('counts single sources', counts.DOM === 1);
  check('NMS-merged sources both counted', counts['OWL-ViT'] === 2 && counts.OCR === 1);
  check('categories tallied', categories.passwords === 1 && categories.govIds === 1);
}
{
  const { counts, categories } = summarizeRedactions([{}]);
  check('missing source/category → unknown', counts.unknown === 1 && categories.unknown === 1);
}
{
  const { counts } = summarizeRedactions([]);
  check('empty list is safe', Object.keys(counts).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
