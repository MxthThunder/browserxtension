/**
 * popup.js — thin control surface.
 *
 * The heavy demo lives in the HUD; this exists so the Day 1 "highlight the
 * sensitive fields on any page" trick still works in one click, which is a
 * fast and reliable opener before the full pipeline runs.
 */

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
    });
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
    });
  });
}

// --- status ---------------------------------------------------------------

(async function initStatus() {
  const s = await send({ type: "GET_STATUS" });
  const badge = $("backend");
  if (!s?.ok) { badge.textContent = "error"; return; }
  if (!s.modelReady) {
    badge.textContent = s.loadError ? "failed" : "loading";
    badge.className = "badge none";
    if (s.loadError) status("Model failed to load. Run tools/vendor-deps.mjs and reload the extension.");
    return;
  }
  badge.textContent = s.executionProvider;
  badge.className = `badge ${s.executionProvider === "webgpu" ? "webgpu" : "wasm"}`;
  $("loadMs").textContent = s.modelLoadMs ? `${Math.round(s.modelLoadMs)} ms` : "—";
})();

// --- actions --------------------------------------------------------------

$("scan").addEventListener("click", async () => {
  const tab = await activeTab();
  if (/^(chrome|edge|about|moz-extension|chrome-extension):/.test(tab.url || "")) {
    status("Content scripts can't run on browser internal pages. Open a normal site.");
    return;
  }
  const res = await sendToTab(tab.id, { type: "SHOW_OVERLAY" });
  if (!res?.ok) { status(`Couldn't reach the page — try reloading it. (${res?.error || ""})`); return; }

  const byLayer = {};
  for (const b of res.boxes || []) byLayer[b.layer] = (byLayer[b.layer] || 0) + 1;
  const detail = Object.entries(byLayer).map(([k, v]) => `${k}:${v}`).join("  ");
  status(`${res.count} sensitive region(s).  ${detail}`);
});

$("clear").addEventListener("click", async () => {
  const tab = await activeTab();
  await sendToTab(tab.id, { type: "CLEAR_OVERLAY" });
  status("Highlights cleared.");
});

$("hud").addEventListener("click", async () => {
  await send({ type: "OPEN_HUD" });
  window.close();
});
