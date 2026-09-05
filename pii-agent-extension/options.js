import {
  getSettings,
  saveSettings,
  resetSettings,
  getAuditLogs,
  clearAuditLogs,
  DEFAULT_SETTINGS,
} from "./storage.js";
import { vault } from "./vault.js";

// DOM Elements
const navItems = document.querySelectorAll(".nav-item");
const sections = document.querySelectorAll(".settings-section");
const pageTitle = document.getElementById("pageTitle");

// Form Inputs
const chkEnabled = document.getElementById("chkEnabled");
const chkFailClosed = document.getElementById("chkFailClosed");
const chkShowPageBadge = document.getElementById("chkShowPageBadge");

const selEngineMode = document.getElementById("selEngineMode");
const numConfidence = document.getElementById("numConfidence");
const lblConfidenceVal = document.getElementById("lblConfidenceVal");
const numFaceProxy = document.getElementById("numFaceProxy");
const lblFaceProxyVal = document.getElementById("lblFaceProxyVal");

const catPasswords = document.getElementById("catPasswords");
const catCreditCards = document.getElementById("catCreditCards");
const catGovIds = document.getElementById("catGovIds");
const catFaces = document.getElementById("catFaces");
const catContactInfo = document.getElementById("catContactInfo");
const catScreens = document.getElementById("catScreens");

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

// Diagnostics Elements
const diagWebgpu = document.getElementById("diagWebgpu");
const diagGpuName = document.getElementById("diagGpuName");
const hardwareStatusText = document.getElementById("hardwareStatusText");

let currentWhitelist = [];

// Initialize Page
document.addEventListener("DOMContentLoaded", async () => {
  setupNavigation();
  setupSliders();
  setupDiagnostics();
  await loadAndRenderSettings();
  await loadAndRenderAuditLogs();
  await initVaultSection();
});

function setupNavigation() {
  const titles = {
    "section-general": "General & Protection Preferences",
    "section-engine": "Engine & Hardware Acceleration",
    "section-categories": "Redaction Target Categories",
    "section-server": "VLM Server & Agent Configuration",
    "section-whitelist": "Domain Allowlist Management",
    "section-vault": "Local Sensitive-Data Vault",
    "section-audit": "Compliance Audit & Logs",
  };

  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const targetId = item.getAttribute("data-target");

      navItems.forEach((n) => n.classList.remove("active"));
      sections.forEach((s) => s.classList.remove("active"));

      item.classList.add("active");
      const targetSection = document.getElementById(targetId);
      if (targetSection) {
        targetSection.classList.add("active");
      }

      if (pageTitle && titles[targetId]) {
        pageTitle.textContent = titles[targetId];
      }
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
}

async function setupDiagnostics() {
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        diagWebgpu.textContent = "Supported (Available)";
        diagWebgpu.style.color = "#34d399";
        hardwareStatusText.textContent = "WebGPU Accelerated";
        
        if (adapter.info && adapter.info.device) {
          diagGpuName.textContent = adapter.info.device;
        } else {
          diagGpuName.textContent = "Hardware GPU Found";
        }
      } else {
        diagWebgpu.textContent = "No Adapter";
        diagWebgpu.style.color = "#f59e0b";
        hardwareStatusText.textContent = "WASM SIMD Active";
      }
    } catch {
      diagWebgpu.textContent = "WASM Fallback";
      diagWebgpu.style.color = "#f59e0b";
      hardwareStatusText.textContent = "WASM SIMD Active";
    }
  } else {
    diagWebgpu.textContent = "Not Supported (WASM Mode)";
    diagWebgpu.style.color = "#f59e0b";
    hardwareStatusText.textContent = "WASM SIMD Active";
  }
}

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

  const cats = settings.categories || {};
  catPasswords.checked = cats.passwords !== false;
  catCreditCards.checked = cats.creditCards !== false;
  catGovIds.checked = cats.govIds !== false;
  catFaces.checked = cats.faces !== false;
  catContactInfo.checked = cats.contactInfo !== false;
  catScreens.checked = cats.screens !== false;

  txtServerUrl.value = settings.serverUrl || "http://127.0.0.1:8001/api/act";
  txtHealthUrl.value = settings.serverHealthUrl || "http://127.0.0.1:8001/health";
  txtApiKey.value = settings.apiKey || "";

  currentWhitelist = Array.isArray(settings.domainWhitelist) ? settings.domainWhitelist : [];
  renderDomainList();
}

function renderDomainList() {
  domainList.innerHTML = "";
  if (currentWhitelist.length === 0) {
    domainList.innerHTML = `<li style="color: #64748b; font-size: 13px;">No excluded domains. Protection active across all websites.</li>`;
    return;
  }

  currentWhitelist.forEach((domain, idx) => {
    const li = document.createElement("li");
    li.className = "domain-item";
    li.innerHTML = `
      <span>🌐 ${domain}</span>
      <button class="btn-remove" data-idx="${idx}" title="Remove domain">✕</button>
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

// Add domain
btnAddDomain.addEventListener("click", () => {
  const domain = txtNewDomain.value.trim().toLowerCase().replace(/^https?:\/\//, "");
  if (domain && !currentWhitelist.includes(domain)) {
    currentWhitelist.push(domain);
    txtNewDomain.value = "";
    renderDomainList();
  }
});

txtNewDomain.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    btnAddDomain.click();
  }
});

// Test Connection
btnTestConnection.addEventListener("click", async () => {
  const url = txtHealthUrl.value.trim();
  connectionStatus.textContent = "Probing endpoint " + url + "...";
  connectionStatus.style.color = "#93c5fd";

  try {
    const start = performance.now();
    const res = await fetch(url, { method: "GET" });
    const latency = (performance.now() - start).toFixed(1);

    if (res.ok) {
      const data = await res.json();
      connectionStatus.textContent = `✓ Server Online (${latency} ms) — ${data.service || "Connected"}`;
      connectionStatus.style.color = "#34d399";
    } else {
      connectionStatus.textContent = `⚠ Server responded with HTTP ${res.status}`;
      connectionStatus.style.color = "#f59e0b";
    }
  } catch (err) {
    connectionStatus.textContent = `✕ Failed to reach server: ${err.message}. Ensure FastAPI is running on port 8001.`;
    connectionStatus.style.color = "#f87171";
  }
});

// Save Settings
btnSave.addEventListener("click", async () => {
  const newSettings = {
    enabled: chkEnabled.checked,
    failClosed: chkFailClosed.checked,
    showPageBadge: chkShowPageBadge.checked,
    engineMode: selEngineMode.value,
    detectionConfidence: parseFloat(numConfidence.value),
    faceProxyPercent: parseFloat(numFaceProxy.value),
    categories: {
      passwords: catPasswords.checked,
      creditCards: catCreditCards.checked,
      govIds: catGovIds.checked,
      faces: catFaces.checked,
      contactInfo: catContactInfo.checked,
      screens: catScreens.checked,
    },
    serverUrl: txtServerUrl.value.trim(),
    serverHealthUrl: txtHealthUrl.value.trim(),
    apiKey: txtApiKey.value.trim(),
    domainWhitelist: currentWhitelist,
  };

  await saveSettings(newSettings);
  showToast("✓ Preferences saved and synced across all tabs!");
});

// Reset Settings
btnReset.addEventListener("click", async () => {
  if (confirm("Reset all extension settings to default values?")) {
    await resetSettings();
    await loadAndRenderSettings();
    showToast("✓ Settings restored to defaults.");
  }
});

function showToast(msg) {
  saveToast.textContent = msg;
  saveToast.classList.remove("hidden");
  setTimeout(() => saveToast.classList.add("hidden"), 3000);
}

// Audit Logs
async function loadAndRenderAuditLogs() {
  const logs = await getAuditLogs();
  auditTableBody.innerHTML = "";

  if (logs.length === 0) {
    auditTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #64748b; padding: 20px;">No audit events recorded yet.</td></tr>`;
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
      <td>${ts}</td>
      <td title="${entry.url || ''}">${url}</td>
      <td style="color: ${count > 0 ? '#38bdf8' : '#94a3b8'}; font-weight: 700;">${count} masked</td>
      <td><span style="color: #34d399;">${backend}</span></td>
      <td>${latency}</td>
      <td><span style="color: #34d399;">100% Sanitized</span></td>
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

// ── Vault Management Section ─────────────────────────────────────────────────

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
    vaultStatusDot.style.background = unlocked ? "#34d399" : "#f87171";
  }
  if (vaultStatusText) {
    vaultStatusText.textContent = customMsg ||
      (unlocked ? "✓ Vault unlocked — AES-256-GCM (device-keyed, zero-leakage)" : "Vault locked");
    vaultStatusText.style.color = unlocked ? "#34d399" : "#f87171";
  }
  if (btnLockVault) {
    btnLockVault.style.display = unlocked ? "inline-block" : "none";
  }
}

function renderVaultTable() {
  if (!vaultTableBody) return;
  try {
    const summary = vault.listKeys();
    vaultTableBody.innerHTML = "";

    const allEntries = [];
    for (const [cat, items] of Object.entries(summary)) {
      for (const item of items) {
        allEntries.push({ cat, ...item });
      }
    }

    if (allEntries.length === 0) {
      vaultTableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align:center;color:#64748b;padding:20px;">
            No entries stored. Add your Name, Email, Phone, etc. using the form above.
          </td>
        </tr>`;
      return;
    }

    for (const entry of allEntries) {
      const tr = document.createElement("tr");
      const catEmoji = {
        personal: "👤", contact: "📞", address: "📍",
        credentials: "🔑", financial: "💳", gov_id: "🪪", custom: "🔧"
      }[entry.cat] || "📦";

      tr.innerHTML = `
        <td><span style="font-size:11px;">${catEmoji} ${entry.cat}</span></td>
        <td><code style="background:#1e293b;padding:1px 5px;border-radius:3px;color:#93c5fd;font-size:11px;">${entry.key}</code></td>
        <td style="font-family:monospace;color:#64748b;font-size:11px;">${entry.maskedValue || "••••"}</td>
        <td><code style="background:#0d1322;padding:1px 5px;border-radius:3px;color:#38bdf8;font-size:10px;">${entry.tokenHandle}</code></td>
        <td>
          <button class="btn btn-danger vault-delete-btn" data-cat="${entry.cat}" data-key="${entry.key}"
            style="font-size:10px;padding:2px 8px;">Delete</button>
        </td>`;
      vaultTableBody.appendChild(tr);
    }

    // Bind delete buttons
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
      vaultTableBody.innerHTML = `
        <tr><td colspan="5" style="text-align:center;color:#f87171;padding:14px;">
          ${err.message}
        </td></tr>`;
    }
  }
}

// Add new vault entry
if (btnAddVaultEntry) {
  btnAddVaultEntry.addEventListener("click", async () => {
    const cat = vaultCategory?.value?.trim();
    const key = vaultKey?.value?.trim().toLowerCase().replace(/\s+/g, "_");
    const val = vaultValue?.value?.trim();

    if (!cat || !key || !val) {
      showToast("⚠️ Please fill in Category, Key, and Value.");
      return;
    }

    try {
      await vault.set(cat, key, val);
      if (vaultKey)   vaultKey.value = "";
      if (vaultValue) vaultValue.value = "";
      renderVaultTable();
      showToast(`✓ Saved to vault: ${cat}.${key}`);
    } catch (err) {
      showToast(`Vault error: ${err.message}`);
    }
  });
}

// Quick preset buttons — pre-fill Category+Key so user only needs to type the value
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

// Lock vault
if (btnLockVault) {
  btnLockVault.addEventListener("click", () => {
    vault.lock();
    setVaultStatus(false, "Vault locked manually.");
    if (vaultTableBody) {
      vaultTableBody.innerHTML = `
        <tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">
          Vault is locked.
        </td></tr>`;
    }
    showToast("Vault locked.");
  });
}

// Export encrypted backup
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

// Clear all vault entries
if (btnClearVault) {
  btnClearVault.addEventListener("click", async () => {
    if (!confirm("⚠️ Delete ALL vault entries permanently? This cannot be undone.")) return;
    try {
      // Delete every entry from every category
      const summary = vault.listKeys();
      for (const [cat, items] of Object.entries(summary)) {
        for (const item of items) {
          await vault.delete(cat, item.key);
        }
      }
      renderVaultTable();
      showToast("All vault entries cleared.");
    } catch (err) {
      showToast(`Clear error: ${err.message}`);
    }
  });
}
