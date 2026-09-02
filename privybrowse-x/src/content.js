/**
 * content.js — runs in the page. The "hands and eyes" of the agent.
 *
 * Two jobs:
 *   1. SCAN — find sensitive elements, and build a DOM digest that is scrubbed
 *      BEFORE it ever leaves this script.
 *   2. OVERLAY — draw the live detection boxes. Note this is a *detection*
 *      visualisation for the operator, NOT the redaction. The real redaction
 *      happens on the captured bitmap in offscreen.js. Conflating the two was
 *      a flaw in the Day 1 prototype: a translucent DOM overlay looks like
 *      redaction while protecting nothing.
 *
 * Loaded as a classic content script (no ES modules available), so the
 * detector logic is inlined rather than imported. Keep it in sync with
 * detector.js — or bundle both if you add a build step later.
 */

(() => {
  "use strict";
  if (window.__privyBrowseLoaded) return;
  window.__privyBrowseLoaded = true;

  // -------------------------------------------------------------------------
  // Detection rules — mirror of detector.js (see note above)
  // -------------------------------------------------------------------------

  const SENSITIVE_AUTOCOMPLETE_TOKENS = [
    "cc-number","cc-exp","cc-exp-month","cc-exp-year","cc-csc","cc-name","cc-type",
    "current-password","new-password","one-time-code",
    "email","tel","tel-national","tel-local","tel-area-code",
    "name","given-name","family-name","additional-name","nickname","username",
    "street-address","address-line1","address-line2","address-line3",
    "address-level1","address-level2","postal-code","country","country-name",
    "bday","bday-day","bday-month","bday-year","sex",
  ];

  const SENSITIVE_NAME_PATTERN = new RegExp([
    "pass(word|wd|phrase)?","secret","token","api.?key","auth",
    "ssn","social.?security","aadhaa?r","uidai","pan\\b","pan.?(no|num|card)",
    "passport","licen[cs]e","voter.?id","driving",
    "credit","debit","card.?(no|num|number)","cvv","cvc","csc",
    "pin\\b","otp","mfa","2fa","email","e-mail","mail.?id",
    "phone","mobile","contact.?(no|num)","whatsapp","dob","birth","age\\b",
    "address","street","pincode","postal","zip","salary","income","ctc\\b",
    "account.?(no|num|number)","acct","ifsc","swift","iban","upi","vpa\\b",
    "gst(in)?","tin\\b","medical","health","insurance","policy.?(no|num)",
  ].join("|"), "i");

  function luhnValid(d) {
    if (!/^\d{13,19}$/.test(d)) return false;
    let sum = 0, dbl = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = +d[i];
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      sum += n; dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
              [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
              [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
              [9,8,7,6,5,4,3,2,1,0]];
  const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
              [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
              [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  function verhoeffValid(d) {
    if (!/^\d{12}$/.test(d)) return false;
    let c = 0;
    const rev = d.split("").reverse();
    for (let i = 0; i < rev.length; i++) c = VD[c][VP[i % 8][+rev[i]]];
    return c === 0;
  }

  // Reject a match that is really a fragment of a longer digit run.
  // A 16-digit order number contains 12-digit substrings, one of which can
  // pass Verhoeff and masquerade as an Aadhaar. \b doesn't help when the
  // separator is a space. Keep in sync with detector.js.
  function notPartOfLongerRun(text, index, len) {
    const before = text.slice(Math.max(0, index - 2), index);
    const after = text.slice(index + len, index + len + 2);
    if (/\d[ -]?$/.test(before)) return false;
    if (/^[ -]?\d/.test(after)) return false;
    return true;
  }

  const VALUE_PATTERNS = [
    { id: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, confidence: 0.95 },
    { id: "aadhaar", re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g, confidence: 0.9,
      validate: (s) => verhoeffValid(s.replace(/[ -]/g, "")), guardRun: true },
    { id: "pan", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, confidence: 0.95 },
    { id: "upi", re: /\b[\w.\-]{2,}@(?:ok(?:icici|hdfcbank|axis|sbi)|paytm|ybl|upi|apl|axl|ibl)\b/gi, confidence: 0.95 },
    { id: "ifsc", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, confidence: 0.9 },
    { id: "credit-card", re: /\b(?:\d[ -]?){13,19}\b/g, confidence: 0.95,
      validate: (s) => luhnValid(s.replace(/[ -]/g, "")) },
    { id: "phone-in", re: /(?:\+91[ -]?)?\b[6-9]\d{9}\b/g, confidence: 0.85, guardRun: true },
    { id: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, confidence: 0.95, guardRun: true },
  ];

  function scanText(text) {
    if (!text) return [];
    const out = [];
    for (const p of VALUE_PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text)) !== null) {
        if (p.validate && !p.validate(m[0])) continue;
        if (p.guardRun && !notPartOfLongerRun(text, m.index, m[0].length)) continue;
        out.push({ id: p.id, match: m[0], index: m.index, confidence: p.confidence });
        if (p.re.lastIndex === m.index) p.re.lastIndex++;
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }

  function scrubText(text) {
    if (!text) return { text, redactions: [] };
    const hits = scanText(text);
    if (!hits.length) return { text, redactions: [] };
    let out = text;
    const redactions = [];
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      out = out.slice(0, h.index) + `[REDACTED:${h.id.toUpperCase()}]` + out.slice(h.index + h.match.length);
      redactions.push({ kind: h.id, confidence: h.confidence });
    }
    return { text: out, redactions: redactions.reverse() };
  }

  function labelHaystack(el) {
    const parts = [
      el.getAttribute("name"), el.getAttribute("id"),
      el.getAttribute("placeholder"), el.getAttribute("aria-label"),
      el.getAttribute("data-testid"),
    ];
    try {
      if (el.labels?.length) for (const l of el.labels) parts.push(l.textContent);
      const lb = el.getAttribute("aria-labelledby");
      if (lb) for (const id of lb.split(/\s+/)) parts.push(document.getElementById(id)?.textContent);
    } catch { /* ignore */ }
    return parts.filter(Boolean).join(" ").slice(0, 500);
  }

  function classifyElement(el) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return { layer: "L1", confidence: 1.0, kind: "password", reason: 'type="password"' };

    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (ac) {
      for (const t of SENSITIVE_AUTOCOMPLETE_TOKENS) {
        if (ac === t || ac.split(/\s+/).includes(t)) {
          return { layer: "L2", confidence: 0.95, kind: t, reason: `autocomplete="${t}"` };
        }
      }
    }

    const hay = labelHaystack(el);
    const m = hay.match(SENSITIVE_NAME_PATTERN);
    if (m) return { layer: "L3", confidence: 0.8, kind: m[0].toLowerCase(), reason: `label matched "${m[0]}"` };

    if (typeof el.value === "string" && el.value.length > 3) {
      const hit = scanText(el.value)[0];
      if (hit) return { layer: "L4", confidence: hit.confidence, kind: hit.id, reason: `value matched ${hit.id}` };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  /** Elements only count if they're actually painted — zero-size or hidden
   *  fields have no pixels to redact (they still matter to the TEXT sink). */
  function isVisible(el, rect) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
    // Off-screen fields can't be in the capture either.
    if (rect.bottom < 0 || rect.right < 0) return false;
    if (rect.top > innerHeight || rect.left > innerWidth) return false;
    return true;
  }

  function scanFields() {
    const boxes = [];
    const hiddenSensitive = [];

    document.querySelectorAll("input, textarea, select").forEach((el) => {
      const cls = classifyElement(el);
      if (!cls) return;

      const r = el.getBoundingClientRect();
      if (!isVisible(el, r)) {
        // No pixels, but still must not be serialised into the digest.
        hiddenSensitive.push({ kind: cls.kind, layer: cls.layer });
        return;
      }

      boxes.push({
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        kind: cls.kind, layer: cls.layer,
        confidence: cls.confidence, reason: cls.reason,
      });
    });

    return { boxes, hiddenSensitive };
  }

  /**
   * PII rendered as plain text — profile pages, order confirmations. Uses
   * Range to get the on-screen rect of the matched substring rather than the
   * whole paragraph, which keeps masks tight and over-redaction low.
   */
  function scanTextNodes(limit = 400) {
    const boxes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim().length < 6) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let seen = 0;
    let node;
    while ((node = walker.nextNode()) && seen < limit) {
      seen++;
      const hits = scanText(node.nodeValue);
      for (const h of hits) {
        try {
          const range = document.createRange();
          range.setStart(node, h.index);
          range.setEnd(node, h.index + h.match.length);
          const r = range.getBoundingClientRect();
          range.detach?.();
          if (r.width <= 0 || r.height <= 0) continue;
          if (r.bottom < 0 || r.top > innerHeight) continue;
          boxes.push({
            rect: { x: r.left, y: r.top, w: r.width, h: r.height },
            kind: h.id, layer: "L4", confidence: h.confidence,
            reason: `text matched ${h.id}`,
          });
        } catch { /* detached / shadow DOM */ }
      }
    }
    return boxes;
  }

  // -------------------------------------------------------------------------
  // Digest — the TEXT sink
  // -------------------------------------------------------------------------

  /**
   * Build the structured page model the server reasons over.
   *
   * Two principles from the problem statement, both applied here rather than
   * server-side, because "the server will filter it" is not privacy:
   *   - SCRUB: every string passes through scrubText.
   *   - MINIMISE: only interactable elements and headings are included, not
   *     the whole DOM. Less data is both safer and cheaper.
   */
  function buildDigest() {
    let redactionCount = 0;
    const byKind = {};

    const note = (reds) => {
      for (const r of reds) {
        redactionCount++;
        byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      }
    };

    const scrub = (s) => {
      const { text, redactions } = scrubText(s || "");
      note(redactions);
      return text;
    };

    const elements = [];
    const interactive = document.querySelectorAll(
      "a[href], button, input, textarea, select, [role=button], [role=link], [role=textbox]"
    );

    let idx = 0;
    interactive.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (r.bottom < 0 || r.top > innerHeight) return;
      if (idx >= 150) return; // context minimisation cap

      const cls = classifyElement(el);
      const entry = {
        i: idx++,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || undefined,
        role: el.getAttribute("role") || undefined,
        label: scrub(labelHaystack(el).slice(0, 120)) || undefined,
        text: scrub((el.textContent || "").trim().slice(0, 120)) || undefined,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      };

      if (cls) {
        // A flagged field NEVER contributes its value, whatever the content
        // regexes think of it. Belt and braces.
        entry.sensitive = true;
        entry.piiKind = cls.kind;
        entry.value = "[REDACTED:FIELD]";
        redactionCount++;
        byKind.field = (byKind.field || 0) + 1;
      } else if (el.value && String(el.value).length < 100) {
        entry.value = scrub(String(el.value));
      }

      elements.push(entry);
    });

    const headings = [];
    document.querySelectorAll("h1, h2, h3").forEach((h) => {
      if (headings.length >= 20) return;
      const t = scrub((h.textContent || "").trim().slice(0, 100));
      if (t) headings.push(t);
    });

    return {
      digest: {
        url: scrub(location.href),
        title: scrub(document.title),
        viewport: { w: innerWidth, h: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
        headings,
        elements,
      },
      stats: { redactionCount, byKind },
    };
  }

  // -------------------------------------------------------------------------
  // Overlay — DETECTION visualisation (not redaction; see file header)
  // -------------------------------------------------------------------------

  const OVERLAY_ID = "__privybrowse_overlay__";

  function clearOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function drawOverlay(boxes) {
    clearOverlay();
    if (!boxes.length) return;

    const layer = document.createElement("div");
    layer.id = OVERLAY_ID;
    Object.assign(layer.style, {
      position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh",
      pointerEvents: "none", zIndex: "2147483647",
    });

    for (const b of boxes) {
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "fixed",
        top: `${b.rect.y}px`, left: `${b.rect.x}px`,
        width: `${b.rect.w}px`, height: `${b.rect.h}px`,
        // Deliberately translucent: this is a DETECTION marker so the operator
        // can still see what was flagged. The actual mask applied to the
        // transmitted bitmap is fully opaque — see redact.js.
        background: "rgba(220, 38, 38, 0.28)",
        border: "2px solid #dc2626",
        borderRadius: "2px", boxSizing: "border-box",
      });
      box.title = `${b.kind} — ${b.reason} (${b.layer})`;

      const tag = document.createElement("div");
      tag.textContent = `${b.layer} ${b.kind}`;
      Object.assign(tag.style, {
        position: "absolute", top: "-16px", left: "0",
        font: "10px/1.4 ui-monospace, monospace", color: "#fff",
        background: "#dc2626", padding: "0 4px", borderRadius: "2px",
        whiteSpace: "nowrap",
      });
      box.appendChild(tag);
      layer.appendChild(box);
    }
    document.documentElement.appendChild(layer);
  }

  // -------------------------------------------------------------------------

  function fullScan() {
    const { boxes: fieldBoxes, hiddenSensitive } = scanFields();
    const textBoxes = scanTextNodes();
    return { boxes: [...fieldBoxes, ...textBoxes], hiddenSensitive };
  }

  let overlayVisible = false;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      switch (msg?.type) {
        case "SCAN_FOR_PAYLOAD": {
          // Measure dpr/scroll HERE, at scan time, and ship it with the boxes.
          // Reading it later at draw time is a race: the user scrolls and every
          // mask shifts.
          const { boxes } = fullScan();
          const { digest, stats } = buildDigest();
          const dpr = window.devicePixelRatio || 1;

          sendResponse({
            ok: true,
            // Converted to capture-pixel space here so the offscreen document
            // never has to know about dpr. One conversion, one place.
            domBoxes: boxes.map((b) => ({
              rect: { x: b.rect.x * dpr, y: b.rect.y * dpr, w: b.rect.w * dpr, h: b.rect.h * dpr },
              kind: b.kind, layer: b.layer, confidence: b.confidence, reason: b.reason,
            })),
            viewportCtx: { dpr, scrollX, scrollY, innerWidth, innerHeight },
            digest, digestStats: stats,
          });
          break;
        }

        case "SHOW_OVERLAY": {
          const { boxes } = fullScan();
          drawOverlay(boxes);
          overlayVisible = true;
          sendResponse({ ok: true, count: boxes.length, boxes });
          break;
        }

        case "CLEAR_OVERLAY":
          clearOverlay();
          overlayVisible = false;
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: `unknown: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return true;
  });

  // Keep boxes glued to their fields while scrolling, but throttle to one
  // redraw per frame — the Day 1 version re-scanned the whole DOM on every
  // scroll event, which is a lot of wasted CPU on a metric we're scored on.
  let rafPending = false;
  const refresh = () => {
    if (!overlayVisible || rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      drawOverlay(fullScan().boxes);
    });
  };
  addEventListener("scroll", refresh, { passive: true });
  addEventListener("resize", refresh);

  console.log("[PrivyBrowse] content script ready");
})();
