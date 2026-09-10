/**
 * Content Script (Manifest V3)
 * 
 * Runs on every webpage to:
 * 1. Dynamically scan & monitor DOM-based PII fields via MutationObserver.
 * 2. Deliver precise bounding box coordinates for offscreen WebGPU canvas redaction.
 * 3. Render optional visual privacy indicators and action execution ripples.
 * 4. Execute synthesized native browser events from centralized VLM agent.
 */

(() => {
if (window.__PRIVIBROWSE_CONTENT_INITIALIZED__) return;
window.__PRIVIBROWSE_CONTENT_INITIALIZED__ = true;

// Sensitive Autocomplete Standard Tokens
const SENSITIVE_AUTOCOMPLETE_TOKENS = [
  "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-name", "cc-type",
  "email", "tel", "tel-national", "tel-country-code", "name", "given-name", "family-name",
  "street-address", "address-line1", "address-line2", "postal-code", "country-name",
  "bday", "bday-day", "bday-month", "bday-year", "current-password",
  "new-password", "one-time-code", "username", "transaction-amount"
];

// Regex for field names, labels, placeholders, and ARIA attributes (C3)
// Fixed: pan[_\b] was matching literal backspace inside []; now uses \bpan\b
const SENSITIVE_NAME_PATTERN =
  /pass(word)?|ssn|aadhar|aadhaar|passport|credit|card.?number|card|cvv|cvc|security.?code|expir(y|ation)?|exp|pin\b|otp|email|phone|mobile|cell|tel|dob|birth|address|billing|zip|postal|postal.?code|pincode|zipcode|city|state|salary|account.?number|ifsc|\bpan\b|kyc|tax.?id|identity|\bname\b|full.?name|first.?name|last.?name|middle.?name|father|mother|guardian|nominee|gender|signature|photo|selfie|profile|picture|telecommand|encryption|payload_target|secret_key|orbit_keplerian/i;

// Regex for scanning visible text nodes containing raw PII patterns
const MAX_TEXT_NODES = 4000;

const INLINE_PII_PATTERNS = {
  CREDIT_CARD: /\b(?:\d{4}[ -]?){3}\d{4}\b/,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/,
  AADHAAR: /\b\d{4}\s\d{4}\s\d{4}\b/,
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  // Grouping-agnostic: the old 3-3-4-only pattern missed the Indian mobile
  // format (98765 43210, 5+5) and Korean-style numbers (010-1000-0001,
  // 3-4-4) — both verified misses, the Indian one especially significant for
  // this product's primary market. Matches 2-5 groups of 2-5 digits joined by
  // '-', '.' or space; a comma (as in prices "2,499") is deliberately not a
  // recognised separator, and a lone 1-digit group (as in ratings "4.3") is
  // too short to qualify, so those are not caught. Trade-off: an occasional
  // date ("2024-01-15") or decimal now over-redacts — cosmetic, and preferred
  // to the alternative of an unredacted phone number.
  PHONE: /\b\+?\(?\d{2,5}\)?(?:[-.\s]\d{2,5}){1,4}\b/,
  PAN: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/,
  DELIVERY_LOCATION: /\b(?:deliver(?:ing)?|ship(?:ping)?|dispatch|send)\s+to\s+[^,\n\r<]{2,50}/i,
  PINCODE_LOCATION: /\b[A-Za-z]{2,25}\s+[1-9][0-9]{5}\b/i,
  INTERNAL_IP: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/,
  OPERATOR_ID: /\b(?:OP-[A-Z0-9]{4,10}|USRC\/[A-Z0-9\/-]+|Operator\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
  CONSOLE_ID: /\b(?:MOX|ISTRAC|MCC)-CON-\d+\b/i,
  GEO_COORDINATES: /\b\d{1,2}(?:\.\d+)?°?\s*[NS][,\s]+\d{1,3}(?:\.\d+)?°?\s*[EW]\b/i
};

const OVERLAY_ID = "__pii_agent_overlay_layer__";
const FLOATING_BADGE_ID = "__pii_agent_floating_badge__";

let cachedMatches = [];
let isProtectionEnabled = true;
let showPageBadge = true;
let observer = null;
let debounceTimer = null;
let lastSpaRoute = typeof window !== "undefined" ? window.location.href : "";
let lastSpaMutationTime = Date.now();

/**
 * Classifies an individual DOM element for sensitivity.
 */
/**
 * Layer G1 name detection.
 *
 * content.js is a classic content script, not a module, so `import` is not
 * available: the shared detector is pulled in dynamically from the extension's
 * web-accessible resources. Until it resolves — and if it never does — the
 * inline fallback below still fires, because a privacy detector must not fail
 * open just because a module load was slow.
 */
let nameDetectorModule = null;

const FALLBACK_NAME_FIELD_RE =
  /\b(full[\s_-]?name|first[\s_-]?name|last[\s_-]?name|given[\s_-]?name|family[\s_-]?name|sur[\s_-]?name|your[\s_-]?name|customer[\s_-]?name|recipient|deliver(?:y)?[\s_-]?to|ordered[\s_-]?by|card[\s_-]?holder|account[\s_-]?holder|beneficiary|nominee|contact[\s_-]?person|passenger[\s_-]?name|patient[\s_-]?name)\b/i;
const FALLBACK_NAME_AUTOCOMPLETE = new Set([
  "name", "given-name", "family-name", "additional-name",
  "honorific-prefix", "honorific-suffix", "nickname",
]);

(async () => {
  try {
    nameDetectorModule = await import(chrome.runtime.getURL("name_detector.js"));
  } catch (err) {
    console.warn("[Content] Shared name detector unavailable; using inline rules:", err?.message);
  }
})();

function detectNameField(descriptors) {
  if (nameDetectorModule?.isNameField) {
    return nameDetectorModule.isNameField(descriptors);
  }
  const auto = String(descriptors.autocomplete || "").toLowerCase();
  if (auto.split(/\s+/).some((t) => FALLBACK_NAME_AUTOCOMPLETE.has(t))) return true;
  if (String(descriptors.itemprop || "").toLowerCase() === "name") return true;
  return FALLBACK_NAME_FIELD_RE.test(
    [descriptors.name, descriptors.id, descriptors.placeholder,
     descriptors.ariaLabel, descriptors.label].filter(Boolean).join(" ")
  );
}

/**
 * The visible label bound to a field, by `for=`, by wrapping <label>, or by
 * aria-labelledby. Many checkout forms carry no useful name/id and identify a
 * field only through its label.
 *
 * @returns {string} label text, or "" when there is none
 */
function labelTextFor(el) {
  try {
    if (el.id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) return (byFor.innerText || byFor.textContent || "").trim().slice(0, 80);
    }
    const wrapping = el.closest?.("label");
    if (wrapping) return (wrapping.innerText || wrapping.textContent || "").trim().slice(0, 80);

    const labelledBy = el.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return (ref.innerText || ref.textContent || "").trim().slice(0, 80);
    }
  } catch {
    // Malformed id / detached node — no label is a valid answer.
  }
  return "";
}

function classifyElement(el) {
  const type = (el.getAttribute("type") || "").toLowerCase();

  if (type === "password") {
    return { sensitive: true, category: "passwords", reason: "type=password" };
  }

  if (type === "tel" || type === "email") {
    return { sensitive: true, category: "contactInfo", reason: `type=${type}` };
  }

  // C2: File upload inputs that accept images/documents are treated as sensitive
  if (type === "file") {
    const accept = (el.getAttribute("accept") || "").toLowerCase();
    const fileHint = [el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("aria-label")]
      .filter(Boolean).join(" ");
    if (/image|pdf|jpg|png|jpeg/i.test(accept) || SENSITIVE_NAME_PATTERN.test(fileHint)) {
      return {
        sensitive: true,
        category: "govIds",
        reason: `file upload: ${el.getAttribute("name") || el.getAttribute("id") || "photo/doc"}`,
      };
    }
  }

  // Layer G1: fields whose value IS a person's name. Checked before the generic
  // autocomplete sweep because the name tokens are not in
  // SENSITIVE_AUTOCOMPLETE_TOKENS, which is why a checkout page's "Full Name"
  // was never flagged and the name shipped to the cloud model unmasked.
  if (detectNameField({
    autocomplete: el.getAttribute("autocomplete"),
    name: el.getAttribute("name"),
    id: el.getAttribute("id"),
    placeholder: el.getAttribute("placeholder"),
    ariaLabel: el.getAttribute("aria-label"),
    label: labelTextFor(el),
    itemprop: el.getAttribute("itemprop"),
  })) {
    return { sensitive: true, category: "names", reason: "person name field" };
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

  // Check actual typed value if present
  const val = (el.value || el.innerText || "").trim();
  if (val.length >= 3) {
    for (const [patternName, re] of Object.entries(INLINE_PII_PATTERNS)) {
      if (re.test(val)) {
        let category = "contactInfo";
        if (patternName === "CREDIT_CARD") category = "creditCards";
        else if (patternName === "SSN" || patternName === "AADHAAR" || patternName === "PAN") category = "govIds";
        else if (patternName === "INTERNAL_IP" || patternName === "OPERATOR_ID" || patternName === "CONSOLE_ID" || patternName === "GEO_COORDINATES") category = "opsSecurity";
        return { sensitive: true, category, reason: `value matches ${patternName}` };
      }
    }
  }

  // C4: Resolve label text including via aria-labelledby / aria-describedby
  let labelText = "";
  if (el.labels && el.labels.length > 0) {
    labelText = Array.from(el.labels).map((l) => l.innerText).join(" ");
  }
  // Resolve aria-labelledby (space-separated list of element IDs)
  const ariaLabelledBy = el.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    ariaLabelledBy.trim().split(/\s+/).forEach((refId) => {
      const refEl = document.getElementById(refId);
      if (refEl) labelText += " " + (refEl.innerText || refEl.textContent || "");
    });
  }
  // Resolve aria-describedby (additional context hints)
  const ariaDescribedBy = el.getAttribute("aria-describedby");
  if (ariaDescribedBy) {
    ariaDescribedBy.trim().split(/\s+/).forEach((refId) => {
      const refEl = document.getElementById(refId);
      if (refEl) labelText += " " + (refEl.innerText || refEl.textContent || "");
    });
  }

  // Contextual DOM ancestor / sibling label search for SPAs (Discord, React modals, Tailwind)
  let contextualText = "";
  let curr = el.parentElement;
  let depth = 0;
  while (curr && curr !== document.body && depth < 3) {
    const textNodes = curr.querySelectorAll("label, span, div, p, h1, h2, h3, h4, h5, h6, [class*='label'], [class*='title'], [class*='header']");
    for (const tn of textNodes) {
      if (tn !== el && !tn.contains(el)) {
        const t = (tn.innerText || tn.textContent || "").trim();
        if (t.length > 0 && t.length < 80) {
          contextualText += " " + t;
        }
      }
    }
    // Also check preceding sibling element
    if (el.previousElementSibling) {
      contextualText += " " + (el.previousElementSibling.innerText || el.previousElementSibling.textContent || "");
    }
    curr = curr.parentElement;
    depth++;
  }

  const haystack = [
    el.getAttribute("name"),
    el.getAttribute("id"),
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("data-field"),
    el.getAttribute("data-type"),
    labelText,
    contextualText,
  ]
    .filter(Boolean)
    .join(" ");

  if (SENSITIVE_NAME_PATTERN.test(haystack)) {
    let category = "contactInfo";
    if (/pass|pin|otp/i.test(haystack)) category = "passwords";
    else if (/credit|card|cvv|cvc|expir|security.?code/i.test(haystack)) category = "creditCards";
    else if (/ssn|aadhar|aadhaar|passport|\bpan\b|kyc/i.test(haystack)) category = "govIds";
    return { sensitive: true, category, reason: `label match: "${haystack.substring(0, 40)}"` };
  }

  return { sensitive: false, category: null, reason: null };
}

// ── Block element lookup used by text-node scanner ───────────────────────────
const BLOCK_TAGS = new Set([
  "DIV", "P", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "NAV",
  "ASIDE", "TR", "TD", "TH", "LI", "DL", "DD", "DT", "BLOCKQUOTE",
  "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "FORM", "FIELDSET", "FIGURE", "SPAN",
]);

function isBlockElement(el) {
  return BLOCK_TAGS.has(el.tagName);
}

/**
 * C1: Walks all visible text nodes and flags those matching INLINE_PII_PATTERNS.
 * Activates the previously dead-code INLINE_PII_PATTERNS constant.
 * Returns DOM box entries pointing at the text's nearest block-level ancestor.
 */
function scanVisibleTextNodes() {
  const results = [];
  const seenAncestors = new WeakMap();
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "TEMPLATE", "CANVAS", "SVG"]);

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      // Skip our own injected overlay elements
      if (parent.closest && parent.closest(`#${OVERLAY_ID}, #${FLOATING_BADGE_ID}`)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (node.textContent.trim().length < 5) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node;
  let textNodeCount = 0;
  // 100 was far too low: a normal article page has hundreds of text nodes in
  // nav, sidebar and body, so PII further down the document was never examined.
  while ((node = walker.nextNode()) && textNodeCount < MAX_TEXT_NODES) {
    textNodeCount++;
    const text = node.textContent;
    for (const [patternName, re] of Object.entries(INLINE_PII_PATTERNS)) {
      if (!re.test(text)) continue;

      // Walk up to find the nearest meaningful block ancestor for bounding box
      let ancestor = node.parentElement;
      let depth = 0;
      while (ancestor && ancestor !== document.body && depth < 6) {
        if (isBlockElement(ancestor) && depth >= 1) break;
        ancestor = ancestor.parentElement;
        depth++;
      }
      if (!ancestor || ancestor === document.body) ancestor = node.parentElement;
      if (!ancestor) continue;

      // Keyed by ancestor AND pattern: one block can legitimately hold a name,
      // an email and a phone, and each deserves its own detection.
      const seenKey = `${patternName}`;
      let seenForAncestor = seenAncestors.get(ancestor);
      if (!seenForAncestor) {
        seenForAncestor = new Set();
        seenAncestors.set(ancestor, seenForAncestor);
      }
      if (seenForAncestor.has(seenKey)) continue;
      seenForAncestor.add(seenKey);

      const rect = ancestor.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;

      let category = "contactInfo";
      if (patternName === "CREDIT_CARD") category = "creditCards";
      else if (patternName === "SSN" || patternName === "AADHAAR" || patternName === "PAN") category = "govIds";
      else if (patternName === "INTERNAL_IP" || patternName === "OPERATOR_ID" || patternName === "CONSOLE_ID" || patternName === "GEO_COORDINATES") category = "opsSecurity";

      results.push({
        el: ancestor,
        category,
        reason: `visible text: ${patternName}`,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      // keep scanning: one node can carry several kinds of PII
    }
  }
  return results;
}

/**
 * C1b: Bounding boxes of on-screen imagery that could contain readable text.
 *
 * OCR previously ran only over regions the object detector had already flagged,
 * so text baked into a screenshot, chart or scanned document was never read at
 * all unless it happened to look like a credit card or a passport. These
 * regions give the OCR pass somewhere to look on an ordinary page.
 */
function collectOcrCandidateRegions() {
  const MIN_SIDE = 64;          // ignore icons, avatars, spacers
  const MIN_AREA = 12000;       // roughly a small figure or larger
  const MAX_REGIONS = 6;        // OCR is the slowest stage - keep it bounded

  const candidates = [];
  const nodes = document.querySelectorAll("img, canvas, svg, picture, video, [style*='background-image']");

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) continue;
    if (rect.width * rect.height < MIN_AREA) continue;
    // Must be inside the viewport - the screenshot only contains what is visible.
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
    if (rect.right <= 0 || rect.left >= window.innerWidth) continue;

    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity || "1") < 0.1) continue;

    candidates.push({
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
      width: Math.round(Math.min(rect.width, window.innerWidth)),
      height: Math.round(Math.min(rect.height, window.innerHeight)),
      area: rect.width * rect.height,
      source: node.tagName.toLowerCase(),
    });
  }

  // Largest first: a big figure is likelier to carry legible text than a thumbnail.
  candidates.sort((a, b) => b.area - a.area);
  return candidates.slice(0, MAX_REGIONS).map(({ area, ...box }) => box);
}

/**
 * C6: Recursively collects inputs inside open Shadow DOM roots.
 * Handles nested shadow roots up to depth 4.
 */
function collectShadowInputs(root, depth = 0) {
  if (depth > 4) return [];
  const inputs = [];
  try {
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) {
        el.shadowRoot
          .querySelectorAll("input, textarea, select, [contenteditable='true']")
          .forEach((input) => inputs.push(input));
        inputs.push(...collectShadowInputs(el.shadowRoot, depth + 1));
      }
    });
  } catch {
    // Closed shadow roots are inaccessible by design — silently skip
  }
  return inputs;
}

/** C5: Regex to identify <img> tags that are likely displaying a government ID document. */
const SENSITIVE_IMG_PATTERN =
  /aadhaar|aadhar|pan[_-]?card|passport|id[_-]?card|kyc|selfie|voter|license|licence|identity.?proof/i;

/**
 * Scans an iframe (both same-origin and cross-origin payment gateways like Stripe/PayPal).
 * Adjusts element bounding boxes by the iframe's position in the parent viewport.
 */
function scanIframeElement(iframeEl, matches) {
  const ifRect = iframeEl.getBoundingClientRect();
  if (ifRect.width <= 0 || ifRect.height <= 0) return;
  if (ifRect.bottom < 0 || ifRect.top > window.innerHeight) return;
  if (ifRect.right < 0 || ifRect.left > window.innerWidth) return;

  const iframeHaystack = [
    iframeEl.getAttribute("src"),
    iframeEl.getAttribute("name"),
    iframeEl.getAttribute("title"),
    iframeEl.getAttribute("id"),
    iframeEl.getAttribute("aria-label"),
    iframeEl.getAttribute("class"),
  ].filter(Boolean).join(" ");

  // Identify cross-origin payment iframes (Stripe, PayPal, Braintree, Adyen, card elements)
  const isPaymentFrame =
    /stripe|paypal|braintree|adyen|card|payment|checkout|wallet|token/i.test(iframeHaystack) ||
    SENSITIVE_NAME_PATTERN.test(iframeHaystack);

  if (isPaymentFrame) {
    matches.push({
      el: iframeEl,
      category: "creditCards",
      reason: `payment frame: ${iframeEl.getAttribute("name") || iframeEl.getAttribute("title") || "Stripe/Payment Gateway"}`,
      x: Math.round(ifRect.left),
      y: Math.round(ifRect.top),
      width: Math.round(ifRect.width),
      height: Math.round(ifRect.height),
    });
  }

  let iframeDoc = null;
  try {
    iframeDoc = iframeEl.contentDocument;
  } catch {
    return; // cross-origin security error - already flagged as payment frame if matched
  }
  if (!iframeDoc || !iframeDoc.body) return;

  // Form inputs inside same-origin iframe
  iframeDoc.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox']").forEach((el) => {
    const r = el.getBoundingClientRect(); // relative to iframe viewport
    if (r.width <= 1 || r.height <= 1) return;
    const { sensitive, category, reason } = classifyElement(el);
    if (sensitive) {
      matches.push({
        el,
        category,
        reason: `iframe: ${reason}`,
        x: Math.round(ifRect.left + r.left),
        y: Math.round(ifRect.top  + r.top),
        width:  Math.round(r.width),
        height: Math.round(r.height),
      });
    }
  });

  // Webcam feeds inside the iframe
  iframeDoc.querySelectorAll("video").forEach((vid) => {
    const r = vid.getBoundingClientRect();
    if (r.width > 20 && r.height > 20) {
      matches.push({
        el: vid,
        category: "faces",
        reason: "iframe: webcam <video> stream",
        x: Math.round(ifRect.left + r.left),
        y: Math.round(ifRect.top  + r.top),
        width:  Math.round(r.width),
        height: Math.round(r.height),
      });
    }
  });

  // File upload inputs inside the iframe
  iframeDoc.querySelectorAll("input[type='file']").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return;
    const { sensitive, category, reason } = classifyElement(el);
    if (sensitive) {
      matches.push({
        el,
        category,
        reason: `iframe: ${reason}`,
        x: Math.round(ifRect.left + r.left),
        y: Math.round(ifRect.top  + r.top),
        width:  Math.round(r.width),
        height: Math.round(r.height),
      });
    }
  });
}

/**
 * Scans the active document for sensitive inputs and visible KYC/PII cards.
 */
function scanPageForSensitiveElements() {
  const candidates = document.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox'], [role='searchbox']");
  const matches = [];

  candidates.forEach((el) => {
    const rect = el.getBoundingClientRect();
    // Skip invisible/zero-size elements
    if (rect.width <= 1 || rect.height <= 1) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
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

  // C6: Shadow DOM inputs (open shadow roots only)
  collectShadowInputs(document.body).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (rect.right < 0 || rect.left > window.innerWidth) return;
    const { sensitive, category, reason } = classifyElement(el);
    if (sensitive) {
      matches.push({
        el,
        category,
        reason: `shadow-dom: ${reason}`,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  });

  // Iframe scanning (both same-origin inputs and cross-origin payment frames like Stripe/PayPal)
  document.querySelectorAll("iframe").forEach((iframeEl) => {
    scanIframeElement(iframeEl, matches);
  });

  // C5: <img> elements displaying likely ID documents
  document.querySelectorAll("img").forEach((imgEl) => {
    const rect = imgEl.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 80) return; // too small to be a document image
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (rect.right < 0 || rect.left > window.innerWidth) return;

    const imgHaystack = [
      imgEl.getAttribute("src"),
      imgEl.getAttribute("alt"),
      imgEl.getAttribute("id"),
      imgEl.getAttribute("name"),
      imgEl.getAttribute("class"),
      imgEl.getAttribute("data-type"),
    ].filter(Boolean).join(" ");

    if (SENSITIVE_IMG_PATTERN.test(imgHaystack)) {
      const srcHint = (imgEl.getAttribute("alt") ||
        imgEl.getAttribute("src")?.split("/").pop()?.substring(0, 30) ||
        "ID document");
      matches.push({
        el: imgEl,
        category: "govIds",
        reason: `img: ${srcHint}`,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  });

  // Webcam <video> feeds or camera viewports (biometric visual capture)
  document.querySelectorAll("video").forEach((vid) => {
    const rect = vid.getBoundingClientRect();
    if (rect.width <= 20 || rect.height <= 20) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (rect.right < 0 || rect.left > window.innerWidth) return;

    // Detect if this is a genuine webcam/camera stream
    const hasMediaStream = Boolean(
      vid.srcObject &&
      typeof vid.srcObject.getVideoTracks === "function" &&
      vid.srcObject.getVideoTracks().length > 0
    );

    const vidHaystack = [
      vid.getAttribute("class"),
      vid.getAttribute("id"),
      vid.getAttribute("aria-label"),
      vid.getAttribute("data-purpose"),
      vid.getAttribute("title"),
    ].filter(Boolean).join(" ").toLowerCase();

    const isCameraNamed = /webcam|selfie|camera|facetrack|biometric|user-stream|live-feed/i.test(vidHaystack);

    // Ignore promotional, decorative, or looping background videos (e.g. HackerRank globe animation)
    const isBackgroundLoop = vid.hasAttribute("loop") && vid.hasAttribute("muted") && !hasMediaStream;
    const src = (vid.currentSrc || vid.src || "").toLowerCase();
    const isStaticVideoFile = /\.(mp4|webm|ogv|mov)(\?.*)?$/i.test(src);

    if ((hasMediaStream || isCameraNamed) && !(isBackgroundLoop && isStaticVideoFile)) {
      matches.push({
        el: vid,
        category: "faces",
        reason: hasMediaStream ? "live webcam <video> stream" : `camera viewport: ${vidHaystack.substring(0, 30)}`,
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  });

  // Delivery location & user address widgets (e.g. Amazon 'Delivering to Chennai 600040', Flipkart, food apps)
  document.querySelectorAll(
    '#nav-global-location-slot, #glow-ingress-block, [id*="location-slot" i], [id*="delivery-location" i], [class*="delivery-location" i], [class*="user-location" i], [class*="user-address" i], [id*="user-address" i], [aria-label*="deliver to" i], [aria-label*="delivery location" i]'
  ).forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width > 2 && rect.height > 2) {
      matches.push({
        el,
        category: "contactInfo",
        reason: "delivery location / user address widget",
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  });

  // C1: Visible text nodes with raw PII patterns (activates INLINE_PII_PATTERNS)
  scanVisibleTextNodes().forEach((m) => matches.push(m));

  cachedMatches = matches;
  updateFloatingBadge(matches.length);
  return matches;
}

/**
 * Extracts interactive DOM element digest for the VLM agent.
 * Recursively inspects both the primary document and accessible same-origin iframes.
 */
/**
 * node -> index in the array returned by the last extractInteractiveElements()
 * call. That index is the `ref` the planner addresses elements by, so page
 * content rows can point at a real, clickable target instead of describing one.
 *
 * Rebuilt on every extraction because refs are renumbered each scan.
 */
let interactiveNodeRefs = new WeakMap();

function extractInteractiveElements() {
  const elements = [];
  interactiveNodeRefs = new WeakMap();
  const rawNodes = Array.from(document.querySelectorAll(
    "button, a, input, select, textarea, [role='button'], [role='textbox'], [role='link'], [contenteditable='true'], [onclick], [tabindex]"
  ));

  // Support same-origin accessible iframes (e.g. embedded ops widgets, dashboards)
  document.querySelectorAll("iframe").forEach((iframe) => {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        const iframeNodes = doc.querySelectorAll(
          "button, a, input, select, textarea, [role='button'], [role='textbox'], [role='link'], [contenteditable='true'], [onclick], [tabindex]"
        );
        iframeNodes.forEach((node) => {
          node._inIframe = iframe;
          rawNodes.push(node);
        });
      }
    } catch {
      // Cross-origin iframes silently skipped per browser security boundary
    }
  });

  // Prioritize primary content / inputs & buttons over sidebars / headers
  rawNodes.sort((a, b) => {
    const aScore = (a.id === "prompt-textarea" || a.getAttribute("data-testid")?.includes("send") ? 100 : 0) +
                   (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.isContentEditable ? 50 : 0) +
                   (a.tagName === "BUTTON" ? 20 : 0);
    const bScore = (b.id === "prompt-textarea" || b.getAttribute("data-testid")?.includes("send") ? 100 : 0) +
                   (b.tagName === "TEXTAREA" || b.tagName === "INPUT" || b.isContentEditable ? 50 : 0) +
                   (b.tagName === "BUTTON" ? 20 : 0);
    return bScore - aScore;
  });

  rawNodes.forEach((node, idx) => {
    let rect = node.getBoundingClientRect();
    if (node._inIframe) {
      const ifRect = node._inIframe.getBoundingClientRect();
      rect = {
        left: ifRect.left + rect.left,
        top: ifRect.top + rect.top,
        width: rect.width,
        height: rect.height,
        bottom: ifRect.top + rect.bottom,
        right: ifRect.left + rect.right,
      };
    }

    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < -200 || rect.top > window.innerHeight + 200) return;

    const agentId = String(idx + 1);
    node.setAttribute("data-agent-id", agentId);

    let selector = "";
    if (node.id) {
      selector = `#${CSS.escape(node.id)}`;
    } else if (node.getAttribute("data-testid")) {
      selector = `${node.tagName.toLowerCase()}[data-testid="${CSS.escape(node.getAttribute("data-testid"))}"]`;
    } else if (node.getAttribute("aria-label")) {
      selector = `${node.tagName.toLowerCase()}[aria-label="${CSS.escape(node.getAttribute("aria-label"))}"]`;
    } else if (node.name) {
      selector = `${node.tagName.toLowerCase()}[name="${CSS.escape(node.name)}"]`;
    } else if (node.getAttribute("placeholder")) {
      selector = `${node.tagName.toLowerCase()}[placeholder="${CSS.escape(node.getAttribute("placeholder"))}"]`;
    } else if (node.getAttribute("role")) {
      selector = `[role="${CSS.escape(node.getAttribute("role"))}"][data-agent-id="${agentId}"]`;
    } else {
      selector = `[data-agent-id="${agentId}"]`;
    }

    interactiveNodeRefs.set(node, elements.length);
    elements.push({
      tag: node.tagName.toLowerCase(),
      id: node.id || "",
      name: node.name || "",
      type: node.type || (node.isContentEditable ? "contenteditable" : ""),
      text: (node.innerText || node.value || node.getAttribute("aria-label") || node.placeholder || "").trim().substring(0, 80),
      // Carried separately as well: `text` falls back through this chain, so a
      // field that has a value loses its placeholder — which on an id-less page
      // is often the only thing identifying it to the planner.
      placeholder: (node.getAttribute("placeholder") || "").trim().substring(0, 80),
      ariaLabel: (node.getAttribute("aria-label") || "").trim().substring(0, 80),
      selector,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      is_interactive: true,
      in_iframe: Boolean(node._inIframe),
    });
  });

  return elements;
}

/**
 * True when this frame can actually carry out the action.
 *
 * Used only by sub-frames, to decide whether to answer a broadcast
 * EXECUTE_ACTION at all. Scroll and finish are frame-agnostic and are left to
 * the top frame.
 */
function frameCanHandleAction(action) {
  if (!action || !action.selector) return false;
  try {
    return Boolean(document.querySelector(action.selector));
  } catch {
    return false;
  }
}

// ── Cross-frame scanning (Layer H) ──────────────────────────────────────────
// A cross-origin iframe — a payment widget, an embedded checkout, a KYC form —
// cannot be read from the parent document, so `extractInteractiveElements`
// silently skipped it and its fields were covered only by the screenshot pass.
// The content script now runs in every frame (`all_frames` in the manifest) and
// frames cooperate over postMessage: the parent asks each child to scan itself,
// the child replies with boxes in ITS OWN coordinates, and the parent shifts
// them by that iframe's rect. Nesting works because a child repeats the same
// exchange with its own children before replying.
//
// Only coordinates cross the boundary — never text. A frame answers only its
// real parent (`event.source === window.parent`), so an unrelated frame on the
// page cannot ask where a form's sensitive fields are.

const FRAME_MSG = "__PRIVYBROWSE_FRAME__";
const FRAME_SCAN_TIMEOUT_MS = 300;

/** Asks every child iframe to scan itself; returns boxes in THIS frame's coords. */
async function collectChildFrameBoxes() {
  const iframes = Array.from(document.querySelectorAll("iframe"));
  if (iframes.length === 0) return { boxes: [], ocrRegions: [] };

  const pending = new Map();
  const boxes = [];
  const ocrRegions = [];

  const onReply = (event) => {
    const data = event.data;
    if (!data || data[FRAME_MSG] !== "SCAN_RESULT") return;
    const entry = pending.get(data.id);
    if (!entry || event.source !== entry.win) return;
    pending.delete(data.id);
    entry.resolve(data);
  };
  window.addEventListener("message", onReply);

  try {
    const waits = iframes.map((frame, i) => {
      const win = frame.contentWindow;
      if (!win) return Promise.resolve(null);

      const rect = frame.getBoundingClientRect();
      // Off-screen or collapsed frames carry nothing paintable.
      if (rect.width < 2 || rect.height < 2) return Promise.resolve(null);

      const id = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const reply = new Promise((resolve) => {
        pending.set(id, { win, resolve });
        setTimeout(() => { pending.delete(id); resolve(null); }, FRAME_SCAN_TIMEOUT_MS);
      });

      try {
        win.postMessage({ [FRAME_MSG]: "SCAN_REQUEST", id }, "*");
      } catch {
        pending.delete(id);
        return Promise.resolve(null);
      }
      return reply.then((data) => (data ? { data, rect } : null));
    });

    for (const result of await Promise.all(waits)) {
      if (!result) continue;
      const { data, rect } = result;
      for (const b of data.boxes || []) {
        boxes.push({ ...b, x: Math.round(b.x + rect.left), y: Math.round(b.y + rect.top) });
      }
      for (const r of data.ocrRegions || []) {
        ocrRegions.push({ ...r, x: Math.round(r.x + rect.left), y: Math.round(r.y + rect.top) });
      }
    }
  } finally {
    window.removeEventListener("message", onReply);
  }

  return { boxes, ocrRegions };
}

// Child side: scan on request from our own parent, and answer with geometry only.
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data[FRAME_MSG] !== "SCAN_REQUEST") return;
  if (window.top === window.self) return;          // top frame has no parent to serve
  if (event.source !== window.parent) return;      // only our real parent may ask

  let boxes = [];
  let ocrRegions = [];
  try {
    if (isProtectionEnabled) {
      boxes = scanPageForSensitiveElements().map((m) => ({
        x: m.x, y: m.y, width: m.width, height: m.height,
        category: m.category, reason: m.reason,
      }));
      ocrRegions = collectOcrCandidateRegions();
      // Recurse: this frame's own children contribute in this frame's coords.
      const nested = await collectChildFrameBoxes();
      boxes.push(...nested.boxes.map((b) => ({
        x: b.x, y: b.y, width: b.width ?? b.w, height: b.height ?? b.h,
        category: b.category, reason: b.reason,
      })));
      ocrRegions.push(...nested.ocrRegions);
    }
  } catch (err) {
    console.warn("[Content] Frame scan failed:", err?.message);
  }

  try {
    event.source.postMessage({ [FRAME_MSG]: "SCAN_RESULT", id: data.id, boxes, ocrRegions }, "*");
  } catch {
    // Parent went away mid-scan.
  }
});

// ── Page content extraction (Layer D) ───────────────────────────────────────
// The planner previously saw only a screenshot plus the interactive elements,
// each truncated to 80 characters. Prices, ratings, review counts and delivery
// promises were therefore invisible, which is why a "find me a bassy speaker"
// run typed a query, scrolled twice and picked the first thing it could name.
//
// Extraction is structural rather than site-specific: result listings are
// repeated sibling groups sharing a class signature, which holds on Flipkart,
// Amazon, and most listing UIs without a single hard-coded selector.

const PRICE_RE = /(?:₹|Rs\.?|INR|\$|€|£)\s?\d[\d,]*(?:\.\d{1,2})?/i;
const RATING_RE = /\b([0-5](?:\.\d)?)\s*(?:out of 5|\/\s*5|★|stars?\b)/i;
const REVIEWS_RE = /\b([\d,]+)\s*(?:ratings?|reviews?)\b/i;
const DELIVERY_RE = /\b(free delivery|delivery by [^|\n]{3,30}|get it by [^|\n]{3,30}|arrives [^|\n]{3,30}|out of stock|currently unavailable|in stock)\b/i;
const BADGE_RE = /\b(assured|prime|bestseller|best seller|sponsored|deal of the day|limited deal|\d+%\s*off)\b/i;

const MAX_CONTENT_ROWS = 24;
const MIN_GROUP_SIZE = 3;

/**
 * A structural signature for grouping siblings. Class lists on listing cards
 * are stable within a page even when the class names themselves are generated.
 */
function structuralSignature(el) {
  const classes = (el.className && typeof el.className === "string")
    ? el.className.trim().split(/\s+/).slice(0, 4).sort().join(".")
    : "";
  return `${el.tagName}:${classes}`;
}

/** First regex capture (or whole match) found in `text`, else "". */
function firstMatch(text, re, group = 0) {
  const m = text.match(re);
  return m ? String(m[group] ?? m[0]).trim() : "";
}

/**
 * Extracts repeated result rows from the whole document.
 *
 * Reads outside the viewport on purpose: `extractInteractiveElements` clips to
 * the viewport because a click needs real coordinates, but the planner should be
 * able to decide "scroll to the cheaper one further down" rather than scrolling
 * blindly. Only text is read here — nothing is clicked.
 *
 * @returns {{rows: Array<Object>, groupCount: number}}
 */
function extractPageContent() {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const groups = new Map();

  for (const a of anchors) {
    const title = (a.innerText || a.textContent || "").trim();
    if (title.length < 8) continue;

    // The card is the nearest ancestor that adds context beyond the link text.
    let card = a;
    for (let i = 0; i < 4 && card.parentElement; i++) {
      const parentText = (card.parentElement.innerText || "").trim();
      if (parentText.length > title.length + 12) { card = card.parentElement; break; }
      card = card.parentElement;
    }

    const sig = structuralSignature(card);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push({ card, anchor: a, title });
  }

  // The largest repeated group is the results list; everything else is chrome.
  let best = null;
  for (const members of groups.values()) {
    if (members.length < MIN_GROUP_SIZE) continue;
    if (!best || members.length > best.length) best = members;
  }
  if (!best) return { rows: [], groupCount: groups.size };

  const seen = new Set();
  const rows = [];
  for (const { card, anchor, title } of best) {
    if (rows.length >= MAX_CONTENT_ROWS) break;
    const text = (card.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(title)) continue;
    seen.add(title);

    const row = {
      title: title.slice(0, 120),
      price: firstMatch(text, PRICE_RE),
      rating: firstMatch(text, RATING_RE, 1),
      reviews: firstMatch(text, REVIEWS_RE, 1),
      delivery: firstMatch(text, DELIVERY_RE).slice(0, 60),
      badge: firstMatch(text, BADGE_RE).slice(0, 40),
    };

    // Point at the clickable element when it is one the planner can address.
    const ref = interactiveNodeRefs.get(anchor);
    if (typeof ref === "number") row.ref = ref;

    // Whether the row is on screen right now, so the planner knows if it must
    // scroll before it can act on this one.
    const rect = card.getBoundingClientRect();
    row.onScreen = rect.bottom > 0 && rect.top < window.innerHeight;

    rows.push(row);
  }

  return { rows, groupCount: groups.size };
}

/**
 * Renders or updates the subtle on-page floating privacy badge.
 */
function updateFloatingBadge(piiCount) {
  // Only render floating badge in the top-level window (never inside sub-iframes/modals)
  if (window.top !== window.self) return;

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

  // Prevent redundant DOM updates that re-trigger the MutationObserver
  const stateKey = `${piiCount}_${isProtectionEnabled}`;
  if (badge.dataset.lastState === stateKey) return;
  badge.dataset.lastState = stateKey;

  badge.innerHTML = `
    <span style="font-size: 13px;">🛡️</span>
    <span>Zero-Leakage</span>
    <span style="background: ${piiCount > 0 ? '#ef4444' : '#10b981'}; color: #fff; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 700;">${piiCount} PII</span>
  `;
}

/**
 * Initializes debounced MutationObserver and SPA navigation listeners.
 * Detects in-place DOM updates and route switches without full page reloads.
 */
function initDynamicObserver() {
  observer = new MutationObserver((mutations) => {
    // Ignore mutations originating from our own overlays, badges, or action indicators
    const isOurOwn = mutations.every((m) => {
      const t = m.target;
      return t && t.closest && t.closest(`#${OVERLAY_ID}, #${FLOATING_BADGE_ID}, #privibrowse-action-indicator`);
    });
    if (isOurOwn) return;

    lastSpaMutationTime = Date.now();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (isProtectionEnabled) {
        scanPageForSensitiveElements();
      }
    }, 400);
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
    });
  }

  // Intercept client-side SPA history navigation (pushState / replaceState / popstate)
  try {
    const notifySpaRoute = () => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastSpaRoute) {
        lastSpaRoute = currentUrl;
        lastSpaMutationTime = Date.now();
        if (isProtectionEnabled) {
          scanPageForSensitiveElements();
        }
      }
    };

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const res = originalPushState.apply(this, args);
      notifySpaRoute();
      return res;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const res = originalReplaceState.apply(this, args);
      notifySpaRoute();
      return res;
    };

    window.addEventListener("popstate", notifySpaRoute);
    window.addEventListener("hashchange", notifySpaRoute);
  } catch {}
}

function animateActionTarget(target, actionType) {
  const indicator = document.createElement("div");
  indicator.id = "privibrowse-action-indicator";
  const rect = target.getBoundingClientRect();
  Object.assign(indicator.style, {
    position: "fixed",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    border: "2px solid #3b82f6",
    background: "rgba(59, 130, 246, 0.2)",
    zIndex: "2147483647",
    pointerEvents: "none",
    borderRadius: "4px",
    transition: "all 0.3s ease",
  });
  document.body.appendChild(indicator);
  setTimeout(() => {
    indicator.style.opacity = "0";
    setTimeout(() => indicator.remove(), 600);
  }, 900);
}

function findElementAcrossFrames(selector) {
  if (!selector) return null;
  let el = null;
  try {
    el = document.querySelector(selector);
  } catch {}
  if (el) return el;

  document.querySelectorAll("iframe").forEach((iframe) => {
    if (el) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) el = doc.querySelector(selector);
    } catch {}
  });
  return el;
}

/**
 * Synthesizes and executes native browser actions requested by VLM.
 */
async function executeAgentAction(action) {
  let target = null;

  // 1. Direct CSS selector across main document and accessible iframes
  if (action.selector) {
    target = findElementAcrossFrames(action.selector);
  }

  // 2. Extract index if selector is nth-of-type or data-agent-id (e.g. button:nth-of-type(45) or [data-agent-id="45"])
  if (!target && action.selector) {
    const numMatch = action.selector.match(/(?:nth-of-type|data-agent-id)[(=["']?(\d+)/i);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10);
      target = findElementAcrossFrames(`[data-agent-id="${idx}"]`);
      if (!target) {
        const allButtons = document.querySelectorAll("button, [role='button']");
        if (allButtons.length >= idx && idx > 0) {
          target = allButtons[idx - 1];
        }
      }
    }
  }

  // 3. Fallback for Submit / Send intent (ChatGPT, Claude, search engines, forms)
  const isSubmitOrSend = (action.type === "submit" || action.type === "click") &&
    (action.explanation || "").toLowerCase().match(/submit|send|prompt|enter|search|proceed/i);

  if (!target && isSubmitOrSend) {
    target = document.querySelector(
      'button[data-testid*="send" i], button[data-testid*="submit" i], button[aria-label*="Send" i], button[aria-label*="Submit" i], button[type="submit"], form button, [role="button"][aria-label*="Send" i]'
    );
  }

  // 4. Coordinates fallback
  if (!target && action.coordinates && typeof action.coordinates.x === "number") {
    target = document.elementFromPoint(action.coordinates.x, action.coordinates.y);
  }

  // If still not found and the action was to submit / send, submit active input via Enter
  if (!target && isSubmitOrSend) {
    const activeInput = document.querySelector("#prompt-textarea, textarea, input:focus, [contenteditable='true']");
    if (activeInput) {
      activeInput.focus();
      activeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      activeInput.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      activeInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return { ok: true, executed: "submit_via_enter", note: "Submitted by dispatching Enter key on prompt input" };
    }
  }

  if (!target && action.type !== "scroll" && action.type !== "finish") {
    return { ok: false, error: `Target element not found: ${action.selector || "coords"}` };
  }

  if (target) {
    animateActionTarget(target, action.type);
    try {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {}
  }

  switch (action.type) {
    case "click":
      // Enable if disabled
      if (target.hasAttribute("disabled") || target.disabled) {
        target.disabled = false;
        target.removeAttribute("disabled");
      }

      target.focus();
      const clickOpts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
      target.dispatchEvent(new PointerEvent("pointerdown", clickOpts));
      target.dispatchEvent(new MouseEvent("mousedown", clickOpts));
      target.dispatchEvent(new PointerEvent("pointerup", clickOpts));
      target.dispatchEvent(new MouseEvent("mouseup", clickOpts));
      target.click();

      // If clicking Send / Submit, also press Enter on prompt input as backup
      if (isSubmitOrSend) {
        const promptInput = document.querySelector("#prompt-textarea, textarea, [contenteditable='true']");
        if (promptInput) {
          promptInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          promptInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
      }
      return { ok: true, executed: "click", selector: action.selector };

    case "type":
      target.focus();
      const val = action.value || "";

      // 1. ContentEditable (ChatGPT, Claude, rich text editors)
      if (target.isContentEditable || target.getAttribute("contenteditable") === "true") {
        target.focus();
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, val);
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        // 2. React 16+ input/textarea value tracker bypass
        const proto = target instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setMethod = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setMethod) {
          setMethod.call(target, val);
        } else {
          target.value = val;
        }

        target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: val }));
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: val }));
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: true, executed: "type", value: val };

    case "scroll":
      const scrollY = action.value === "up" ? -350 : 350;
      window.scrollBy({ top: scrollY, behavior: "smooth" });
      return { ok: true, executed: "scroll", direction: action.value };

    case "submit":
      if (target.form && target.form.requestSubmit) {
        target.form.requestSubmit();
      } else if (target.form) {
        target.form.submit();
      } else {
        target.focus();
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
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
    if (window.top !== window.self) {
      // Sub-frames are scanned through the parent's postMessage handshake, not
      // directly, so their boxes arrive already offset into page coordinates.
      return false;
    }
    (async () => {
    const tScanStart = performance.now();
    const matches = scanPageForSensitiveElements();
    const ocrRegions = collectOcrCandidateRegions();

    // Cross-origin iframes scan themselves and report back in page coordinates.
    let frameBoxes = [];
    try {
      const nested = await collectChildFrameBoxes();
      frameBoxes = nested.boxes;
      ocrRegions.push(...nested.ocrRegions);
    } catch (err) {
      console.warn("[Content] Child frame scan failed:", err?.message);
    }

    const domScanMs = performance.now() - tScanStart;
    const interactive = extractInteractiveElements();
    // Must run AFTER extractInteractiveElements: it consumes the ref map that
    // call rebuilds, so page rows can name a clickable target.
    let pageContent = { rows: [], groupCount: 0 };
    try {
      pageContent = extractPageContent();
    } catch (err) {
      console.warn("[Content] Page content extraction failed:", err?.message);
    }
    let structuredData = null;
    try {
      structuredData = window.__PRIVIBROWSE_TELEMETRY_ADAPTER__?.getTelemetryDigest() || null;
    } catch {}

    sendResponse({
      ok: true,
      domScanMs,
      ocrRegions,
      frameBoxCount: frameBoxes.length,
      boxes: [
        ...matches.map((m) => ({
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
          category: m.category,
          reason: m.reason,
        })),
        ...frameBoxes,
      ],
      interactiveElements: interactive,
      pageContent: pageContent.rows,
      structuredData,
      spaMetadata: {
        currentRoute: window.location.href,
        lastMutationTime: lastSpaMutationTime,
        timestamp: new Date().toISOString(),
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
    });
    })();
    // Async: the child-frame handshake must complete before responding.
    return true;
  }

  if (message.type === "EXECUTE_ACTION") {
    // The script now runs in every frame, so this message reaches all of them
    // and the FIRST responder wins. A sub-frame that cannot see the target must
    // stay silent, or its "not found" would beat the frame that can actually
    // perform the action. The top frame always answers, so a genuine miss is
    // still reported rather than hanging.
    if (window.top !== window.self && !frameCanHandleAction(message.action)) {
      return false;
    }
    executeAgentAction(message.action)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_ELEMENT_HREF") {
    // Same rule as EXECUTE_ACTION: a frame that cannot see the link stays quiet.
    if (window.top !== window.self && !document.querySelector(message.selector || "\0")) {
      return false;
    }
    // Resolves a link's REAL address for new_tab, so the agent never navigates
    // to a URL a model assembled from memory.
    try {
      const node = document.querySelector(message.selector);
      if (!node) {
        sendResponse({ ok: false, error: `No element matches ${message.selector}` });
        return false;
      }
      // The model often targets a card wrapping the link rather than the <a>.
      const link = node.closest("a[href]") || node.querySelector("a[href]") || node;
      const href = link.href || link.getAttribute?.("href") || "";
      if (!href) {
        sendResponse({ ok: false, error: "Target element has no link to open" });
        return false;
      }
      // `link.href` is already absolute; resolve the attribute form too.
      sendResponse({ ok: true, href: new URL(href, document.baseURI).toString() });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }

  if (message.type === "HIGHLIGHT_DOM") {
    const matches = scanPageForSensitiveElements();
    drawHighlightOverlay(matches);
    sendResponse({ ok: true, count: matches.length });
    return false;
  }

  if (message.type === "CLEAR_OVERLAYS") {
    const layer = document.getElementById(OVERLAY_ID);
    if (layer) layer.remove();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "SETTINGS_CHANGED") {
    if (message.settings) {
      isProtectionEnabled = Boolean(message.settings.enabled);
      showPageBadge = Boolean(message.settings.showPageBadge);
      scanPageForSensitiveElements();
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
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

// Initial Boot — load persisted protection state before the first scan
function bootWithSettings() {
  if (window.top !== window.self) return;

  const start = () => {
    scanPageForSensitiveElements();
    initDynamicObserver();
  };
  try {
    chrome.storage.local.get(["settings"], (result) => {
      const s = result && result.settings;
      if (s) {
        isProtectionEnabled = s.enabled !== false;
        showPageBadge = Boolean(s.showPageBadge);
      }
      start();
    });
  } catch {
    start();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootWithSettings);
} else {
  bootWithSettings();
}
})();
