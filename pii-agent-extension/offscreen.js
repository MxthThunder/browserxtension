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

// ── ONNX Runtime / Transformers.js config ────────────────────────────────────
env.allowLocalModels  = true;
env.allowRemoteModels = true;
env.useBrowserCache   = false; // Models are stored locally in extension; bypasses Cache API scheme warnings
env.localModelPath    = chrome.runtime.getURL("models/");
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
    console.log("[Offscreen] OWL-ViT: initialising zero-shot detector (WASM SIMD) …");
    // Force device: "wasm" (CPUExecutionProvider).
    // Avoids ORT WebGPU EP's missing Cast node kernel (/class_head/Cast) in the OWL-ViT graph.
    owlvitPipeline = await pipeline("zero-shot-object-detection", OWL_VIT_MODEL, {
      device: "wasm",
    });
    console.log("[Offscreen] OWL-ViT ready (WASM SIMD)");
    return owlvitPipeline;
  })();
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
        minDetectionConfidence: 0.4,
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
async function ocrRegion(cropCanvas, regionBox, categories) {
  if (!tessWorker || !tessReady) return [];
  try {
    const dataUrl = cropCanvas.toDataURL("image/png");
    const { data: { text } } = await tessWorker.recognize(dataUrl);
    const matched = [];
    for (const { category, label, re } of OCR_PII_PATTERNS) {
      if (categories[category] === false) continue;
      if (re.test(text)) {
        matched.push({
          source:     "OCR",
          label:      `OCR: ${label}`,
          category,
          confidence: 0.9,
          x: regionBox.x,
          y: regionBox.y,
          w: regionBox.w,
          h: regionBox.h,
        });
        break; // one label per region
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
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (iou(sorted[i], sorted[j]) > iouThreshold) used.add(j);
    }
  }
  return keep;
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

// ── Pre-warm models on extension load ────────────────────────────────────────
// OWL-ViT: ~155MB ONNX, downloads from HF Hub and caches. Ready in ~15s.
// BlazeFace: ~12MB WASM + 1MB model, loads from local lib/ — ready in ~1s.
initOWLViT().catch((e) => console.warn("[Offscreen] OWL-ViT pre-init error:", e.message));
initFaceDetector();
// OCR is lazy – only started when the first visual region is found.

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

  // ── 1. Ensure OWL-ViT is initialised ────────────────────────────────────────
  const owlvitModel = await initOWLViT();
  const activeBackend = owlvitPipeline ? "OWL-ViT-WASM" : "degraded";

  // ── 2. Decode screenshot ───────────────────────────────────────────────────
  const img    = await loadImage(screenshotUrl);
  const width  = img.naturalWidth  || img.width;
  const height = img.naturalHeight || img.height;

  canvas.width = rawCanvas.width  = width;
  canvas.height = rawCanvas.height = height;

  rawCtx.drawImage(img, 0, 0, width, height); // inspection copy (local HUD only)
  ctx.drawImage(img, 0, 0, width, height);    // redaction canvas

  const scaleX = width  / (viewport.width  || width);
  const scaleY = height / (viewport.height || height);

  const tImgReady = performance.now();

  // ── L1: DOM boxes (already analysed by content.js) ──────────────────────
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

  // ── L2 + L3: OWL-ViT and MediaPipe run in parallel ──────────────────────
  const tStartVision = performance.now();

  const [owlResult, faceResult] = await Promise.allSettled([
    // L2: OWL-ViT zero-shot object detection
    (async () => {
      if (!owlvitModel) throw new Error("OWL-ViT not ready");
      const shouldRun =
        categories.faces !== false ||
        categories.screens !== false ||
        categories.govIds !== false ||
        categories.creditCards !== false;
      if (!shouldRun) return [];
      // O3: Use RawImage (already-fetched img data) to avoid double data-URI decode
      const rawImg = await RawImage.fromURL(screenshotUrl);
      return owlvitModel(rawImg, PII_VISUAL_QUERIES, { threshold });
    })(),

    // L3: MediaPipe BlazeFace (primary face detector)
    (async () => {
      if (categories.faces === false) return [];
      await initFaceDetector(); // no-op if already done
      return detectFaces(img, width, height);
    })(),
  ]);

  const tEndVision = performance.now();

  // Fail-closed: OWL-ViT is mandatory for visual PII guarantee
  if (owlResult.status === "rejected" && failClosed) {
    throw new Error(
      `[FAIL-CLOSED] OWL-ViT failed: ${owlResult.reason?.message}. Frame refused — not transmitted.`
    );
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

  // ── L4: OCR on candidate visual regions ──────────────────────────────────
  const tStartOCR = performance.now();
  const ocrRedactions = [];

  if (allVisualBoxes.length > 0 || domRedactions.length > 0) {
    // Lazy-start OCR worker on first visual hit
    await initOCR();

    // O1: OCR targets = visual boxes (OWL-ViT/Face) UNION DOM boxes (text nodes, file uploads, img).
    // Deduplicate by bucketing to a 12px grid to avoid OCR-ing the same region twice.
    const seenOcrKeys = new Set();
    const ocrTargets = [];
    for (const b of [...allVisualBoxes, ...domRedactions]) {
      const key = `${Math.round(b.x / 12)},${Math.round(b.y / 12)}`;
      if (!seenOcrKeys.has(key) && b.w > 10 && b.h > 8) {
        seenOcrKeys.add(key);
        ocrTargets.push({ x: b.x, y: b.y, w: b.w, h: b.h });
      }
    }

    if (tessReady && ocrTargets.length > 0) {
      const cropCanvas = new OffscreenCanvas(1, 1);
      const cropCtx    = cropCanvas.getContext("2d");

      for (const region of ocrTargets.slice(0, 12)) { // max 12 regions (raised from 8 for DOM coverage)
        const rx = Math.max(0, Math.min(region.x, width - 1));
        const ry = Math.max(0, Math.min(region.y, height - 1));
        const rw = Math.max(1, Math.min(region.w, width - rx));
        const rh = Math.max(1, Math.min(region.h, height - ry));
        cropCanvas.width  = rw;
        cropCanvas.height = rh;
        cropCtx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);

        // Convert OffscreenCanvas to data URL via Blob
        const blob    = await cropCanvas.convertToBlob({ type: "image/png" });
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

  const tEndOCR = performance.now();

  // ── L5: Merge all redaction boxes + NMS ──────────────────────────────────
  const merged = [...domRedactions, ...owlRedactions, ...faceRedactions, ...ocrRedactions];
  const finalRedactionBoxes = applyNMS(merged, 0.45);

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

  // ── Build output ──────────────────────────────────────────────────────────
  const sanitizedImageUrl = canvas.toDataURL("image/jpeg", 0.90);
  const rawImageUrl       = rawCanvas.toDataURL("image/jpeg", 0.85);
  const integrityHash     = await computeHash(sanitizedImageUrl.substring(0, 1000));
  const totalTime         = performance.now() - t0;

  console.log(
    `[Offscreen] Redaction complete: DOM=${domRedactions.length} ` +
    `OWL-ViT=${owlRedactions.length} Face=${faceRedactions.length} ` +
    `OCR=${ocrRedactions.length} Total=${finalRedactionBoxes.length} ` +
    `(${Math.round(totalTime)}ms)`
  );

  // ── Step 1: Build Unified Perception Representation ───────────────────────
  const unifiedPerceptionState = buildUnifiedPerceptionState({
    domElements: payload.interactiveElements || [],
    domSensitiveBoxes: domBoxes || [],
    owlvitDetections: owlRedactions || [],
    faceDetections: faceRedactions || [],
    ocrDetections: ocrRedactions || [],
    viewport: viewport,
    url: payload.url || "",
  });

  // ── Step 2: Local Privacy Engine Evaluation ────────────────────────────────
  let privacyDecisionManifest = defaultPrivacyEngine.evaluatePerceptionState(
    unifiedPerceptionState,
    { url: payload.url || "", options: payload.options || {} }
  );

  // ── Step 3: Local Reasoning Model (Ambiguity Resolution) ───────────────────
  if (privacyDecisionManifest.ambiguousElements?.length > 0) {
    privacyDecisionManifest = await defaultPrivacyReasoner.resolveManifestAmbiguities(
      privacyDecisionManifest,
      { url: payload.url || "", userTask: payload.userTask || "" }
    );
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
    resolution: { width, height },
    timings: {
      totalRedactionLatencyMs: totalTime,
      visionLatencyMs:  tEndVision - tStartVision,
      ocrLatencyMs:     tEndOCR    - tStartOCR,
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
    return true;
  }

  return true;
});
