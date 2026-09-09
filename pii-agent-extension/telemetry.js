/**
 * Real-Time Telemetry & Diagnostic Logger (Zero-Leakage Extension)
 * 
 * Streams events simultaneously to:
 * 1. FastAPI Terminal (via http://127.0.0.1:8001/api/log)
 * 2. Extension UI Activity Log (via chrome.runtime.sendMessage)
 * 3. Browser DevTools Console
 */

export function logEvent(source, message, details = null, level = "info") {
  const t = new Date().toLocaleTimeString();
  const formatted = `[${source.toUpperCase()}] ${message}`;

  if (level === "error") {
    console.error(formatted, details || "");
  } else if (level === "warn") {
    console.warn(formatted, details || "");
  } else {
    console.log(formatted, details || "");
  }

  // 1. Broadcast to Extension UI (popup / side panel)
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: "TELEMETRY_LOG",
        source,
        message,
        level,
        details,
        timestamp: t,
      }).catch(() => {});
    }
  } catch {}

  // 2. Broadcast to FastAPI Terminal (fire-and-forget)
  try {
    fetch("http://127.0.0.1:8001/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, level, message, details }),
    }).catch(() => {});
  } catch {}
}
