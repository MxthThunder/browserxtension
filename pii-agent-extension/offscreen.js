/**
 * Day 3: Offscreen Vision & Redaction Engine
 * 
 * Runs client-side Vision Transformer (Xenova/yolos-tiny) on WebGPU
 * (with WASM fallback) and performs zero-leakage canvas-level redaction
 * before sanitized pixels ever leave the browser boundary.
 */

import { pipeline, env } from "./lib/transformers.min.js";

// Point WASM assets to local extension lib folder
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("lib/");

const canvas = document.getElementById("offscreenCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const rawCanvas = document.getElementById("rawCanvas");
const rawCtx = rawCanvas.getContext("2d");

let detector = null;
let activeBackend = "WASM";
let isModelLoading = false;
let modelLoadPromise = null;

async function initModel() {
  if (detector) return detector;
  if (modelLoadPromise) return modelLoadPromise;

  isModelLoading = true;
  modelLoadPromise = (async () => {
    console.log("[Offscreen] Initializing Vision Model...");
    try {
      if (!navigator.gpu) throw new Error("navigator.gpu not available in this context");
      console.log("[Offscreen] Attempting WebGPU backend...");
      detector = await pipeline("object-detection", "Xenova/yolos-tiny", { device: "webgpu" });
      activeBackend = "WebGPU";
      console.log("[Offscreen] Successfully initialized with WebGPU!");
    } catch (gpuErr) {
      console.warn("[Offscreen] WebGPU failed, falling back to WASM:", gpuErr.message);
      detector = await pipeline("object-detection", "Xenova/yolos-tiny", { device: "wasm" });
      activeBackend = "WASM";
      console.log("[Offscreen] Initialized with WASM fallback.");
    }
    isModelLoading = false;
    return detector;
  })();

  return modelLoadPromise;
}

// Pre-initialize model on load
initModel().catch((err) => console.error("[Offscreen] Model init error:", err));

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error("Failed to decode image data URL: " + e));
    img.src = url;
  });
}

/**
 * Merges DOM-based sensitive boxes and Vision model detections,
 * paints them with blackout/blur directly onto the canvas,
 * and extracts ONLY the sanitized image.
 */
async function processAndRedactFrame(payload) {
  const {
    screenshotUrl,
    domBoxes = [],
    viewport = { width: 1, height: 1 },
    options = { faceProxyPct: 0.30, threshold: 0.5 },
  } = payload;

  const model = await initModel();
  const img = await loadImage(screenshotUrl);

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  // Set up canvases
  canvas.width = width;
  canvas.height = height;
  rawCanvas.width = width;
  rawCanvas.height = height;

  // Draw raw image onto rawCanvas (for local HUD side-by-side inspection ONLY)
  rawCtx.drawImage(img, 0, 0, width, height);

  // Draw onto the sanitization canvas
  ctx.drawImage(img, 0, 0, width, height);

  // 1. Run local Vision model inference
  const startInference = performance.now();
  let visionDetections = [];
  try {
    visionDetections = await model(screenshotUrl, { threshold: options.threshold || 0.5 });
  } catch (infErr) {
    console.warn("[Offscreen] Vision detection error:", infErr);
  }
  const inferenceLatencyMs = performance.now() - startInference;

  // Compute scale factor between DOM viewport coordinates and screenshot pixels (HiDPI / DPR)
  const scaleX = width / (viewport.width || width);
  const scaleY = height / (viewport.height || height);

  const finalRedactionBoxes = [];

  // 2. Add DOM-based PII boxes
  domBoxes.forEach((box) => {
    const scaledX = Math.round(box.x * scaleX);
    const scaledY = Math.round(box.y * scaleY);
    const scaledW = Math.round(box.width * scaleX);
    const scaledH = Math.round(box.height * scaleY);

    finalRedactionBoxes.push({
      source: "DOM",
      label: box.reason || "DOM PII",
      tag: box.tag,
      x: scaledX,
      y: scaledY,
      w: Math.max(scaledW, 10),
      h: Math.max(scaledH, 10),
    });
  });

  // 3. Process Vision model detections (Day 2/3 face proxy)
  const visionBoxesWithProxy = [];
  visionDetections.forEach((det) => {
    const { xmin, ymin, xmax, ymax } = det.box;
    const w = xmax - xmin;
    const h = ymax - ymin;

    visionBoxesWithProxy.push({
      label: det.label,
      score: det.score,
      box: det.box,
    });

    // If person detected, redact upper 30% face proxy
    if (det.label === "person") {
      const faceHeight = Math.round(h * (options.faceProxyPct || 0.30));
      finalRedactionBoxes.push({
        source: "VISION_FACE_PROXY",
        label: "FACE PROXY (~30%)",
        x: Math.round(xmin),
        y: Math.round(ymin),
        w: Math.round(w),
        h: Math.max(faceHeight, 10),
        score: det.score,
      });
    } else if (["cell phone", "laptop", "book"].includes(det.label)) {
      // Optional flag for sensitive physical display objects
      finalRedactionBoxes.push({
        source: "VISION_OBJECT",
        label: `OBJECT: ${det.label.toUpperCase()}`,
        x: Math.round(xmin),
        y: Math.round(ymin),
        w: Math.round(w),
        h: Math.round(h),
        score: det.score,
      });
    }
  });

  // 4. Paint Redactions directly onto the sanitization canvas (Zero-Leakage)
  ctx.save();
  finalRedactionBoxes.forEach((item) => {
    // Solid Blackout Box
    ctx.fillStyle = "rgba(10, 10, 15, 0.95)";
    ctx.fillRect(item.x, item.y, item.w, item.h);

    // High-visibility neon border
    ctx.lineWidth = 2;
    if (item.source === "DOM") {
      ctx.strokeStyle = "#ff3b3b"; // Red for DOM PII (passwords, cards)
    } else if (item.source === "VISION_FACE_PROXY") {
      ctx.strokeStyle = "#eab308"; // Amber for Face Proxy
    } else {
      ctx.strokeStyle = "#38bdf8"; // Cyan for Objects
    }
    ctx.strokeRect(item.x, item.y, item.w, item.h);

    // Label tag
    const badgeText = `[REDACTED: ${item.label.slice(0, 24)}]`;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "bold 11px monospace";
    ctx.fillText(badgeText, item.x + 4, item.y + 14);
  });
  ctx.restore();

  // 5. Draw visual bounding outlines on rawCanvas for HUD inspection
  rawCtx.save();
  finalRedactionBoxes.forEach((item) => {
    rawCtx.lineWidth = 2;
    rawCtx.strokeStyle = item.source === "DOM" ? "#ff3b3b" : (item.source === "VISION_FACE_PROXY" ? "#eab308" : "#38bdf8");
    rawCtx.strokeRect(item.x, item.y, item.w, item.h);
    rawCtx.fillStyle = rawCtx.strokeStyle;
    rawCtx.font = "bold 12px monospace";
    rawCtx.fillText(item.label, item.x, Math.max(item.y - 4, 12));
  });
  rawCtx.restore();

  // Export Sanitized DataURL (The actual zero-leakage payload)
  const sanitizedImageUrl = canvas.toDataURL("image/jpeg", 0.85);
  // Export Raw DataURL with overlay boxes for local HUD inspection only
  const inspectedRawImageUrl = rawCanvas.toDataURL("image/jpeg", 0.85);

  return {
    ok: true,
    backend: activeBackend,
    inferenceLatencyMs: Number(inferenceLatencyMs.toFixed(1)),
    timestamp: new Date().toISOString(),
    resolution: { width, height },
    domBoxesCount: domBoxes.length,
    visionDetectionsCount: visionDetections.length,
    totalRedactionsCount: finalRedactionBoxes.length,
    redactionList: finalRedactionBoxes,
    visionDetections: visionBoxesWithProxy,
    sanitizedImageUrl, // Sent to server
    inspectedRawImageUrl, // Displayed in local HUD
  };
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING_OFFSCREEN") {
    sendResponse({
      ok: true,
      ready: detector !== null,
      loading: isModelLoading,
      backend: activeBackend,
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
    return true; // Keep channel open for async response
  }

  return true;
});
