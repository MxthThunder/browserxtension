/**
 * Day 1: DOM-based PII scanner.
 *
 * Goal: find sensitive form fields on the current page using ONLY cheap,
 * high-precision signals (no ML yet — that comes in Day 2/3 for things
 * PII detection can't catch, like a face inside a webcam <video> feed
 * or a photographed ID card).
 *
 * Three detection layers, ordered by how sensitive is the field:
 *   1. type="password"                      -> always sensitive
 *   2. autocomplete token (cc-number, etc.)  -> spec-defined, very reliable
 *   3. name/id/placeholder/aria-label regex  -> catches everything else
 */

const SENSITIVE_AUTOCOMPLETE_TOKENS = [
  "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-name",
  "email", "tel", "tel-national", "name", "given-name", "family-name",
  "street-address", "address-line1", "address-line2", "postal-code",
  "bday", "bday-day", "bday-month", "bday-year", "current-password",
  "new-password", "one-time-code"
];

// Loosely matches common PII-ish field names across sites. This will
// over-trigger sometimes (fine — DOM layer favors recall+precision
// trade-off toward "flag it", vision layer can refine later).
const SENSITIVE_NAME_PATTERN =
  /pass(word)?|ssn|aadhar|aadhaar|passport|credit|card.?number|cvv|cvc|pin\b|otp|email|phone|mobile|dob|birth|address|salary|account.?number|ifsc|pan\b/i;

function classifyElement(el) {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password") {
    return { sensitive: true, reason: "type=password" };
  }

  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  for (const token of SENSITIVE_AUTOCOMPLETE_TOKENS) {
    if (autocomplete.includes(token)) {
      return { sensitive: true, reason: `autocomplete=${token}` };
    }
  }

  const haystack = [
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
  ]
    .filter(Boolean)
    .join(" ");

  if (SENSITIVE_NAME_PATTERN.test(haystack)) {
    return { sensitive: true, reason: `name/label match: "${haystack}"` };
  }

  return { sensitive: false, reason: null };
}

function findSensitiveElements() {
  const candidates = document.querySelectorAll("input, textarea, select");
  const matches = [];

  candidates.forEach((el) => {
    const rect = el.getBoundingClientRect();
    // Skip hidden/zero-size fields — nothing to redact visually.
    if (rect.width === 0 || rect.height === 0) return;

    const { sensitive, reason } = classifyElement(el);
    if (sensitive) {
      matches.push({ el, rect, reason });
    }
  });

  return matches;
}

// ---- Visual overlay (this is your Day 1 "wow" demo primitive) ----

const OVERLAY_ID = "__pii_agent_overlay_layer__";

function clearOverlay() {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
}

function drawOverlay(matches) {
  clearOverlay();

  const layer = document.createElement("div");
  layer.id = OVERLAY_ID;
  Object.assign(layer.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    pointerEvents: "none",
    zIndex: "2147483647", // max z-index, sit above everything
  });

  matches.forEach(({ rect, reason }) => {
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      background: "rgba(0, 0, 0, 0.75)", // black-box redaction look
      border: "2px solid #ff3b3b",
      borderRadius: "3px",
      boxSizing: "border-box",
    });

    const label = document.createElement("div");
    label.textContent = "PII";
    Object.assign(label.style, {
      position: "absolute",
      top: "-18px",
      left: "0",
      fontSize: "10px",
      fontFamily: "monospace",
      color: "#ff3b3b",
      background: "white",
      padding: "1px 4px",
      borderRadius: "2px",
    });
    box.title = reason; // hover to see why it was flagged
    box.appendChild(label);
    layer.appendChild(box);
  });

  document.documentElement.appendChild(layer);
}

function runScan() {
  const matches = findSensitiveElements();
  drawOverlay(matches);
  console.log(`[PII Agent] found ${matches.length} sensitive field(s)`, matches);
  return matches.length;
}

// Re-draw on scroll/resize so boxes track the fields (fixed positioning
// means the coordinates go stale otherwise).
window.addEventListener("scroll", () => runScan(), { passive: true });
window.addEventListener("resize", () => runScan());

// Listen for messages from popup or background/HUD.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCAN") {
    const count = runScan();
    sendResponse({ count });
    return true;
  }
  if (message?.type === "CLEAR") {
    clearOverlay();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "GET_DOM_PII_BOXES") {
    const matches = findSensitiveElements();
    const boxes = matches.map(({ el, rect, reason }) => {
      // Calculate CSS selector
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector += `#${el.id}`;
      } else if (el.name) {
        selector += `[name="${el.name}"]`;
      }

      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        reason,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.getAttribute("id") || "",
        selector,
      };
    });

    // Also extract non-sensitive interactive elements for server VLM reasoning
    const interactive = getInteractiveElements();

    sendResponse({
      ok: true,
      boxes,
      count: boxes.length,
      interactiveElements: interactive,
      dpr: window.devicePixelRatio || 1,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    });
    return true;
  }

  // Day 4: Execute VLM Agent action returned from server
  if (message?.type === "EXECUTE_ACTION") {
    const { action } = message;
    let target = null;

    if (action?.selector) {
      try {
        target = document.querySelector(action.selector);
      } catch (e) {
        console.warn("[PII Agent] Invalid selector:", action.selector);
      }
    }

    if (!target && action?.coordinates) {
      target = document.elementFromPoint(action.coordinates.x, action.coordinates.y);
    }

    if (target) {
      // Visual feedback: flash green ring around target
      showActionPulse(target, action.type);

      if (action.type === "click" || action.type === "submit") {
        target.focus();
        target.click();
        console.log(`[PII Agent] Executed CLICK on`, target);
      } else if (action.type === "type" && action.value) {
        target.focus();
        target.value = action.value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        console.log(`[PII Agent] Executed TYPE '${action.value}' on`, target);
      } else if (action.type === "scroll" && action.coordinates) {
        window.scrollBy({ top: action.coordinates.y, behavior: "smooth" });
      }

      sendResponse({ ok: true, executed: true, tag: target.tagName, selector: action.selector });
    } else {
      sendResponse({ ok: false, error: "Target element not found on page" });
    }
    return true;
  }

  return true;
});

function getInteractiveElements() {
  const elements = document.querySelectorAll("button, a, input, select, textarea");
  const list = [];

  elements.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    let selector = el.tagName.toLowerCase();
    if (el.id) selector = `#${el.id}`;
    else if (el.name) selector = `[name="${el.name}"]`;

    const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").trim();

    list.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      name: el.name || "",
      type: el.getAttribute("type") || "",
      text: text.slice(0, 80),
      selector,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    });
  });

  return list;
}

function showActionPulse(el, actionType) {
  const rect = el.getBoundingClientRect();
  const pulse = document.createElement("div");
  Object.assign(pulse.style, {
    position: "fixed",
    top: `${rect.top - 4}px`,
    left: `${rect.left - 4}px`,
    width: `${rect.width + 8}px`,
    height: `${rect.height + 8}px`,
    border: "3px solid #10b981",
    borderRadius: "8px",
    boxShadow: "0 0 16px #10b981",
    zIndex: "2147483647",
    pointerEvents: "none",
    transition: "all 0.6s ease-out",
  });

  const tag = document.createElement("div");
  tag.textContent = `⚡ AGENT ${actionType.toUpperCase()}`;
  Object.assign(tag.style, {
    position: "absolute",
    top: "-22px",
    left: "0",
    background: "#10b981",
    color: "#ffffff",
    fontSize: "11px",
    fontWeight: "bold",
    padding: "2px 6px",
    borderRadius: "4px",
    fontFamily: "monospace",
  });

  pulse.appendChild(tag);
  document.documentElement.appendChild(pulse);

  setTimeout(() => {
    pulse.style.opacity = "0";
    pulse.style.transform = "scale(1.05)";
    setTimeout(() => pulse.remove(), 600);
  }, 1200);
}

// Auto-run once on load so the demo works even without opening the popup.
runScan();
