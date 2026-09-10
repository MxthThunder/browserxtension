/**
 * Semantic Redaction Pipeline (Manifest V3)
 * Step 5 of Privacy-Preserving Browser-Agent Architecture.
 *
 * Implements session-scoped semantic placeholder generation, ephemeral bidirectional
 * token mapping, visual canvas obliteration (blackout/blur/pixelate), and structured text digest sanitization.
 *
 * Guarantees Zero-Leakage:
 * - Session mappings (e.g. "Jane Doe" <-> "[PERSON_1]") exist purely in volatile memory.
 * - External LLMs / VLMs only ever see session placeholders ([PERSON_1], [EMAIL_1], [CARD_1]).
 * - Sensitive visual bounding boxes are physically obliterated on an offscreen canvas.
 */

import { findNames } from "./name_detector.js";

export const REDACTION_TYPES = {
  PERSON: "PERSON",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  CARD: "CARD",
  PASSWORD: "PASSWORD",
  GOV_ID: "GOV_ID",
  ADDRESS: "ADDRESS",
  FACE: "FACE",
  FINANCIAL: "FINANCIAL",
  GENERIC_PII: "PII"
};

/**
 * Credential labels, kept byte-identical to INLINE_PII_PATTERNS' copy in
 * content.js — that file is a classic content script and cannot `import`, so
 * the list is duplicated rather than shared (the same call the PHONE pattern
 * made). scripts/test-credential-detection.mjs asserts the two never drift.
 */
export const CREDENTIAL_LABELS = [
  "pass(?:word|phrase|wd)", "pwd", "passcode",
  "otp", "one[\\s_-]?time[\\s_-]?(?:code|password|pin)",
  "(?:security|secret)[\\s_-]?(?:question|answer)",
  "(?:recovery|backup|reset|activation)[\\s_-]?code",
  "(?:api|secret|access|private|client|encryption)[\\s_-]?(?:key|secret)",
  "(?:access|auth|bearer|refresh|session|csrf)[\\s_-]?token",
  "session[\\s_-]?id",
  "cvv", "cvc", "csc", "pin",
  "user(?:name|[\\s_-]?id)", "login(?:[\\s_-]?id)?",
].join("|");

export const VISUAL_MASK_STYLES = {
  SOLID_BLACK: "solid_black",
  PIXELATE: "pixelate",
  BLUR: "blur"
};

export class SemanticRedactor {
  constructor() {
    this._placeholderToReal = new Map();
    this._realToPlaceholder = new Map();
    this._counters = {
      [REDACTION_TYPES.PERSON]: 0,
      [REDACTION_TYPES.EMAIL]: 0,
      [REDACTION_TYPES.PHONE]: 0,
      [REDACTION_TYPES.CARD]: 0,
      [REDACTION_TYPES.PASSWORD]: 0,
      [REDACTION_TYPES.GOV_ID]: 0,
      [REDACTION_TYPES.ADDRESS]: 0,
      [REDACTION_TYPES.FACE]: 0,
      [REDACTION_TYPES.FINANCIAL]: 0,
      [REDACTION_TYPES.GENERIC_PII]: 0,
    };
  }

  /**
   * Clears all session-scoped ephemeral mappings.
   */
  resetSession() {
    this._placeholderToReal.clear();
    this._realToPlaceholder.clear();
    for (const key of Object.keys(this._counters)) {
      this._counters[key] = 0;
    }
  }

  /**
   * Generates or retrieves a session-scoped placeholder for a sensitive string.
   * @param {string} rawValue Plaintext sensitive value
   * @param {string} type REDACTION_TYPES key
   * @returns {string} E.g. "[PERSON_1]" or "[EMAIL_1]"
   */
  getOrCreatePlaceholder(rawValue, type = REDACTION_TYPES.GENERIC_PII) {
    if (!rawValue || typeof rawValue !== "string") return rawValue;
    const cleanRaw = rawValue.trim();
    if (!cleanRaw) return rawValue;

    if (this._realToPlaceholder.has(cleanRaw)) {
      return this._realToPlaceholder.get(cleanRaw);
    }

    const normType = REDACTION_TYPES[type.toUpperCase()] || REDACTION_TYPES.GENERIC_PII;
    this._counters[normType] = (this._counters[normType] || 0) + 1;
    const placeholder = `[${normType}_${this._counters[normType]}]`;

    this._realToPlaceholder.set(cleanRaw, placeholder);
    this._placeholderToReal.set(placeholder, cleanRaw);

    return placeholder;
  }

  _mapCategoryToType(cat) {
    if (!cat || typeof cat !== "string") return REDACTION_TYPES.GENERIC_PII;
    const lower = cat.toLowerCase();
    if (lower.includes("name") || lower.includes("person")) return REDACTION_TYPES.PERSON;
    if (lower.includes("email")) return REDACTION_TYPES.EMAIL;
    if (lower.includes("phone") || lower.includes("tel") || lower.includes("mobile") || lower.includes("contact")) return REDACTION_TYPES.PHONE;
    if (lower.includes("card") || lower.includes("credit") || lower.includes("debit")) return REDACTION_TYPES.CARD;
    if (lower.includes("pass") || lower.includes("secret") || lower.includes("pin") || lower.includes("otp")) return REDACTION_TYPES.PASSWORD;
    if (lower.includes("gov") || lower.includes("id") || lower.includes("ssn") || lower.includes("pan") || lower.includes("aadhaar")) return REDACTION_TYPES.GOV_ID;
    if (lower.includes("address") || lower.includes("zip") || lower.includes("postal") || lower.includes("pincode")) return REDACTION_TYPES.ADDRESS;
    if (lower.includes("face")) return REDACTION_TYPES.FACE;
    if (lower.includes("salary") || lower.includes("financial") || lower.includes("income") || lower.includes("bank")) return REDACTION_TYPES.FINANCIAL;
    return REDACTION_TYPES[cat.toUpperCase()] || REDACTION_TYPES.GENERIC_PII;
  }

  /**
   * Alias for getOrCreatePlaceholder to cleanly anonymize a value.
   */
  anonymize(rawValue, typeOrCategory = REDACTION_TYPES.GENERIC_PII) {
    const type = this._mapCategoryToType(typeOrCategory);
    return this.getOrCreatePlaceholder(rawValue, type);
  }

  /**
   * De-anonymizes a string or object by restoring placeholders to raw values strictly locally.
   * NEVER pass the de-anonymized output over the network.
   * @param {string} text Sanitized text with placeholders
   * @returns {string} Plaintext restored
   */
  deAnonymize(text) {
    if (!text || typeof text !== "string") return text;
    let result = text;
    for (const [placeholder, rawVal] of this._placeholderToReal.entries()) {
      result = result.split(placeholder).join(rawVal);
    }
    return result;
  }

  /**
   * Checks if a string contains any session placeholders.
   * @param {string} text 
   */
  hasPlaceholders(text) {
    if (!text || typeof text !== "string") return false;
    for (const placeholder of this._placeholderToReal.keys()) {
      if (text.includes(placeholder)) return true;
    }
    return false;
  }

  /**
   * Returns a read-only list of current session placeholders (without exposing raw values).
   */
  getSessionPlaceholderSummary() {
    const summary = [];
    for (const [placeholder] of this._placeholderToReal.entries()) {
      summary.push(placeholder);
    }
    return summary;
  }

  /**
   * Sanitizes a raw text string by replacing recognized regex patterns with session placeholders.
   * @param {string} rawText 
   * @returns {string}
   */
  sanitizeText(rawText) {
    if (!rawText || typeof rawText !== "string") return "";
    let sanitized = rawText;

    // Credentials FIRST. A secret has no shape of its own, so it has to claim
    // its span before the numeric patterns below mistake "PIN: 4829" for
    // something benign — and because a leaked credential is the worst outcome
    // on this list, it must not depend on another pattern missing it.
    //
    // The label is deliberately preserved: the model still learns "a password
    // lives here", which it needs to reason about a login form, while the value
    // becomes [PASSWORD_n]. Only the value is replaced.
    sanitized = sanitized.replace(
      new RegExp(`\\b(${CREDENTIAL_LABELS})(\\s*[:=]\\s*)(\\S[^\\n\\r]{0,79})`, "gi"),
      (_m, label, sep, value) =>
        `${label}${sep}${this.getOrCreatePlaceholder(value, REDACTION_TYPES.PASSWORD)}`
    );

    // Vendor-shaped keys and JWTs, which announce themselves with no label.
    sanitized = sanitized.replace(
      /\b(?:sk|pk|rk)[-_](?:test|live|prod)[-_][A-Za-z0-9]{12,}|\b(?:sk|pk)[-_][A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}|\bAIza[0-9A-Za-z_-]{35}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      (match) => this.getOrCreatePlaceholder(match, REDACTION_TYPES.PASSWORD)
    );

    // UPI handles. The EMAIL pattern below cannot catch these: it requires a
    // dot-TLD and a UPI handle has none ("name@upi", "name@oksbi"), so a
    // payment identifier was passing through untouched. Matched against the
    // known PSP suffixes rather than "any @word", which would eat @mentions.
    sanitized = sanitized.replace(
      /\b[A-Za-z0-9._-]{2,}@(?:upi|ybl|ibl|axl|apl|paytm|okhdfcbank|oksbi|okaxis|okicici|hdfcbank|sbi|icici|axisbank|kotak|yesbank|freecharge|airtel|jupiteraxis|fam|slc|naviaxis)\b/gi,
      (match) => this.getOrCreatePlaceholder(match, REDACTION_TYPES.FINANCIAL)
    );

    // Credit Cards
    sanitized = sanitized.replace(/\b(?:\d{4}[ -]?){3}\d{4}\b/g, (match) =>
      this.getOrCreatePlaceholder(match, REDACTION_TYPES.CARD)
    );

    // Emails
    sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, (match) =>
      this.getOrCreatePlaceholder(match, REDACTION_TYPES.EMAIL)
    );

    // Phone Numbers. Grouping-agnostic (see content.js's INLINE_PII_PATTERNS.PHONE
    // for the full rationale): the previous 3-3-4-only pattern missed the
    // Indian mobile format (98765 43210) and Korean-style 3-4-4 numbers.
    sanitized = sanitized.replace(/\b\+?\(?\d{2,5}\)?(?:[-.\s]\d{2,5}){1,4}\b/g, (match) =>
      this.getOrCreatePlaceholder(match, REDACTION_TYPES.PHONE)
    );

    // SSN
    sanitized = sanitized.replace(/\b\d{3}-\d{2}-\d{4}\b/g, (match) =>
      this.getOrCreatePlaceholder(match, REDACTION_TYPES.GOV_ID)
    );

    // Aadhaar
    sanitized = sanitized.replace(/\b\d{4}\s\d{4}\s\d{4}\b/g, (match) =>
      this.getOrCreatePlaceholder(match, REDACTION_TYPES.GOV_ID)
    );

    // PAN
    sanitized = sanitized.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g, (match) =>
      this.getOrCreatePlaceholder(match, REDACTION_TYPES.GOV_ID)
    );

    // Passport (1 letter + 7 digits)
    sanitized = sanitized.replace(/\b[A-Z]\d{7}\b/g, (match) =>
      this.getOrCreatePlaceholder(match, REDACTION_TYPES.GOV_ID)
    );

    // Bank IFSC
    sanitized = sanitized.replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, (match) =>
      this.getOrCreatePlaceholder(match, REDACTION_TYPES.GOV_ID)
    );

    // Indian pincode, only when nearby words say it is one. A bare 6-digit run
    // is far more often a price, an order id or a product code, so the label or
    // a delivery cue has to be present. "Delivery by Fri to 560001" counts:
    // on a real page that number is the user's own address.
    sanitized = sanitized.replace(
      /\b(pin\s?code|pin|postal\s?code|zip|deliver(?:y|ing)?(?:\s+\w+){0,3}?\s+to|ship(?:ping)?\s+to)\b(\s*[:\-]?\s*)(\d{6})\b/gi,
      (_m, label, sep, digits) =>
        `${label}${sep}${this.getOrCreatePlaceholder(digits, REDACTION_TYPES.ADDRESS)}`
    );

    // Person names. Applied LAST so the numeric and email patterns above have
    // already claimed their spans and cannot be re-matched inside a placeholder.
    // Replaced back-to-front so each index stays valid as the string shortens.
    for (const nameHit of findNames(sanitized).reverse()) {
      const placeholder = this.getOrCreatePlaceholder(nameHit.text, REDACTION_TYPES.PERSON);
      sanitized =
        sanitized.slice(0, nameHit.index) +
        placeholder +
        sanitized.slice(nameHit.index + nameHit.length);
    }

    return sanitized;
  }

  /**
   * Sanitizes a structured perception state / DOM interactive list for external LLM ingestion.
   * Replaces raw text and sensitive values with session placeholders.
   * @param {Array<Object>} interactiveElements Array of perceived elements
   * @param {Object} [privacyDecisionManifest] Decisions from LocalPrivacyEngine
   * @returns {Array<Object>} Sanitized elements safe for transmission
   */
  sanitizePerceptionElements(interactiveElements = [], privacyDecisionManifest = null) {
    const decisions = privacyDecisionManifest ? privacyDecisionManifest.decisions : {};

    return interactiveElements.map((el) => {
      const decision = decisions[el.id] || { decision: "ALLOW", reason: "Default allow" };

      // Blocked elements are completely excluded or stripped
      if (decision.decision === "BLOCK") {
        return {
          id: el.id,
          role: el.role,
          blocked: true,
          reason: decision.reason
        };
      }

      const copy = { ...el };

      if (decision.decision === "LOCAL_ONLY") {
        copy.is_local_only = true;
        copy.text = this.getOrCreatePlaceholder(copy.text || "LOCAL_SECRET", REDACTION_TYPES.PASSWORD);
        if (copy.value) {
          copy.value = this.getOrCreatePlaceholder(copy.value, REDACTION_TYPES.PASSWORD);
        }
      } else if (decision.decision === "REDACT") {
        let cat = el.category || el.role || "GENERIC_PII";
        let rType = REDACTION_TYPES.GENERIC_PII;
        if (cat.includes("password")) rType = REDACTION_TYPES.PASSWORD;
        else if (cat.includes("credit") || cat.includes("financial")) rType = REDACTION_TYPES.CARD;
        else if (cat.includes("gov") || cat.includes("id")) rType = REDACTION_TYPES.GOV_ID;
        else if (cat.includes("contact") || cat.includes("email")) rType = REDACTION_TYPES.EMAIL;
        else if (cat.includes("phone")) rType = REDACTION_TYPES.PHONE;
        else if (cat.includes("name") || cat.includes("person")) rType = REDACTION_TYPES.PERSON;

        if (copy.text) copy.text = this.getOrCreatePlaceholder(copy.text, rType);
        if (copy.value) copy.value = this.getOrCreatePlaceholder(copy.value, rType);
      } else if (copy.text) {
        copy.text = this.sanitizeText(copy.text);
      }

      return copy;
    });
  }

  /**
   * Visually obliterates sensitive regions on an HTML Canvas (2D context).
   * @param {HTMLCanvasElement} canvas The canvas containing the captured viewport
   * @param {Array<Object>} redactionRegions Bounding box list [{x, y, w, h, category, label, style}]
   * @param {Object} [options] Mask styling options
   */
  applyVisualMasks(canvas, redactionRegions = [], options = {}) {
    if (!canvas || !redactionRegions || redactionRegions.length === 0) return canvas;

    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;

    const defaultStyle = options.style || VISUAL_MASK_STYLES.SOLID_BLACK;
    const padding = options.padding || 4;

    redactionRegions.forEach((region) => {
      const rx = Math.max(0, (region.x || 0) - padding);
      const ry = Math.max(0, (region.y || 0) - padding);
      const rw = Math.min(canvas.width - rx, (region.w || region.width || 0) + padding * 2);
      const rh = Math.min(canvas.height - ry, (region.h || region.height || 0) + padding * 2);

      if (rw <= 0 || rh <= 0) return;

      const style = region.maskStyle || defaultStyle;

      if (style === VISUAL_MASK_STYLES.SOLID_BLACK) {
        ctx.save();
        ctx.fillStyle = "#000000";
        ctx.fillRect(rx, ry, rw, rh);

        // Render subtle privacy watermark badge on top of black box
        if (rw >= 60 && rh >= 16) {
          ctx.fillStyle = "#10b981";
          ctx.font = "bold 10px monospace";
          ctx.textBaseline = "middle";
          const label = region.label ? `[REDACTED: ${region.label.substring(0, 15)}]` : "[REDACTED]";
          ctx.fillText(label, rx + 4, ry + rh / 2);
        }
        ctx.restore();
      } else if (style === VISUAL_MASK_STYLES.PIXELATE) {
        try {
          const pixelSize = Math.max(8, Math.min(rw, rh) / 6);
          const imgData = ctx.getImageData(rx, ry, rw, rh);
          // Downsample and pixelate in-place
          for (let y = 0; y < rh; y += pixelSize) {
            for (let x = 0; x < rw; x += pixelSize) {
              const pIndex = (Math.floor(y) * rw + Math.floor(x)) * 4;
              const r = imgData.data[pIndex];
              const g = imgData.data[pIndex + 1];
              const b = imgData.data[pIndex + 2];
              for (let dy = 0; dy < pixelSize && y + dy < rh; dy++) {
                for (let dx = 0; dx < pixelSize && x + dx < rw; dx++) {
                  const targetIndex = ((y + dy) * rw + (x + dx)) * 4;
                  imgData.data[targetIndex] = r;
                  imgData.data[targetIndex + 1] = g;
                  imgData.data[targetIndex + 2] = b;
                }
              }
            }
          }
          ctx.putImageData(imgData, rx, ry);
        } catch {
          // Fallback to solid black if getImageData fails (e.g. CORS tainted canvas)
          ctx.fillStyle = "#000000";
          ctx.fillRect(rx, ry, rw, rh);
        }
      } else if (style === VISUAL_MASK_STYLES.BLUR) {
        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.95)";
        ctx.filter = "blur(12px)";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.restore();
      }
    });

    return canvas;
  }
}

// Global Singleton Instance
export const semanticRedactor = new SemanticRedactor();
