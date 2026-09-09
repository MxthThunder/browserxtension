/**
 * background.js — service worker. A ROUTER, not a worker.
 *
 * Deliberately contains no model, no canvas, and no heavy state. Under MV3
 * this process is killed after ~30s idle; anything expensive living here gets
 * rebuilt constantly and wrecks the latency numbers. Its whole job:
 *
 *   popup/content  ->  [ensure offscreen doc exists]  ->  offscreen  ->  back
 *
 * The one piece of real logic is capture, because chrome.tabs.captureVisibleTab
 * is only callable from an extension process, not from a content script.
 */

const OFFSCREEN_PATH = "src/offscreen.html";

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

let creatingOffscreen = null; // in-flight promise guard

/**
 * Ensure exactly one offscreen document exists.
 *
 * The guard matters: two rapid clicks both see "no document", both call
 * createDocument, and the second throws "Only a single offscreen document may
 * be created". Sharing the in-flight promise makes concurrent callers await
 * the same creation.
 */
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // DOM_SCRAPING is the closest documented justification for "I need a DOM
    // and a canvas to process an image". There is no ML-specific reason yet.
    reasons: ["DOM_SCRAPING"],
    justification:
      "Runs the local vision model and composites PII redactions onto captured " +
      "frames before any data leaves the device. Requires DOM/canvas and WebGPU, " +
      "neither of which is available in the service worker.",
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function callOffscreen(type, payload, { timeoutMs = 30000 } = {}) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    // Without a timeout, a wedged offscreen document leaves the popup spinning
    // with no explanation — the worst thing to debug live.
    const timer = setTimeout(
      () => resolve({ ok: false, error: `offscreen timeout after ${timeoutMs}ms (${type})` }),
      timeoutMs
    );
    chrome.runtime.sendMessage({ target: "offscreen", type, payload }, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res ?? { ok: false, error: "empty response from offscreen" });
    });
  });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture the visible tab.
 *
 * NOTE ON THE UPGRADE PATH: captureVisibleTab is viewport-only and rate
 * limited to roughly two calls per second, which is fine for the click-driven
 * demo but CANNOT drive a live video-rate HUD. If you want the HUD updating
 * continuously, switch to chrome.tabCapture.getMediaStreamId + getUserMedia
 * inside the offscreen document. That is a different plumbing job — decide
 * before Day 6, not during it.
 */
async function captureTab(windowId) {
  const t0 = performance.now();
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality: 92, // source quality; the redacted output is re-encoded at 85
  });
  return { dataUrl, captureMs: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * The full client-side pipeline for one frame:
 *   content script scan -> capture -> offscreen inference+redaction -> result
 *
 * Ordering note: the DOM scan runs BEFORE the capture, and returns the
 * viewport context (dpr + scroll) measured at scan time. If we captured first
 * and measured after, a scroll between the two would shift every mask.
 */
async function runPipeline(tab, { wantRawPreview = false } = {}) {
  // 1. DOM scan in the page
  const scan = await sendToTab(tab.id, { type: "SCAN_FOR_PAYLOAD" });
  if (!scan?.ok) {
    return { ok: false, error: scan?.error || "content script unreachable (reload the page)" };
  }

  // 2. Capture
  const { dataUrl, captureMs } = await captureTab(tab.windowId);

  // 3. Inference + redaction, in the offscreen document
  const result = await callOffscreen("PROCESS_FRAME", {
    dataUrl,
    domBoxes: scan.domBoxes,
    wantRawPreview,
  });

  if (result.ok) {
    result.timing = { ...result.timing, capture: Math.round(captureMs * 100) / 100 };
    result.digest = scan.digest;           // already scrubbed in the content script
    result.digestStats = scan.digestStats;
    result.pageUrl = tab.url;
  }
  return result;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res);
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages aimed at the offscreen document are handled there, not here.
  if (msg?.target === "offscreen") return false;

  (async () => {
    try {
      switch (msg?.type) {
        case "RUN_PIPELINE": {
          const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : await getActiveTab();
          if (!tab) { sendResponse({ ok: false, error: "no active tab" }); break; }
          if (/^(chrome|edge|about|moz-extension|chrome-extension):/.test(tab.url || "")) {
            // Worth an explicit message: content scripts cannot run on browser
            // internal pages, and the resulting silence looks like a crash.
            sendResponse({ ok: false, error: "Cannot run on browser internal pages. Open a normal website." });
            break;
          }
          sendResponse(await runPipeline(tab, { wantRawPreview: msg.wantRawPreview }));
          break;
        }

        case "INIT_MODEL":
          sendResponse(await callOffscreen("INIT", {}, { timeoutMs: 120000 }));
          break;

        case "GET_STATUS":
          sendResponse(await callOffscreen("GET_STATUS"));
          break;

        case "GET_METRICS":
          sendResponse(await callOffscreen("GET_METRICS"));
          break;

        case "OPEN_HUD":
          await chrome.tabs.create({ url: chrome.runtime.getURL("src/hud.html") });
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: `unknown message: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // async response
});

// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[PrivyBrowse] installed");
  // Spin up the offscreen document immediately so the model is loading in the
  // background while the user is still navigating to their demo page.
  try {
    await ensureOffscreen();
  } catch (err) {
    console.warn("[PrivyBrowse] could not pre-create offscreen doc:", err.message);
  }
});
