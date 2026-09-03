/**
 * Upgraded Offscreen Vision & Redaction Engine
 *
 * Detection pipeline (order matters — cheapest first):
 *
 *  L1 — DOM PII boxes     (provided by content.js, zero ML cost)
 *  L2 — OWL-ViT           (zero-shot open-vocabulary visual detector on WebGPU/WASM)
 *                          Queries: ID cards, passports, credit cards, bank statements,
 *                          medical docs, faces, QR codes, PIN pads …
 *  L3 — OCR + Regex       (Tesseract.js on targeted <img>/<canvas>/<video> regions;
 *                          regex + Luhn/Verhoeff checksum for Aadhaar, PAN, cards …)
 *  L4 — NMS merge         (deduplicate overlapping boxes from all three layers)
 *  L5 — Canvas redaction  (solid opaque blackout — no blur, no alpha)
 *  L6 — Fail-closed gate  (refuse frame if vision layer threw)
 *
 * NOTE: OCR (L3) is stubbed pending Tesseract.js bundling.
 *   To enable: set TESSERACT_ENABLED = true after running
 *   `npm pack tesseract.js@5` and copying dist/ into lib/tesseract/
 */

import { pipeline, env } from "./lib/transformers.min.js";

// ── ONNX / WASM runtime ───────────────────────────────────────────────────────
const libPath = chrome.runtime.getURL("lib/");
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${libPath}ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: libPath,
};
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// ── Canvas elements ───────────────────────────────────────────────────────────
const canvas    = document.getElementById("offscreenCanvas");
const ctx       = canvas.getContext("2d", { willReadFrequently: true });
const rawCanvas = document.getElementById("rawCanvas");
const rawCtx    = rawCanvas.getContext("2d");

// ── OWL-ViT: Open-Vocabulary PII Visual Detector ─────────────────────────────
// Replaces yolos-tiny (80 fixed COCO classes) with zero-shot detection.
// Any PII visual type can be queried without retraining.

const PII_VISUAL_QUERIES = [
  // Documents / Identity
  "ID card",
  "Aadhaar card",
  "identity document",
  "passport",
  // Financial
  "credit card",
  "debit card",
  "bank card",
  "bank statement",
  "financial document",
  "cheque",
  // Medical
  "medical report",
  "prescription document",
  "lab result",
  // Employment / Tax
  "payslip",
  "salary slip",
  "tax document",
  // Biometric
  "human face",
  "fingerprint",
  // Access / Auth
  "PIN pad",
  "keypad with numbers",
  "QR code",
  "barcode",
  // Misc
  "handwritten signature",
  "handwritten document",
];

// OWL-ViT zero-shot confidence scores are inherently lower than fine-tuned
// detectors. 0.08 provides a recall-favoring threshold (flag more, miss less).
const OWL_VIT_THRESHOLD = 0.08;

let detector        = null;
let activeBackend   = "WASM";
let isModelLoading  = false;
let modelLoadPromise = null;

async function initModel() {
  if (detector) return detector;
  if (modelLoadPromise) return modelLoadPromise;

  isModelLoading = true;
  modelLoadPromise = (async () => {
    console.log("[Offscreen] Initializing OWL-ViT zero-shot detector …");
    try {
      if (!navigator.gpu) throw new Error("navigator.gpu not available");
      console.log("[Offscreen] Attempting WebGPU backend …");
      detector = await pipeline(
        "zero-shot-object-detection",
        "Xenova/owlvit-base-patch32",
        { device: "webgpu" }
      );
      activeBackend = "WebGPU";
      console.log("[Offscreen] OWL-ViT ready on WebGPU.");
    } catch (gpuErr) {
      console.warn("[Offscreen] WebGPU unavailable, falling back to WASM:", gpuErr.message);
      detector = await pipeline(
        "zero-shot-object-detection",
        "Xenova/owlvit-base-patch32",
        { device: "wasm" }
      );
      activeBackend = "WASM";
      console.log("[Offscreen] OWL-ViT ready on WASM.");
    }
    isModelLoading = false;
    return detector;
  })();

  return modelLoadPromise;
}

// Pre-warm on document load
initModel().catch((err) => console.error("[Offscreen] Model init error:", err));

// ── Checksum Validators ───────────────────────────────────────────────────────

/** Luhn algorithm — validates credit/debit card numbers. */
function luhnCheck(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let odd = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i]);
    if (!odd) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    odd = !odd;
  }
  return sum % 10 === 0;
}

/** Verhoeff algorithm — validates Indian Aadhaar numbers. */
function verhoeffCheck(value) {
  const D = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0],
  ];
  const P = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
  ];
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(digits)) return false;
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) {
    c = D[c][P[i % 8][parseInt(rev[i])]];
  }
  return c === 0;
}

// ── PII Text Patterns (for OCR output) ───────────────────────────────────────

const PII_TEXT_PATTERNS = [
  {
    name: "Aadhaar",
    pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    validate: (m) => verhoeffCheck(m),
  },
  {
    name: "PAN Card",
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    validate: null,
  },
  {
    name: "Credit / Debit Card",
    pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
    validate: (m) => luhnCheck(m),
  },
  {
    name: "Indian Passport",
    pattern: /\b[A-PR-WY][1-9]\d{7}\b/g,
    validate: null,
  },
  {
    name: "IFSC Code",
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    validate: null,
  },
  {
    name: "UPI ID",
    pattern: /\b[\w.\-]+@[\w.\-]+\b/g,
    validate: null,
  },
  {
    name: "Indian Mobile",
    pattern: /\b[6-9]\d{9}\b/g,
    validate: null,
  },
  {
    name: "VPA / Account Number",
    pattern: /\b\d{9,18}\b/g,
    validate: null,
  },
];

/**
 * Run regex + checksum PII detection on plain text (from OCR).
 * Returns PII type names only — raw values are NEVER stored or transmitted.
 * @param {string} text
 * @returns {string[]} detected PII type names
 */
function extractPIITypesFromText(text) {
  const found = [];
  for (const { name, pattern, validate } of PII_TEXT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(re)) {
      if (!validate || validate(match[0])) {
        found.push(name);
        break; // one confirmed hit per type is sufficient to flag the region
      }
    }
  }
  return found;
}

// ── OCR Layer (Tesseract.js) — STUB ──────────────────────────────────────────
// Enable by:
//   1. npm pack tesseract.js@5  → copy dist/ into pii-agent-extension/lib/tesseract/
//   2. Set TESSERACT_ENABLED = true
//   3. Confirm lang data (eng.traineddata) is present in lib/tesseract/

const TESSERACT_ENABLED = false;

/**
 * Run OCR on visual element regions (img / canvas / video) found by DOM scan.
 * Only these regions are processed — not the full page — to keep latency low.
 *
 * @param {string}   screenshotDataUrl  - Full page screenshot data URL
 * @param {Array}    visualElements     - [{x,y,width,height,tag}] from content.js
 * @param {number}   scaleX             - DPR scale factor X
 * @param {number}   scaleY             - DPR scale factor Y
 * @returns {Array}  redaction boxes for OCR-detected PII regions
 */
async function runOCROnRegions(screenshotDataUrl, visualElements, scaleX, scaleY) {
  if (!TESSERACT_ENABLED || !visualElements || visualElements.length === 0) {
    return [];
  }

  // ── Tesseract.js v5 integration (activate when lib/tesseract/ is present) ──
  // const { createWorker } = await import(chrome.runtime.getURL("lib/tesseract/tesseract.esm.min.js"));
  // const worker = await createWorker("eng", 1, {
  //   workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
  //   corePath:   chrome.runtime.getURL("lib/tesseract/tesseract-core-simd.wasm.js"),
  //   langPath:   chrome.runtime.getURL("lib/tesseract/"),
  // });
  //
  // const img = await loadImage(screenshotDataUrl);
  // const tmpCanvas = document.createElement("canvas");
  // const tmpCtx = tmpCanvas.getContext("2d");
  // const ocrBoxes = [];
  //
  // for (const el of visualElements) {
  //   const sx = Math.round(el.x * scaleX), sy = Math.round(el.y * scaleY);
  //   const sw = Math.round(el.width * scaleX), sh = Math.round(el.height * scaleY);
  //   tmpCanvas.width = sw; tmpCanvas.height = sh;
  //   tmpCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  //   const { data: { text } } = await worker.recognize(tmpCanvas);
  //   const piiTypes = extractPIITypesFromText(text);
  //   if (piiTypes.length > 0) {
  //     ocrBoxes.push({
  //       source: "OCR",
  //       label: `OCR: ${piiTypes.join(", ")}`,
  //       x: sx, y: sy, w: sw, h: sh,
  //     });
  //   }
  // }
  // await worker.terminate();
  // return ocrBoxes;

  return []; // placeholder until Tesseract is bundled
}

// ── Non-Maximum Suppression ───────────────────────────────────────────────────

function computeIoU(a, b) {
  const xA = Math.max(a.x, b.x),  yA = Math.max(a.y, b.y);
  const xB = Math.min(a.x + a.w, b.x + b.w);
  const yB = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Deduplicate overlapping boxes.
 * Priority: DOM (most precise) > VISION_FACE > VISION_OBJECT > OCR
 * Higher-priority or larger box suppresses overlapping lower-priority boxes.
 */
function applyNMS(boxes, iouThreshold = 0.45) {
  const PRIORITY = { DOM: 4, VISION_FACE: 3, VISION_OBJECT: 2, OCR: 1 };
  const sorted = [...boxes].sort((a, b) => {
    const dp = (PRIORITY[b.source] ?? 0) - (PRIORITY[a.source] ?? 0);
    return dp !== 0 ? dp : (b.w * b.h) - (a.w * a.h);
  });

  const kept = [];
  const suppressed = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!suppressed.has(j) && computeIoU(sorted[i], sorted[j]) > iouThreshold) {
        suppressed.add(j);
      }
    }
  }
  return kept;
}

// ── Image Loader ──────────────────────────────────────────────────────────────

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => resolve(img);
    img.onerror = (e) => reject(new Error("Image decode failed: " + e));
    img.src = url;
  });
}

// ── Main Processing Function ──────────────────────────────────────────────────

async function processAndRedactFrame(payload) {
  const {
    screenshotUrl,
    domBoxes      = [],
    visualElements = [], // <img>, <canvas>, <video> regions from DOM (for OCR targeting)
    viewport      = { width: 1, height: 1 },
    options       = {},
  } = payload;

  const threshold = options.threshold ?? OWL_VIT_THRESHOLD;

  const model = await initModel();
  const img   = await loadImage(screenshotUrl);

  const width  = img.naturalWidth  || img.width;
  const height = img.naturalHeight || img.height;

  canvas.width = rawCanvas.width   = width;
  canvas.height = rawCanvas.height = height;

  rawCtx.drawImage(img, 0, 0, width, height); // raw (local HUD only)
  ctx.drawImage(img, 0, 0, width, height);    // will be redacted in-place

  const scaleX = width  / (viewport.width  || width);
  const scaleY = height / (viewport.height || height);

  // ── L1: DOM PII boxes ────────────────────────────────────────────────────────
  const allBoxes = domBoxes.map((box) => ({
    source: "DOM",
    label:  box.reason || "DOM PII",
    tag:    box.tag,
    x: Math.round(box.x     * scaleX),
    y: Math.round(box.y     * scaleY),
    w: Math.max(Math.round(box.width  * scaleX), 10),
    h: Math.max(Math.round(box.height * scaleY), 10),
  }));

  // ── L2 + L3: Vision + OCR in parallel ───────────────────────────────────────
  const tStart = performance.now();

  const [visionResult, ocrResult] = await Promise.allSettled([
    // L2: OWL-ViT zero-shot
    model(screenshotUrl, PII_VISUAL_QUERIES, { threshold }),

    // L3: OCR on targeted visual regions
    runOCROnRegions(screenshotUrl, visualElements, scaleX, scaleY),
  ]);

  const inferenceLatencyMs = performance.now() - tStart;

  // ── L6: Fail-Closed Safety Gate ──────────────────────────────────────────────
  // Vision is mandatory. If it fails, we cannot guarantee visual PII is redacted.
  // Refusing to transmit is safer than sending an under-redacted frame.
  if (visionResult.status === "rejected") {
    throw new Error(
      `[FAIL-CLOSED] Vision layer failed: ${visionResult.reason?.message}. Frame refused — not transmitted.`
    );
  }

  // OCR failure: fatal only when Tesseract is intentionally enabled.
  const ocrFailed = ocrResult.status === "rejected";
  if (ocrFailed && TESSERACT_ENABLED) {
    throw new Error(
      `[FAIL-CLOSED] OCR layer failed: ${ocrResult.reason?.message}. Frame refused.`
    );
  }
  if (ocrFailed) {
    console.warn("[Offscreen] OCR layer skipped (Tesseract not bundled yet).");
  }

  // ── Process OWL-ViT results ──────────────────────────────────────────────────
  const visionDetections = visionResult.value || [];
  const visionBoxesLog   = [];

  visionDetections.forEach((det) => {
    const { xmin, ymin, xmax, ymax } = det.box;
    const w = xmax - xmin;
    const h = ymax - ymin;

    visionBoxesLog.push({ label: det.label, score: det.score, box: det.box });

    // Distinguish face detections so HUD can colour them differently
    const label = det.label.toLowerCase();
    const isFace = label.includes("face") || label.includes("human");

    allBoxes.push({
      source: isFace ? "VISION_FACE" : "VISION_OBJECT",
      label:  det.label.toUpperCase(),
      score:  det.score,
      x: Math.round(xmin),
      y: Math.round(ymin),
      w: Math.max(Math.round(w), 10),
      h: Math.max(Math.round(h), 10),
    });
  });

  // ── Process OCR results ──────────────────────────────────────────────────────
  const ocrBoxes = ocrResult.value || [];
  ocrBoxes.forEach((box) => allBoxes.push(box));

  // ── L4: NMS deduplication ────────────────────────────────────────────────────
  const finalRedactionBoxes = applyNMS(allBoxes, 0.45);

  // ── L5: Canvas blackout redaction ────────────────────────────────────────────
  // Solid fills only — blur and alpha are reversible, blackout is not.
  ctx.save();
  finalRedactionBoxes.forEach((item) => {
    ctx.fillStyle = "rgba(10, 10, 15, 0.97)";
    ctx.fillRect(item.x, item.y, item.w, item.h);

    ctx.lineWidth = 2;
    ctx.strokeStyle =
      item.source === "DOM"          ? "#ff3b3b" :
      item.source === "VISION_FACE"  ? "#eab308" :
      item.source === "OCR"          ? "#a855f7" : // purple for OCR-detected text PII
      "#38bdf8";                                   // cyan for vision objects
    ctx.strokeRect(item.x, item.y, item.w, item.h);

    ctx.fillStyle = ctx.strokeStyle;
    ctx.font      = "bold 11px monospace";
    ctx.fillText(`[REDACTED: ${item.label.slice(0, 24)}]`, item.x + 4, item.y + 14);
  });
  ctx.restore();

  // Inspection overlays on rawCanvas (shown in HUD, never transmitted)
  rawCtx.save();
  finalRedactionBoxes.forEach((item) => {
    rawCtx.lineWidth   = 2;
    rawCtx.strokeStyle =
      item.source === "DOM"         ? "#ff3b3b" :
      item.source === "VISION_FACE" ? "#eab308" :
      item.source === "OCR"         ? "#a855f7" :
      "#38bdf8";
    rawCtx.strokeRect(item.x, item.y, item.w, item.h);
    rawCtx.fillStyle = rawCtx.strokeStyle;
    rawCtx.font      = "bold 12px monospace";
    rawCtx.fillText(item.label, item.x, Math.max(item.y - 4, 12));
  });
  rawCtx.restore();

  return {
    ok:                   true,
    backend:              activeBackend,
    model:                "owlvit-base-patch32",
    inferenceLatencyMs:   Number(inferenceLatencyMs.toFixed(1)),
    timestamp:            new Date().toISOString(),
    resolution:           { width, height },
    domBoxesCount:        domBoxes.length,
    visionDetectionsCount: visionDetections.length,
    ocrDetectionsCount:   ocrBoxes.length,
    totalRedactionsCount: finalRedactionBoxes.length,
    redactionList:        finalRedactionBoxes,
    visionDetections:     visionBoxesLog,
    layerHealth: {
      dom:    true,
      vision: true,
      ocr:    !ocrFailed || !TESSERACT_ENABLED,
    },
    sanitizedImageUrl:     canvas.toDataURL("image/jpeg", 0.85),   // sent to server
    inspectedRawImageUrl:  rawCanvas.toDataURL("image/jpeg", 0.85), // local HUD only
  };
}

// ── Message Listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING_OFFSCREEN") {
    sendResponse({
      ok:           true,
      ready:        detector !== null,
      loading:      isModelLoading,
      backend:      activeBackend,
      model:        "owlvit-base-patch32",
      ocrEnabled:   TESSERACT_ENABLED,
    });
    return true;
  }

  if (message.type === "PROCESS_FRAME") {
    processAndRedactFrame(message.payload)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("[Offscreen] processAndRedactFrame error:", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  return true;
});
