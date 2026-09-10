/**
 * Regression: faces in a full-page screenshot were never detected.
 *
 * `blaze_face_short_range` runs at 128x128, and MediaPipe downscales whatever it
 * is handed. On a 2560px-wide screenshot a ~70px thumbnail face arrives about
 * 3px across, so a page visibly full of faces reported zero detections. The
 * frame is now also scanned in overlapping tiles, which keeps small faces
 * resolvable. This suite pins the geometry, the coordinate mapping back to
 * full-frame space, and the de-duplication of a face seen in two tiles.
 *
 * Run: node scripts/test-face-tiling.mjs
 */
import fs from 'node:fs';

const SRC = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension/offscreen.js';
// Normalised to LF. These suites slice the source on newline markers, and git
// renormalises the extension files to CRLF on a Windows checkout — which
// silently turned every slice into a crash.
const src = fs.readFileSync(SRC, 'utf8').split('\r\n').join('\n');

const slice = (startMarker, fnMarker) =>
  src.slice(src.indexOf(startMarker), src.indexOf('\n}\n', src.indexOf(fnMarker)) + 3);

const consts = src.slice(src.indexOf('const FACE_TILE_PX'), src.indexOf('function boxIoU'));
const harness = `
${consts}
${slice('function boxIoU', 'function boxIoU')}
${slice('function dedupeFaces', 'function dedupeFaces')}
${slice('function computeFaceTiles', 'function computeFaceTiles')}
${slice('function mapDetections', 'function mapDetections')}
return { boxIoU, dedupeFaces, computeFaceTiles, mapDetections,
         FACE_TILE_PX, FACE_TILE_MAX, FACE_TILE_OVERLAP };
`;
const { boxIoU, dedupeFaces, computeFaceTiles, mapDetections, FACE_TILE_PX, FACE_TILE_MAX } =
  new Function(harness)();

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  PASS  ' : '  FAIL  ') + name); };

console.log('tile geometry');
{
  // A small frame needs no tiling — the whole-frame pass already resolves it.
  check('a small frame is not tiled', computeFaceTiles(400, 300).length === 0);
  check('a frame at the tile size is not tiled', computeFaceTiles(512, 512).length === 0);

  const tiles = computeFaceTiles(2560, 1271);   // the reported screenshot size
  check('a full-page screenshot IS tiled', tiles.length > 0);
  check('tile count stays within the cap', tiles.length <= FACE_TILE_MAX);
  check('every tile is inside the frame',
    tiles.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= 2560 && t.y + t.h <= 1271));
  check('no tile is a useless sliver', tiles.every((t) => t.w >= 96 && t.h >= 96));

  // The point of the fix: a 70px face must occupy enough of a 128px model input.
  const scale = 128 / FACE_TILE_PX;
  check('a 70px face is resolvable after the model downscale (>=10px)', 70 * scale >= 10);
  check('the same face on the full 2560px frame would NOT be resolvable',
    70 * (128 / 2560) < 5);

  // Overlap must be real, or a face on a seam is cut in half in both tiles.
  const row = tiles.filter((t) => t.y === tiles[0].y).sort((a, b) => a.x - b.x);
  check('adjacent tiles overlap horizontally',
    row.length > 1 && row[0].x + row[0].w > row[1].x);

  // Every pixel of a face-sized region must fall inside at least one tile.
  const covered = (px, py) => tiles.some((t) => px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h);
  check('the frame is covered (sampled on a grid)', (() => {
    for (let y = 0; y < 1271; y += 137) for (let x = 0; x < 2560; x += 149) if (!covered(x, y)) return false;
    return true;
  })());
}

console.log('\ncoordinate mapping');
{
  const detection = { detections: [{ boundingBox: { originX: 30, originY: 20, width: 60, height: 60 }, categories: [{ score: 0.9 }] }] };
  const mapped = mapDetections(detection, 1024, 384);
  check('a tile-local box is offset back into frame coordinates',
    mapped[0].x === 1054 && mapped[0].y === 404);
  check('size is unchanged by the offset', mapped[0].w === 60 && mapped[0].h === 60);
  check('the box is labelled as a face for the redaction categories',
    mapped[0].category === 'faces' && mapped[0].source === 'MediaPipe-Face');
  check('an empty result maps to nothing', mapDetections({ detections: [] }, 0, 0).length === 0);
  check('a null result does not throw', mapDetections(null, 0, 0).length === 0);
}

console.log('\nIoU + de-duplication');
{
  const a = { x: 100, y: 100, w: 100, h: 100, confidence: 0.9 };
  check('identical boxes score 1', Math.abs(boxIoU(a, { ...a }) - 1) < 1e-9);
  check('disjoint boxes score 0', boxIoU(a, { x: 900, y: 900, w: 50, h: 50 }) === 0);
  check('half-overlapping boxes score 1/3',
    Math.abs(boxIoU(a, { x: 150, y: 100, w: 100, h: 100 }) - (5000 / 15000)) < 1e-9);

  // The real case: one face sitting in the overlap of two tiles, reported twice
  // with slightly different boxes.
  const twice = dedupeFaces([
    { x: 500, y: 300, w: 80, h: 80, confidence: 0.94 },
    { x: 504, y: 297, w: 78, h: 82, confidence: 0.88 },
  ]);
  check('one face seen in two tiles is counted once', twice.length === 1);
  check('the more confident detection is the one kept', twice[0].confidence === 0.94);

  const distinct = dedupeFaces([
    { x: 100, y: 100, w: 80, h: 80, confidence: 0.9 },
    { x: 400, y: 100, w: 80, h: 80, confidence: 0.9 },
    { x: 700, y: 100, w: 80, h: 80, confidence: 0.9 },
  ]);
  check('genuinely separate faces are all kept', distinct.length === 3);

  check('an empty detection list is safe', dedupeFaces([]).length === 0);

  // Four faces in a podcast thumbnail, as in the reported page.
  const podcast = dedupeFaces([
    { x: 1000, y: 300, w: 70, h: 70, confidence: 0.91 },
    { x: 1090, y: 300, w: 70, h: 70, confidence: 0.89 },
    { x: 1000, y: 380, w: 70, h: 70, confidence: 0.93 },
    { x: 1090, y: 380, w: 70, h: 70, confidence: 0.87 },
  ]);
  check('four adjacent-but-distinct faces survive dedupe', podcast.length === 4);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
