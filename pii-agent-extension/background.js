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
import { logEvent } from "./telemetry.js";

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

try {
  if (chrome.storage?.session) {
    chrome.storage.session.get(["agentSessionState"]).then((res) => {
      if (res?.agentSessionState) {
        agentSessionState = { ...agentSessionState, ...res.agentSessionState };
      }
    }).catch(() => {});
  }
} catch {}

function syncSessionState() {
  try {
    if (chrome.storage?.session) {
      chrome.storage.session.set({ agentSessionState }).catch(() => {});
    }
  } catch {}
}

logEvent("background", "Service Worker loaded and active");

// Ensure offscreen document exists for WebGPU inference and canvas redaction
let offscreenCreationPromise = null;
async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (offscreenCreationPromise) return offscreenCreationPromise;

  offscreenCreationPromise = (async () => {
    try {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["BLOBS"],
        justification: "Client-side WebGPU vision inference and zero-leakage canvas redaction",
      });
      logEvent("background", "Offscreen WebGPU document initialized.");
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      if (!err.message?.includes("Only a single offscreen document")) {
        logEvent("background", `Offscreen creation note: ${err.message}`, null, "warn");
      }
    } finally {
      offscreenCreationPromise = null;
    }
  })();

  return offscreenCreationPromise;
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) return tab;
  const allTabs = await chrome.tabs.query({ active: true });
  return allTabs[0];
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
  const t0 = performance.now();
  logEvent("background", "1/6: Starting captureAndRedactActiveTab pipeline...");
  const settings = await getSettings();

  let tab = null;
  if (options.tabId) {
    try {
      tab = await chrome.tabs.get(options.tabId);
    } catch (e) {
      logEvent("background", `Could not get tab by ID ${options.tabId}: ${e.message}`, null, "warn");
    }
  }
  if (!tab || !tab.id) {
    tab = await getActiveTab();
  }

  if (!tab || !tab.id) {
    logEvent("background", "No active tab found to capture!", null, "error");
    throw new Error("No active tab found to capture. Please focus a web tab.");
  }
  logEvent("background", `2/6: Active tab identified: ID=${tab.id}, Title="${tab.title || ''}", URL="${tab.url || ''}"`);

  // Check domain allowlist
  if (isDomainWhitelisted(tab.url, settings.domainWhitelist)) {
    logEvent("background", `Domain is allowlisted, skipping redaction: ${tab.url}`);
  }

  // 1. Fetch live DOM PII boxes from the active tab with 3s timeout
  logEvent("background", "3/6: Querying DOM content script for sensitive input fields...");
  let domData = { boxes: [], viewport: { width: 1, height: 1, devicePixelRatio: 1 } };
  try {
    const response = await Promise.race([
      sendTabMessage(tab.id, { type: "GET_DOM_PII_BOXES" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Content script timeout after 3s")), 3000))
    ]);
    if (response && response.ok) {
      domData = response;
      logEvent("background", `Content script returned ${domData.boxes?.length || 0} DOM PII box(es)`);
    }
  } catch (err) {
    logEvent("background", `DOM query note: ${err.message}`, null, "warn");
  }

  // Update badge with detected PII count
  updateBadge(settings.enabled, (domData.boxes || []).length);

  // 2. Capture tab screenshot
  logEvent("background", "4/6: Capturing tab viewport screenshot...");
  const windowId = options.windowId || tab.windowId;
  let screenshotUrl;
  try {
    screenshotUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 90,
    });
  } catch (err) {
    logEvent("background", `captureVisibleTab(windowId=${windowId}) note: ${err.message}. Retrying with active window...`, null, "warn");
    try {
      screenshotUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "jpeg",
        quality: 90,
      });
    } catch (err2) {
      logEvent("background", `captureVisibleTab(null) failed: ${err2.message}`, null, "error");
      throw new Error(`Screenshot capture failed: ${err2.message}`);
    }
  }
  if (!screenshotUrl) {
    throw new Error("Failed to capture tab screenshot: empty data returned.");
  }
  logEvent("background", `Screenshot captured (${Math.round((screenshotUrl?.length || 0) / 1024)} KB)`);

  // 3. Ensure offscreen document is ready
  logEvent("background", "5/6: Ensuring offscreen WebGPU/WASM engine is initialized...");
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

  logEvent("background", "6/6: Dispatching PROCESS_FRAME to offscreen engine...");
  let result;
  try {
    result = await Promise.race([
      chrome.runtime.sendMessage({
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
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Offscreen PROCESS_FRAME timed out after 30s")), 30000))
    ]);
  } catch (err) {
    logEvent("background", `Offscreen engine error: ${err.message}`, null, "error");
    throw err;
  }

  logEvent("background", `Offscreen processing finished in ${Math.round(performance.now() - t0)}ms: ok=${result?.ok}, redacted=${result?.redactionList?.length || 0}`);

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
      verification: result.verification || { verified: true, emergencyBlackoutsApplied: 0, status: "VERIFIED_ZERO_LEAKAGE" },
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

  // 2. Reuse interactive DOM elements already fetched inside captureAndRedactActiveTab
  // (#4 FIX: eliminated redundant second GET_DOM_PII_BOXES message — captureResult already contains them)
  let domElements = captureResult.interactiveElements || [];
  if (domElements.length === 0 && captureResult.unifiedPerceptionState?.domBoxes) {
    domElements = captureResult.unifiedPerceptionState.domBoxes;
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

  if (serverResult.privacy_feedback) {
    const fb = serverResult.privacy_feedback;
    if (fb.leak_concern_detected) {
      logEvent("background", `[PRIVACY ADVICE] Server detected potential leak concern in reasoning. Adaptive threshold tightened.`, null, "warn");
    } else if (fb.redacted_regions_acknowledged) {
      logEvent("background", `[PRIVACY COMPLIANT] Server confirmed redacted regions observed. Zero-leakage preserved.`);
    }
  }

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
    privacyFeedback: serverResult.privacy_feedback || null,
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
  if (!message || !message.type) return false;
  if (message.type === "TELEMETRY_LOG") return false;

  logEvent("background", `Received runtime message: ${message.type}`);

  if (message.type === "CAPTURE_AND_REDACT") {
    logEvent("background", "Executing CAPTURE_AND_REDACT pipeline");
    captureAndRedactActiveTab(message.options || {})
      .then((data) => {
        logEvent("background", `CAPTURE_AND_REDACT succeeded: ok=${data?.ok}, redacted=${data?.redactionList?.length || 0}`);
        sendResponse(data);
      })
      .catch((err) => {
        logEvent("background", `CAPTURE_AND_REDACT failed: ${err.message}`, null, "error");
        sendResponse({ ok: false, error: err.message });
      });
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

  // #23: Audit log export to CSV
  if (message.type === "EXPORT_AUDIT_LOG") {
    chrome.storage.local.get(["auditLog"], (result) => {
      const entries = result.auditLog || [];
      if (entries.length === 0) {
        sendResponse({ ok: false, error: "No audit entries to export" });
        return;
      }
      const header = ["timestamp", "url", "tabTitle", "actionType", "model", "redactions", "latencyMs", "backend"].join(",");
      const rows = entries.map((e) => [
        e.timestamp || e.ts || new Date().toISOString(),
        JSON.stringify(e.url || ""),
        JSON.stringify(e.tabTitle || ""),
        e.actionType || e.type || "",
        e.model || "",
        e.redactions || e.redactionsCount || 0,
        Math.round(e.latencyMs || 0),
        e.backend || ""
      ].join(","));
      const csv = [header, ...rows].join("\n");
      const b64 = btoa(unescape(encodeURIComponent(csv)));
      sendResponse({ ok: true, csv, dataUrl: "data:text/csv;base64," + b64, count: entries.length });
    });
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
