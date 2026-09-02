const statusEl = document.getElementById("status");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.getElementById("openHud").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_HUD" });
  window.close();
});

document.getElementById("openDemo").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("demo.html") });
  window.close();
});

document.getElementById("scan").addEventListener("click", async () => {
  statusEl.textContent = "Scanning...";
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    statusEl.textContent = "No active tab.";
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "SCAN" }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Could not reach page (try reloading).";
      return;
    }
    statusEl.textContent = `Found ${response?.count || 0} sensitive field(s).`;
  });
});

document.getElementById("clear").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "CLEAR" }, () => {
    statusEl.textContent = "Overlay cleared.";
  });
});
