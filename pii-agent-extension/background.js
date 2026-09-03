/**
 * Background Service Worker (Manifest V3)
 * 
 * Coordinates between active tab (DOM PII coordinates),
 * tab capture (visible viewport screenshot),
 * and the offscreen WebGPU document for zero-leakage redaction.
 */

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["BLOBS"],
    justification: "Client-side WebGPU vision inference and canvas redaction",
  });
  console.log("[Background] Offscreen document created.");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function captureAndRedactActiveTab(options = {}) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    throw new Error("No active tab found to capture.");
  }

  // 1. Fetch live DOM PII boxes from the active tab's content script
  let domData = { boxes: [], viewport: { width: 1, height: 1 } };
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
    if (response && response.ok) {
      domData = response;
    }
  } catch (err) {
    console.warn("[Background] Could not contact content script on tab:", err.message);
  }

  // 2. Capture tab screenshot
  const screenshotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 90,
  });

  // 3. Ensure offscreen document is active
  await ensureOffscreenDocument();

  // 4. Send to offscreen engine for WebGPU inference + Canvas Redaction
  const result = await chrome.runtime.sendMessage({
    type: "PROCESS_FRAME",
    payload: {
      screenshotUrl,
      domBoxes:       domData.boxes          || [],
      visualElements: domData.visualElements || [], // <img>/<canvas>/<video> for targeted OCR
      viewport:       domData.viewport       || { width: 1, height: 1 },
      options,
    },
  });

  return {
    ...result,
    tabId: tab.id,
    tabTitle: tab.title,
    tabUrl: tab.url,
  };
}

// Handle runtime messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_AND_REDACT") {
    captureAndRedactActiveTab(message.options)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Day 4: Full closed-loop task execution with server
  if (message.type === "DISPATCH_TASK") {
    executeTaskWithServer(message.task, message.options)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "OPEN_HUD") {
    const hudUrl = chrome.runtime.getURL("hud.html");
    chrome.tabs.query({ url: hudUrl }, (tabs) => {
      if (tabs && tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true });
      } else {
        chrome.tabs.create({ url: hudUrl });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  return true;
});

const SERVER_ENDPOINT = "http://127.0.0.1:8001/api/act";

async function executeTaskWithServer(task, options = {}) {
  // 1. Capture and redact locally on client
  const captureResult = await captureAndRedactActiveTab(options);
  if (!captureResult || !captureResult.ok) {
    throw new Error("Local canvas redaction failed: " + (captureResult?.error || "Unknown"));
  }

  // 2. Fetch interactive DOM elements from active tab
  let domElements = [];
  try {
    const tab = await getActiveTab();
    const domResponse = await chrome.tabs.sendMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
    if (domResponse?.interactiveElements) {
      domElements = domResponse.interactiveElements;
    }
  } catch (e) {
    console.warn("[Background] Could not fetch interactive elements:", e);
  }

  // 3. Prepare sanitized payload for FastAPI server (Zero-Leakage)
  const payload = {
    task,
    sanitized_image_base64: captureResult.sanitizedImageUrl,
    dom_elements: domElements,
    redaction_manifest: (captureResult.redactionList || []).map((r) => ({
      source: r.source,
      label: r.label,
      box: [r.x, r.y, r.w, r.h],
    })),
    viewport: captureResult.resolution,
    url: captureResult.tabUrl,
  };

  // 4. Send to server VLM endpoint
  const resp = await fetch(SERVER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`Server returned HTTP ${resp.status}: ${await resp.text()}`);
  }

  const serverResult = await resp.json();

  // 5. Execute returned action on active tab
  let executionResult = null;
  if (serverResult.action && serverResult.action.type !== "finish") {
    const tab = await getActiveTab();
    executionResult = await chrome.tabs.sendMessage(tab.id, {
      type: "EXECUTE_ACTION",
      action: serverResult.action,
    });
  }

  return {
    ok: true,
    task,
    captureResult,
    serverResult,
    executionResult,
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Background] Visual Perception Privacy Agent installed.");
  await ensureOffscreenDocument().catch(console.error);
});
