/**
 * Offscreen Vision & Redaction Engine (Manifest V3)
 *
 * Pipeline (all on-device, zero-leakage):
 *   L1: DOM boxes          — sensitive inputs flagged by content.js
 *   L2: OWL-ViT            — zero-shot physical PII object detection (credit card, passport, etc.)
 *   L3: MediaPipe BlazeFace — precise face bounding-box detection
 *   L4: Tesseract OCR       — regex-matched text extracted from visual regions
 *   L5: Canvas blackout     — opaque redaction painted before any data leaves the device
 *   L6: Server (LLM)        — only sanitized image transmitted to FastAPI
 */

import { pipeline, env, RawImage } from "./lib/transformers.min.js";
import { buildUnifiedPerceptionState } from "./perception.js";
import { defaultPrivacyEngine } from "./privacy_engine.js";
import { defaultPrivacyReasoner } from "./local_reasoner.js";
import { logEvent } from "./telemetry.js";


// ── Console Telemetry & C++ WASM Filter ─────────────────────────────────────
if (typeof window !== "undefined") {
  const _origWarn = console.warn;
  console.warn = (...args) => {
    const msg = args.map((a) => (typeof a === "string" ? a : a?.message || "")).join(" ");
    // Filter benign internal C++ Emscripten / TFLite runtime notices
    if (/gl_context\.cc|inference_feedback_manager\.cc|TensorFlow Lite XNNPACK|XNNPACK delegate/i.test(msg)) {
      return;
    }
    _origWarn.apply(console, args);
  };

  window.addEventListener("error", (e) => {
    console.error("[Offscreen Global Error]", e.message, e.filename, e.lineno, e.error);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[Offscreen Unhandled Rejection]", e.reason);
  });
}

// ── ONNX Runtime / Transformers.js config ────────────────────────────────────
env.allowLocalModels  = true;
env.allowRemoteModels = false; // Strictly local offline model execution
env.useBrowserCache   = false; // Models stored locally in extension package
env.localModelPath    = chrome.runtime.getURL("models/");

if (!env.backends) env.backends = {};
if (!env.backends.onnx) env.backends.onnx = {};
if (!env.backends.onnx.wasm) env.backends.onnx.wasm = {};
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths  = chrome.runtime.getURL("lib/");

// ── Canvas elements ──────────────────────────────────────────────────────────
const canvas    = document.getElementById("offscreenCanvas");
const ctx       = canvas.getContext("2d", { willReadFrequently: true });
const rawCanvas = document.getElementById("rawCanvas");
const rawCtx    = rawCanvas.getContext("2d");

// ── OWL-ViT: zero-shot PII object detection ──────────────────────────────────
const OWL_VIT_MODEL     = "Xenova/owlvit-base-patch32";
const OWL_VIT_THRESHOLD = 0.12; // Sensitive threshold for open-vocabulary zero-shot queries

/** 22 zero-shot text queries covering physical PII objects */
const PII_VISUAL_QUERIES = [
  "credit card",
  "debit card",
  "bank card",
  "passport",
  "identity card",
  "national id card",
  "driving license",
  "driver's license",
  "aadhaar card",
  "pan card",
  "social security card",
  "government document",
  "official document",
  "laptop screen",
  "phone screen",
  "computer monitor",
  "bank statement",
  "printed financial document",
  "medical record",
  "confidential document",
  "cheque book",
  "voter id card",
];

let owlvitPipeline    = null;
let owlvitLoadPromise = null;

async function initOWLViT() {
  if (owlvitPipeline) return owlvitPipeline;
  if (owlvitLoadPromise) return owlvitLoadPromise;

  owlvitLoadPromise = (async () => {
    logEvent("offscreen", "OWL-ViT: Initialising zero-shot detector (WASM SIMD)...");
    // Force device: "wasm" (CPUExecutionProvider).
    // Avoids ORT WebGPU EP's missing Cast node kernel (/class_head/Cast) in the OWL-ViT graph.
    owlvitPipeline = await pipeline("zero-shot-object-detection", OWL_VIT_MODEL, {
      device: "wasm",
    });
    logEvent("offscreen", "OWL-ViT zero-shot detector READY (WASM SIMD)");
    return owlvitPipeline;
  })();

  // Race: return null if model hasn't loaded yet to avoid blocking pipeline
  // The model will still be loading in the background for future calls
  return owlvitLoadPromise;
}

// ── MediaPipe BlazeFace: precise face detection ───────────────────────────────
let faceDetector       = null;
let faceDetectorReady  = false;
let faceDetectorPromise = null;

async function initFaceDetector() {
  if (faceDetector && faceDetectorReady) return faceDetector;
  if (faceDetectorPromise) return faceDetectorPromise;

  faceDetectorPromise = (async () => {
    try {
      const mpBase = chrome.runtime.getURL("lib/mediapipe/");
      // Dynamically import the locally-bundled MediaPipe Vision ESM
      const { FaceDetector, FilesetResolver } = await import(
        chrome.runtime.getURL("lib/mediapipe/vision_bundle.mjs")
      );

      const vision = await FilesetResolver.forVisionTasks(mpBase);
      faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: chrome.runtime.getURL(
            "lib/mediapipe/blaze_face_short_range.tflite"
          ),
          delegate: "CPU", // GPU delegate not always available in offscreen context
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.35,
        minSuppressionThreshold: 0.3,
      });
      faceDetectorReady = true;
      console.log("[Offscreen] MediaPipe BlazeFace ready");
      return faceDetector;
    } catch (err) {
      console.warn("[Offscreen] MediaPipe BlazeFace init failed:", err.message);
      faceDetector = null;
      return null;
    }
  })();
  return faceDetectorPromise;
}

// ── Pre-warm vision models immediately upon document load (no delay) ───────
initOWLViT().catch((err) => console.log("[Offscreen] OWL-ViT pre-warm status:", err.message));
initFaceDetector().catch((err) => console.log("[Offscreen] BlazeFace pre-warm status:", err.message));



/**
 * Run MediaPipe face detection on a decoded HTMLImageElement.
 * Returns an array of { x, y, w, h, score } boxes.
 */
function detectFaces(img, imgWidth, imgHeight) {
  if (!faceDetector || !faceDetectorReady) return [];
  try {
    const result = faceDetector.detect(img);
    return (result.detections || []).map((d) => {
      const bb = d.boundingBox;
      return {
        source:     "MediaPipe-Face",
        label:      "Face",
        category:   "faces",
        confidence: d.categories?.[0]?.score ?? 0.9,
        x: Math.round(bb.originX),
        y: Math.round(bb.originY),
        w: Math.round(bb.width),
        h: Math.round(bb.height),
      };
    });
  } catch (err) {
    console.warn("[Offscreen] MediaPipe detect() error:", err.message);
    return [];
  }
}

// ── Tesseract OCR ─────────────────────────────────────────────────────────────
let tessWorker    = null;
let tessReady     = false;
let tessInitPromise = null;

/** PII regex patterns applied against OCR text output */
const OCR_PII_PATTERNS = [
  { category: "creditCards", label: "Credit Card Number", re: /\b(?:\d[ -]?){13,16}\b/ },
  { category: "govIds",      label: "Aadhaar Number",     re: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
  { category: "govIds",      label: "SSN",                re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { category: "govIds",      label: "PAN Card",           re: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  { category: "govIds",      label: "Passport Number",    re: /\b[A-Z]\d{7}\b/ },
  { category: "contactInfo", label: "Email Address",      re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/ },
  { category: "contactInfo", label: "Phone Number",       re: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { category: "govIds",      label: "Bank IFSC Code",     re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
  { category: "govIds",      label: "Account Number",     re: /\b\d{9,18}\b/ },
];

async function initOCR() {
  if (tessReady) return tessWorker;
  if (tessInitPromise) return tessInitPromise;

  tessInitPromise = (async () => {
    try {
      // Tesseract.js does not expose a native ESM — use the UMD global loaded via offscreen.html
      // We load via a dynamic script injection trick in the offscreen document
      if (typeof Tesseract === "undefined") {
        console.warn("[Offscreen] Tesseract global not found; OCR disabled.");
        return null;
      }
      tessWorker = await Tesseract.createWorker("eng", 1, {
        workerPath:    chrome.runtime.getURL("lib/tesseract/worker.min.js"),
        corePath:      chrome.runtime.getURL("lib/tesseract/tesseract-core.wasm.js"),
        langPath:      chrome.runtime.getURL("lib/tesseract/"),
        workerBlobURL: false,
        cacheMethod:   "write",
        logger:        () => {},
      });
      tessReady = true;
      console.log("[Offscreen] Tesseract OCR ready");
      return tessWorker;
    } catch (err) {
      console.warn("[Offscreen] Tesseract init failed:", err?.message || err);
      return null;
    }
  })();
  return tessInitPromise;
}

/**
 * Run OCR on a canvas crop of a bounding box region.
 * Returns array of matched PII boxes (same region, labelled by regex match type).
 */
/**
 * Flattens Tesseract output into word boxes.
 * v4 exposes data.words directly; v5 nests them under blocks/paragraphs/lines.
 */
function extractOcrWords(data) {
  if (!data) return [];
  if (Array.isArray(data.words) && data.words.length) return data.words;

  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) words.push(word);
      }
    }
  }
  return words;
}

/**
 * OCRs one region and returns a redaction box per MATCHED PHRASE.
 *
 * It used to return the whole region on any match, which was survivable when
 * regions were small object detections but blacks out an entire figure once
 * page-sized images become OCR targets. Word boxes localise the hit instead.
 */
async function ocrRegion(cropCanvas, regionBox, categories) {
  if (!tessWorker || !tessReady) return [];
  try {
    const dataUrl = cropCanvas.toDataURL("image/png");
    const { data } = await tessWorker.recognize(dataUrl, {}, { text: true, blocks: true });
    const text = data?.text || "";
    if (!text.trim()) return [];

    const words = extractOcrWords(data).filter((w) => w && w.text && w.bbox);
    const matched = [];
    const claimed = new Set();
    const PAD = 3;

    for (const { category, label, re } of OCR_PII_PATTERNS) {
      if (categories[category] === false) continue;
      if (!re.test(text)) continue;

      let localised = false;

      // Walk runs of up to 5 adjacent words: an email is one word, a phone
      // number is often two or three. Span is the OUTER loop so the tightest
      // match wins - starting from the word index would let a run beginning at
      // the "Email" label swallow the label and the rows beneath it.
      for (let span = 1; span <= 5 && !localised; span++) {
        for (let i = 0; i + span <= words.length; i++) {
          const run = words.slice(i, i + span);
          if (run.some((_, k) => claimed.has(i + k))) continue;
          if (!re.test(run.map((w) => w.text).join(" "))) continue;

          const x0 = Math.min(...run.map((w) => w.bbox.x0));
          const y0 = Math.min(...run.map((w) => w.bbox.y0));
          const x1 = Math.max(...run.map((w) => w.bbox.x1));
          const y1 = Math.max(...run.map((w) => w.bbox.y1));

          // Crop is drawn 1:1, so local coordinates need only the region offset.
          matched.push({
            source:     "OCR",
            label:      `OCR: ${label}`,
            category,
            confidence: 0.9,
            x: regionBox.x + Math.max(0, x0 - PAD),
            y: regionBox.y + Math.max(0, y0 - PAD),
            w: Math.max(1, x1 - x0 + PAD * 2),
            h: Math.max(1, y1 - y0 + PAD * 2),
          });
          run.forEach((_, k) => claimed.add(i + k));
          localised = true;
          break;
        }
      }

      if (!localised) {
        // The text is in there but could not be placed. Fail closed by covering
        // the region - but never silently swallow a hit.
        logEvent(
          "offscreen",
          `OCR matched ${label} but could not localise it; covering the whole region (${regionBox.w}x${regionBox.h}px)`,
          null,
          "warn"
        );
        matched.push({
          source:     "OCR",
          label:      `OCR: ${label} (unlocalised)`,
          category,
          confidence: 0.9,
          x: regionBox.x,
          y: regionBox.y,
          w: regionBox.w,
          h: regionBox.h,
        });
      }
    }

    return matched;
  } catch {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** SHA-256 hash of a string for frame integrity audit. */
async function computeHash(text) {
  try {
    const buf  = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "hash_" + Date.now().toString(16);
  }
}

/** Decode a data-URL or blob-URL into an HTMLImageElement. */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => resolve(img);
    img.onerror = (e) => reject(new Error("Image decode failed: " + e));
    img.src = url;
  });
}

/**
 * Non-Maximum Suppression — remove redundant overlapping boxes.
 * @param {Array} boxes  Each box: { x, y, w, h, confidence }
 * @param {number} iouThreshold
 */
function applyNMS(boxes, iouThreshold = 0.45) {
  if (boxes.length === 0) return [];
  const sorted = [...boxes].sort((a, b) => (b.confidence ?? 1) - (a.confidence ?? 1));
  const keep   = [];
  const used   = new Set();

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    // Copy so the merged `sources` list never mutates the caller's detection objects.
    const winner = { ...sorted[i], sources: sorted[i].source ? [sorted[i].source] : [] };
    keep.push(winner);
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (iou(sorted[i], sorted[j]) > iouThreshold) {
        used.add(j);
        // The overlapping box is dropped, but which layer found it is not:
        // without this, a region seen by two layers reports only one source.
        const alsoSeenBy = sorted[j].source;
        if (alsoSeenBy && !winner.sources.includes(alsoSeenBy)) {
          winner.sources.push(alsoSeenBy);
        }
      }
    }
  }
  return keep;
}

/**
 * L2D — Second-pass zero-leakage guard.
 *
 * Verifies that every redaction rect actually reads as opaque black on the
 * sanitized canvas. Catches the case where a box was computed but painted
 * off-canvas or clipped, which would otherwise ship with PII still visible.
 *
 * Cheap by construction: samples a sparse grid per rect rather than reading
 * every pixel, so cost scales with box count, not image area.
 *
 * @returns {{residualFound: boolean, repainted: number, checked: number, failures: Array}}
 */
function verifyRedactionOpacity(context, boxes, canvasWidth, canvasHeight) {
  const failures = [];
  let checked = 0;

  for (const box of boxes) {
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.min(Math.round(box.w), canvasWidth - x);
    const h = Math.min(Math.round(box.h), canvasHeight - y);
    if (w <= 0 || h <= 0) {
      // Box lies fully outside the canvas — nothing was painted at all.
      failures.push({ box, reason: "off-canvas" });
      continue;
    }

    checked++;
    let data;
    try {
      data = context.getImageData(x, y, w, h).data;
    } catch (err) {
      // The canvas cannot be read at all (e.g. tainted by a cross-origin
      // draw). That is "unable to verify", NOT "found a leak" — reporting it
      // as a leak would fail every frame closed and take the product down.
      return { residualFound: false, unreadable: true, checked, failures: [], error: err.message };
    }

    // Sample up to ~400 pixels spread across the rect.
    const totalPixels = w * h;
    const stride = Math.max(1, Math.floor(totalPixels / 400));
    let brightest = 0;
    for (let p = 0; p < totalPixels; p += stride) {
      const i = p * 4;
      // Rec. 601 luma is close enough to spot anything that is not black.
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma > brightest) brightest = luma;
    }

    // The redaction stroke is a 2px red border, so allow a small margin.
    if (brightest > 40) {
      failures.push({ box, reason: `not opaque (peak luma ${Math.round(brightest)})` });
    }
  }

  return { residualFound: failures.length > 0, unreadable: false, checked, failures };
}

function iou(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2),  iy2 = Math.min(ay2, by2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return inter / union;
}

// ── Main Processing Function ──────────────────────────────────────────────────

/**
 * Full on-device redaction pipeline.
 *
 * Order:  DOM → OWL-ViT ‖ MediaPipe → OCR on crops → NMS → Blackout
 */
async function processAndRedactFrame(payload) {
  const {
    screenshotUrl,
    domBoxes  = [],
    viewport  = { width: 1, height: 1, devicePixelRatio: 1 },
    options   = {},
  } = payload;

  const threshold    = options.threshold    ?? OWL_VIT_THRESHOLD;
  const faceProxyPct = options.faceProxyPct ?? 0.30;
  const engineMode   = options.engineMode   ?? "auto";
  const categories   = options.categories   ?? {};
  const failClosed   = options.failClosed   ?? true;

  const t0 = performance.now();
  logEvent("offscreen", "Step 1/6: processAndRedactFrame payload received");

  // ── 1. Ensure OWL-ViT is initialised ────────────────────────────────────────
  let owlvitModel = null;
  try {
    owlvitModel = await Promise.race([
      initOWLViT(),
      new Promise((res) => setTimeout(() => {
        logEvent("offscreen", "OWL-ViT compiling in background; proceeding with DOM + BlazeFace + OCR for immediate capture", null, "info");
        res(null);
      }, 15000))
    ]);
    logEvent("offscreen", `Step 2/6: OWL-ViT detector status: ${owlvitModel ? "READY" : "BACKGROUND_LOADING"}`);
  } catch (err) {
    logEvent("offscreen", `OWL-ViT init: ${err.message}`, null, "info");
  }
  const activeBackend = owlvitPipeline ? "OWL-ViT-WASM" : "degraded";

  // ── 2. Decode screenshot ───────────────────────────────────────────────────
  logEvent("offscreen", "Step 3/6: Decoding screenshot image...");
  const img    = await loadImage(screenshotUrl);
  const width  = img.naturalWidth  || img.width;
  const height = img.naturalHeight || img.height;
  logEvent("offscreen", `Screenshot decoded: ${width}x${height}px`);

  canvas.width = rawCanvas.width  = width;
  canvas.height = rawCanvas.height = height;

  rawCtx.drawImage(img, 0, 0, width, height); // inspection copy (local HUD only)
  ctx.drawImage(img, 0, 0, width, height);    // redaction canvas

  const scaleX = width  / (viewport.width  || width);
  const scaleY = height / (viewport.height || height);

  const tImgReady = performance.now();

  // ── L1: DOM boxes (already analysed by content.js) ──────────────────────
  const tStartDomMap = performance.now();
  const domRedactions = [];
  domBoxes.forEach((box) => {
    if (box.category && categories[box.category] === false) return;
    domRedactions.push({
      source:     "DOM",
      label:      box.reason || "DOM Field",
      category:   box.category || "input",
      confidence: 1.0,
      x: Math.max(0, Math.round(box.x     * scaleX) - 4),
      y: Math.max(0, Math.round(box.y     * scaleY) - 4),
      w: Math.min(width,  Math.round(box.width  * scaleX) + 8),
      h: Math.min(height, Math.round(box.height * scaleY) + 8),
    });
  });

  const domMapMs = performance.now() - tStartDomMap;

  // ── L2 + L3: OWL-ViT and MediaPipe run in parallel ──────────────────────
  logEvent("offscreen", "Step 4/6: Running parallel vision inference (OWL-ViT + MediaPipe BlazeFace)...");
  const tStartVision = performance.now();

  // Timed inside each branch: the wall-clock span below covers both, so it
  // cannot attribute cost to OWL-ViT vs BlazeFace on its own.
  let owlvitMs = 0;
  let faceMs   = 0;

  const [owlResult, faceResult] = await Promise.allSettled([
    // L2: OWL-ViT zero-shot object detection (credit cards, IDs, passports, screens)
    (async () => {
      const tBranch = performance.now();
      try {
        if (!owlvitModel) return [];
        const shouldRun =
          categories.faces !== false ||
          categories.screens !== false ||
          categories.govIds !== false ||
          categories.creditCards !== false;
        if (!shouldRun) return [];
        const rawImg = await RawImage.fromURL(screenshotUrl);
        return owlvitModel(rawImg, PII_VISUAL_QUERIES, { threshold });
      } finally {
        owlvitMs = performance.now() - tBranch;
      }
    })(),

    // L3: MediaPipe BlazeFace (human face bounding boxes)
    (async () => {
      const tBranch = performance.now();
      try {
        if (categories.faces === false) return [];
        await initFaceDetector();
        return detectFaces(img, width, height);
      } finally {
        faceMs = performance.now() - tBranch;
      }
    })(),
  ]);

  const tEndVision = performance.now();
  logEvent("offscreen", `Vision inference finished in ${Math.round(tEndVision - tStartVision)}ms`);

  // Fail-closed enforcement if required
  if (owlResult.status === "rejected" && failClosed && categories.govIds !== false) {
    console.warn("[Offscreen] OWL-ViT inference encountered an error:", owlResult.reason?.message);
  }


  // ── Map OWL-ViT detections → PII redaction boxes ──────────────────────────
  const owlRedactions = [];
  const owlDetections = owlResult.value ?? [];

  for (const det of owlDetections) {
    const { label, score, box: { xmin, ymin, xmax, ymax } } = det;
    const labelLower = label.toLowerCase();

    let category = "govIds";
    if (/card|bank|credit|debit/i.test(labelLower)) {
      category = "creditCards";
    } else if (/screen|monitor|laptop|phone|tv/i.test(labelLower)) {
      category = "screens";
    } else if (/face|person|human/i.test(labelLower)) {
      category = "faces";
    } else if (/passport|id|license|aadhaar|pan|security|document|record|cheque|voter/i.test(labelLower)) {
      category = "govIds";
    }

    if (categories[category] === false) continue;

    owlRedactions.push({
      source:     "OWL-ViT",
      label:      `OWL-ViT: ${label}`,
      category,
      confidence: score,
      x: Math.round(xmin),
      y: Math.round(ymin),
      w: Math.round(xmax - xmin),
      h: Math.round(ymax - ymin),
    });
  }

  // ── Map MediaPipe face boxes ──────────────────────────────────────────────
  const faceRedactions = (faceResult.value ?? []).filter(
    () => categories.faces !== false
  );

  if (faceResult.status === "rejected") {
    console.warn("[Offscreen] MediaPipe face detection failed:", faceResult.reason?.message);
  }

  // ── Merge all vision boxes so far ─────────────────────────────────────────
  const allVisualBoxes = [...owlRedactions, ...faceRedactions];

  // ── L4: OCR on candidate visual regions (only when unclassified visual targets exist) ──
  const tStartOCR = performance.now();
  const ocrRedactions = [];

  // Was gated on `categories.ocr`, a key that never existed in settings — so
  // the toggle was inert. `ocrEnabled` is a real setting, defaulting to on.
  // OCR also used to run ONLY over regions the object detector had flagged, so
  // text baked into an ordinary screenshot or figure was never read: the
  // detector looks for cards and passports, not blocks of text. Image regions
  // reported by the page are now first-class OCR targets too.
  const imageRegions = (payload.ocrRegions || []).map((r) => ({
    source: "image-region",
    label: "image region",
    category: "unknown",
    confidence: 0.5,
    x: Math.round(r.x * scaleX),
    y: Math.round(r.y * scaleY),
    w: Math.round(r.width * scaleX),
    h: Math.round(r.height * scaleY),
  }));

  if (options.ocrEnabled !== false && (allVisualBoxes.length > 0 || imageRegions.length > 0)) {
    const unclassifiedVisualTargets = [...allVisualBoxes, ...imageRegions].filter(
      (vb) => !domRedactions.some((db) => Math.abs(db.x - vb.x) < 20 && Math.abs(db.y - vb.y) < 20)
    );

    if (unclassifiedVisualTargets.length > 0) {
      await initOCR();
      if (tessReady) {
        const cropCanvas = new OffscreenCanvas(1, 1);
        const cropCtx    = cropCanvas.getContext("2d");

        for (const region of unclassifiedVisualTargets.slice(0, 2)) {
          const rx = Math.max(0, Math.min(region.x, width - 1));
          const ry = Math.max(0, Math.min(region.y, height - 1));
          const rw = Math.max(1, Math.min(region.w, width - rx));
          const rh = Math.max(1, Math.min(region.h, height - ry));
          cropCanvas.width  = rw;
          cropCanvas.height = rh;
          cropCtx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);

          const blob = await cropCanvas.convertToBlob({ type: "image/png" });
          const dataUrl = await new Promise((res) => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result);
            reader.readAsDataURL(blob);
          });

          const hits = await ocrRegion({ toDataURL: () => dataUrl }, { ...region, x: rx, y: ry, w: rw, h: rh }, categories);
          ocrRedactions.push(...hits);
        }
      }
    }
  }

  const tEndOCR = performance.now();

  // ── L5: Merge all redaction boxes + NMS ──────────────────────────────────
  const merged = [...domRedactions, ...owlRedactions, ...faceRedactions, ...ocrRedactions];
  const tStartNms = performance.now();
  const finalRedactionBoxes = applyNMS(merged, 0.45);
  const nmsMs = performance.now() - tStartNms;
  const nmsSuppressed = merged.length - finalRedactionBoxes.length;

  // ── L6: Zero-Leakage canvas blackout ─────────────────────────────────────
  const tStartPaint = performance.now();
  finalRedactionBoxes.forEach((box) => {
    ctx.fillStyle = "#000000";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth   = 2;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  });
  const tEndPaint = performance.now();

  // ── L2D: Second-pass zero-leakage guard ──────────────────────────────────
  const tStartGuard = performance.now();
  let guardReport = { enabled: false, residualFound: false, emergencyBlackout: false, checked: 0, failures: [] };

  if (options.secondPassGuard !== false) {
    const verdict = verifyRedactionOpacity(ctx, finalRedactionBoxes, width, height);
    guardReport = {
      enabled: true,
      residualFound: verdict.residualFound,
      emergencyBlackout: false,
      unreadable: Boolean(verdict.unreadable),
      checked: verdict.checked,
      failures: verdict.failures.map((f) => f.reason),
    };

    if (verdict.unreadable) {
      logEvent("offscreen", `Zero-Leakage guard could not read the canvas (${verdict.error}); skipping verification for this frame`, null, "warn");
    } else if (verdict.residualFound) {
      // Emergency blackout: repaint each failed region, clamped to the canvas,
      // then verify once more.
      logEvent("offscreen", `Zero-Leakage guard caught ${verdict.failures.length} unsealed region(s) — repainting`, null, "error");
      for (const failure of verdict.failures) {
        const b = failure.box;
        const x = Math.max(0, Math.min(Math.round(b.x), width));
        const y = Math.max(0, Math.min(Math.round(b.y), height));
        const w = Math.max(0, Math.min(Math.round(b.w), width - x));
        const h = Math.max(0, Math.min(Math.round(b.h), height - y));
        if (w > 0 && h > 0) {
          ctx.fillStyle = "#000000";
          ctx.fillRect(x, y, w, h);
        }
      }
      guardReport.emergencyBlackout = true;

      const recheck = verifyRedactionOpacity(ctx, finalRedactionBoxes, width, height);
      guardReport.residualFound = recheck.residualFound;

      if (recheck.residualFound && failClosed) {
        throw new Error(
          `Zero-Leakage Guarantee: ${recheck.failures.length} region(s) could not be sealed after emergency blackout. Frame blocked.`
        );
      }
    }
  }
  const guardMs = performance.now() - tStartGuard;

  // ── Build output ──────────────────────────────────────────────────────────
  const sanitizedImageUrl = canvas.toDataURL("image/jpeg", 0.90);
  const rawImageUrl       = rawCanvas.toDataURL("image/jpeg", 0.85);
  // Hash the whole sanitized frame: hashing the first 1000 chars only covered
  // the base64 JPEG header, so different redactions produced identical hashes.
  const integrityHash     = await computeHash(sanitizedImageUrl);
  const totalTime         = performance.now() - t0;

  logEvent(
    "offscreen",
    `Step 6/6: Redaction complete in ${Math.round(totalTime)}ms! (DOM=${domRedactions.length}, OWL=${owlRedactions.length}, Face=${faceRedactions.length}, OCR=${ocrRedactions.length}, Total=${finalRedactionBoxes.length})`
  );

  // ── L7: Perception State (local engine only — no Ollama here) ────────────
  // Note: Ollama ambiguity resolution is handled by agent_loop.js to avoid
  // double LLM calls which cause 8-16s delays per capture cycle.
  const unifiedPerceptionState = buildUnifiedPerceptionState({
    domElements: payload.interactiveElements || [],
    domSensitiveBoxes: domBoxes || [],
    owlvitDetections: owlRedactions || [],
    faceDetections: faceRedactions || [],
    ocrDetections: ocrRedactions || [],
    viewport: viewport,
    url: payload.url || "",
  });

  let privacyDecisionManifest = defaultPrivacyEngine.evaluatePerceptionState(
    unifiedPerceptionState,
    { url: payload.url || "", options: payload.options || {} }
  );

  // Ambiguity Resolution: If running in standalone capture mode and ambiguous elements exist,
  // resolve them via local reasoning (Qwen / fastpath). When agent loop is running,
  // agent_loop passes resolveAmbiguities: false to avoid redundant calls.
  if (options.resolveAmbiguities !== false && privacyDecisionManifest.ambiguousElements?.length > 0) {
    try {
      privacyDecisionManifest = await defaultPrivacyReasoner.resolveManifestAmbiguities(
        privacyDecisionManifest,
        { url: payload.url || "", userTask: payload.userTask || "" }
      );
    } catch (e) {
      console.warn("[Offscreen] Local reasoning warning:", e.message);
    }
  }

  return {
    ok: true,
    activeBackend,
    sanitizedImageUrl,
    rawImageUrl,
    integrityHash,
    redactionList: finalRedactionBoxes,
    unifiedPerceptionState,
    privacyDecisionManifest,
    guard: guardReport,
    resolution: { width, height },
    timings: {
      totalRedactionLatencyMs: totalTime,
      // Wall-clock span covering OWL-ViT and BlazeFace together; the two
      // per-branch numbers below are what attribute cost to each engine.
      visionLatencyMs:  tEndVision - tStartVision,
      owlvitMs,
      faceMs,
      domScanMs:        payload.domScanMs ?? null,
      domMapMs,
      ocrLatencyMs:     tEndOCR    - tStartOCR,
      nmsMs,
      nmsSuppressed,
      guardMs,
      imageLoadMs:      tImgReady  - t0,
      paintLatencyMs:   tEndPaint  - tStartPaint,
      domCount:         domRedactions.length,
      owlvitCount:      owlRedactions.length,
      faceCount:        faceRedactions.length,
      ocrCount:         ocrRedactions.length,
    },
  };
}

// ── Runtime Message Listener ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PROCESS_FRAME") {
    processAndRedactFrame(message.payload)
      .then((data) => sendResponse(data))
      .catch((err) => {
        console.error("[Offscreen] Pipeline error:", err);
        sendResponse({ ok: false, error: err.message, stack: err.stack });
      });
    return true; // keep async channel open
  }

  if (message.type === "GET_ENGINE_STATUS") {
    sendResponse({
      ok:              true,
      activeBackend:   owlvitPipeline ? "OWL-ViT-WASM" : "loading",
      isOWLViTLoaded:  Boolean(owlvitPipeline),
      isFaceReady:     faceDetectorReady,
      isOCRReady:      tessReady,
      modelArchitecture: "OWL-ViT (zero-shot) + MediaPipe BlazeFace (faces) + Tesseract OCR (text)",
    });
    return false;
  }

  return false;
});
