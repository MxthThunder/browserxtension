/**
 * PriviBrowse-X — Air-Gapped Popup Instrumentation Controller
 * ISRO PS #26171 Security & Redaction System
 */

import { getSettings, saveSettings } from "./storage.js";

// ── DOM References ──────────────────────────────────────────
const toggleProtection    = document.getElementById("toggleProtection");
const statusText          = document.getElementById("statusText");
const basicCount          = document.getElementById("basicCount");

const chkAdvanced         = document.getElementById("chkAdvanced");
const advancedPanel       = document.getElementById("advancedPanel");

const taskInput           = document.getElementById("taskInput");
const selModelProvider    = document.getElementById("selModelProvider");
const btnDispatchTask     = document.getElementById("btnDispatchTask");
const btnStopTask         = document.getElementById("btnStopTask");
const lblServerStatus     = document.getElementById("lblServerStatus");
const stepFeed            = document.getElementById("stepFeed");

const btnCapture          = document.getElementById("btnCapture");
const btnHighlightDOM     = document.getElementById("btnHighlightDOM");
const btnAutoSync         = document.getElementById("btnAutoSync");
const lblLiveState        = document.getElementById("lblLiveState");
const btnClearOverlays    = document.getElementById("btnClearOverlays");

const btnViewSanitized    = document.getElementById("btnViewSanitized");
const btnViewRaw          = document.getElementById("btnViewRaw");
const displayImage        = document.getElementById("displayImage");
const viewportPlaceholder = document.getElementById("viewportPlaceholder");
const redactionCountPill  = document.getElementById("redactionCountPill");
const visualRedactionList = document.getElementById("visualRedactionList");

const agentStatusLog      = document.getElementById("agentStatusLog");
const linkOpenOptions     = document.getElementById("linkOpenOptions");
const linkOpenDemo        = document.getElementById("linkOpenDemo");
const btnOpenSidePanel    = document.getElementById("btnOpenSidePanel");
const linkOpenDashboard   = document.getElementById("linkOpenDashboard");

let latestCapture = null;
let activeViewMode = "sanitized";
let autoSyncInterval = null;
let pendingStepRow = null;

// ── Initialization ───────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const settings = await getSettings();

  setProtectionUI(settings.enabled !== false);
  setAdvancedUI(Boolean(settings.uiAdvancedMode));
  if (selModelProvider) selModelProvider.value = settings.modelProvider || "ollama_qwen";

  await probeServerHealth();
  await loadBasicCount();

  // Rehydrate state from background session
  try {
    const sessionResp = await chrome.runtime.sendMessage({ type: "GET_AGENT_SESSION_STATE" });
    if (sessionResp?.ok && sessionResp.session) {
      restoreSessionState(sessionResp.session);
    }
  } catch (err) {
    console.warn("[Popup] Could not fetch session state:", err);
  }
});

function restoreSessionState(session) {
  if (!session) return;

  if (session.taskPrompt && !taskInput.value) {
    taskInput.value = session.taskPrompt;
  }

  if (session.stepsHistory && session.stepsHistory.length > 0) {
    stepFeed.innerHTML = "";
    session.stepsHistory.forEach((s) => {
      const act = s.action || {};
      const privacyPhrase = describePrivacy(s.redactionCount);
      const actionPhrase = describeAction(act);
      const text = privacyPhrase
        ? `${privacyPhrase} // ${actionPhrase}`
        : actionPhrase;
      addStepRow(text, s.error ? "error" : "success");
    });
  }

  if (session.latestCapture) {
    latestCapture = session.latestCapture;
    updateSandboxDisplay();
    updateDetectedList(latestCapture.redactionList || []);
  }

  if (session.activityLogs && session.activityLogs.length > 0) {
    agentStatusLog.innerHTML = "";
    session.activityLogs.forEach((log) => {
      const entry = document.createElement("div");
      entry.className = "log-row";
      entry.textContent = log;
      agentStatusLog.appendChild(entry);
    });
    agentStatusLog.scrollTop = agentStatusLog.scrollHeight;
  }

  if (session.status === "RUNNING") {
    setRunningUI(true);
    clearPendingRow();
    setPendingRow("EVALUATING DOM & VISION SENSITIVITY…");
  } else {
    setRunningUI(false);
    clearPendingRow();
  }
}

function setRunningUI(isRunning) {
  if (isRunning) {
    btnDispatchTask.classList.add("hidden");
    if (btnStopTask) {
      btnStopTask.classList.remove("hidden");
      btnStopTask.disabled = false;
    }
    taskInput.disabled = true;
  } else {
    if (btnStopTask) {
      btnStopTask.classList.add("hidden");
    }
    btnDispatchTask.classList.remove("hidden");
    btnDispatchTask.disabled = false;
    btnDispatchTask.textContent = "EXEC";
    taskInput.disabled = false;
  }
}

async function getActiveWebTab() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id || !tab.url || tab.url.startsWith("chrome://")) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  if (!tab || !tab.url || tab.url.startsWith("chrome://")) {
    const allTabs = await chrome.tabs.query({});
    tab = allTabs.find((t) => t.url && (t.url.startsWith("http://") || t.url.startsWith("https://") || t.url.includes("demo.html"))) || tab;
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
        console.warn("[Popup] Could not re-inject content script:", injectErr.message);
      }
    }
    throw err;
  }
}

// ── Status Readout ───────────────────────────────────────────
async function loadBasicCount() {
  try {
    const tab = await getActiveWebTab();
    if (!tab || !tab.id) throw new Error("no active tab");
    const resp = await sendTabMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
    const n = resp && resp.ok ? (resp.boxes || []).length : 0;
    basicCount.textContent =
      n === 0 ? "0 SENSITIVE NODES DETECTED" : `[${n} SENSITIVE FIELD${n === 1 ? "" : "S"} INTERCEPTED]`;
  } catch {
    basicCount.textContent = "0 SENSITIVE NODES DETECTED";
  }
}

function setProtectionUI(enabled) {
  toggleProtection.dataset.state = enabled ? "on" : "off";
  toggleProtection.setAttribute("aria-pressed", String(enabled));
  statusText.textContent = enabled ? "AIR-GAP ENFORCED" : "INTERCEPT PAUSED";
}

toggleProtection.addEventListener("click", async () => {
  const next = toggleProtection.dataset.state !== "on";
  setProtectionUI(next);
  await saveSettings({ enabled: next });
  appendLog(next ? "AIR-GAP RESUMED // FAIL-CLOSED ACTIVE" : "INTERCEPT SUSPENDED // RAW PASSTHROUGH");
});

// ── Advanced Drawer ──────────────────────────────────────────
function setAdvancedUI(open) {
  chkAdvanced.checked = open;
  advancedPanel.classList.toggle("open", open);
}

chkAdvanced.addEventListener("change", async () => {
  setAdvancedUI(chkAdvanced.checked);
  await saveSettings({ uiAdvancedMode: chkAdvanced.checked });
});

if (selModelProvider) {
  selModelProvider.addEventListener("change", async () => {
    await saveSettings({ modelProvider: selModelProvider.value });
  });
}

function appendLog(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = "log-row";
  const timeStr = new Date().toISOString().substring(11, 19);
  entry.textContent = `[${timeStr}] ${msg}`;
  agentStatusLog.appendChild(entry);
  agentStatusLog.scrollTop = agentStatusLog.scrollHeight;
}

// ── Declassified Receipt Feed Formatting ─────────────────────
function stripModelTag(text) {
  return (text || "").replace(/^\[[^\]]+\]\s*/, "");
}

function describeAction(act = {}) {
  const explanation = stripModelTag(act.explanation);
  if (explanation) return explanation;
  switch (act.type) {
    case "click": return "Dispatched click on DOM selector";
    case "type": return "Injected keystrokes into sanitized input";
    case "scroll": return "Adjusted viewport scroll matrix";
    case "finish": return "Task execution verified and completed";
    default: return "Executed pipeline perception cycle";
  }
}

function describePrivacy(redactionCount = 0) {
  if (!redactionCount) return null;
  return `SHIELDED ${redactionCount} PII REGION${redactionCount === 1 ? "" : "S"}`;
}

function addStepRow(text, state = "success") {
  const row = document.createElement("div");
  row.className = `receipt-row ${state}`;
  const tag = state === "pending" ? "EXEC" : state === "error" ? "HALT" : "SHIELD";
  row.innerHTML = `<span class="receipt-tag">[${tag}]</span><span class="receipt-text"></span>`;
  row.querySelector(".receipt-text").textContent = text;
  stepFeed.appendChild(row);
  stepFeed.scrollTop = stepFeed.scrollHeight;
  return row;
}

function setPendingRow(text) {
  clearPendingRow();
  pendingStepRow = addStepRow(text, "pending");
}

function clearPendingRow() {
  if (pendingStepRow) {
    pendingStepRow.remove();
    pendingStepRow = null;
  }
}

// ── Server Health Probe ──────────────────────────────────────
async function probeServerHealth() {
  const settings = await getSettings();
  const url = settings.serverHealthUrl || "http://127.0.0.1:8001/health";
  try {
    const res = await fetch(url);
    if (res.ok) {
      lblServerStatus.classList.add("hidden");
    } else {
      lblServerStatus.textContent = `LOCAL BRIDGE WARNING: HTTP ${res.status}`;
      lblServerStatus.classList.remove("hidden");
    }
  } catch {
    lblServerStatus.textContent = "BRIDGE OFFLINE // RUN LOCAL BRIDGE ON PORT 8001";
    lblServerStatus.classList.remove("hidden");
  }
}

// ── Viewport Sandbox Preview ─────────────────────────────────
btnViewSanitized.addEventListener("click", () => {
  activeViewMode = "sanitized";
  btnViewSanitized.classList.add("active");
  btnViewRaw.classList.remove("active");
  updateSandboxDisplay();
});

btnViewRaw.addEventListener("click", () => {
  activeViewMode = "raw";
  btnViewRaw.classList.add("active");
  btnViewSanitized.classList.remove("active");
  updateSandboxDisplay();
});

function updateSandboxDisplay() {
  if (!latestCapture) return;
  const url = activeViewMode === "sanitized" ? latestCapture.sanitizedImageUrl : latestCapture.rawImageUrl;
  if (!url) return;
  displayImage.src = url;
  displayImage.style.display = "block";
  viewportPlaceholder.style.display = "none";
}

function updateDetectedList(redactions = []) {
  redactionCountPill.textContent = `${redactions.length} MASKED`;

  visualRedactionList.innerHTML = "";
  if (redactions.length === 0) {
    visualRedactionList.innerHTML = `<div class="empty-hint">NO SENSITIVE ENTITIES CAUGHT IN LAST FRAME</div>`;
    return;
  }

  redactions.forEach((r) => {
    const item = document.createElement("div");
    item.className = "detected-row";
    item.innerHTML = `<span class="detected-cat">[${escapeHtml(r.label || "PII")}]</span><span class="detected-val">${escapeHtml(r.source || "DOM")}</span>`;
    visualRedactionList.appendChild(item);
  });
}

// ── Action Buttons (F1, F2, F3, CLR) ─────────────────────────

// F1: Capture
btnCapture.addEventListener("click", async () => {
  btnCapture.disabled = true;
  const originalHtml = btnCapture.innerHTML;
  btnCapture.innerHTML = `<span class="ctrl-code">F1</span><span class="ctrl-name">MASKING…</span>`;
  appendLog("Perception pipeline triggered (WebGPU + BlazeFace + OCR)…");

  try {
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: "Capture timed out" });
      }, 30000);

      chrome.runtime.sendMessage({ type: "CAPTURE_AND_REDACT", options: {} }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: "Empty response" });
        }
      });
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || "Capture failed");
    }

    latestCapture = result;
    updateSandboxDisplay();
    updateDetectedList(result.redactionList || []);

    const ms = result.timings?.totalRedactionLatencyMs;
    appendLog(
      `SHIELDED ${result.redactionList?.length || 0} region(s)${ms ? ` in ${ms.toFixed(0)}ms` : ""}.`,
      "success"
    );
  } catch (err) {
    appendLog(`Capture error: ${err.message}`, "error");
  } finally {
    btnCapture.disabled = false;
    btnCapture.innerHTML = originalHtml;
  }
});

// F2: Highlight DOM
btnHighlightDOM.addEventListener("click", async () => {
  try {
    const tab = await getActiveWebTab();
    if (!tab || !tab.id) {
      appendLog("No active web tab found.", "error");
      return;
    }
    const resp = await sendTabMessage(tab.id, { type: "HIGHLIGHT_DOM" });
    if (resp && resp.ok) {
      appendLog(`HIGHLIGHTED ${resp.count} PII DOM node(s).`, "success");
    } else {
      appendLog(`Highlight error: ${resp?.error || "Failed"}`, "error");
    }
  } catch (err) {
    appendLog(`Highlight error: ${err.message}`, "error");
  }
});

// CLR: Clear Overlays
btnClearOverlays.addEventListener("click", async () => {
  try {
    const tab = await getActiveWebTab();
    if (!tab || !tab.id) return;
    await sendTabMessage(tab.id, { type: "CLEAR_OVERLAYS" });
    appendLog("CLEARED all visual highlight overlays.", "success");
  } catch (err) {
    appendLog(`Clear error: ${err.message}`, "error");
  }
});

// F3: Live Sync Toggle
btnAutoSync.addEventListener("click", () => {
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
    btnAutoSync.classList.remove("active");
    if (lblLiveState) lblLiveState.textContent = "LIVE";
    appendLog("Live capture loop stopped.");
  } else {
    btnAutoSync.classList.add("active");
    if (lblLiveState) lblLiveState.textContent = "STREAMING";
    appendLog("Live air-gap stream engaged (3s interval).");
    btnCapture.click();
    autoSyncInterval = setInterval(() => btnCapture.click(), 3000);
  }
});

// ── Agent Execution & Halt Controls ──────────────────────────
if (btnStopTask) {
  btnStopTask.addEventListener("click", async () => {
    btnStopTask.disabled = true;
    btnStopTask.innerHTML = `<span class="halt-box">■</span> ABORTING…`;
    appendLog("EMERGENCY HALT SIGNAL SENT", "error");
    try {
      await chrome.runtime.sendMessage({ type: "STOP_AGENT_LOOP" });
      clearPendingRow();
      addStepRow("Agent loop aborted by user command.", "error");
    } catch (err) {
      console.warn("[Popup] Stop signal error:", err);
    } finally {
      btnStopTask.innerHTML = `<span class="halt-box">■</span> HALT`;
      setRunningUI(false);
    }
  });
}

btnDispatchTask.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.focus();
    return;
  }

  setRunningUI(true);
  stepFeed.innerHTML = "";
  setPendingRow("INTERCEPTING DOM & PLANNING AIR-GAPPED ACTION…");
  appendLog(`TASK DISPATCH: "${task}"`);

  try {
    const modelProvider = selModelProvider?.value || "auto";
    const res = await chrome.runtime.sendMessage({
      type: "START_AGENT_LOOP",
      task,
      options: { maxSteps: 8, modelProvider },
    });

    if (!res || !res.ok) throw new Error(res?.error || "Agent loop failed");

    clearPendingRow();
    addStepRow(stripModelTag(res.summary) || "Task completed successfully.", "success");
    appendLog(`TASK COMPLETED: ${res.summary} (${res.stepsExecuted || 0} steps).`, "success");
  } catch (err) {
    clearPendingRow();
    addStepRow(err.message, "error");
    appendLog(`TASK FAILED: ${err.message}`, "error");
  } finally {
    setRunningUI(false);
  }
});

// Keyboard shortcuts
taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!btnDispatchTask.classList.contains("hidden") && !btnDispatchTask.disabled) {
      btnDispatchTask.click();
    }
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && btnStopTask && !btnStopTask.classList.contains("hidden")) {
    btnStopTask.click();
  }
});

// Runtime event listener for step events
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AGENT_LOOP_STEP_EVENT" && msg.step) {
    const s = msg.step;
    const act = s.action || {};

    clearPendingRow();
    const privacyPhrase = describePrivacy(s.redactionCount);
    const actionPhrase = describeAction(act);
    const text = privacyPhrase
      ? `${privacyPhrase} // ${actionPhrase}`
      : actionPhrase;
    addStepRow(text, "success");
    if (act.type !== "finish") setPendingRow("PROCESSING NEXT PERCEPTION CYCLE…");

    appendLog(`STEP ${s.step}: ${(act.type || "ACTION").toUpperCase()} -> ${act.selector || act.value || "VIEWPORT"}`);
    if (s.sanitizedImage) {
      latestCapture = { sanitizedImageUrl: s.sanitizedImage, redactionList: [] };
      updateSandboxDisplay();
    }
  }
});

// Navigation Links
if (btnOpenSidePanel) {
  btnOpenSidePanel.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });
    window.close();
  });
}

if (linkOpenDashboard) {
  linkOpenDashboard.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
}

if (linkOpenOptions) {
  linkOpenOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

if (linkOpenDemo) {
  linkOpenDemo.addEventListener("click", async () => {
    try {
      const probe = await fetch("http://localhost:8000/demo.html", { method: "HEAD", signal: AbortSignal.timeout(600) });
      if (probe.ok) {
        chrome.tabs.create({ url: "http://localhost:8000/demo.html" });
        return;
      }
    } catch {}
    chrome.tabs.create({ url: chrome.runtime.getURL("demo.html") });
  });
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}
