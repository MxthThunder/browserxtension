/**
 * Content Script (Manifest V3)
 * 
 * Runs on every webpage to:
 * 1. Dynamically scan & monitor DOM-based PII fields via MutationObserver.
 * 2. Deliver precise bounding box coordinates for offscreen WebGPU canvas redaction.
 * 3. Render optional visual privacy indicators and action execution ripples.
 * 4. Execute synthesized native browser events from centralized VLM agent.
 */

// Sensitive Autocomplete Standard Tokens
const SENSITIVE_AUTOCOMPLETE_TOKENS = [
  "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-name", "cc-type",
  "email", "tel", "tel-national", "tel-country-code", "name", "given-name", "family-name",
  "street-address", "address-line1", "address-line2", "postal-code", "country-name",
  "bday", "bday-day", "bday-month", "bday-year", "current-password",
  "new-password", "one-time-code", "username", "transaction-amount"
];

// Regex for field names, labels, placeholders, and ARIA attributes
const SENSITIVE_NAME_PATTERN =
  /pass(word)?|ssn|aadhar|aadhaar|passport|credit|card.?number|cvv|cvc|pin\b|otp|email|phone|mobile|cell|dob|birth|address|salary|account.?number|ifsc|pan[_\b]|kyc|tax.?id|identity/i;

// Regex for scanning visible text nodes containing raw PII patterns
const INLINE_PII_PATTERNS = {
  CREDIT_CARD: /\b(?:\d{4}[ -]?){3}\d{4}\b/,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/,
  AADHAAR: /\b\d{4}\s\d{4}\s\d{4}\b/,
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  PHONE: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  PAN: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/
};

const OVERLAY_ID = "__pii_agent_overlay_layer__";
const FLOATING_BADGE_ID = "__pii_agent_floating_badge__";

let cachedMatches = [];
let isProtectionEnabled = true;
let showPageBadge = true;
let observer = null;

/**
 * Classifies an individual DOM element for sensitivity.
 */
function classifyElement(el) {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password") {
    return { sensitive: true, category: "passwords", reason: "type=password" };
  }

  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  for (const token of SENSITIVE_AUTOCOMPLETE_TOKENS) {
    if (autocomplete.includes(token)) {
      let category = "contactInfo";
      if (token.startsWith("cc-")) category = "creditCards";
      if (token.includes("password") || token === "one-time-code") category = "passwords";
      return { sensitive: true, category, reason: `autocomplete=${token}` };
    }
  }

  // Check element attributes and associated label text
  let labelText = "";
  if (el.labels && el.labels.length > 0) {
    labelText = Array.from(el.labels).map((l) => l.innerText).join(" ");
  }

  const haystack = [
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    labelText,
  ]
    .filter(Boolean)
    .join(" ");

  if (SENSITIVE_NAME_PATTERN.test(haystack)) {
    let category = "contactInfo";
    if (/pass|pin|otp/i.test(haystack)) category = "passwords";
    else if (/credit|card|cvv|cvc/i.test(haystack)) category = "creditCards";
    else if (/ssn|aadhar|aadhaar|passport|pan|kyc/i.test(haystack)) category = "govIds";
    return { sensitive: true, category, reason: `label match: "${haystack.substring(0, 30)}"` };
  }

  return { sensitive: false, category: null, reason: null };
}

/**
 * Scans the active document for sensitive inputs and visible KYC/PII cards.
 */
function scanPageForSensitiveElements() {
  const candidates = document.querySelectorAll("input, textarea, select, [contenteditable='true']");
  const matches = [];

  candidates.forEach((el) => {
    const rect = el.getBoundingClientRect();
    // Skip invisible/zero-size elements
    if (rect.width <= 1 || rect.height <= 1) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return; // Outside viewport
    if (rect.right < 0 || rect.left > window.innerWidth) return;

    const { sensitive, category, reason } = classifyElement(el);
    if (sensitive) {
      matches.push({
        el,
        category,
        reason,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  });

  // Also check for webcam <video> feeds or camera viewports (biometric visual capture)
  const videos = document.querySelectorAll("video");
  videos.forEach((vid) => {
    const rect = vid.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 20) {
      matches.push({
        el: vid,
        category: "faces",
        reason: "webcam <video> stream",
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  });

  cachedMatches = matches;
  updateFloatingBadge(matches.length);
  return matches;
}

/**
 * Extracts interactive DOM element digest for the VLM agent.
 */
function extractInteractiveElements() {
  const elements = [];
  const nodes = document.querySelectorAll(
    "button, a, input, select, textarea, [role='button'], [onclick], [tabindex]"
  );

  nodes.forEach((node, idx) => {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;

    let selector = "";
    if (node.id) {
      selector = `#${CSS.escape(node.id)}`;
    } else if (node.name) {
      selector = `[name="${CSS.escape(node.name)}"]`;
    } else if (node.getAttribute("role")) {
      selector = `[role="${CSS.escape(node.getAttribute("role"))}"]`;
    } else {
      selector = `${node.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
    }

    elements.push({
      tag: node.tagName.toLowerCase(),
      id: node.id || "",
      name: node.name || "",
      type: node.type || "",
      text: (node.innerText || node.value || node.placeholder || "").trim().substring(0, 80),
      selector,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      is_interactive: true,
    });
  });

  return elements;
}

/**
 * Renders or updates the subtle on-page floating privacy badge.
 */
function updateFloatingBadge(piiCount) {
  if (!showPageBadge || !isProtectionEnabled) {
    const existing = document.getElementById(FLOATING_BADGE_ID);
    if (existing) existing.remove();
    return;
  }

  let badge = document.getElementById(FLOATING_BADGE_ID);
  if (!badge) {
    badge = document.createElement("div");
    badge.id = FLOATING_BADGE_ID;
    Object.assign(badge.style, {
      position: "fixed",
      top: "12px",
      right: "12px",
      zIndex: "2147483640",
      background: "rgba(11, 15, 25, 0.88)",
      backdropFilter: "blur(8px)",
      border: "1px solid rgba(59, 130, 246, 0.4)",
      borderRadius: "999px",
      padding: "5px 12px",
      color: "#f8fafc",
      fontSize: "11.5px",
      fontWeight: "600",
      display: "flex",
      alignItems: "center",
      gap: "6px",
      boxShadow: "0 4px 15px rgba(0,0,0,0.4)",
      cursor: "pointer",
      userSelect: "none",
      transition: "transform 0.15s ease",
      fontFamily: "system-ui, -apple-system, sans-serif",
    });

    badge.addEventListener("mouseenter", () => {
      badge.style.transform = "scale(1.04)";
    });
    badge.addEventListener("mouseleave", () => {
      badge.style.transform = "scale(1.0)";
    });
    badge.addEventListener("click", () => {
      // Send message to open extension hub
      chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
    });

    document.body.appendChild(badge);
  }

  badge.innerHTML = `
    <span style="font-size: 13px;">🛡️</span>
    <span>Zero-Leakage</span>
    <span style="background: ${piiCount > 0 ? '#ef4444' : '#10b981'}; color: #fff; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 700;">${piiCount} PII</span>
  `;
}

/**
 * Initializes MutationObserver to detect dynamically inserted elements in SPAs.
 */
function initDynamicObserver() {
  if (observer) observer.disconnect();

  let debounceTimer = null;
  observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scanPageForSensitiveElements();
    }, 200);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "autocomplete", "name", "style", "class"],
  });
}

/**
 * Visual Ripple Animation for Agent Actions.
 */
function animateActionTarget(targetElement, actionType) {
  const rect = targetElement.getBoundingClientRect();
  const indicator = document.createElement("div");
  
  Object.assign(indicator.style, {
    position: "fixed",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    border: "2px solid #10b981",
    background: "rgba(16, 185, 129, 0.2)",
    borderRadius: "4px",
    zIndex: "2147483646",
    pointerEvents: "none",
    boxShadow: "0 0 15px #10b981",
    transition: "all 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: "12px",
    fontWeight: "700",
  });

  indicator.textContent = `🤖 Agent: ${actionType.toUpperCase()}`;
  document.body.appendChild(indicator);

  setTimeout(() => {
    indicator.style.opacity = "0";
    indicator.style.transform = "scale(1.08)";
    setTimeout(() => indicator.remove(), 600);
  }, 900);
}

/**
 * Synthesizes and executes native browser actions requested by VLM.
 */
async function executeAgentAction(action) {
  let target = null;
  if (action.selector) {
    try {
      target = document.querySelector(action.selector);
    } catch {
      target = null;
    }
  }

  // Fallback to coordinates if selector was not resolved
  if (!target && action.coordinates) {
    target = document.elementFromPoint(action.coordinates.x, action.coordinates.y);
  }

  if (!target && action.type !== "scroll" && action.type !== "finish") {
    return { ok: false, error: `Target element not found: ${action.selector || "coords"}` };
  }

  if (target) {
    animateActionTarget(target, action.type);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  switch (action.type) {
    case "click":
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      target.click();
      return { ok: true, executed: "click", selector: action.selector };

    case "type":
      target.focus();
      target.value = action.value || "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, executed: "type", value: action.value };

    case "scroll":
      const scrollY = action.value === "up" ? -350 : 350;
      window.scrollBy({ top: scrollY, behavior: "smooth" });
      return { ok: true, executed: "scroll", direction: action.value };

    case "submit":
      if (target.form) {
        target.form.submit();
      } else {
        target.click();
      }
      return { ok: true, executed: "submit" };

    case "finish":
      return { ok: true, executed: "finish", explanation: action.explanation };

    default:
      return { ok: false, error: `Unknown action type: ${action.type}` };
  }
}

// Runtime Message Listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_DOM_PII_BOXES") {
    const matches = scanPageForSensitiveElements();
    const interactive = extractInteractiveElements();
    sendResponse({
      ok: true,
      boxes: matches.map((m) => ({
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        category: m.category,
        reason: m.reason,
      })),
      interactiveElements: interactive,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
    });
    return true;
  }

  if (message.type === "EXECUTE_ACTION") {
    executeAgentAction(message.action)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "HIGHLIGHT_DOM") {
    const matches = scanPageForSensitiveElements();
    drawHighlightOverlay(matches);
    sendResponse({ ok: true, count: matches.length });
    return true;
  }

  if (message.type === "CLEAR_OVERLAYS") {
    const layer = document.getElementById(OVERLAY_ID);
    if (layer) layer.remove();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "SETTINGS_CHANGED") {
    if (message.settings) {
      isProtectionEnabled = Boolean(message.settings.enabled);
      showPageBadge = Boolean(message.settings.showPageBadge);
      scanPageForSensitiveElements();
    }
    sendResponse({ ok: true });
    return true;
  }

  return true;
});

function drawHighlightOverlay(matches) {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const layer = document.createElement("div");
  layer.id = OVERLAY_ID;
  Object.assign(layer.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    pointerEvents: "none",
    zIndex: "2147483647",
  });

  matches.forEach(({ x, y, width, height, reason }) => {
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      top: `${y}px`,
      left: `${x}px`,
      width: `${width}px`,
      height: `${height}px`,
      background: "rgba(239, 68, 68, 0.25)",
      border: "2px solid #ef4444",
      borderRadius: "4px",
      boxSizing: "border-box",
    });

    const lbl = document.createElement("div");
    lbl.textContent = `🛡️ PII: ${reason}`;
    Object.assign(lbl.style, {
      position: "absolute",
      top: "-18px",
      left: "0",
      fontSize: "10px",
      fontWeight: "700",
      background: "#ef4444",
      color: "#fff",
      padding: "1px 5px",
      borderRadius: "3px",
      whiteSpace: "nowrap",
    });

    box.appendChild(lbl);
    layer.appendChild(box);
  });

  document.body.appendChild(layer);
}

// Initial Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    scanPageForSensitiveElements();
    initDynamicObserver();
  });
} else {
  scanPageForSensitiveElements();
  initDynamicObserver();
}
