/**
 * Privacy Agent — popup controller (redesigned).
 * Basic view: toggle + prompt. Advanced view (opt-in): model, tools, preview, log.
 */

import { getSettings, saveSettings } from "./storage.js";
import { logEvent } from "./telemetry.js";

/* ── Element refs ────────────────────────────────────────── */
const popup           = document.getElementById("popup");
const btnTheme        = document.getElementById("btnTheme");
const btnOpenOptions  = document.getElementById("btnOpenOptions");

const toggleProtection= document.getElementById("toggleProtection");
const heroCard        = document.getElementById("heroCard");
const statusText      = document.getElementById("statusText");
const basicCount      = document.getElementById("basicCount");
const pageNotice      = document.getElementById("pageNotice");

const taskInput       = document.getElementById("taskInput");
const btnDispatchTask = document.getElementById("btnDispatchTask");
const btnStopTask     = document.getElementById("btnStopTask");
const stepFeed        = document.getElementById("stepFeed");
const lblServerStatus = document.getElementById("lblServerStatus");

const chkAdvanced     = document.getElementById("chkAdvanced");
const advancedPanel   = document.getElementById("advancedPanel");

const selModelProvider    = document.getElementById("selModelProvider");
const btnCapture          = document.getElementById("btnCapture");
const btnHighlightDOM     = document.getElementById("btnHighlightDOM");
const btnAutoSync         = document.getElementById("btnAutoSync");
const btnClearOverlays    = document.getElementById("btnClearOverlays");

const btnViewSanitized    = document.getElementById("btnViewSanitized");
const btnViewRaw          = document.getElementById("btnViewRaw");
const displayImage        = document.getElementById("displayImage");
const viewportPlaceholder = document.getElementById("viewportPlaceholder");
const redactionCountPill  = document.getElementById("redactionCountPill");
const visualRedactionList = document.getElementById("visualRedactionList");

const agentStatusLog  = document.getElementById("agentStatusLog");
const linkOpenDashboard = document.getElementById("linkOpenDashboard");
const linkOpenDemo    = document.getElementById("linkOpenDemo");
const btnOpenHUD      = document.getElementById("btnOpenHUD");

let latestCapture     = null;
let activeViewMode    = "sanitized";
let autoSyncInterval  = null;
let pendingStepRow    = null;
let agentRunning      = false;
let currentTheme      = "dark";

/* ── Init ─────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", async () => {
  const settings = await getSettings();

  // Theme
  currentTheme = settings.theme || "dark";
  applyTheme(currentTheme);

  setProtectionUI(settings.enabled !== false);
  setAdvancedUI(Boolean(settings.uiAdvancedMode));
  if (selModelProvider) selModelProvider.value = settings.modelProvider || "auto";

  await probeServerHealth();
  logEvent("popup", "Privacy Agent UI initialized");
  await loadBasicCount();

  // Restore session if agent was running
  try {
    const sessionResp = await chrome.runtime.sendMessage({ type: "GET_AGENT_SESSION_STATE" });
    if (sessionResp?.ok && sessionResp.session) restoreSessionState(sessionResp.session);
  } catch (err) {
    console.warn("[Popup] Could not fetch session state:", err);
  }
});

/* ── Theme ────────────────────────────────────────────── */
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  popup.setAttribute("data-theme", theme);
}

btnTheme.addEventListener("click", async () => {
  const next = currentTheme === "dark" ? "light" : "dark";
  applyTheme(next);
  await saveSettings({ theme: next });
});

/* ── Protection toggle ────────────────────────────────── */
function setProtectionUI(enabled) {
  toggleProtection.dataset.state = enabled ? "on" : "off";
  toggleProtection.setAttribute("aria-pressed", String(enabled));
  toggleProtection.classList.toggle("active", enabled);

  statusText.textContent = enabled ? "Protected" : "Paused";

  if (enabled) {
    heroCard.removeAttribute("data-off");
  } else {
    heroCard.setAttribute("data-off", "");
  }
}

toggleProtection.addEventListener("click", async () => {
  const next = toggleProtection.dataset.state !== "on";
  setProtectionUI(next);
  await saveSettings({ enabled: next });
  appendLog(next ? "Protection resumed." : "Protection paused.");
});

/* ── Advanced view ────────────────────────────────────── */
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

/* ── Basic count ─────────────────────────────────────── */
async function loadBasicCount() {
  try {
    const tab = await getActiveWebTab();
    if (!tab || !tab.id) throw new Error("no tab");
    const resp = await sendTabMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
    const n = resp?.ok ? (resp.boxes || []).length : 0;
    if (n === 0) {
      pageNotice.textContent = "Nothing sensitive found on this page.";
    } else {
      pageNotice.textContent = `${n} sensitive field${n === 1 ? "" : "s"} protected on this page.`;
    }
  } catch {
    pageNotice.textContent = "";
  }
}

/* ── Agent task dispatch ─────────────────────────────── */
function setAgentRunning(running) {
  agentRunning = running;
  btnDispatchTask.disabled = running;
  btnDispatchTask.classList.toggle("hidden", running);
  btnStopTask.classList.toggle("hidden", !running);
  taskInput.disabled = running;
}

btnDispatchTask.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    taskInput.classList.add("attention");
    taskInput.focus();
    setTimeout(() => taskInput.classList.remove("attention"), 350);
    return;
  }

  setAgentRunning(true);
  stepFeed.innerHTML = "";
  setPendingRow("Reading the page…");
  logEvent("popup", `User started agent task: "${task}"`);
  appendLog(`Running: "${task}"`);

  try {
    const tab = await getActiveWebTab();
    const modelProvider = selModelProvider?.value || "auto";
    const res = await chrome.runtime.sendMessage({
      type: "START_AGENT_LOOP",
      task,
      // maxSteps deliberately omitted: the loop reads settings.maxSteps, so the
      // budget lives in one place instead of being pinned to 8 by the caller.
      options: { modelProvider, tabId: tab?.id, windowId: tab?.windowId },
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
    setAgentRunning(false);
  }
});

btnStopTask.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "STOP_AGENT_LOOP" });
  } catch {}
  clearPendingRow();
  addStepRow("Stopped by user.", "error");
  appendLog("Task stopped by user.", "error");
  setAgentRunning(false);
});

/* ── Session restore ─────────────────────────────────── */
function restoreSessionState(session) {
  if (!session) return;

  if (session.taskPrompt && !taskInput.value) taskInput.value = session.taskPrompt;

  if (session.stepsHistory?.length > 0) {
    stepFeed.innerHTML = "";
    session.stepsHistory.forEach((s) => {
      const act = s.action || {};
      const privacy = describePrivacy(s.redactionCount);
      const action  = describeAction(act);
      const text = privacy
        ? `${privacy}, then ${action.charAt(0).toLowerCase()}${action.slice(1)}`
        : action;
      addStepRow(text, s.error ? "error" : "success");
    });
  }

  if (session.latestCapture) {
    latestCapture = session.latestCapture;
    updateSandboxDisplay();
    updateDetectedList(latestCapture.redactionList || []);
  }

  if (session.activityLogs?.length > 0) {
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
    setAgentRunning(true);
    setPendingRow("Deciding the next step…");
  } else {
    setAgentRunning(false);
  }
}

/* ── Tab utilities ───────────────────────────────────── */
async function getActiveWebTab() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || tab.url.startsWith("chrome://")) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  }
  if (!tab?.url || tab.url.startsWith("chrome://")) {
    const allTabs = await chrome.tabs.query({});
    tab = allTabs.find((t) => t.url && (t.url.startsWith("http") || t.url.includes("demo.html"))) || tab;
  }
  return tab;
}

async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (err.message?.includes("Receiving end") || err.message?.includes("Could not establish")) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        await new Promise((r) => setTimeout(r, 120));
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (injectErr) {
        console.warn("[Popup] Re-inject failed:", injectErr.message);
      }
    }
    throw err;
  }
}

/* ── Server health ───────────────────────────────────── */
async function probeServerHealth() {
  const settings = await getSettings();
  const url = settings.serverHealthUrl || "http://127.0.0.1:8001/health";
  try {
    const res = await fetch(url);
    if (res.ok) {
      lblServerStatus.classList.add("hidden");
    } else {
      lblServerStatus.textContent = `Server responded HTTP ${res.status}`;
      lblServerStatus.classList.remove("hidden");
    }
  } catch {
    lblServerStatus.textContent = "Server offline — start it on port 8001";
    lblServerStatus.classList.remove("hidden");
  }
}

/* ── Step feed helpers ───────────────────────────────── */
function stripModelTag(text) {
  return (text || "").replace(/^\[[^\]]+\]\s*/, "");
}

function describeAction(act = {}) {
  const expl = stripModelTag(act.explanation);
  if (expl) return expl;
  switch (act.type) {
    case "click":  return "Clicked an element on the page";
    case "type":   return "Typed into a field";
    case "scroll": return "Scrolled the page";
    case "finish": return "Finished the task";
    default:       return "Took an action";
  }
}

function describePrivacy(n = 0) {
  if (!n) return null;
  return `Redacted ${n} sensitive item${n === 1 ? "" : "s"}`;
}

function addStepRow(text, state = "success") {
  const row = document.createElement("div");
  row.className = `step-row ${state}`;
  const mark = state === "pending" ? "…" : state === "error" ? "✕" : "✓";
  row.innerHTML = `<span class="mark">${mark}</span><span></span>`;
  row.lastChild.textContent = text;
  stepFeed.appendChild(row);
  stepFeed.scrollTop = stepFeed.scrollHeight;
  return row;
}

function setPendingRow(text) {
  clearPendingRow();
  pendingStepRow = addStepRow(text, "pending");
}

function clearPendingRow() {
  if (pendingStepRow) { pendingStepRow.remove(); pendingStepRow = null; }
}

/* ── Activity log ────────────────────────────────────── */
function appendLog(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry${type !== "info" ? " " + type : ""}`;
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  entry.textContent = `${t}  ${msg}`;
  agentStatusLog.appendChild(entry);
  agentStatusLog.scrollTop = agentStatusLog.scrollHeight;
}

/* ── Preview controls ────────────────────────────────── */
btnViewSanitized?.addEventListener("click", () => {
  activeViewMode = "sanitized";
  btnViewSanitized.classList.add("active");
  btnViewRaw.classList.remove("active");
  updateSandboxDisplay();
});

btnViewRaw?.addEventListener("click", () => {
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
    visualRedactionList.innerHTML = `<span class="muted-sm">No sensitive entities detected.</span>`;
    return;
  }
  redactions.forEach((r) => {
    const item = document.createElement("div");
    item.className = "detected-item";
    item.innerHTML = `<span class="label">${r.label}</span><span class="source">${r.source}</span>`;
    visualRedactionList.appendChild(item);
  });
}

/* ── Quick action buttons ────────────────────────────── */
btnCapture?.addEventListener("click", async () => {
  const orig = btnCapture.textContent;
  btnCapture.disabled = true;
  appendLog("Capturing & redacting…");

  try {
    const tab = await getActiveWebTab();
    const result = await Promise.race([
      chrome.runtime.sendMessage({
        type: "CAPTURE_AND_REDACT",
        options: { tabId: tab?.id, windowId: tab?.windowId, url: tab?.url, title: tab?.title },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Capture timed out")), 35000)),
    ]);
    if (!result?.ok) throw new Error(result?.error || "Capture failed");
    latestCapture = result;
    updateSandboxDisplay();
    updateDetectedList(result.redactionList || []);
    const ms = result.timings?.totalRedactionLatencyMs;
    appendLog(`Protected ${result.redactionList?.length || 0} item(s) in ${ms ? Math.round(ms) : "?"}ms.`, "success");
  } catch (err) {
    appendLog(`Capture error: ${err.message}`, "error");
  } finally {
    btnCapture.disabled = false;
    btnCapture.childNodes[btnCapture.childNodes.length - 1].textContent = orig.trim() ? orig : "Capture";
  }
});

btnHighlightDOM?.addEventListener("click", async () => {
  try {
    const tab = await getActiveWebTab();
    if (!tab?.id) { appendLog("No active web tab.", "error"); return; }
    const resp = await sendTabMessage(tab.id, { type: "HIGHLIGHT_DOM" });
    if (resp?.ok) appendLog(`Highlighted ${resp.count} field(s).`, "success");
    else appendLog(`Highlight error: ${resp?.error || "Failed"}`, "error");
  } catch (err) { appendLog(`Highlight error: ${err.message}`, "error"); }
});

btnClearOverlays?.addEventListener("click", async () => {
  try {
    const tab = await getActiveWebTab();
    if (!tab?.id) return;
    await sendTabMessage(tab.id, { type: "CLEAR_OVERLAYS" });
    appendLog("Cleared overlays.", "success");
  } catch (err) { appendLog(`Clear error: ${err.message}`, "error"); }
});

btnAutoSync?.addEventListener("click", () => {
  if (autoSyncInterval) {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
    btnAutoSync.classList.remove("active");
    appendLog("Stopped live capture.");
  } else {
    btnAutoSync.classList.add("active");
    appendLog("Started live capture (every 3s).");
    btnCapture?.click();
    autoSyncInterval = setInterval(() => btnCapture?.click(), 3000);
  }
});

/* ── Runtime messages ────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TELEMETRY_LOG") {
    appendLog(`[${msg.source}] ${msg.message}`, msg.level || "info");
    if (msg.source !== "popup") {
      fetch("http://127.0.0.1:8001/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: msg.source, level: msg.level || "info", message: msg.message, details: msg.details }),
      }).catch(() => {});
    }
    return false;
  }

  if (msg.type === "AGENT_LOOP_STEP_EVENT" && msg.step) {
    const s = msg.step;
    const act = s.action || {};
    clearPendingRow();
    const privacy = describePrivacy(s.redactionCount);
    const action  = describeAction(act);
    const text = privacy
      ? `${privacy}, then ${action.charAt(0).toLowerCase()}${action.slice(1)}`
      : action;
    addStepRow(text, "success");
    if (act.type !== "finish") setPendingRow("Deciding the next step…");
    appendLog(`Step ${s.step}: ${act.type || "action"} → ${act.selector || act.value || "viewport"}`, "success");
    if (s.sanitizedImage) {
      latestCapture = { sanitizedImageUrl: s.sanitizedImage, redactionList: [] };
      updateSandboxDisplay();
    }
  }
});

/* ── Nav links ───────────────────────────────────────── */
btnOpenOptions?.addEventListener("click", () => chrome.runtime.openOptionsPage());

linkOpenDashboard?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

linkOpenDemo?.addEventListener("click", async () => {
  try {
    const probe = await fetch("http://localhost:8000/demo.html", { method: "HEAD", signal: AbortSignal.timeout(600) });
    if (probe.ok) { chrome.tabs.create({ url: "http://localhost:8000/demo.html" }); return; }
  } catch {}
  chrome.tabs.create({ url: chrome.runtime.getURL("demo.html") });
});

btnOpenHUD?.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("hud.html") });
});
