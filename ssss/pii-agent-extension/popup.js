/**
 * Privacy Agent — popup controller.
 * Basic view: one toggle, plain-language status. Advanced view (opt-in):
 * agent task runner, quick capture tools, and a preview/activity log.
 */

import { getSettings, saveSettings } from "./storage.js";

const toggleProtection = document.getElementById("toggleProtection");
const statusText = document.getElementById("statusText");
const basicCount = document.getElementById("basicCount");

const chkAdvanced = document.getElementById("chkAdvanced");
const advancedPanel = document.getElementById("advancedPanel");

const taskInput = document.getElementById("taskInput");
const selModelProvider = document.getElementById("selModelProvider");
const btnDispatchTask = document.getElementById("btnDispatchTask");
const lblServerStatus = document.getElementById("lblServerStatus");
const stepFeed = document.getElementById("stepFeed");

const btnCapture = document.getElementById("btnCapture");
const btnHighlightDOM = document.getElementById("btnHighlightDOM");
const btnAutoSync = document.getElementById("btnAutoSync");
const btnClearOverlays = document.getElementById("btnClearOverlays");

const btnViewSanitized = document.getElementById("btnViewSanitized");
const btnViewRaw = document.getElementById("btnViewRaw");
const displayImage = document.getElementById("displayImage");
const viewportPlaceholder = document.getElementById("viewportPlaceholder");
const redactionCountPill = document.getElementById("redactionCountPill");
const visualRedactionList = document.getElementById("visualRedactionList");

const agentStatusLog = document.getElementById("agentStatusLog");
const linkOpenOptions = document.getElementById("linkOpenOptions");
const linkOpenDemo = document.getElementById("linkOpenDemo");

let latestCapture = null;
let activeViewMode = "sanitized";
let autoSyncInterval = null;
let pendingStepRow = null;

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await getSettings();

  setProtectionUI(settings.enabled !== false);
  setAdvancedUI(Boolean(settings.uiAdvancedMode));
  if (selModelProvider) selModelProvider.value = settings.modelProvider || "auto";

  await probeServerHealth();
  await loadBasicCount();
});

// Basic view: plain-language count of what's protected on the current page
async function loadBasicCount() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("no active tab");
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
    const n = resp && resp.ok ? (resp.boxes || []).length : 0;
    basicCount.textContent =
      n === 0 ? "Nothing sensitive found on this page." : `${n} sensitive field${n === 1 ? "" : "s"} protected on this page.`;
  } catch {
    basicCount.textContent = "";
  }
}

// Protection toggle (the entire "basic" control surface)
function setProtectionUI(enabled) {
  toggleProtection.dataset.state = enabled ? "on" : "off";
  toggleProtection.setAttribute("aria-pressed", String(enabled));
  statusText.textContent = enabled ? "Protected" : "Paused";
}

toggleProtection.addEventListener("click", async () => {
  const next = toggleProtection.dataset.state !== "on";
  setProtectionUI(next);
  await saveSettings({ enabled: next });
  appendLog(next ? "Protection resumed." : "Protection paused.");
});

// Advanced view toggle
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
  entry.className = `log-entry${type !== "info" ? " " + type : ""}`;
  const timeStr = new Date().toLocaleTimeString().split(" ")[0];
  entry.textContent = `${timeStr}  ${msg}`;
  agentStatusLog.appendChild(entry);
  agentStatusLog.scrollTop = agentStatusLog.scrollHeight;
}

// Plain-language step feed (Basic view) — no jargon, no timestamps.
// The technical Activity log in Advanced still gets the detailed version.
function stripModelTag(text) {
  return (text || "").replace(/^\[[^\]]+\]\s*/, "");
}

function describeAction(act = {}) {
  const explanation = stripModelTag(act.explanation);
  if (explanation) return explanation;
  switch (act.type) {
    case "click": return "Clicked an element on the page";
    case "type": return "Typed into a field";
    case "scroll": return "Scrolled the page";
    case "finish": return "Finished the task";
    default: return "Took an action";
  }
}

function describePrivacy(redactionCount = 0) {
  if (!redactionCount) return null;
  return `Redacted ${redactionCount} sensitive item${redactionCount === 1 ? "" : "s"}`;
}

function addStepRow(text, state = "success") {
  const row = document.createElement("div");
  row.className = `step-row ${state}`;
  const mark = state === "pending" ? "…" : state === "error" ? "✕" : "✓";
  row.innerHTML = `<span class="mark">${mark}</span><span></span>`;
  row.lastChild.textContent = text;
  stepFeed.appendChild(row);
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

// Server health — stay silent when healthy, only speak up when something's wrong
async function probeServerHealth() {
  const settings = await getSettings();
  const url = settings.serverHealthUrl || "http://127.0.0.1:8001/health";
  try {
    const res = await fetch(url);
    if (res.ok) {
      lblServerStatus.classList.add("hidden");
    } else {
      lblServerStatus.textContent = `Server responded with HTTP ${res.status}`;
      lblServerStatus.classList.remove("hidden");
    }
  } catch {
    lblServerStatus.textContent = "Server offline — start it on port 8001";
    lblServerStatus.classList.remove("hidden");
  }
}

// Sandbox preview toggle
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
  redactionCountPill.textContent = `${redactions.length} masked`;

  visualRedactionList.innerHTML = "";
  if (redactions.length === 0) {
    visualRedactionList.innerHTML = `<div class="muted">Nothing detected on this screen.</div>`;
    return;
  }

  redactions.forEach((r) => {
    const item = document.createElement("div");
    item.className = "detected-item";
    item.innerHTML = `<span class="label">${r.label}</span><span class="source">${r.source}</span>`;
    visualRedactionList.appendChild(item);
  });
}

// Capture & Redact
btnCapture.addEventListener("click", async () => {
  btnCapture.disabled = true;
  btnCapture.textContent = "…";
  appendLog("Capturing and redacting viewport…");

  try {
    const result = await chrome.runtime.sendMessage({ type: "CAPTURE_AND_REDACT" });
    if (!result || !result.ok) {
      throw new Error(result?.error || "Capture failed");
    }

    latestCapture = result;
    updateSandboxDisplay();
    updateDetectedList(result.redactionList || []);

    const ms = result.timings?.totalRedactionLatencyMs;
    appendLog(
      `${result.redactionList?.length || 0} region(s) redacted${ms ? ` in ${ms.toFixed(0)} ms` : ""}.`,
      "success"
    );
  } catch (err) {
    appendLog(`Capture error: ${err.message}`, "error");
  } finally {
    btnCapture.disabled = false;
    btnCapture.textContent = "Capture";
  }
});

// Highlight DOM
btnHighlightDOM.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "HIGHLIGHT_DOM" }, (resp) => {
      if (resp && resp.ok) appendLog(`Highlighted ${resp.count} field(s) on the page.`, "success");
    });
  }
});

// Clear overlays
btnClearOverlays.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_OVERLAYS" }, () => appendLog("Cleared overlays."));
  }
});

// Live stream toggle
btnAutoSync.addEventListener("click", () => {
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
    btnAutoSync.textContent = "Live";
    btnAutoSync.classList.remove("active");
    appendLog("Stopped live capture.");
  } else {
    btnAutoSync.textContent = "Stop";
    btnAutoSync.classList.add("active");
    appendLog("Started live capture (every 3s).");
    btnCapture.click();
    autoSyncInterval = setInterval(() => btnCapture.click(), 3000);
  }
});

// Dispatch agent task — the prompt box is the core feature:
// type a goal in plain English, the page gets redacted on-device before
// any of it is analyzed, then the agent acts step-by-step until done.
btnDispatchTask.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.classList.add("attention");
    taskInput.focus();
    setTimeout(() => taskInput.classList.remove("attention"), 400);
    return;
  }

  btnDispatchTask.disabled = true;
  btnDispatchTask.textContent = "…";
  taskInput.disabled = true;
  stepFeed.innerHTML = "";
  setPendingRow("Reading the page…");
  appendLog(`Running: "${task}"`);

  try {
    const modelProvider = selModelProvider?.value || "auto";
    const res = await chrome.runtime.sendMessage({
      type: "START_AGENT_LOOP",
      task,
      options: { maxSteps: 8, modelProvider },
    });

    if (!res || !res.ok) throw new Error(res?.error || "Agent loop failed");

    clearPendingRow();
    addStepRow(stripModelTag(res.summary) || "Done.", "success");
    appendLog(`Done: ${res.summary} (${res.stepsExecuted || 0} step(s)).`, "success");
  } catch (err) {
    clearPendingRow();
    addStepRow(err.message, "error");
    appendLog(`Failed: ${err.message}`, "error");
  } finally {
    btnDispatchTask.disabled = false;
    btnDispatchTask.textContent = "Go";
    taskInput.disabled = false;
  }
});

// Live step events from a running agent loop
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AGENT_LOOP_STEP_EVENT" && msg.step) {
    const s = msg.step;
    const act = s.action || {};

    clearPendingRow();
    const privacyPhrase = describePrivacy(s.redactionCount);
    const actionPhrase = describeAction(act);
    const text = privacyPhrase
      ? `${privacyPhrase}, then ${actionPhrase.charAt(0).toLowerCase()}${actionPhrase.slice(1)}`
      : actionPhrase;
    addStepRow(text, "success");
    if (act.type !== "finish") setPendingRow("Deciding the next step…");

    appendLog(`Step ${s.step}: ${(act.type || "action")} → ${act.selector || act.value || "viewport"}`, "success");
    if (s.sanitizedImage) {
      latestCapture = { sanitizedImageUrl: s.sanitizedImage, redactionList: [] };
      updateSandboxDisplay();
    }
  }
});

linkOpenOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
linkOpenDemo.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("demo.html") });
});
