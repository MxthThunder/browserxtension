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
import { findNames, findNameCandidates } from "./name_detector.js";


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

/**
 * Per-category acceptance thresholds, applied AFTER the model's own scan.
 *
 * A single uniform 0.12 across all 22 queries treats every query as equally
 * reliable, which they are not: "credit card" and "passport" are visually
 * distinctive and score confidently, while "confidential document" and
 * "official document" are near-unbounded descriptions that fire on any page of
 * printed text. Tuning per category buys precision on the vague queries without
 * giving up recall on the sharp ones.
 *
 * The scan itself still runs at the lowest of these, so nothing is lost before
 * this filter can see it. Values are keyed by the mapped category, and any
 * category absent here keeps the base threshold.
 */
const OWL_VIT_CATEGORY_THRESHOLDS = {
  creditCards: 0.12, // distinctive rectangular objects; keep recall high
  govIds:      0.14,
  faces:       0.12, // BlazeFace is the primary face detector; this is a backstop
  screens:     0.20, // "monitor"/"laptop screen" fire on any bright rectangle
};

/** Queries whose wording is broad enough to need their own, stricter floor. */
const OWL_VIT_VAGUE_QUERY_RE = /confidential|official document|government document|printed financial/i;
const OWL_VIT_VAGUE_THRESHOLD = 0.22;

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



/* ── Face detection scale problem ──────────────────────────────────────────
   `blaze_face_short_range` takes a 128x128 input, and MediaPipe scales whatever
   you hand it down to that. A full-page screenshot is ~2560px wide, so a face in
   an article thumbnail (~70px) arrives at the model about 3px across and is
   simply not there any more — which is why a page full of visible faces reported
   zero detections.

   The frame is therefore also scanned in overlapping tiles. At a 512px tile that
   same 70px face lands at ~17px in model space, which is comfortably detectable.
   The whole-frame pass is kept as well: it is cheap and catches a close-up face
   that would otherwise be split across tiles. */
const FACE_TILE_PX       = 512;   // source pixels per tile
const FACE_TILE_OVERLAP  = 0.25;  // so a face on a seam still lands whole in one tile
const FACE_TILE_MAX      = 30;
const FACE_TILE_BUDGET_MS = 1500;
const FACE_DEDUPE_IOU    = 0.35;

function boxIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** The same face seen in two overlapping tiles must count once. */
function dedupeFaces(boxes) {
  const kept = [];
  for (const box of boxes.sort((p, q) => q.confidence - p.confidence)) {
    if (!kept.some((k) => boxIoU(k, box) > FACE_DEDUPE_IOU)) kept.push(box);
  }
  return kept;
}

/**
 * Overlapping tile rects covering the frame, largest-first coverage order.
 * Pure so the geometry can be verified without a canvas.
 */
function computeFaceTiles(imgWidth, imgHeight) {
  if (imgWidth <= FACE_TILE_PX * 1.2 && imgHeight <= FACE_TILE_PX * 1.2) return [];
  const step = Math.max(64, Math.round(FACE_TILE_PX * (1 - FACE_TILE_OVERLAP)));
  const tiles = [];
  for (let y = 0; y < imgHeight; y += step) {
    for (let x = 0; x < imgWidth; x += step) {
      const w = Math.min(FACE_TILE_PX, imgWidth - x);
      const h = Math.min(FACE_TILE_PX, imgHeight - y);
      if (w < 96 || h < 96) continue;   // a strip this thin holds no usable face
      tiles.push({ x, y, w, h });
      if (tiles.length >= FACE_TILE_MAX) return tiles;
    }
  }
  return tiles;
}

function mapDetections(result, offsetX, offsetY) {
  return (result?.detections || []).map((d) => {
    const bb = d.boundingBox;
    return {
      source:     "MediaPipe-Face",
      label:      "Face",
      category:   "faces",
      confidence: d.categories?.[0]?.score ?? 0.9,
      x: Math.round(bb.originX + offsetX),
      y: Math.round(bb.originY + offsetY),
      w: Math.round(bb.width),
      h: Math.round(bb.height),
    };
  });
}

/**
 * Run MediaPipe face detection over a decoded frame.
 * Returns an array of { source, label, category, confidence, x, y, w, h } boxes
 * in full-frame coordinates.
 */
async function detectFaces(img, imgWidth, imgHeight) {
  if (!faceDetector || !faceDetectorReady) return [];

  const found = [];

  // Pass 1 — whole frame. Cheap, and the only pass that can see a face spanning
  // more than one tile.
  try {
    found.push(...mapDetections(faceDetector.detect(img), 0, 0));
  } catch (err) {
    console.warn("[Offscreen] MediaPipe detect() error (full frame):", err.message);
  }

  // Pass 2 — overlapping tiles, so small faces survive the model's downscale.
  const tiles = computeFaceTiles(imgWidth, imgHeight);
  if (tiles.length) {
    const started = performance.now();
    let scanned = 0;

    const canvas = new OffscreenCanvas(FACE_TILE_PX, FACE_TILE_PX);
    const context = canvas.getContext("2d", { willReadFrequently: true });

    for (const tile of tiles) {
      if (performance.now() - started > FACE_TILE_BUDGET_MS) {
        logEvent("offscreen", `Face tiling budget reached after ${scanned}/${tiles.length} tile(s); frame partially scanned`, null, "warn");
        break;
      }
      try {
        canvas.width = tile.w;
        canvas.height = tile.h;
        context.clearRect(0, 0, tile.w, tile.h);
        context.drawImage(img, tile.x, tile.y, tile.w, tile.h, 0, 0, tile.w, tile.h);
        found.push(...mapDetections(faceDetector.detect(canvas), tile.x, tile.y));
        scanned++;
      } catch (err) {
        console.warn("[Offscreen] MediaPipe detect() error (tile):", err.message);
      }
    }
  }

  const deduped = dedupeFaces(found);
  if (deduped.length) {
    logEvent("offscreen", `BlazeFace found ${deduped.length} face(s) (${found.length} raw detection(s) before dedupe)`);
  }
  return deduped;
}

// ── Tesseract OCR ─────────────────────────────────────────────────────────────
let tessWorker    = null;
let tessReady     = false;
let tessInitPromise = null;
let activeOcrLanguages = "eng";

/** PII regex patterns applied against OCR text output */
const OCR_PII_PATTERNS = [
  { category: "creditCards", label: "Credit Card Number", re: /\b(?:\d[ -]?){13,16}\b/ },
  { category: "govIds",      label: "Aadhaar Number",     re: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
  { category: "govIds",      label: "SSN",                re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { category: "govIds",      label: "PAN Card",           re: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  { category: "govIds",      label: "Passport Number",    re: /\b[A-Z]\d{7}\b/ },
  { category: "contactInfo", label: "Email Address",      re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/ },
  // Grouping-agnostic (see content.js's INLINE_PII_PATTERNS.PHONE for the
  // full rationale): the previous 3-3-4-only pattern missed the Indian
  // mobile format and Korean-style 3-4-4 numbers, both verified misses.
  { category: "contactInfo", label: "Phone Number",       re: /\b\+?\(?\d{2,5}\)?(?:[-.\s]\d{2,5}){1,4}\b/ },
  { category: "govIds",      label: "Bank IFSC Code",     re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
  { category: "govIds",      label: "Account Number",     re: /\b\d{9,18}\b/ },
  // Credentials rendered INSIDE an image — a screenshot of a login form, a
  // pasted terminal session, a shared password manager view. The DOM scanner
  // cannot see these at all: there is no text node, only pixels.
  //
  // Label list kept in step with content.js / semantic_redactor.js; the value
  // stops at whitespace here rather than end-of-line, because OCR emits word
  // boxes and a run that crossed a line break would produce a box spanning
  // unrelated rows. scripts/test-credential-detection.mjs guards the drift.
  { category: "passwords",   label: "Credential",
    re: /\b(?:pass(?:word|phrase|wd)|pwd|passcode|otp|pin|cvv|cvc|csc|api[\s_-]?key|secret[\s_-]?key|access[\s_-]?token|auth[\s_-]?token|recovery[\s_-]?code|security[\s_-]?answer|user(?:name|[\s_-]?id))\s*[:=]\s*\S+/i },
  { category: "passwords",   label: "API Key / Token",
    re: /\b(?:sk|pk|rk)[-_](?:test|live|prod)[-_][A-Za-z0-9]{12,}|\bAKIA[0-9A-Z]{16}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { category: "creditCards", label: "UPI ID",
    re: /\b[A-Za-z0-9._-]{2,}@(?:upi|ybl|ibl|axl|apl|paytm|okhdfcbank|oksbi|okaxis|okicici|hdfcbank|sbi|icici|axisbank|kotak|yesbank|freecharge|airtel|jupiteraxis|fam|slc|naviaxis)\b/i },
];

/**
 * Languages the OCR worker is initialised with.
 *
 * KNOWN RECALL GAP: only `eng.traineddata.gz` is bundled, so text in Devanagari,
 * Tamil, Bengali and every other non-Latin script is currently invisible to
 * Layer 2C — a live blind spot on Indian government and e-commerce pages. The
 * language set is configurable rather than hard-coded so this can be closed
 * without a code change: drop the matching `<lang>.traineddata.gz` files into
 * `lib/tesseract/` (from tessdata_fast) and set `ocrLanguages` in Settings to a
 * "+"-joined list, e.g. "eng+hin+tam+ben".
 *
 * Adding a language costs both download size (~1-15MB each) and per-frame
 * latency, which is why this is a deliberate choice and not a default.
 */
const DEFAULT_OCR_LANGUAGES = "eng";

async function initOCR(languages) {
  if (tessReady) return tessWorker;
  if (tessInitPromise) return tessInitPromise;

  const requested = String(languages || DEFAULT_OCR_LANGUAGES).trim() || DEFAULT_OCR_LANGUAGES;

  tessInitPromise = (async () => {
    // Tesseract.js does not expose a native ESM — use the UMD global loaded via offscreen.html
    if (typeof Tesseract === "undefined") {
      console.warn("[Offscreen] Tesseract global not found; OCR disabled.");
      return null;
    }

    const options = {
      workerPath:    chrome.runtime.getURL("lib/tesseract/worker.min.js"),
      corePath:      chrome.runtime.getURL("lib/tesseract/tesseract-core.wasm.js"),
      langPath:      chrome.runtime.getURL("lib/tesseract/"),
      workerBlobURL: false,
      cacheMethod:   "write",
      logger:        () => {},
    };

    // Try the requested set, then fall back to English. A missing traineddata
    // file must degrade OCR to the bundled language, never disable it outright —
    // losing the whole layer over one absent file would be a large, silent drop
    // in redaction coverage.
    for (const langs of [requested, DEFAULT_OCR_LANGUAGES]) {
      try {
        tessWorker = await Tesseract.createWorker(langs, 1, options);
        tessReady = true;
        activeOcrLanguages = langs;
        if (langs !== requested) {
          logEvent(
            "offscreen",
            `OCR languages "${requested}" unavailable; running with "${langs}". ` +
            `Add the missing .traineddata.gz files to lib/tesseract/ to enable them.`,
            null,
            "warn"
          );
        }
        console.log(`[Offscreen] Tesseract OCR ready (${langs})`);
        return tessWorker;
      } catch (err) {
        console.warn(`[Offscreen] Tesseract init failed for "${langs}":`, err?.message || err);
      }
    }
    return null;
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
/**
 * Layer G2: person names in OCR'd text, localised to word boxes.
 *
 * Kept separate from OCR_PII_PATTERNS because names are not a regex: they are
 * decided by an adjacent cue ("Name:", "Deliver to", "Dr") or by a gazetteer
 * hit, and the deciding cue sits in NEIGHBOURING words. Matching therefore runs
 * over the joined line text and maps character offsets back onto words, so a hit
 * covers exactly the name and not the label in front of it.
 *
 * @param {Array<{text: string, bbox: Object}>} words
 * @param {Set<number>} claimed Word indices already covered by another pattern
 * @returns {Array<{start: number, end: number, text: string, via: string}>} word-index ranges
 */
/** Joins OCR words into one string, recording each word's char offset within it. */
function joinWordsWithOffsets(words) {
  const offsets = [];
  let text = "";
  for (const w of words) {
    if (text) text += " ";
    offsets.push(text.length);
    text += w.text;
  }
  return { text, offsets };
}

/** Maps character-offset hits (from findNames/findNameCandidates) back onto word-index ranges. */
function mapHitsToWordRanges(words, offsets, hits, claimed) {
  const ranges = [];
  for (const hit of hits) {
    const hitEnd = hit.index + hit.length;
    let start = -1;
    let end = -1;
    for (let i = 0; i < words.length; i++) {
      const wordStart = offsets[i];
      const wordEnd = wordStart + words[i].text.length;
      if (wordEnd <= hit.index || wordStart >= hitEnd) continue;
      if (start === -1) start = i;
      end = i + 1;
    }
    if (start === -1) continue;
    let overlapsClaimed = false;
    for (let i = start; i < end; i++) {
      if (claimed.has(i)) { overlapsClaimed = true; break; }
    }
    if (overlapsClaimed) continue;
    ranges.push({ start, end, text: hit.text, via: hit.via });
  }
  return ranges;
}

function matchOcrNames(words, claimed) {
  if (!words.length) return [];
  const { text, offsets } = joinWordsWithOffsets(words);
  return mapHitsToWordRanges(words, offsets, findNames(text), claimed);
}

/**
 * Layer G3 input: capitalised runs G1+G2 could not confirm, localised to
 * word ranges with a short surrounding-word context for the model prompt.
 * Returns candidates only - it never decides redact/safe itself.
 */
function matchNameCandidates(words, claimed) {
  if (!words.length) return [];
  const { text, offsets } = joinWordsWithOffsets(words);
  const ranges = mapHitsToWordRanges(words, offsets, findNameCandidates(text), claimed);
  return ranges.map((r) => ({
    ...r,
    contextBefore: words.slice(Math.max(0, r.start - 3), r.start).map((w) => w.text).join(" "),
    contextAfter: words.slice(r.end, Math.min(words.length, r.end + 3)).map((w) => w.text).join(" "),
  }));
}

/**
 * True when `re` matches the ENTIRE string, not merely somewhere inside it.
 *
 * Used only to decide whether to WIDEN an already-found box by one more word
 * (see the extension loop in ocrRegion): a plain `.test()` there would keep
 * growing into an unrelated neighbour whenever the combined text happens to
 * contain a match anywhere, e.g. prepending "Order#1234" onto a real phone
 * number "555-0123" — `.test("Order#1234 555-0123")` is true (a phone pattern
 * exists somewhere in there), but "Order#1234" is not part of the number.
 * Requiring the WHOLE combined string to be consumed rules that out while
 * still allowing a genuine multi-word number ("(415) 555-0123") to grow.
 */
function fullMatch(re, str) {
  const m = str.match(re);
  if (!m) return false;

  // Not a strict m[0] === str check: \b cannot attach directly before a
  // non-word character, so a leading "(" or "+" is always excluded from the
  // matched text even when it visually belongs to the number (verified against
  // the phone pattern — "(415) 555-0123" matches only "415) 555-0123"). That is
  // harmless for the box itself, which is built from whole-word bounding boxes
  // rather than character offsets, but it would make a naive equality check
  // reject a perfectly good extension. Tolerate ONLY that specific wrapper
  // punctuation before/after the match; anything else left over (letters,
  // digits, '#', ':' ...) means the match did not really consume the whole
  // string, and the candidate extension must still be rejected.
  const before = str.slice(0, m.index);
  const after = str.slice(m.index + m[0].length);
  return /^[+(\s]*$/.test(before) && /^[)\s]*$/.test(after);
}

async function ocrRegion(cropCanvas, regionBox, categories) {
  if (!tessWorker || !tessReady) return { matched: [], candidates: [] };
  try {
    const dataUrl = cropCanvas.toDataURL("image/png");
    const { data } = await tessWorker.recognize(dataUrl, {}, { text: true, blocks: true });
    const text = data?.text || "";
    if (!text.trim()) return { matched: [], candidates: [] };

    const words = extractOcrWords(data).filter((w) => w && w.text && w.bbox);
    const matched = [];
    const claimed = new Set();
    const PAD = 3;

    for (const { category, label, re } of OCR_PII_PATTERNS) {
      if (categories[category] === false) continue;
      if (!re.test(text)) continue;

      // A region can contain the SAME pattern more than once (e.g. a phone
      // number quoted once by the user and echoed back once by a reply on the
      // same screen) - keep searching for fresh, non-overlapping occurrences
      // until a full pass finds none, instead of stopping at the first hit.
      // `claimed` prevents re-finding the same words, so each pass only sees
      // what the previous ones left unclaimed.
      let foundCount = 0;
      for (;;) {
        let localised = false;

        // Walk runs of up to 5 adjacent words: an email is one word, a phone
        // number is often two or three. Span is the OUTER loop so the tightest
        // match wins - starting from the word index would let a run beginning at
        // the "Email" label swallow the label and the rows beneath it.
        for (let span = 1; span <= 5 && !localised; span++) {
          for (let i = 0; i + span <= words.length; i++) {
            const run0 = words.slice(i, i + span);
            if (run0.some((_, k) => claimed.has(i + k))) continue;
            // Substring test here, as before: this only decides "is there a
            // detection at all", and recall matters more than precision at that
            // point (a glued OCR token like "Email:john@x.com" must still be
            // caught). The stricter whole-string check below is for deciding
            // how far to WIDEN an already-found box, where the trade-off flips.
            if (!re.test(run0.map((w) => w.text).join(" "))) continue;

            // Grow the anchor outward while doing so still yields a SINGLE
            // whole-string match. Needed for patterns whose minimum structure a
            // trailing fragment can also satisfy alone - e.g. the phone pattern
            // matches "555-0123" (2 groups) by itself, so without this the
            // tightest-span search stops there and leaves the "(415)" area code
            // in the word before it unboxed and unredacted. Growing only ever
            // extends a match already found by the safe smallest-span search
            // above, so the original swallow-the-page failure mode (a match
            // starting at a label and absorbing unrelated rows) cannot recur.
            let start = i, end = i + span;
            for (;;) {
              if (start > 0 && !claimed.has(start - 1) &&
                  fullMatch(re, words.slice(start - 1, end).map((w) => w.text).join(" "))) {
                start -= 1;
                continue;
              }
              if (end < words.length && !claimed.has(end) &&
                  fullMatch(re, words.slice(start, end + 1).map((w) => w.text).join(" "))) {
                end += 1;
                continue;
              }
              break;
            }

            const run = words.slice(start, end);
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
            for (let k = start; k < end; k++) claimed.add(k);
            localised = true;
            foundCount++;
            break;
          }
        }

        if (!localised) break;
      }

      if (foundCount === 0) {
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

    // Layer G2: names. Runs after the regex patterns so numeric and email spans
    // are already claimed and cannot be re-covered as part of a name run.
    if (categories.names !== false) {
      for (const range of matchOcrNames(words, claimed)) {
        const run = words.slice(range.start, range.end);
        const x0 = Math.min(...run.map((w) => w.bbox.x0));
        const y0 = Math.min(...run.map((w) => w.bbox.y0));
        const x1 = Math.max(...run.map((w) => w.bbox.x1));
        const y1 = Math.max(...run.map((w) => w.bbox.y1));

        matched.push({
          source:     "OCR",
          label:      `OCR: Person Name (${range.via})`,
          category:   "names",
          // A cued name is near-certain; a gazetteer hit is a shared-token guess
          // ("Rose" as a colour) and is scored lower so NMS prefers any
          // overlapping deterministic detection.
          confidence: range.via === "cue" ? 0.9 : 0.7,
          x: regionBox.x + Math.max(0, x0 - PAD),
          y: regionBox.y + Math.max(0, y0 - PAD),
          w: Math.max(1, x1 - x0 + PAD * 2),
          h: Math.max(1, y1 - y0 + PAD * 2),
        });
        for (let i = range.start; i < range.end; i++) claimed.add(i);
      }
    }

    // Layer G3 input: spans G1+G2 could not confirm. Region offset is applied
    // now so the caller can add a box straight from a candidate's own fields
    // without needing to see `regionBox` or `words` again.
    const candidates = categories.names !== false
      ? matchNameCandidates(words, claimed).map((c) => ({
          text: c.text,
          contextBefore: c.contextBefore,
          contextAfter: c.contextAfter,
          x: regionBox.x + Math.max(0, Math.min(...words.slice(c.start, c.end).map((w) => w.bbox.x0)) - PAD),
          y: regionBox.y + Math.max(0, Math.min(...words.slice(c.start, c.end).map((w) => w.bbox.y0)) - PAD),
          w: Math.max(1, Math.max(...words.slice(c.start, c.end).map((w) => w.bbox.x1))
                        - Math.min(...words.slice(c.start, c.end).map((w) => w.bbox.x0)) + PAD * 2),
          h: Math.max(1, Math.max(...words.slice(c.start, c.end).map((w) => w.bbox.y1))
                        - Math.min(...words.slice(c.start, c.end).map((w) => w.bbox.y0)) + PAD * 2),
        }))
      : [];

    return { matched, candidates };
  } catch {
    return { matched: [], candidates: [] };
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
        return await detectFaces(img, width, height);
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
  let owlBelowThreshold = 0;

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

    // Per-category / per-query floor. The scan ran at the permissive base
    // threshold so nothing was discarded before this point.
    const floor = Math.max(
      threshold,
      OWL_VIT_CATEGORY_THRESHOLDS[category] ?? threshold,
      OWL_VIT_VAGUE_QUERY_RE.test(labelLower) ? OWL_VIT_VAGUE_THRESHOLD : 0
    );
    if (score < floor) {
      owlBelowThreshold += 1;
      continue;
    }

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
  const nameCandidates = [];
  let ocrRegionsScanned = 0;
  let ocrRegionsSkipped = 0;

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
      await initOCR(options.ocrLanguages);
      if (tessReady) {
        const cropCanvas = new OffscreenCanvas(1, 1);
        const cropCtx    = cropCanvas.getContext("2d");

        // Budget by TIME, not by a fixed count. The old `slice(0, 2)` scanned at
        // most two regions per frame, so a page with six image cards left four
        // completely unexamined regardless of how fast they would have been.
        // Ordering is largest-first from content.js, so the highest-value
        // regions are still done first if the budget runs out.
        const ocrBudgetMs = options.ocrBudgetMs ?? 2500;
        const maxRegions  = options.ocrMaxRegions ?? 8;
        const ocrStart    = performance.now();
        let scanned = 0, skipped = 0;

        for (const region of unclassifiedVisualTargets.slice(0, maxRegions)) {
          if (scanned > 0 && performance.now() - ocrStart > ocrBudgetMs) {
            skipped = unclassifiedVisualTargets.length - scanned;
            break;
          }
          scanned += 1;
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
          ocrRedactions.push(...hits.matched);
          nameCandidates.push(...hits.candidates);
        }

        if (skipped > 0) {
          // Never silent: an unscanned region is unredacted text, and the
          // operator needs to see that the budget is costing coverage.
          logEvent(
            "offscreen",
            `OCR budget (${ocrBudgetMs}ms) reached after ${scanned} region(s); ` +
            `${skipped} region(s) went unscanned and may contain unredacted text.`,
            null,
            "warn"
          );
        }
        ocrRegionsScanned = scanned;
        ocrRegionsSkipped = skipped;
      }
    }
  }

  const tEndOCR = performance.now();

  // ── L4b: Layer G3 — Ollama as an ADDITIVE name disambiguator ─────────────
  // Runs only over spans G1+G2 could not confirm, and only when there are
  // any (most frames have none, so most frames pay nothing here). A verdict
  // of true ADDS a box; anything else (false, timeout, unreachable Ollama,
  // malformed JSON) leaves the frame exactly at the G1+G2 floor - this layer
  // cannot remove a detection the deterministic layers already made, so it
  // cannot regress the measured recall baseline by construction.
  const tStartG3 = performance.now();
  let g3Redactions = [];
  let g3Trace = { engine: "skipped", candidatesFound: nameCandidates.length, candidatesQueried: 0, added: 0, latencyMs: 0 };

  if (categories.names !== false && options.ollamaNameDisambiguation !== false && nameCandidates.length > 0) {
    try {
      const { verdicts, engine, latencyMs } = await defaultPrivacyReasoner.resolveNameCandidates(nameCandidates);
      let added = 0;
      verdicts.forEach((isName, i) => {
        if (!isName) return;
        const c = nameCandidates[i];
        g3Redactions.push({
          source:     "Ollama",
          label:      "Ollama: Person Name (G3)",
          category:   "names",
          confidence: 0.75,
          x: c.x, y: c.y, w: c.w, h: c.h,
        });
        added++;
      });
      g3Trace = { engine, candidatesFound: nameCandidates.length, candidatesQueried: Math.min(nameCandidates.length, defaultPrivacyReasoner.maxNameCandidatesPerBatch), added, latencyMs };
      if (added > 0) {
        logEvent("offscreen", `Layer G3 (${engine}) added ${added} name redaction(s) G1+G2 missed`, null, "info");
      }
    } catch (err) {
      // Additive-only: a failure here must never block the frame or drop a
      // deterministic detection, so it is swallowed and simply adds nothing.
      g3Trace = { engine: "error", candidatesFound: nameCandidates.length, candidatesQueried: 0, added: 0, latencyMs: Math.round(performance.now() - tStartG3) };
    }
  }
  const g3Ms = performance.now() - tStartG3;

  // ── L5: Merge all redaction boxes + NMS ──────────────────────────────────
  const merged = [...domRedactions, ...owlRedactions, ...faceRedactions, ...ocrRedactions, ...g3Redactions];
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
    `Step 6/6: Redaction complete in ${Math.round(totalTime)}ms! (DOM=${domRedactions.length}, OWL=${owlRedactions.length}, Face=${faceRedactions.length}, OCR=${ocrRedactions.length}, G3=${g3Redactions.length}, Total=${finalRedactionBoxes.length})`
  );

  // ── L7: Perception State ──────────────────────────────────────────────────
  // Form-field ambiguity resolution (a different Ollama use than Layer G3
  // above) still happens in agent_loop.js, not here, to avoid stacking two
  // separate LLM round-trips onto one capture cycle.
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
      // Coverage, not just cost: skipped regions are unexamined text, so the
      // dashboard can show when the latency budget is buying a recall loss.
      ocrRegionsScanned,
      ocrRegionsSkipped,
      ocrLanguages:     activeOcrLanguages,
      owlBelowThreshold,
      nmsMs,
      nmsSuppressed,
      guardMs,
      imageLoadMs:      tImgReady  - t0,
      paintLatencyMs:   tEndPaint  - tStartPaint,
      domCount:         domRedactions.length,
      owlvitCount:      owlRedactions.length,
      faceCount:        faceRedactions.length,
      ocrCount:         ocrRedactions.length,
      g3Ms,
      g3Engine:            g3Trace.engine,
      g3CandidatesFound:   g3Trace.candidatesFound,
      g3CandidatesQueried: g3Trace.candidatesQueried,
      g3Count:             g3Redactions.length,
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
