/**
 * coords.js — the single source of truth for coordinate conversion.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three coordinate systems are in play at once, and mixing them up is the
 * single most common way this kind of pipeline "works" while drawing every box
 * 40px off. An audience reads that as "the product is broken", not as an
 * off-by-scale bug. So: all conversion happens here, with assertions, and
 * nowhere else. Never inline `* devicePixelRatio` in a drawing function.
 *
 *   1. CSS pixels, viewport-relative
 *      What getBoundingClientRect() returns in a content script.
 *      Origin = top-left of the visible viewport. Changes as you scroll.
 *
 *   2. CSS pixels, document-relative
 *      Viewport coords + scroll offset. Stable across scrolling, which is what
 *      you want if a detection is cached and reused after the user scrolls.
 *
 *   3. Capture pixels
 *      What chrome.tabs.captureVisibleTab actually hands you: the viewport
 *      scaled by devicePixelRatio. On a 2x retina panel a 100px-wide CSS box
 *      is 200px wide in the capture. This is the space redaction masks must be
 *      drawn in, because this is the bitmap that leaves the machine.
 *
 *   4. Model input pixels
 *      A letterboxed square (e.g. 640x640): the capture is scaled by a single
 *      ratio to fit, then padded with grey bars to fill the rest. Boxes coming
 *      back from a raw ONNX session are in THIS space and must be un-padded
 *      and un-scaled before they mean anything.
 *
 * NOTE ON TRANSFORMERS.JS: the high-level `pipeline("object-detection")` helper
 * already undoes the letterbox for you and returns boxes in source-image pixel
 * space. So if you feed it the capture bitmap, its output is already in space
 * (3) and you only need modelToCapture() when you drop to raw ORT for speed.
 * It's here because you probably will drop to raw ORT, and because writing the
 * inverse transform under time pressure on Day 5 is how demos die.
 */

// ---------------------------------------------------------------------------
// Rect helpers — a "rect" here is always {x, y, w, h}, never {xmin, xmax}.
// One shape, everywhere. Detector output gets normalised on arrival.
// ---------------------------------------------------------------------------

export function rect(x, y, w, h) {
  return { x, y, w, h };
}

/** Detector libraries love {xmin,ymin,xmax,ymax}. Convert on the boundary. */
export function fromCorners(box) {
  const { xmin, ymin, xmax, ymax } = box;
  return { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
}

export function toCorners(r) {
  return { xmin: r.x, ymin: r.y, xmax: r.x + r.w, ymax: r.y + r.h };
}

export function area(r) {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/** Intersection-over-union. Used for box merging and for precision metrics. */
export function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Clamp a rect inside a w x h frame. Masks must never run off the bitmap. */
export function clampToFrame(r, frameW, frameH) {
  const x = Math.max(0, Math.min(r.x, frameW));
  const y = Math.max(0, Math.min(r.y, frameH));
  const x2 = Math.max(0, Math.min(r.x + r.w, frameW));
  const y2 = Math.max(0, Math.min(r.y + r.h, frameH));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

/**
 * Grow a box by `px` on every side, then clamp.
 *
 * Redaction wants this and detection does not. A bounding box that is exactly
 * tight around a password field can still leave a rim of readable glyph edges
 * after rounding; a few pixels of padding costs nothing visually and removes a
 * whole class of "you can still sort of read it" objections. Applied to masks
 * only — never to the boxes you report as detections, or your precision
 * numbers become dishonest.
 */
export function padRect(r, px, frameW, frameH) {
  const grown = { x: r.x - px, y: r.y - px, w: r.w + px * 2, h: r.h + px * 2 };
  return clampToFrame(grown, frameW, frameH);
}

// ---------------------------------------------------------------------------
// System 1/2 <-> 3 : CSS pixels <-> capture pixels
// ---------------------------------------------------------------------------

/**
 * Build the conversion context once per capture, in the content script, and
 * send it along with the boxes. Capturing dpr/scroll at draw time instead of
 * at measure time is a race: the user scrolls, and every mask shifts.
 */
export function makeViewportContext({ devicePixelRatio, scrollX, scrollY, innerWidth, innerHeight }) {
  assert(devicePixelRatio > 0, `devicePixelRatio must be > 0, got ${devicePixelRatio}`);
  return {
    dpr: devicePixelRatio,
    scrollX: scrollX || 0,
    scrollY: scrollY || 0,
    viewportW: innerWidth,
    viewportH: innerHeight,
  };
}

/** getBoundingClientRect() output -> capture-pixel space. */
export function cssViewportToCapture(r, ctx) {
  return {
    x: r.x * ctx.dpr,
    y: r.y * ctx.dpr,
    w: r.w * ctx.dpr,
    h: r.h * ctx.dpr,
  };
}

/** capture-pixel space -> CSS viewport (for drawing the live DOM overlay). */
export function captureToCssViewport(r, ctx) {
  return {
    x: r.x / ctx.dpr,
    y: r.y / ctx.dpr,
    w: r.w / ctx.dpr,
    h: r.h / ctx.dpr,
  };
}

/** Viewport-relative -> document-relative. Survives scrolling. */
export function viewportToDocument(r, ctx) {
  return { x: r.x + ctx.scrollX, y: r.y + ctx.scrollY, w: r.w, h: r.h };
}

export function documentToViewport(r, ctx) {
  return { x: r.x - ctx.scrollX, y: r.y - ctx.scrollY, w: r.w, h: r.h };
}

/**
 * Iframe support: a content script in a child frame measures in ITS OWN
 * viewport, so its coords are meaningless to the parent until offset by where
 * the frame sits. Each frame reports upward with its own frame rect; the top
 * frame composes. Cross-origin frames cannot be measured from the parent at
 * all, which is exactly why the child has to volunteer the information.
 */
export function childFrameToParent(r, frameRectInParent) {
  return {
    x: r.x + frameRectInParent.x,
    y: r.y + frameRectInParent.y,
    w: r.w,
    h: r.h,
  };
}

// ---------------------------------------------------------------------------
// System 3 <-> 4 : capture pixels <-> letterboxed model input
// ---------------------------------------------------------------------------

/**
 * Compute the letterbox transform for fitting `src` into a `size` x `size`
 * square while preserving aspect ratio.
 *
 * Returns the scale plus the padding offsets, which together are everything
 * needed to go both directions.
 */
export function letterbox(srcW, srcH, size) {
  assert(srcW > 0 && srcH > 0, `bad source dims ${srcW}x${srcH}`);
  assert(size > 0, `bad model size ${size}`);
  const scale = Math.min(size / srcW, size / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  return {
    scale,
    padX: (size - drawW) / 2,
    padY: (size - drawH) / 2,
    drawW,
    drawH,
    size,
    srcW,
    srcH,
  };
}

/** Model-space box -> capture-space box. Un-pad first, THEN un-scale. */
export function modelToCapture(r, lb) {
  return {
    x: (r.x - lb.padX) / lb.scale,
    y: (r.y - lb.padY) / lb.scale,
    w: r.w / lb.scale,
    h: r.h / lb.scale,
  };
}

/** Capture-space box -> model-space box. Scale first, THEN pad. */
export function captureToModel(r, lb) {
  return {
    x: r.x * lb.scale + lb.padX,
    y: r.y * lb.scale + lb.padY,
    w: r.w * lb.scale,
    h: r.h * lb.scale,
  };
}

/**
 * Some detectors emit normalised [0..1] boxes instead of pixels. Detecting
 * which you have by eyeballing numbers at 2am is miserable, so be explicit.
 */
export function normalizedToPixels(r, frameW, frameH) {
  return { x: r.x * frameW, y: r.y * frameH, w: r.w * frameW, h: r.h * frameH };
}

/**
 * Heuristic guard: if every box is < 1.5, they're almost certainly normalised
 * and you are about to draw six 1-pixel masks in the top-left corner.
 */
export function looksNormalized(rects) {
  if (!rects.length) return false;
  return rects.every((r) => r.x <= 1.5 && r.y <= 1.5 && r.w <= 1.5 && r.h <= 1.5);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export class CoordError extends Error {}

export function assert(cond, msg) {
  if (!cond) throw new CoordError(`[coords] ${msg}`);
}

/**
 * Call this on the final mask list before compositing. It is the last gate
 * between "a box is wrong" and "we shipped an unredacted password to a
 * server". Cheap, and it fires during development rather than on stage.
 */
export function validateMasks(masks, frameW, frameH, { minSize = 1 } = {}) {
  const problems = [];
  masks.forEach((m, i) => {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.w) || !Number.isFinite(m.h)) {
      problems.push(`mask[${i}] has non-finite coords: ${JSON.stringify(m)}`);
      return;
    }
    if (m.w < minSize || m.h < minSize) {
      problems.push(`mask[${i}] is degenerate (${m.w}x${m.h}) — box math likely wrong`);
    }
    if (m.x < -0.01 || m.y < -0.01 || m.x + m.w > frameW + 0.01 || m.y + m.h > frameH + 0.01) {
      problems.push(`mask[${i}] escapes the ${frameW}x${frameH} frame: ${JSON.stringify(m)}`);
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Self-tests — run with:  node src/coords.js
//
// These exist because every one of them is a bug I would otherwise have hit.
// ---------------------------------------------------------------------------

function runSelfTests() {
  let passed = 0;
  const failures = [];

  const check = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
    }
  };

  const near = (a, b, eps = 1e-6) => {
    if (Math.abs(a - b) > eps) throw new Error(`expected ${b}, got ${a}`);
  };
  const nearRect = (a, b, eps = 1e-6) => {
    near(a.x, b.x, eps); near(a.y, b.y, eps);
    near(a.w, b.w, eps); near(a.h, b.h, eps);
  };

  check("dpr roundtrip on a 2x display", () => {
    const ctx = makeViewportContext({ devicePixelRatio: 2, scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600 });
    const css = rect(10, 20, 100, 40);
    const cap = cssViewportToCapture(css, ctx);
    nearRect(cap, rect(20, 40, 200, 80));
    nearRect(captureToCssViewport(cap, ctx), css);
  });

  check("dpr roundtrip on a 3x display", () => {
    const ctx = makeViewportContext({ devicePixelRatio: 3, scrollX: 0, scrollY: 0, innerWidth: 400, innerHeight: 800 });
    const css = rect(7, 13, 55, 21);
    nearRect(captureToCssViewport(cssViewportToCapture(css, ctx), ctx), css);
  });

  check("scroll offset roundtrip", () => {
    const ctx = makeViewportContext({ devicePixelRatio: 1, scrollX: 120, scrollY: 340, innerWidth: 800, innerHeight: 600 });
    const vp = rect(10, 10, 50, 50);
    const doc = viewportToDocument(vp, ctx);
    nearRect(doc, rect(130, 350, 50, 50));
    nearRect(documentToViewport(doc, ctx), vp);
  });

  check("letterbox of a landscape frame pads top/bottom only", () => {
    const lb = letterbox(1280, 720, 640);
    near(lb.scale, 0.5);
    near(lb.padX, 0);
    near(lb.padY, (640 - 360) / 2);
  });

  check("letterbox of a portrait frame pads left/right only", () => {
    const lb = letterbox(720, 1280, 640);
    near(lb.scale, 0.5);
    near(lb.padY, 0);
    near(lb.padX, (640 - 360) / 2);
  });

  check("model->capture->model roundtrip", () => {
    const lb = letterbox(1512, 982, 640);
    const capBox = rect(300, 200, 120, 45);
    nearRect(modelToCapture(captureToModel(capBox, lb), lb), capBox, 1e-9);
  });

  check("a full-frame capture box maps to the letterbox draw area", () => {
    const lb = letterbox(1000, 500, 640);
    const full = captureToModel(rect(0, 0, 1000, 500), lb);
    near(full.x, lb.padX);
    near(full.y, lb.padY);
    near(full.w, lb.drawW);
    near(full.h, lb.drawH);
  });

  check("corner <-> xywh conversion", () => {
    const r = fromCorners({ xmin: 10, ymin: 20, xmax: 110, ymax: 70 });
    nearRect(r, rect(10, 20, 100, 50));
    const c = toCorners(r);
    near(c.xmax, 110); near(c.ymax, 70);
  });

  check("iou of identical boxes is 1", () => near(iou(rect(0, 0, 10, 10), rect(0, 0, 10, 10)), 1));
  check("iou of disjoint boxes is 0", () => near(iou(rect(0, 0, 10, 10), rect(50, 50, 10, 10)), 0));
  check("iou of half-overlapping boxes", () => {
    // two 10x10 boxes overlapping in a 5x10 strip -> 50 / (100+100-50)
    near(iou(rect(0, 0, 10, 10), rect(5, 0, 10, 10)), 50 / 150);
  });

  check("clamp pulls a box back inside the frame", () => {
    nearRect(clampToFrame(rect(-10, -10, 50, 50), 100, 100), rect(0, 0, 40, 40));
    nearRect(clampToFrame(rect(80, 80, 50, 50), 100, 100), rect(80, 80, 20, 20));
  });

  check("padRect grows then clamps at the edge", () => {
    nearRect(padRect(rect(0, 0, 10, 10), 4, 100, 100), rect(0, 0, 14, 14));
    nearRect(padRect(rect(50, 50, 10, 10), 4, 100, 100), rect(46, 46, 18, 18));
  });

  check("normalized box detection fires on [0..1] boxes", () => {
    if (!looksNormalized([rect(0.1, 0.2, 0.3, 0.4)])) throw new Error("should detect normalized");
    if (looksNormalized([rect(10, 20, 30, 40)])) throw new Error("should not flag pixel boxes");
  });

  check("child frame boxes offset into parent space", () => {
    nearRect(childFrameToParent(rect(5, 5, 20, 10), { x: 100, y: 200 }), rect(105, 205, 20, 10));
  });

  check("validateMasks catches a degenerate box", () => {
    const p = validateMasks([rect(0, 0, 0, 10)], 100, 100);
    if (p.length !== 1) throw new Error(`expected 1 problem, got ${p.length}`);
  });

  check("validateMasks catches an escaping box", () => {
    const p = validateMasks([rect(90, 90, 50, 50)], 100, 100);
    if (p.length !== 1) throw new Error(`expected 1 problem, got ${p.length}`);
  });

  check("validateMasks passes clean masks", () => {
    const p = validateMasks([rect(10, 10, 20, 20), rect(0, 0, 100, 100)], 100, 100);
    if (p.length !== 0) throw new Error(`expected 0 problems, got ${p.join("; ")}`);
  });

  check("realistic end-to-end: 2x retina, scrolled, letterboxed 640", () => {
    // A password field 300px down a page scrolled 500px, on a 2x display,
    // detected by a model running at 640x640. This is the actual path.
    const ctx = makeViewportContext({ devicePixelRatio: 2, scrollX: 0, scrollY: 500, innerWidth: 1440, innerHeight: 900 });
    const cssBox = rect(220, 300, 260, 36);          // from getBoundingClientRect
    const capBox = cssViewportToCapture(cssBox, ctx); // -> 440,600 520x72
    nearRect(capBox, rect(440, 600, 520, 72));

    const lb = letterbox(1440 * 2, 900 * 2, 640);     // capture is 2880x1800
    const modelBox = captureToModel(capBox, lb);
    // and back again — this is the invariant that keeps masks aligned
    nearRect(modelToCapture(modelBox, lb), capBox, 1e-9);

    const problems = validateMasks([capBox], 2880, 1800);
    if (problems.length) throw new Error(problems.join("; "));
  });

  console.log(`\ncoords.js self-tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.error("  FAIL " + f));
    process.exitCode = 1;
  }
  return failures.length === 0;
}

// Only run under Node, never when imported by the extension.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("coords.js")) {
  runSelfTests();
}
