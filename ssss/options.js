/**
 * Privacy Agent — settings page.
 *
 * Two rules hold this file together:
 *   1. Nothing is saved by a button. Every control writes the moment it
 *      changes, and saveSettings() merges, so a partial object is enough.
 *   2. No colour or copy lives in here. State goes on as a class; the
 *      stylesheet decides what that looks like.
 */

import {
  getSettings,
  saveSettings,
  resetSettings,
  getAuditLogs,
  clearAuditLogs,
} from "./storage.js";
import { vault } from "./vault.js";

const $ = (id) => document.getElementById(id);

const hero = $("hero");
const toggleProtection = $("toggleProtection");
const statusText = $("statusText");
const lifetimeStat = $("lifetimeStat");

const chkAdvanced = $("chkAdvanced");
const advancedPanel = $("advancedPanel");

const chkFailClosed = $("chkFailClosed");
const chkShowPageBadge = $("chkShowPageBadge");

const selEngineMode = $("selEngineMode");
const numConfidence = $("numConfidence");
const lblConfidenceVal = $("lblConfidenceVal");
const numFaceProxy = $("numFaceProxy");
const lblFaceProxyVal = $("lblFaceProxyVal");

const categoryInputs = {
  passwords: $("catPasswords"),
  creditCards: $("catCreditCards"),
  govIds: $("catGovIds"),
  faces: $("catFaces"),
  contactInfo: $("catContactInfo"),
  screens: $("catScreens"),
};

const txtServerUrl = $("txtServerUrl");
const txtHealthUrl = $("txtHealthUrl");
const txtApiKey = $("txtApiKey");
const btnTestConnection = $("btnTestConnection");
const connectionStatus = $("connectionStatus");

const txtNewDomain = $("txtNewDomain");
const btnAddDomain = $("btnAddDomain");
const domainList = $("domainList");

const vaultStatusDot = $("vaultStatusDot");
const vaultStatusText = $("vaultStatusText");
const vaultCategory = $("vaultCategory");
const vaultKey = $("vaultKey");
const vaultValue = $("vaultValue");
const vaultList = $("vaultList");
const btnAddVaultEntry = $("btnAddVaultEntry");
const btnLockVault = $("btnLockVault");
const btnExportVault = $("btnExportVault");
const btnClearVault = $("btnClearVault");

const auditTableBody = $("auditTableBody");
const btnExportJson = $("btnExportJson");
const btnExportCsv = $("btnExportCsv");
const btnClearLogs = $("btnClearLogs");

const btnReset = $("btnReset");
const savedNote = $("savedNote");

const diagWebgpu = $("diagWebgpu");
const diagGpuName = $("diagGpuName");

const btnOpenHud = $("btnOpenHud");
const btnOpenDemo = $("btnOpenDemo");

let domains = [];

/* ── Boot ────────────────────────────────────────────────────────────────── */

init();

async function init() {
  const settings = await getSettings();

  paintProtection(Boolean(settings.enabled));
  paintAdvanced(Boolean(settings.uiAdvancedMode));

  chkFailClosed.checked = settings.failClosed !== false;
  chkShowPageBadge.checked = settings.showPageBadge !== false;

  selEngineMode.value = settings.engineMode || "auto";
  numConfidence.value = settings.detectionConfidence ?? 0.65;
  numFaceProxy.value = settings.faceProxyPercent ?? 0.3;
  paintRangeLabels();

  const cats = settings.categories || {};
  for (const [name, input] of Object.entries(categoryInputs)) {
    input.checked = cats[name] !== false;
  }

  txtServerUrl.value = settings.serverUrl || "";
  txtHealthUrl.value = settings.serverHealthUrl || "";
  txtApiKey.value = settings.apiKey || "";

  domains = Array.isArray(settings.domainWhitelist) ? [...settings.domainWhitelist] : [];
  renderDomains();

  wireAutosave();
  probeHardware();
  await renderHistory();
  await openVault();
}

/* ── Protection and Advanced ─────────────────────────────────────────────── */

function paintProtection(on) {
  toggleProtection.dataset.state = on ? "on" : "off";
  toggleProtection.setAttribute("aria-checked", String(on));
  hero.classList.toggle("is-off", !on);
  statusText.textContent = on ? "Protection is on" : "Protection is off";
}

toggleProtection.addEventListener("click", async () => {
  const next = toggleProtection.dataset.state !== "on";
  paintProtection(next);
  await saveSettings({ enabled: next });
  whisper(next ? "Protection on" : "Protection off");
});

function paintAdvanced(open) {
  chkAdvanced.checked = open;
  advancedPanel.classList.toggle("open", open);
  document.body.classList.toggle("advanced-on", open);
}

chkAdvanced.addEventListener("change", async () => {
  paintAdvanced(chkAdvanced.checked);
  await saveSettings({ uiAdvancedMode: chkAdvanced.checked });
});

/* ── Autosave ────────────────────────────────────────────────────────────── */

function paintRangeLabels() {
  lblConfidenceVal.textContent = parseFloat(numConfidence.value).toFixed(2);
  lblFaceProxyVal.textContent = Math.round(parseFloat(numFaceProxy.value) * 100) + "%";
}

function wireAutosave() {
  chkFailClosed.addEventListener("change", () =>
    persist({ failClosed: chkFailClosed.checked })
  );

  chkShowPageBadge.addEventListener("change", () =>
    persist({ showPageBadge: chkShowPageBadge.checked })
  );

  selEngineMode.addEventListener("change", () =>
    persist({ engineMode: selEngineMode.value })
  );

  // Ranges paint on every frame but only write when the drag ends.
  numConfidence.addEventListener("input", paintRangeLabels);
  numConfidence.addEventListener("change", () =>
    persist({ detectionConfidence: parseFloat(numConfidence.value) })
  );

  numFaceProxy.addEventListener("input", paintRangeLabels);
  numFaceProxy.addEventListener("change", () =>
    persist({ faceProxyPercent: parseFloat(numFaceProxy.value) })
  );

  for (const [name, input] of Object.entries(categoryInputs)) {
    input.addEventListener("change", async () => {
      const settings = await getSettings();
      const categories = { ...settings.categories, [name]: input.checked };
      persist({ categories });
    });
  }

  // Text fields commit on blur, which is what "change" means for an input.
  txtServerUrl.addEventListener("change", () =>
    persist({ serverUrl: txtServerUrl.value.trim() })
  );
  txtHealthUrl.addEventListener("change", () =>
    persist({ serverHealthUrl: txtHealthUrl.value.trim() })
  );
  txtApiKey.addEventListener("change", () =>
    persist({ apiKey: txtApiKey.value.trim() })
  );
}

async function persist(patch) {
  await saveSettings(patch);
  whisper("Saved");
}

let whisperTimer = null;

function whisper(message) {
  savedNote.textContent = message;
  savedNote.classList.add("show");
  clearTimeout(whisperTimer);
  whisperTimer = setTimeout(() => savedNote.classList.remove("show"), 1600);
}

/* ── Hardware ────────────────────────────────────────────────────────────── */

async function probeHardware() {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    setDiag(diagWebgpu, "Not available in this browser", "warn");
    diagGpuName.textContent = "None";
    return;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      setDiag(diagWebgpu, "No adapter offered", "warn");
      diagGpuName.textContent = "None";
      return;
    }
    setDiag(diagWebgpu, "In use", "ok");
    diagGpuName.textContent =
      (adapter.info && (adapter.info.device || adapter.info.description)) ||
      "Reported without a name";
  } catch {
    setDiag(diagWebgpu, "Unavailable, using the processor", "warn");
    diagGpuName.textContent = "None";
  }
}

function setDiag(node, text, state) {
  node.textContent = text;
  node.classList.remove("ok", "warn");
  if (state) node.classList.add(state);
}

/* ── Pages ───────────────────────────────────────────────────────────────── */

// Both live behind Advanced: they are for looking at the machinery, not for
// changing a setting.
function openExtensionPage(file) {
  const url = chrome.runtime.getURL(file);
  if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
  else window.open(url, "_blank");
}

btnOpenHud.addEventListener("click", () => openExtensionPage("hud.html"));
btnOpenDemo.addEventListener("click", () => openExtensionPage("demo.html"));

/* ── Sites to skip ───────────────────────────────────────────────────────── */

function renderDomains() {
  domainList.textContent = "";

  if (domains.length === 0) {
    domainList.append(li("empty", "Protection is on everywhere."));
    return;
  }

  domains.forEach((domain, index) => {
    const row = document.createElement("li");
    row.className = "list-item";

    const name = document.createElement("span");
    name.className = "list-key";
    name.textContent = domain;

    const remove = document.createElement("button");
    remove.className = "btn-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Protect " + domain + " again";
    remove.addEventListener("click", async () => {
      domains.splice(index, 1);
      renderDomains();
      await persist({ domainWhitelist: domains });
    });

    row.append(name, remove);
    domainList.append(row);
  });
}

async function addDomain() {
  const value = txtNewDomain.value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");

  if (!value) return;

  if (domains.includes(value)) {
    whisper(value + " is already on the list");
    txtNewDomain.value = "";
    return;
  }

  domains.push(value);
  txtNewDomain.value = "";
  renderDomains();
  await persist({ domainWhitelist: domains });
}

btnAddDomain.addEventListener("click", addDomain);

txtNewDomain.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addDomain();
});

/* ── Small helpers ───────────────────────────────────────────────────────── */

function li(className, text) {
  const node = document.createElement("li");
  node.className = className;
  node.textContent = text;
  return node;
}

// State is a class name, never an inline colour.
function paintStatus(node, text, state) {
  node.className = "status" + (state ? " " + state : "");
  node.textContent = text;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── Server check ────────────────────────────────────────────────────────── */

btnTestConnection.addEventListener("click", async () => {
  const url = txtHealthUrl.value.trim();

  if (!url) {
    paintStatus(connectionStatus, "Add an address first.", "warn");
    return;
  }

  paintStatus(connectionStatus, "Checking…", null);

  try {
    const started = performance.now();
    const response = await fetch(url, { method: "GET" });
    const took = Math.round(performance.now() - started);

    if (!response.ok) {
      paintStatus(connectionStatus, "Answered with " + response.status + ".", "warn");
      return;
    }

    let name = "";
    try {
      const body = await response.json();
      name = typeof body.service === "string" ? body.service : "";
    } catch {
      /* A bare 200 is answer enough. */
    }

    paintStatus(
      connectionStatus,
      name ? `Reachable in ${took} ms — ${name}` : `Reachable in ${took} ms`,
      "ok"
    );
  } catch {
    paintStatus(connectionStatus, "No answer. Is the server running?", "bad");
  }
});

/* ── Saved details ───────────────────────────────────────────────────────── */

const CATEGORY_LABELS = {
  personal: "Personal",
  contact: "Contact",
  address: "Address",
  credentials: "Sign-in",
  financial: "Payment",
  gov_id: "ID document",
  custom: "Other",
};

// The dot is a child of the status line, so it has to survive a repaint.
function paintVaultStatus(text, state) {
  vaultStatusText.className = "status" + (state ? " " + state : "");
  vaultStatusText.replaceChildren(vaultStatusDot, document.createTextNode(text));
}

async function openVault() {
  try {
    await vault.init();
    paintVaultStatus("Open on this device", "ok");
    renderVault();
  } catch (error) {
    paintVaultStatus("Could not open: " + error.message, "bad");
    vaultList.replaceChildren(li("empty", "Nothing to show."));
  }
}

function renderVault() {
  let grouped;

  try {
    grouped = vault.listKeys();
  } catch {
    vaultList.replaceChildren(li("empty", "Hidden while locked."));
    return;
  }

  const entries = [];
  for (const [category, items] of Object.entries(grouped)) {
    for (const item of items) entries.push({ category, ...item });
  }

  if (entries.length === 0) {
    vaultList.replaceChildren(li("empty", "Nothing saved yet."));
    return;
  }

  vaultList.replaceChildren(...entries.map(vaultRow));
}

// Values are never put into innerHTML: every node is built and filled by text.
function vaultRow(entry) {
  const row = document.createElement("li");
  row.className = "list-item";

  const meta = document.createElement("div");
  meta.className = "list-meta";

  const label = document.createElement("span");
  label.className = "list-key";
  label.textContent =
    (CATEGORY_LABELS[entry.category] || entry.category) +
    " · " +
    entry.key.replace(/_/g, " ");

  const masked = document.createElement("span");
  masked.className = "list-val";
  masked.textContent = entry.maskedValue || "••••";

  // Only useful once you know what a placeholder is, so Advanced reveals it.
  const token = document.createElement("span");
  token.className = "list-token";
  token.textContent = entry.tokenHandle;

  meta.append(label, masked, token);

  const remove = document.createElement("button");
  remove.className = "btn-remove";
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "Delete " + entry.key;
  remove.addEventListener("click", async () => {
    await vault.delete(entry.category, entry.key);
    renderVault();
    whisper("Deleted");
  });

  row.append(meta, remove);
  return row;
}

async function addVaultEntry() {
  const category = vaultCategory.value;
  const key = vaultKey.value.trim().toLowerCase().replace(/\s+/g, "_");
  const value = vaultValue.value.trim();

  if (!key || !value) {
    whisper("Give it a name and a value");
    return;
  }

  try {
    await vault.set(category, key, value);
    vaultKey.value = "";
    vaultValue.value = "";
    renderVault();
    whisper("Saved on this device");
  } catch (error) {
    whisper("Could not save: " + error.message);
  }
}

btnAddVaultEntry.addEventListener("click", addVaultEntry);

vaultValue.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addVaultEntry();
});

// Chips only prefill the pair below them; nothing is saved until you say so.
for (const chip of document.querySelectorAll(".vault-preset")) {
  chip.addEventListener("click", () => {
    vaultCategory.value = chip.dataset.cat;
    vaultKey.value = chip.dataset.key;
    vaultValue.focus();
  });
}

btnLockVault.addEventListener("click", () => {
  vault.lock();
  paintVaultStatus("Locked. Reload this page to open it again.", "warn");
  vaultList.replaceChildren(li("empty", "Hidden while locked."));
  whisper("Locked");
});

btnExportVault.addEventListener("click", async () => {
  try {
    const json = await vault.exportEncryptedBackup();
    download(
      new Blob([json], { type: "application/json" }),
      "privacy-agent-vault-backup.json"
    );
    whisper("Backup saved");
  } catch (error) {
    whisper("Could not export: " + error.message);
  }
});

btnClearVault.addEventListener("click", async () => {
  if (!confirm("Delete every saved detail? This cannot be undone.")) return;

  try {
    const grouped = vault.listKeys();
    for (const [category, items] of Object.entries(grouped)) {
      for (const item of items) await vault.delete(category, item.key);
    }
    renderVault();
    whisper("Deleted everything saved");
  } catch (error) {
    whisper("Could not delete: " + error.message);
  }
});

/* ── History ─────────────────────────────────────────────────────────────── */

const BACKEND_LABELS = { webgpu: "Graphics card", wasm: "Processor" };

function hiddenCount(entry) {
  return entry.redactionsCount ?? entry.redactions ?? 0;
}

function siteOf(entry) {
  if (!entry.url) return entry.task ? "Agent step" : "This device";
  try {
    return new URL(entry.url).hostname.replace(/^www\./, "");
  } catch {
    return entry.url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function timeOf(value) {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? "—"
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function renderHistory() {
  const logs = await getAuditLogs();
  paintLifetime(logs);

  if (logs.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "td-empty";
    cell.textContent = "Nothing covered yet.";
    row.append(cell);
    auditTableBody.replaceChildren(row);
    return;
  }

  auditTableBody.replaceChildren(...logs.slice(0, 50).map(historyRow));
}

function historyRow(entry) {
  const hidden = hiddenCount(entry);
  const backend = String(entry.backend || "").toLowerCase();

  const cells = [
    [timeOf(entry.timestamp), ""],
    [siteOf(entry), "site"],
    [String(hidden), hidden > 0 ? "num" : ""],
    [BACKEND_LABELS[backend] || entry.backend || "—", ""],
    [entry.latencyMs ? Math.round(entry.latencyMs) + " ms" : "—", "num"],
  ];

  const row = document.createElement("tr");
  for (const [text, className] of cells) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = text;
    row.append(cell);
  }
  return row;
}

// The one number worth putting next to the headline.
function paintLifetime(logs) {
  const total = logs.reduce((sum, entry) => sum + hiddenCount(entry), 0);

  if (total === 0) {
    lifetimeStat.textContent = "Nothing has needed hiding yet.";
    return;
  }

  const sites = new Set(logs.filter((entry) => entry.url).map(siteOf));
  const things = total === 1 ? "thing" : "things";

  lifetimeStat.textContent =
    sites.size > 0
      ? `${total} ${things} hidden across ${sites.size} ${
          sites.size === 1 ? "site" : "sites"
        }.`
      : `${total} ${things} hidden so far.`;
}

/* ── Exports and reset ───────────────────────────────────────────────────── */

const stamp = () => new Date().toISOString().slice(0, 10);

btnExportJson.addEventListener("click", async () => {
  const logs = await getAuditLogs();
  download(
    new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" }),
    `privacy-agent-history-${stamp()}.json`
  );
});

// A site name comes off a page, so it is quoted and defused before export.
function csvCell(value) {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

btnExportCsv.addEventListener("click", async () => {
  const logs = await getAuditLogs();
  const rows = [
    ["Time", "Site", "Hidden", "Ran on", "Took (ms)"],
    ...logs.map((entry) => [
      entry.timestamp,
      siteOf(entry),
      hiddenCount(entry),
      entry.backend || "",
      entry.latencyMs ? Math.round(entry.latencyMs) : 0,
    ]),
  ];

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  download(new Blob([csv], { type: "text/csv" }), `privacy-agent-history-${stamp()}.csv`);
});

btnClearLogs.addEventListener("click", async () => {
  if (!confirm("Clear the history kept on this device?")) return;
  await clearAuditLogs();
  await renderHistory();
  whisper("History cleared");
});

btnReset.addEventListener("click", async () => {
  if (!confirm("Put every setting back to its default?")) return;
  await resetSettings();
  location.reload();
});

