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
const btnOpenSidePanel = document.getElementById("btnOpenSidePanel");
const linkOpenDashboard = document.getElementById("linkOpenDashboard");

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

  // Rehydrate state from background session if popup was reopened
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
        ? `${privacyPhrase}, then ${actionPhrase.charAt(0).toLowerCase()}${actionPhrase.slice(1)}`
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
      entry.className = "log-entry";
      entry.textContent = log;
      agentStatusLog.appendChild(entry);
    });
    agentStatusLog.scrollTop = agentStatusLog.scrollHeight;
  }

  if (session.status === "RUNNING") {
    btnDispatchTask.disabled = true;
    btnDispatchTask.textContent = "…";
    taskInput.disabled = true;
    clearPendingRow();
    setPendingRow("Deciding the next step…");
  } else if (session.status === "COMPLETED") {
    clearPendingRow();
    btnDispatchTask.disabled = false;
    btnDispatchTask.textContent = "Go";
    taskInput.disabled = false;
  } else if (session.status === "STOPPED" || session.status === "ERROR") {
    clearPendingRow();
    btnDispatchTask.disabled = false;
    btnDispatchTask.textContent = "Go";
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

// Basic view: plain-language count of what's protected on the current page
async function loadBasicCount() {
  try {
    const tab = await getActiveWebTab();
    if (!tab || !tab.id) throw new Error("no active tab");
    const resp = await sendTabMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
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

  // Show a hint after 5s so the user knows model loading is normal
  const loadHintTimer = setTimeout(() => {
    appendLog("Loading vision models (first run may take 30-60s)…", "info");
    btnCapture.textContent = "Loading…";
  }, 5000);

  try {
    // Use a promise wrapper with timeout so button never stays disabled forever
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: "Capture timed out — please try again" });
      }, 90000);

      chrome.runtime.sendMessage({ type: "CAPTURE_AND_REDACT", options: {} }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: "Empty response" });
        }
      });
    });

    clearTimeout(loadHintTimer);

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
    clearTimeout(loadHintTimer);
    appendLog(`Capture error: ${err.message}`, "error");
  } finally {
    btnCapture.disabled = false;
    btnCapture.textContent = "Capture";
  }
});


// Highlight DOM
btnHighlightDOM.addEventListener("click", async () => {
  try {
    const tab = await getActiveWebTab();
    if (!tab || !tab.id) {
      appendLog("No active web tab found.", "error");
      return;
    }
    const resp = await sendTabMessage(tab.id, { type: "HIGHLIGHT_DOM" });
    if (resp && resp.ok) {
      appendLog(`Highlighted ${resp.count} field(s) on the page.`, "success");
    } else {
      appendLog(`Highlight error: ${resp?.error || "Failed"}`, "error");
    }
  } catch (err) {
    appendLog(`Highlight error: ${err.message}`, "error");
  }
});

// Clear overlays
btnClearOverlays.addEventListener("click", async () => {
  try {
    const tab = await getActiveWebTab();
    if (!tab || !tab.id) return;
    await sendTabMessage(tab.id, { type: "CLEAR_OVERLAYS" });
    appendLog("Cleared overlays.", "success");
  } catch (err) {
    appendLog(`Clear error: ${err.message}`, "error");
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

linkOpenOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
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
