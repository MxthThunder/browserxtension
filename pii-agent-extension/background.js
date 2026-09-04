/**
 * Background Service Worker (Manifest V3)
 * 
 * Central coordinator for:
 * 1. Offscreen WebGPU document lifecycle.
 * 2. Tab screenshot capture and DOM coordinate aggregation.
 * 3. Toolbar badge counters and context menus.
 * 4. Closed-loop agent execution with FastAPI VLM server.
 * 5. Persistent audit logging and settings synchronization.
 */

import { getSettings, saveSettings, logAuditEntry, DEFAULT_SETTINGS } from "./storage.js";
import { agentLoop } from "./agent_loop.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

// Ensure offscreen document exists for WebGPU inference and canvas redaction
async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["BLOBS"],
    justification: "Client-side WebGPU vision inference and zero-leakage canvas redaction",
  });
  console.log("[Background] Offscreen WebGPU document initialized.");
}

// Installation & Update Hook
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Background] Extension installed/updated:", details.reason);
  await ensureOffscreenDocument();

  // Initialize context menus
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "menu_inspect_pii",
      title: "🛡️ Highlight Sensitive PII on Page",
      contexts: ["page", "selection", "editable"],
    });
    chrome.contextMenus.create({
      id: "menu_open_hub",
      title: "🚀 Open Visual Privacy Hub (Popup)",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "menu_toggle_protection",
      title: "🔒 Toggle Protection for this Tab",
      contexts: ["page"],
    });
  });
});

// Handle Context Menu Clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === "menu_inspect_pii") {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_DOM" });
    } catch (e) {
      console.warn("Could not highlight DOM:", e);
    }
  } else if (info.menuItemId === "menu_open_hub") {
    // Open popup or side panel
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } else if (info.menuItemId === "menu_toggle_protection") {
    const settings = await getSettings();
    await saveSettings({ enabled: !settings.enabled });
    updateBadge(!settings.enabled);
  }
});

// Handle Keyboard Shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  const settings = await getSettings();
  if (command === "toggle-protection") {
    const newState = !settings.enabled;
    await saveSettings({ enabled: newState });
    updateBadge(newState);
  } else if (command === "capture-sanitize") {
    try {
      await captureAndRedactActiveTab();
    } catch (e) {
      console.error("Shortcut capture error:", e);
    }
  }
});

function updateBadge(enabled, piiCount = 0) {
  if (!enabled) {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  } else {
    chrome.action.setBadgeText({ text: piiCount > 0 ? `${piiCount}` : "ON" });
    chrome.action.setBadgeBackgroundColor({ color: piiCount > 0 ? "#ef4444" : "#10b981" });
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Checks if a domain is on the user's exclusion/allowlist.
 */
function isDomainWhitelisted(url, whitelist = []) {
  if (!url || !Array.isArray(whitelist) || whitelist.length === 0) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return whitelist.some((w) => hostname === w.toLowerCase() || hostname.endsWith("." + w.toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * Executes zero-leakage capture and client-side redaction pipeline.
 */
async function captureAndRedactActiveTab(options = {}) {
  const settings = await getSettings();
  const tab = await getActiveTab();

  if (!tab || !tab.id) {
    throw new Error("No active tab found to capture.");
  }

  // Check domain allowlist
  if (isDomainWhitelisted(tab.url, settings.domainWhitelist)) {
    console.log("[Background] Domain is whitelisted, skipping visual redaction:", tab.url);
  }

  // 1. Fetch live DOM PII boxes from the active tab's content script
  let domData = { boxes: [], viewport: { width: 1, height: 1, devicePixelRatio: 1 } };
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
    if (response && response.ok) {
      domData = response;
    }
  } catch (err) {
    console.warn("[Background] Could not contact content script on tab:", err.message);
  }

  // Update badge with detected PII count
  updateBadge(settings.enabled, (domData.boxes || []).length);

  // 2. Capture tab screenshot
  const screenshotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 90,
  });

  // 3. Ensure offscreen document is ready
  await ensureOffscreenDocument();

  // 4. Send to offscreen engine for WebGPU inference + Canvas Redaction
  const mergedOptions = {
    threshold: settings.detectionConfidence,
    faceProxyPct: settings.faceProxyPercent,
    engineMode: settings.engineMode,
    categories: settings.categories,
    failClosed: settings.failClosed,
    ...options,
  };

  const result = await chrome.runtime.sendMessage({
    type: "PROCESS_FRAME",
    payload: {
      screenshotUrl,
      domBoxes: domData.boxes || [],
      interactiveElements: domData.interactiveElements || [],
      viewport: domData.viewport || { width: 1, height: 1, devicePixelRatio: 1 },
      options: mergedOptions,
      url: tab.url || "",
    },
  });

  if (!result || !result.ok) {
    if (settings.failClosed) {
      throw new Error(`Zero-Leakage Guarantee: Redaction failed (${result?.error || "Unknown"}). Execution blocked.`);
    }
  }

  // 5. Record compliance audit entry
  if (result && result.ok) {
    await logAuditEntry({
      url: tab.url,
      tabTitle: tab.title,
      redactionsCount: (result.redactionList || []).length,
      redactionManifest: result.redactionList || [],
      backend: result.activeBackend || "WebGPU",
      latencyMs: result.timings?.totalRedactionLatencyMs || 0,
      breakdown: result.timings || {},
    });
  }

  return {
    ...result,
    tabId: tab.id,
    tabTitle: tab.title,
    tabUrl: tab.url,
  };
}

/**
 * Closed-loop agent execution with FastAPI VLM Server.
 */
async function executeTaskWithServer(task, options = {}) {
  const settings = await getSettings();
  const startTime = performance.now();

  // 1. Capture and redact locally on client
  const captureResult = await captureAndRedactActiveTab(options);
  if (!captureResult || !captureResult.ok) {
    throw new Error("Client canvas redaction failed: " + (captureResult?.error || "Unknown"));
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
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) {
    headers["Authorization"] = `Bearer ${settings.apiKey}`;
  }

  const endpoint = settings.serverUrl || "http://127.0.0.1:8001/api/act";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
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

  const totalCycleLatencyMs = performance.now() - startTime;

  return {
    ok: true,
    task,
    action: serverResult.action,
    serverAudit: serverResult.audit,
    clientTimings: captureResult.timings,
    totalCycleLatencyMs,
    executionResult,
    redactionCount: (captureResult.redactionList || []).length,
    backend: captureResult.activeBackend,
  };
}

// Runtime Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_AND_REDACT") {
    captureAndRedactActiveTab(message.options)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "START_AGENT_LOOP") {
    agentLoop.runLoop(message.task, message.options, (stepData) => {
      // Broadcast step event to open popup or HUD
      chrome.runtime.sendMessage({
        type: "AGENT_LOOP_STEP_EVENT",
        step: stepData
      }).catch(() => {});
    })
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "STOP_AGENT_LOOP") {
    agentLoop.stop();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "DISPATCH_TASK") {
    executeTaskWithServer(message.task, message.options)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "OPEN_POPUP") {
    if (chrome.sidePanel && chrome.sidePanel.open && sender.tab) {
      chrome.sidePanel.open({ tabId: sender.tab.id });
    }
    sendResponse({ ok: true });
    return true;
  }

  return true;
});
