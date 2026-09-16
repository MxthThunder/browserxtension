/**
 * ws_intercept.js — WebSocket Monkey-Patch (document_start)
 *
 * This file ONLY patches window.WebSocket. It must run at document_start
 * so the patch is in place before the page creates any WebSocket connections.
 *
 * It is intentionally kept separate from content.js (which runs at document_idle
 * and needs a fully parsed DOM). Mixing document_start and DOM access causes
 * null-reference errors and degrades scan quality.
 *
 * Message chain:
 *   WS frame → window.postMessage(PRIVIBROWSE_TELEMETRY_FRAME) [for data_adapter]
 *            → chrome.runtime.sendMessage(PRIVIBROWSE_WS_FRAME_INTERCEPTED) [for HUD]
 */

(function patchWebSocket() {
  const _NativeWS = window.WebSocket;
  if (!_NativeWS || window.__PRIVIBROWSE_WS_PATCHED__) return;
  window.__PRIVIBROWSE_WS_PATCHED__ = true;

  function PriviBrowseWebSocket(url, protocols) {
    const ws = protocols ? new _NativeWS(url, protocols) : new _NativeWS(url);

    ws.addEventListener("message", (evt) => {
      try {
        // Only forward parseable JSON frames — binary/non-JSON WS traffic is left alone
        const data = typeof evt.data === "string" ? JSON.parse(evt.data) : null;
        if (!data || typeof data !== "object") return;

        // Determine if this looks like telemetry (has known telemetry signals)
        const isTelemetry =
          data.channels || data.mnemonic || data.spacecraft ||
          data.met_seconds !== undefined || Array.isArray(data);

        if (!isTelemetry) return;

        // Normalize to the adapter's expected format
        const payload = data.channels ? data.channels : data;

        // Path 1: window.postMessage → data_adapter.js (same-page listener)
        window.postMessage({
          type: "PRIVIBROWSE_TELEMETRY_FRAME",
          payload,
          fullFrame: data,
          wsUrl: url,
          ts: Date.now(),
        }, "*");

        // Path 2: chrome.runtime.sendMessage → background.js → HUD
        try {
          if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage({
              type: "PRIVIBROWSE_WS_FRAME_INTERCEPTED",
              fullFrame: data,
              wsUrl: url,
              byteLength: typeof evt.data === "string" ? evt.data.length : 0,
              ts: Date.now(),
            }).catch(() => {}); // background may not be ready yet — safe to ignore
          }
        } catch (_) {}

        // Path 3: DOM marking — flag elements whose textContent matches a
        // sensitive WS field so content.js includes them in screenshot redaction.
        // This bridges the gap between stream-level PII detection and the visual
        // screenshot that the LLM also receives.
        try {
          markSensitiveDomElements(data);
        } catch (_) {}

      } catch (_) {
        // Not JSON — silently ignore (binary protocols like protobuf, CBOR)
      }
    });

    return ws;
  }

  // Copy all static properties and prototype so instanceof checks pass
  Object.setPrototypeOf(PriviBrowseWebSocket, _NativeWS);
  PriviBrowseWebSocket.prototype = _NativeWS.prototype;
  Object.defineProperties(PriviBrowseWebSocket, {
    CONNECTING: { value: 0, writable: false },
    OPEN:       { value: 1, writable: false },
    CLOSING:    { value: 2, writable: false },
    CLOSED:     { value: 3, writable: false },
  });

  window.WebSocket = PriviBrowseWebSocket;
  window.__PRIVIBROWSE_NATIVE_WS__ = _NativeWS;

  // ── DOM Marking — bridge WS PII into screenshot redaction ──────────────────
  // PII patterns mirrored from content.js INLINE_PII_PATTERNS (kept in sync).
  const _WS_PII_RE = [
    /\b\+?\(?\d{2,5}\)?(?:[-.\s]\d{2,5}){1,4}\b/,          // PHONE
    /(?<!\d)\d{4} \d{4} \d{4}(?!\d)/,                        // AADHAAR
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/,                             // PAN
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,  // EMAIL
    /\b\d{1,2}(?:\.\d+)?°?\s*[NS][,\s]+\d{1,3}(?:\.\d+)?°?\s*[EW]\b/i, // GEO
    /\bUSRC\/[A-Z0-9\/-]+/,                                  // OPERATOR_ID
  ];

  // Throttle: only re-mark DOM every 500ms (WS fires at 1 Hz — mark on every other frame)
  let _lastMarkTs = 0;

  function markSensitiveDomElements(frame) {
    const now = Date.now();
    if (now - _lastMarkTs < 500) return;
    _lastMarkTs = now;

    if (!document.body) return;

    // Build a set of known-sensitive string values from this frame
    const sensitiveValues = new Set();

    // 1. Walk channels[] — mark sensitive: true channels and CLASSIFIED_COORD / OPERATOR_BADGE
    if (Array.isArray(frame.channels)) {
      for (const ch of frame.channels) {
        if (ch.sensitive && ch.value != null) {
          sensitiveValues.add(String(ch.value).trim());
        }
        if (ch.id === "CH-COORD" || ch.id === "CH-OPR") {
          if (ch.value != null) sensitiveValues.add(String(ch.value).trim());
        }
      }
    }

    // 2. Walk top-level string fields — add any that match a PII pattern
    for (const [key, val] of Object.entries(frame)) {
      if (key === "channels" || key === "timestamp" || key === "met_seconds") continue;
      if (typeof val !== "string" || val.length < 4) continue;
      if (_WS_PII_RE.some((re) => re.test(val))) {
        sensitiveValues.add(val.trim());
      }
    }

    if (sensitiveValues.size === 0 && !frame.orbit) return;

    // 3. Walk all text nodes — mark element if its trimmed text matches
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim();
      if (!text || text.length < 4) continue;
      if (sensitiveValues.has(text) || [...sensitiveValues].some((v) => text.includes(v) && v.length > 5)) {
        const el = node.parentElement;
        if (el && !el.closest("[data-privibrowse-ignore]")) {
          el.setAttribute("data-privibrowse-confirmed-pii", "true");
        }
      }
    }

    // 4. Explicitly mark known sensitive display elements by ID — always flagged
    //    when they have real content (not the default dash placeholder).
    //    This covers elements that can't be caught by value-matching alone
    //    (timing gap, format variation, separate lat/lon spans, etc.)
    const ALWAYS_SENSITIVE_IDS = [
      "latDisplay",   // orbit HUD: LAT (split from lonDisplay, regex can't match alone)
      "lonDisplay",   // orbit HUD: LON
      "vCoord",       // telemetry matrix: CLASSIFIED_COORD
      "vOpr",         // telemetry matrix: OPERATOR_BADGE
      "vGip",         // telemetry matrix: GROUND_STATION_IP
    ];
    for (const id of ALWAYS_SENSITIVE_IDS) {
      const el = document.getElementById(id);
      if (el && el.textContent.trim() !== "—" && el.textContent.trim() !== "") {
        el.setAttribute("data-privibrowse-confirmed-pii", "true");
      }
    }
  }

})();
