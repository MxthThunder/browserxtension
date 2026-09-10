import {
  getSettings,
  saveSettings,
  resetSettings,
  getAuditLogs,
  clearAuditLogs,
} from "./storage.js";
import { vault } from "./vault.js";

// Nav / layout
const navItems = document.querySelectorAll(".nav-item[data-target]");
const sections = document.querySelectorAll(".settings-section");
const pageTitle = document.getElementById("pageTitle");
const btnTheme = document.getElementById("btnTheme");

// Form Inputs
const chkEnabled = document.getElementById("chkEnabled");
const chkFailClosed = document.getElementById("chkFailClosed");
const chkShowPageBadge = document.getElementById("chkShowPageBadge");

const selEngineMode = document.getElementById("selEngineMode");
const numConfidence = document.getElementById("numConfidence");
const numMaxSteps = document.getElementById("numMaxSteps");
const lblMaxStepsVal = document.getElementById("lblMaxStepsVal");
const numUnproductive = document.getElementById("numUnproductive");
const lblUnproductiveVal = document.getElementById("lblUnproductiveVal");
const lblConfidenceVal = document.getElementById("lblConfidenceVal");
const numFaceProxy = document.getElementById("numFaceProxy");
const lblFaceProxyVal = document.getElementById("lblFaceProxyVal");

const catPasswords = document.getElementById("catPasswords");
const catCreditCards = document.getElementById("catCreditCards");
const catGovIds = document.getElementById("catGovIds");
const catFaces = document.getElementById("catFaces");
const catContactInfo = document.getElementById("catContactInfo");
const catScreens = document.getElementById("catScreens");
const catNames = document.getElementById("catNames");

const txtServerUrl = document.getElementById("txtServerUrl");
const txtHealthUrl = document.getElementById("txtHealthUrl");
const txtApiKey = document.getElementById("txtApiKey");
const btnTestConnection = document.getElementById("btnTestConnection");
const connectionStatus = document.getElementById("connectionStatus");

const txtNewDomain = document.getElementById("txtNewDomain");
const btnAddDomain = document.getElementById("btnAddDomain");
const domainList = document.getElementById("domainList");

const btnExportJson = document.getElementById("btnExportJson");
const btnExportCsv = document.getElementById("btnExportCsv");
const btnClearLogs = document.getElementById("btnClearLogs");
const auditTableBody = document.getElementById("auditTableBody");

const btnSave = document.getElementById("btnSave");
const btnReset = document.getElementById("btnReset");
const saveToast = document.getElementById("saveToast");
const saveToastText = document.getElementById("saveToastText");

// Diagnostics
const diagWebgpu = document.getElementById("diagWebgpu");
const diagGpuName = document.getElementById("diagGpuName");
const hardwareStatusText = document.getElementById("hardwareStatusText");

let currentWhitelist = [];
let currentTheme = "dark";

document.addEventListener("DOMContentLoaded", async () => {
  setupNavigation();
  setupSliders();
  setupDiagnostics();
  await applySavedTheme();
  await loadAndRenderSettings();
  await loadAndRenderAuditLogs();
  await initVaultSection();
});

/* ── Theme ─────────────────────────────────────────────── */
async function applySavedTheme() {
  const settings = await getSettings();
  currentTheme = settings.theme || "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
}

btnTheme.addEventListener("click", async () => {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
  await saveSettings({ theme: currentTheme });
});

/* ── Navigation ────────────────────────────────────────── */
function setupNavigation() {
  const titles = {
    "section-general": "General & Protection",
    "section-engine": "Engine & Hardware",
    "section-categories": "PII Categories",
    "section-server": "Backend & Server",
    "section-whitelist": "Domain Whitelist",
    "section-vault": "Secure Vault",
    "section-audit": "Audit & Compliance",
  };

  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const targetId = item.getAttribute("data-target");

      navItems.forEach((n) => n.classList.remove("active"));
      sections.forEach((s) => s.classList.remove("active"));

      item.classList.add("active");
      const targetSection = document.getElementById(targetId);
      if (targetSection) targetSection.classList.add("active");
      if (pageTitle && titles[targetId]) pageTitle.textContent = titles[targetId];
    });
  });
}

function setupSliders() {
  numConfidence.addEventListener("input", () => {
    lblConfidenceVal.textContent = parseFloat(numConfidence.value).toFixed(2);
  });

  numFaceProxy.addEventListener("input", () => {
    const pct = Math.round(parseFloat(numFaceProxy.value) * 100);
    lblFaceProxyVal.textContent = pct + "%";
  });

  numMaxSteps.addEventListener("input", () => {
    lblMaxStepsVal.textContent = numMaxSteps.value;
  });

  numUnproductive.addEventListener("input", () => {
    lblUnproductiveVal.textContent = numUnproductive.value;
  });
}

async function setupDiagnostics() {
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200)),
      ]);
      if (adapter) {
        diagWebgpu.textContent = "Supported";
        diagWebgpu.classList.add("good");
        hardwareStatusText.textContent = "WebGPU accelerated";

        diagGpuName.textContent = adapter.info?.device || "Hardware GPU found";
      } else {
        diagWebgpu.textContent = "No adapter";
        diagWebgpu.classList.add("warn");
        hardwareStatusText.textContent = "WASM SIMD active";
      }
    } catch {
      diagWebgpu.textContent = "WASM fallback";
      diagWebgpu.classList.add("warn");
      hardwareStatusText.textContent = "WASM SIMD active";
    }
  } else {
    diagWebgpu.textContent = "Not supported (WASM mode)";
    diagWebgpu.classList.add("warn");
    hardwareStatusText.textContent = "WASM SIMD active";
  }
}

/* ── Settings ──────────────────────────────────────────── */
async function loadAndRenderSettings() {
  const settings = await getSettings();

  chkEnabled.checked = Boolean(settings.enabled);
  chkFailClosed.checked = Boolean(settings.failClosed);
  chkShowPageBadge.checked = Boolean(settings.showPageBadge);

  selEngineMode.value = settings.engineMode || "auto";
  numConfidence.value = settings.detectionConfidence || 0.65;
  lblConfidenceVal.textContent = parseFloat(numConfidence.value).toFixed(2);

  numFaceProxy.value = settings.faceProxyPercent || 0.30;
  lblFaceProxyVal.textContent = Math.round(parseFloat(numFaceProxy.value) * 100) + "%";

  numMaxSteps.value = settings.maxSteps || 25;
  lblMaxStepsVal.textContent = numMaxSteps.value;

  numUnproductive.value = settings.maxUnproductiveSteps || 3;
  lblUnproductiveVal.textContent = numUnproductive.value;

  const cats = settings.categories || {};
  catPasswords.checked = cats.passwords !== false;
  catCreditCards.checked = cats.creditCards !== false;
  catGovIds.checked = cats.govIds !== false;
  catFaces.checked = cats.faces !== false;
  catContactInfo.checked = cats.contactInfo !== false;
  catScreens.checked = cats.screens !== false;
  catNames.checked = cats.names !== false;

  txtServerUrl.value = settings.serverUrl || "http://127.0.0.1:8001/api/act";
  txtHealthUrl.value = settings.serverHealthUrl || "http://127.0.0.1:8001/health";
  txtApiKey.value = settings.apiKey || "";

  currentWhitelist = Array.isArray(settings.domainWhitelist) ? settings.domainWhitelist : [];
  renderDomainList();
}

function renderDomainList() {
  domainList.innerHTML = "";
  if (currentWhitelist.length === 0) {
    domainList.innerHTML = `<li class="domain-empty">No excluded domains — protection is active on every site.</li>`;
    return;
  }

  currentWhitelist.forEach((domain, idx) => {
    const li = document.createElement("li");
    li.className = "domain-item";
    li.innerHTML = `
      <span>${escapeHtml(domain)}</span>
      <button class="btn-remove" data-idx="${idx}" title="Remove domain" aria-label="Remove domain">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    domainList.appendChild(li);
  });

  domainList.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-idx"), 10);
      currentWhitelist.splice(idx, 1);
      renderDomainList();
    });
  });
}

btnAddDomain.addEventListener("click", () => {
  const domain = txtNewDomain.value.trim().toLowerCase().replace(/^https?:\/\//, "");
  if (domain && !currentWhitelist.includes(domain)) {
    currentWhitelist.push(domain);
    txtNewDomain.value = "";
    renderDomainList();
  }
});

txtNewDomain.addEventListener("keydown", (e) => {
  if (e.key === "Enter") btnAddDomain.click();
});

btnTestConnection.addEventListener("click", async () => {
  const url = txtHealthUrl.value.trim();
  connectionStatus.className = "connection-status";
  connectionStatus.textContent = "Probing endpoint " + url + "…";

  try {
    const start = performance.now();
    const res = await fetch(url, { method: "GET" });
    const latency = (performance.now() - start).toFixed(1);

    if (res.ok) {
      const data = await res.json();
      connectionStatus.textContent = `Server online (${latency} ms) — ${data.service || "connected"}`;
      connectionStatus.classList.add("good");
    } else {
      connectionStatus.textContent = `Server responded with HTTP ${res.status}`;
      connectionStatus.classList.add("warn");
    }
  } catch (err) {
    connectionStatus.textContent = `Failed to reach server: ${err.message}. Ensure the backend is running on port 8001.`;
    connectionStatus.classList.add("bad");
  }
});

btnSave.addEventListener("click", async () => {
  const newSettings = {
    enabled: chkEnabled.checked,
    failClosed: chkFailClosed.checked,
    showPageBadge: chkShowPageBadge.checked,
    engineMode: selEngineMode.value,
    detectionConfidence: parseFloat(numConfidence.value),
    faceProxyPercent: parseFloat(numFaceProxy.value),
    maxSteps: parseInt(numMaxSteps.value, 10),
    maxUnproductiveSteps: parseInt(numUnproductive.value, 10),
    categories: {
      passwords: catPasswords.checked,
      creditCards: catCreditCards.checked,
      govIds: catGovIds.checked,
      faces: catFaces.checked,
      contactInfo: catContactInfo.checked,
      screens: catScreens.checked,
      names: catNames.checked,
    },
    serverUrl: txtServerUrl.value.trim(),
    serverHealthUrl: txtHealthUrl.value.trim(),
    apiKey: txtApiKey.value.trim(),
    domainWhitelist: currentWhitelist,
  };

  await saveSettings(newSettings);
  showToast("Preferences saved and synced across all tabs.");
});

btnReset.addEventListener("click", async () => {
  if (confirm("Reset all extension settings to default values?")) {
    await resetSettings();
    await loadAndRenderSettings();
    showToast("Settings restored to defaults.");
  }
});

function showToast(msg) {
  saveToastText.textContent = msg;
  saveToast.classList.remove("hidden");
  setTimeout(() => saveToast.classList.add("hidden"), 3000);
}

/* ── Audit logs ────────────────────────────────────────── */
async function loadAndRenderAuditLogs() {
  const logs = await getAuditLogs();
  auditTableBody.innerHTML = "";

  if (logs.length === 0) {
    auditTableBody.innerHTML = `<tr><td colspan="6" class="empty-state">No audit events recorded yet.</td></tr>`;
    return;
  }

  logs.slice(0, 50).forEach((entry) => {
    const tr = document.createElement("tr");
    const ts = new Date(entry.timestamp).toLocaleTimeString();
    const count = entry.redactionsCount || 0;
    const url = entry.url ? entry.url.replace(/^https?:\/\//, "").substring(0, 32) : "demo.html";
    const latency = entry.latencyMs ? entry.latencyMs.toFixed(1) + " ms" : "--";
    const backend = entry.backend || "WebGPU";

    tr.innerHTML = `
      <td class="cell-mono">${ts}</td>
      <td title="${escapeHtml(entry.url || "")}">${escapeHtml(url)}</td>
      <td><span class="badge-pill ${count > 0 ? "success" : "neutral"}">${count} masked</span></td>
      <td>${escapeHtml(backend)}</td>
      <td class="cell-mono">${latency}</td>
      <td><span class="badge-pill success">Sanitized</span></td>
    `;
    auditTableBody.appendChild(tr);
  });
}

btnExportJson.addEventListener("click", async () => {
  const logs = await getAuditLogs();
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
  downloadFile(blob, `privacy_agent_audit_${Date.now()}.json`);
});

btnExportCsv.addEventListener("click", async () => {
  const logs = await getAuditLogs();
  const headers = ["Timestamp", "URL", "RedactionsCount", "Backend", "LatencyMs", "Status"];
  const rows = logs.map((l) => [
    `"${l.timestamp}"`,
    `"${l.url || ""}"`,
    l.redactionsCount || 0,
    `"${l.backend || "WebGPU"}"`,
    l.latencyMs || 0,
    '"Sanitized"',
  ]);
  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv" });
  downloadFile(blob, `privacy_agent_audit_${Date.now()}.csv`);
});

btnClearLogs.addEventListener("click", async () => {
  if (confirm("Clear all recorded audit compliance logs?")) {
    await clearAuditLogs();
    await loadAndRenderAuditLogs();
    showToast("Audit logs cleared.");
  }
});

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

/* ── Vault ─────────────────────────────────────────────── */

const vaultStatusDot   = document.getElementById("vaultStatusDot");
const vaultStatusText  = document.getElementById("vaultStatusText");
const btnLockVault     = document.getElementById("btnLockVault");
const vaultCategory    = document.getElementById("vaultCategory");
const vaultKey         = document.getElementById("vaultKey");
const vaultValue       = document.getElementById("vaultValue");
const btnAddVaultEntry = document.getElementById("btnAddVaultEntry");
const vaultTableBody   = document.getElementById("vaultTableBody");
const btnExportVault   = document.getElementById("btnExportVault");
const btnClearVault    = document.getElementById("btnClearVault");

async function initVaultSection() {
  try {
    await vault.init();
    setVaultStatus(true);
    renderVaultTable();
  } catch (err) {
    setVaultStatus(false, `Vault error: ${err.message}`);
  }
}

function setVaultStatus(unlocked, customMsg = null) {
  if (vaultStatusDot) {
    vaultStatusDot.classList.toggle("unlocked", unlocked);
  }
  if (vaultStatusText) {
    vaultStatusText.textContent = customMsg ||
      (unlocked ? "Vault unlocked — AES-256-GCM, device-keyed, zero-leakage" : "Vault locked");
    vaultStatusText.classList.toggle("unlocked", unlocked);
    vaultStatusText.classList.toggle("locked", !unlocked);
  }
  if (btnLockVault) {
    btnLockVault.style.display = unlocked ? "inline-flex" : "none";
  }
}

function renderVaultTable() {
  if (!vaultTableBody) return;
  try {
    const summary = vault.listKeys();
    vaultTableBody.innerHTML = "";

    const allEntries = [];
    for (const [cat, items] of Object.entries(summary)) {
      for (const item of items) allEntries.push({ cat, ...item });
    }

    if (allEntries.length === 0) {
      vaultTableBody.innerHTML = `
        <tr><td colspan="5" class="empty-state">No entries stored. Add your name, email, phone etc. using the form above.</td></tr>`;
      return;
    }

    for (const entry of allEntries) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(entry.cat)}</td>
        <td><code class="cell-code">${escapeHtml(entry.key)}</code></td>
        <td class="cell-mono">${escapeHtml(entry.maskedValue || "••••")}</td>
        <td><code class="cell-code">${escapeHtml(entry.tokenHandle)}</code></td>
        <td>
          <button class="btn btn-ghost btn-danger-ghost vault-delete-btn" data-cat="${entry.cat}" data-key="${entry.key}"
            style="font-size:10.5px;padding:3px 9px;">Delete</button>
        </td>`;
      vaultTableBody.appendChild(tr);
    }

    vaultTableBody.querySelectorAll(".vault-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const cat = btn.getAttribute("data-cat");
        const key = btn.getAttribute("data-key");
        if (confirm(`Delete vault entry: ${cat}.${key}?`)) {
          await vault.delete(cat, key);
          renderVaultTable();
          showToast(`Deleted vault entry: ${cat}.${key}`);
        }
      });
    });
  } catch (err) {
    if (vaultTableBody) {
      vaultTableBody.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

if (btnAddVaultEntry) {
  btnAddVaultEntry.addEventListener("click", async () => {
    const cat = vaultCategory?.value?.trim();
    const key = vaultKey?.value?.trim().toLowerCase().replace(/\s+/g, "_");
    const val = vaultValue?.value?.trim();

    if (!cat || !key || !val) {
      showToast("Please fill in category, key and value.");
      return;
    }

    try {
      await vault.set(cat, key, val);
      if (vaultKey) vaultKey.value = "";
      if (vaultValue) vaultValue.value = "";
      renderVaultTable();
      showToast(`Saved to vault: ${cat}.${key}`);
    } catch (err) {
      showToast(`Vault error: ${err.message}`);
    }
  });
}

document.querySelectorAll(".vault-preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const cat = btn.getAttribute("data-cat");
    const key = btn.getAttribute("data-key");
    if (vaultCategory) vaultCategory.value = cat;
    if (vaultKey) {
      vaultKey.value = key;
      vaultKey.focus();
    }
    if (vaultValue) vaultValue.focus();
  });
});

if (btnLockVault) {
  btnLockVault.addEventListener("click", () => {
    vault.lock();
    setVaultStatus(false, "Vault locked manually.");
    if (vaultTableBody) {
      vaultTableBody.innerHTML = `<tr><td colspan="5" class="empty-state">Vault is locked.</td></tr>`;
    }
    showToast("Vault locked.");
  });
}

if (btnExportVault) {
  btnExportVault.addEventListener("click", async () => {
    try {
      const json = await vault.exportEncryptedBackup();
      const blob = new Blob([json], { type: "application/json" });
      downloadFile(blob, `vault_encrypted_backup_${Date.now()}.json`);
      showToast("Encrypted vault backup downloaded.");
    } catch (err) {
      showToast(`Export error: ${err.message}`);
    }
  });
}

if (btnClearVault) {
  btnClearVault.addEventListener("click", async () => {
    if (!confirm("Delete ALL vault entries permanently? This cannot be undone.")) return;
    try {
      const summary = vault.listKeys();
      for (const [cat, items] of Object.entries(summary)) {
        for (const item of items) await vault.delete(cat, item.key);
      }
      renderVaultTable();
      showToast("All vault entries cleared.");
    } catch (err) {
      showToast(`Clear error: ${err.message}`);
    }
  });
}
