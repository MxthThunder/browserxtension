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
import { vault } from "./vault.js";
import { semanticRedactor } from "./semantic_redactor.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

// ── Persistent In-Memory Session State (Survives Popup Close/Reopen) ─────────
let agentSessionState = {
  status: "IDLE", // "IDLE" | "RUNNING" | "COMPLETED" | "STOPPED" | "ERROR"
  taskPrompt: "",
  currentStep: 0,
  maxSteps: 8,
  stepsHistory: [],
  latestCapture: null,
  activityLogs: [],
  summary: ""
};

if (chrome.storage?.session) {
  chrome.storage.session.get(["agentSessionState"], (res) => {
    if (res?.agentSessionState) {
      agentSessionState = { ...agentSessionState, ...res.agentSessionState };
    }
  }).catch(() => {});
}

function syncSessionState() {
  if (chrome.storage?.session) {
    chrome.storage.session.set({ agentSessionState }).catch(() => {});
  }
}

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
  // Give offscreen doc a moment to load its scripts before we send messages
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * Sends a message to the offscreen document with a configurable timeout.
 * Prevents the pipeline from hanging if the offscreen doc crashes or hangs.
 */
function sendOffscreenMessage(message, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[Background] Offscreen message '${message.type}' timed out after ${timeoutMs}ms`);
      resolve({ ok: false, error: `Offscreen timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          console.warn("[Background] Offscreen sendMessage error:", chrome.runtime.lastError.message);
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: "Empty offscreen response" });
        }
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    }
  });
}

// Installation & Update Hook
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Background] Extension installed/updated:", details.reason);
  await ensureOffscreenDocument();

  // Initialize the encrypted local vault (device-keyed AES-256-GCM)
  try {
    await vault.init();
    console.log("[Background] Local sensitive vault ready.");
  } catch (err) {
    console.warn("[Background] Vault init failed (first install is normal):", err.message);
  }

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
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  return tab;
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (
      err.message?.includes("Receiving end does not exist") ||
      err.message?.includes("Could not establish connection")
    ) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
        await new Promise((r) => setTimeout(r, 120));
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (injectErr) {
        console.warn("[Background] Could not re-inject content script:", injectErr.message);
      }
    }
    throw err;
  }
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

  // 1. Fetch live DOM PII boxes from the active tab
  let domData = { boxes: [], viewport: { width: 1, height: 1, devicePixelRatio: 1 } };
  try {
    const response = await sendTabMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
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

  // Use timeout-guarded offscreen messaging to prevent eternal hangs
  // First capture may be slow (model loading), subsequent ones are fast
  const result = await sendOffscreenMessage({
    type: "PROCESS_FRAME",
    payload: {
      screenshotUrl,
      domBoxes: domData.boxes || [],
      interactiveElements: domData.interactiveElements || [],
      viewport: domData.viewport || { width: 1, height: 1, devicePixelRatio: 1 },
      options: mergedOptions,
      url: tab.url || "",
      userTask: options.userTask || agentSessionState.taskPrompt || "",
    },
  }, 90000); // 90s to allow first-run OWL-ViT model loading

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

  const returnPayload = {
    ...result,
    tabId: tab.id,
    tabTitle: tab.title,
    tabUrl: tab.url,
  };

  if (result && result.ok) {
    agentSessionState.latestCapture = returnPayload;
    syncSessionState();
  }

  return returnPayload;
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
    if (tab && tab.id) {
      const domResponse = await sendTabMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
      if (domResponse?.interactiveElements) {
        domElements = domResponse.interactiveElements;
      }
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
  // De-anonymize locally before DOM execution (vault tokens + session placeholders)
  let executionResult = null;
  if (serverResult.action && serverResult.action.type !== "finish") {
    const action = serverResult.action;
    let resolvedValue = action.value;
    if (resolvedValue) {
      // Vault tokens
      if (vault.isUnlocked()) {
        resolvedValue = resolvedValue.replace(
          /\{\{VAULT:([a-z0-9_]+)\.([a-z0-9_]+)\}\}/gi,
          (_m, cat, key) => { try { return vault.get(cat, key) ?? _m; } catch { return _m; } }
        );
      }
      // Session placeholders
      resolvedValue = semanticRedactor.deAnonymize(resolvedValue);
    }
    const execAction = { ...action, value: resolvedValue };
    const tab = await getActiveTab();
    if (tab && tab.id) {
      executionResult = await sendTabMessage(tab.id, {
        type: "EXECUTE_ACTION",
        action: execAction,
      });
    }
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

// Broadcast settings changes (from popup or options page) to every open tab
// so content scripts pick up the new protection state immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const newSettings = changes.settings.newValue;
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (!tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_CHANGED", settings: newSettings }).catch(() => {});
    });
  });
});

// Initialize Agent Loop capture handler
agentLoop.setCaptureHandler(captureAndRedactActiveTab);

// Initialize vault once at service-worker start (handles both fresh installs and SW restarts)
vault.init().catch((err) =>
  console.warn("[Background] Vault init at startup:", err?.message)
);

// Runtime Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_AND_REDACT") {
    captureAndRedactActiveTab(message.options || {})
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "START_AGENT_LOOP") {
    agentSessionState.status = "RUNNING";
    agentSessionState.taskPrompt = message.task;
    agentSessionState.currentStep = 0;
    agentSessionState.maxSteps = message.options?.maxSteps || 8;
    agentSessionState.stepsHistory = [];
    agentSessionState.activityLogs = [`Started task: "${message.task}"`];
    agentSessionState.summary = "";
    syncSessionState();

    agentLoop.runLoop(
      message.task,
      { ...message.options, captureFn: captureAndRedactActiveTab },
      (stepData) => {
        agentSessionState.currentStep = stepData.step;
        agentSessionState.stepsHistory.push(stepData);
        if (stepData.sanitizedImage) {
          agentSessionState.latestCapture = {
            sanitizedImageUrl: stepData.sanitizedImage,
            redactionList: stepData.redactionCount ? new Array(stepData.redactionCount).fill({ label: "PII Masked" }) : []
          };
        }
        agentSessionState.activityLogs.push(`Step ${stepData.step}: ${stepData.action?.type || "action"} — ${stepData.action?.explanation || ""}`);
        syncSessionState();

        // Broadcast step event to open popup or HUD
        chrome.runtime.sendMessage({
          type: "AGENT_LOOP_STEP_EVENT",
          step: stepData,
          session: agentSessionState
        }).catch(() => {});
      }
    )
      .then((res) => {
        agentSessionState.status = res.status || "COMPLETED";
        agentSessionState.summary = res.summary || "Task finished.";
        syncSessionState();
        sendResponse({ ok: true, ...res, session: agentSessionState });
      })
      .catch((err) => {
        agentSessionState.status = "ERROR";
        agentSessionState.summary = err.message;
        syncSessionState();
        sendResponse({ ok: false, error: err.message, session: agentSessionState });
      });
    return true;
  }

  if (message.type === "STOP_AGENT_LOOP") {
    agentLoop.stop();
    agentSessionState.status = "STOPPED";
    agentSessionState.summary = "Agent stopped by user.";
    syncSessionState();
    sendResponse({ ok: true, session: agentSessionState });
    return false;
  }

  if (message.type === "GET_AGENT_SESSION_STATE") {
    sendResponse({ ok: true, session: agentSessionState });
    return false;
  }

  if (message.type === "CLEAR_AGENT_SESSION") {
    agentSessionState = {
      status: "IDLE",
      taskPrompt: "",
      currentStep: 0,
      maxSteps: 8,
      stepsHistory: [],
      latestCapture: null,
      activityLogs: [],
      summary: ""
    };
    syncSessionState();
    sendResponse({ ok: true });
    return false;
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
    return false;
  }

  if (message.type === "OPEN_SIDE_PANEL") {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.sidePanel.open({ windowId: tabs[0].windowId })
            .then(() => sendResponse({ ok: true }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
        } else {
          sendResponse({ ok: false, error: "No active window" });
        }
      });
      return true;
    }
    sendResponse({ ok: false, error: "Side panel not supported" });
    return false;
  }

  if (message.type === "OPEN_POPUP") {
    if (chrome.sidePanel && chrome.sidePanel.open && sender.tab) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
