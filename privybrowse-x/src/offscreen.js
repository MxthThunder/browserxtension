/**
 * offscreen.js — the inference host. Everything model-shaped lives here.
 *
 * Runs inside offscreen.html (see that file for why the service worker can't
 * do this job). Owns:
 *   - loading Transformers.js and the detector from LOCAL files only
 *   - WebGPU with a WASM fallback, and honest reporting of which one ran
 *   - keeping the session warm between frames
 *   - compositing redactions before any pixel leaves this document
 *
 * The one rule: this file may return a REDACTED bitmap or a set of boxes. It
 * must never return the raw capture. Keeping that invariant in a single file
 * is why the redaction can be audited at all.
 */

import { pipeline, env } from "../vendor/transformers.js";
import { MetricsCollector, STAGES } from "./metrics.js";
import {
  mergeBoxes, normalizeDetections, produceRedactedBlob, blobToDataURL,
  compositeRedactions, RedactionError,
} from "./redact.js";

// ---------------------------------------------------------------------------
// Offline configuration — this is the CSP fix
// ---------------------------------------------------------------------------

// Never fetch from huggingface.co at runtime. Two reasons: MV3 blocks remote
// code, and a live demo must not depend on venue wifi. vendor-deps.mjs put
// everything on disk; these lines make the library actually use it.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("models/");
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("wasm/");

// Single-threaded WASM avoids needing cross-origin isolation headers, which
// an extension page cannot easily set. Slower, but it is the FALLBACK path —
// if you are hitting it in the demo, the real problem is that WebGPU failed.
env.backends.onnx.wasm.numThreads = 1;

const MODEL_ID = "Xenova/yolos-tiny";
const DETECTION_THRESHOLD = 0.35;

// COCO classes worth masking. `person` is the important one for the webcam
// scenario. Note honestly in the write-up that this yields a whole-body box,
// not a tight face box — a dedicated face model would be tighter, and saying
// so pre-empts the criticism.
const SENSITIVE_VISION_CLASSES = new Set([
  "person", "face", "head",
  "cell phone", "laptop", "tv", "book", "id card",
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let detector = null;
let executionProvider = "none";
let modelReady = false;
let loadError = null;
const metrics = new MetricsCollector({ warmupFrames: 1 });
metrics.modelId = MODEL_ID;

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

async function loadModel() {
  if (modelReady) return { ok: true, executionProvider };
  if (loadError) return { ok: false, error: loadError };

  const t0 = performance.now();

  // WebGPU first — it is the entire point of the on-device claim. Fall back
  // rather than fail, because some judging laptops will not have it, but
  // record which path ran so the latency number is never misattributed.
  try {
    if (!navigator.gpu) throw new Error("navigator.gpu unavailable");
    // Ask for an adapter explicitly: navigator.gpu can exist while adapter
    // request still fails on a blocklisted driver, and the failure surfaces
    // much more clearly here than deep inside ORT.
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no WebGPU adapter (driver blocklisted?)");

    detector = await pipeline("object-detection", MODEL_ID, {
      device: "webgpu",
      dtype: "fp32", // q8 on WebGPU still has rough edges in ORT Web
    });
    executionProvider = "webgpu";
  } catch (gpuErr) {
    console.warn("[PrivyBrowse] WebGPU unavailable, falling back to WASM:", gpuErr.message);
    metrics.recordError("webgpu-init", gpuErr);
    try {
      detector = await pipeline("object-detection", MODEL_ID, {
        device: "wasm",
        dtype: "q8", // quantised is a big win on the CPU path
      });
      executionProvider = "wasm";
    } catch (wasmErr) {
      loadError = `both backends failed: webgpu=${gpuErr.message} wasm=${wasmErr.message}`;
      metrics.recordError("wasm-init", wasmErr);
      return { ok: false, error: loadError };
    }
  }

  metrics.modelLoadMs = performance.now() - t0;
  metrics.executionProvider = executionProvider;
  modelReady = true;
  metrics.sampleResources("after-model-load");

  console.log(
    `[PrivyBrowse] model ready on ${executionProvider} in ${metrics.modelLoadMs.toFixed(0)}ms`
  );

  // Warm the session immediately. The first real inference then hits compiled
  // shaders instead of paying compilation cost in front of an audience.
  await warmUp();

  return { ok: true, executionProvider, loadMs: metrics.modelLoadMs };
}

/**
 * Run one throwaway inference on a blank frame.
 *
 * WebGPU compiles shaders lazily on first use, so without this the first
 * user-visible action is several times slower than every subsequent one.
 * Doing it at load time moves that cost off the demo path.
 */
async function warmUp() {
  try {
    const c = new OffscreenCanvas(640, 640);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, 640, 640);
    const bmp = await createImageBitmap(c);
    const t0 = performance.now();
    await detector(bmp, { threshold: 0.99 });
    console.log(`[PrivyBrowse] warm-up inference: ${(performance.now() - t0).toFixed(0)}ms`);
    bmp.close?.();
  } catch (err) {
    console.warn("[PrivyBrowse] warm-up failed (non-fatal):", err.message);
    metrics.recordError("warmup", err);
  }
}

// ---------------------------------------------------------------------------
// The main pipeline
// ---------------------------------------------------------------------------

/**
 * Take a captured frame plus DOM detections, and return a redacted image.
 *
 * @param dataUrl        raw capture from chrome.tabs.captureVisibleTab
 * @param domBoxes       DOM detections ALREADY in capture-pixel space
 * @param wantRawPreview HUD only. Gated hard — see the comment at the return.
 */
async function processFrame({ dataUrl, domBoxes = [], wantRawPreview = false }) {
  const timer = metrics.newFrame();
  let bitmap = null;

  try {
    // --- decode ---
    timer.start(STAGES.DECODE);
    const rawBlob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(rawBlob);
    timer.end(STAGES.DECODE);

    const W = bitmap.width;
    const H = bitmap.height;

    // --- inference ---
    let visionBoxes = [];
    let visionHealthy = false;

    if (modelReady) {
      try {
        timer.start(STAGES.INFERENCE);
        const raw = await detector(bitmap, { threshold: DETECTION_THRESHOLD });
        timer.end(STAGES.INFERENCE);

        timer.start(STAGES.POSTPROCESS);
        // Transformers.js already undoes the letterbox and returns boxes in
        // source-image pixels, so no modelToCapture() call is needed on this
        // path. normalizeDetections still runs to guard against a future
        // switch to raw ORT, where that assumption stops holding.
        const all = normalizeDetections(raw, W, H);
        visionBoxes = all.filter((d) => SENSITIVE_VISION_CLASSES.has(d.label));
        timer.end(STAGES.POSTPROCESS);

        visionHealthy = true;
      } catch (err) {
        // Do NOT set visionHealthy. produceRedactedBlob will then refuse to
        // emit anything, which is the fail-closed behaviour we want: a frame
        // masked by DOM alone could still contain a face or a photographed ID.
        timer.end(STAGES.INFERENCE);
        metrics.recordError("inference", err);
        console.error("[PrivyBrowse] inference failed — failing closed:", err);
      }
    }

    // --- merge ---
    timer.start(STAGES.MERGE);
    const masks = mergeBoxes(domBoxes, visionBoxes);
    timer.end(STAGES.MERGE);

    // --- composite + encode ---
    timer.start(STAGES.COMPOSITE);
    const redacted = await produceRedactedBlob(bitmap, masks, {
      visionHealthy,
      type: "image/jpeg",
      quality: 0.85,
    });
    timer.end(STAGES.COMPOSITE);

    timer.start(STAGES.ENCODE);
    const redactedDataUrl = await blobToDataURL(redacted.blob);
    timer.end(STAGES.ENCODE);

    timer
      .set("executionProvider", executionProvider)
      .set("maskCount", masks.length)
      .set("domBoxes", domBoxes.length)
      .set("visionBoxes", visionBoxes.length)
      .set("frameSize", `${W}x${H}`);

    metrics.record(timer);
    metrics.logLast();

    return {
      ok: true,
      redactedDataUrl,
      // The raw frame is returned ONLY for the local side-by-side HUD, and
      // never travels further than the extension's own UI. It is deliberately
      // a separate field from redactedDataUrl so that no server-bound code
      // path can pick it up by accident.
      rawDataUrl: wantRawPreview ? dataUrl : undefined,
      masks: masks.map((m) => ({
        rect: m.rect, source: m.source, kind: m.kind,
        confidence: m.confidence, reason: m.reason, style: m.style,
      })),
      timing: timer.toJSON(),
      executionProvider,
      visionHealthy,
    };
  } catch (err) {
    metrics.recordError("processFrame", err);
    return {
      ok: false,
      failClosed: err instanceof RedactionError,
      error: String(err.message || err),
      executionProvider,
    };
  } finally {
    bitmap?.close?.();
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  (async () => {
    switch (msg.type) {
      case "INIT":
        sendResponse(await loadModel());
        break;

      case "PROCESS_FRAME":
        if (!modelReady && !loadError) await loadModel();
        sendResponse(await processFrame(msg.payload || {}));
        break;

      case "GET_METRICS":
        sendResponse({ ok: true, metrics: metrics.export() });
        break;

      case "GET_STATUS":
        sendResponse({
          ok: true, modelReady, executionProvider,
          loadError, modelId: MODEL_ID,
          modelLoadMs: metrics.modelLoadMs,
        });
        break;

      default:
        sendResponse({ ok: false, error: `unknown offscreen message: ${msg.type}` });
    }
  })();

  return true; // keep the channel open for the async response
});

// Begin loading as soon as the document exists, so the model is warm before
// the user's first click rather than after it.
loadModel();
metrics.startResourceSampling(2000);

console.log("[PrivyBrowse] offscreen inference host started");
