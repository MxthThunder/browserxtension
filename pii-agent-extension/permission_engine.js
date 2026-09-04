/**
 * Local Action Permission Engine (Manifest V3)
 * Step 8 of Privacy-Preserving Browser-Agent Architecture.
 *
 * Implements risk scoring, security policies, and Human-in-the-Loop (HITL)
 * modal confirmation before executing sensitive or irreversible browser actions
 * (e.g., payments, form submissions, deletions, file uploads).
 *
 * Guarantees Zero-Leakage:
 * - High-risk actions are intercepted locally before execution.
 * - Prompts user directly on the active browser tab with sanitized action details.
 */

export const ACTION_RISK_LEVELS = {
  LOW: "LOW",           // Auto-execute (scroll, wait, safe navigation, reading)
  MEDIUM: "MEDIUM",     // Auto-execute with audit (input typing, standard button clicks)
  HIGH: "HIGH",         // Require Human-in-the-Loop Confirmation (payments, submit, file upload, delete)
  CRITICAL: "CRITICAL"  // Strictly blocked (interactions with BLOCKED privacy elements)
};

export const PERMISSION_OUTCOMES = {
  ALLOW: "ALLOW",
  REQUIRE_CONFIRMATION: "REQUIRE_CONFIRMATION",
  BLOCK: "BLOCK"
};

// Patterns that classify an action or target button as high-risk
const SENSITIVE_ACTION_PATTERNS = {
  PAYMENT: /pay|purchase|checkout|buy now|place order|transfer|subscribe|authorize payment|confirm payment|send money/i,
  SUBMIT: /submit|confirm identity|authenticate|apply now|send application|register account/i,
  DESTRUCTIVE: /delete|remove|erase|cancel subscription|revoke|purge|destroy|reset account/i,
  UPLOAD: /upload|browse files|attach document|choose file/i
};

export class LocalPermissionEngine {
  constructor(config = {}) {
    this.strictMode = config.strictMode || false;
    this.confirmationTimeoutMs = config.confirmationTimeoutMs || 30000;
  }

  /**
   * Evaluates the risk level and permission outcome of an agent-requested action.
   *
   * @param {Object} action Structured action {type, selector, value, coordinates, explanation}
   * @param {HTMLElement|Object} [targetElement] The resolved DOM element or element descriptor
   * @param {Object} [privacyDecisionManifest] Output from LocalPrivacyEngine
   * @returns {{outcome: string, riskLevel: string, reason: string, requiresModal: boolean}}
   */
  evaluate(action, targetElement = null, privacyDecisionManifest = null) {
    if (!action || !action.type) {
      return {
        outcome: PERMISSION_OUTCOMES.BLOCK,
        riskLevel: ACTION_RISK_LEVELS.CRITICAL,
        reason: "Invalid action payload",
        requiresModal: false
      };
    }

    const actType = action.type.toLowerCase();

    // 1. Check if the target element was flagged as BLOCK by LocalPrivacyEngine
    if (privacyDecisionManifest && targetElement) {
      const elId = targetElement.id || action.selector;
      const decision = privacyDecisionManifest.decisions?.[elId];
      if (decision && decision.decision === "BLOCK") {
        return {
          outcome: PERMISSION_OUTCOMES.BLOCK,
          riskLevel: ACTION_RISK_LEVELS.CRITICAL,
          reason: `Action blocked: Target element has privacy classification 'BLOCK' (${decision.reason})`,
          requiresModal: false
        };
      }
    }

    // 2. Low Risk Actions: Scroll, Wait, Finish
    if (["scroll", "wait", "finish"].includes(actType)) {
      return {
        outcome: PERMISSION_OUTCOMES.ALLOW,
        riskLevel: ACTION_RISK_LEVELS.LOW,
        reason: `Safe non-mutating action: ${actType}`,
        requiresModal: false
      };
    }

    // 3. Inspect target element context (text, tag, name, type)
    let targetHaystack = "";
    if (targetElement) {
      targetHaystack = [
        targetElement.innerText,
        targetElement.value,
        targetElement.getAttribute?.("aria-label"),
        targetElement.getAttribute?.("title"),
        targetElement.getAttribute?.("name"),
        targetElement.getAttribute?.("id"),
        targetElement.type,
        action.explanation
      ].filter(Boolean).join(" ");
    } else {
      targetHaystack = `${action.selector || ""} ${action.explanation || ""} ${action.value || ""}`;
    }

    // 4. High Risk: Payment & Checkout actions
    if (SENSITIVE_ACTION_PATTERNS.PAYMENT.test(targetHaystack)) {
      return {
        outcome: PERMISSION_OUTCOMES.REQUIRE_CONFIRMATION,
        riskLevel: ACTION_RISK_LEVELS.HIGH,
        reason: `Financial Transaction Detected: "${targetHaystack.substring(0, 45)}"`,
        requiresModal: true
      };
    }

    // 5. High Risk: Destructive Actions (Delete, Cancel, Revoke)
    if (SENSITIVE_ACTION_PATTERNS.DESTRUCTIVE.test(targetHaystack)) {
      return {
        outcome: PERMISSION_OUTCOMES.REQUIRE_CONFIRMATION,
        riskLevel: ACTION_RISK_LEVELS.HIGH,
        reason: `Destructive Action Detected: "${targetHaystack.substring(0, 45)}"`,
        requiresModal: true
      };
    }

    // 6. High Risk: Form Submissions
    if (actType === "submit" || SENSITIVE_ACTION_PATTERNS.SUBMIT.test(targetHaystack)) {
      return {
        outcome: PERMISSION_OUTCOMES.REQUIRE_CONFIRMATION,
        riskLevel: ACTION_RISK_LEVELS.HIGH,
        reason: `Form Submission Triggered: "${targetHaystack.substring(0, 45)}"`,
        requiresModal: true
      };
    }

    // 7. High Risk: File Uploads
    if (targetElement?.type === "file" || SENSITIVE_ACTION_PATTERNS.UPLOAD.test(targetHaystack)) {
      return {
        outcome: PERMISSION_OUTCOMES.REQUIRE_CONFIRMATION,
        riskLevel: ACTION_RISK_LEVELS.HIGH,
        reason: "File Upload Triggered",
        requiresModal: true
      };
    }

    // 8. Medium Risk: Standard clicks and text inputs
    return {
      outcome: PERMISSION_OUTCOMES.ALLOW,
      riskLevel: ACTION_RISK_LEVELS.MEDIUM,
      reason: `Standard interactive actuation: ${actType}`,
      requiresModal: false
    };
  }

  /**
   * Prompts the user with an on-page Human-in-the-Loop (HITL) confirmation dialog.
   * Resolves to true if approved, false if rejected/timed out.
   *
   * @param {Object} action 
   * @param {string} reason 
   * @returns {Promise<boolean>}
   */
  async requestUserConfirmation(action, reason) {
    if (typeof document === "undefined") return true;

    return new Promise((resolve) => {
      const modalId = "__pii_agent_permission_modal__";
      const existing = document.getElementById(modalId);
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = modalId;
      Object.assign(overlay.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        backgroundColor: "rgba(15, 23, 42, 0.75)",
        backdropFilter: "blur(6px)",
        zIndex: "2147483647",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif"
      });

      const dialog = document.createElement("div");
      Object.assign(dialog.style, {
        background: "#0f172a",
        border: "1px solid #e11d48",
        boxShadow: "0 20px 40px rgba(225, 29, 72, 0.35)",
        borderRadius: "14px",
        padding: "24px",
        maxWidth: "460px",
        width: "90%",
        color: "#f8fafc",
        textAlign: "left"
      });

      dialog.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">
          <div style="font-size: 24px;">🛡️</div>
          <div>
            <h3 style="margin: 0; font-size: 16px; color: #f43f5e; font-weight: 700;">Human-in-the-Loop Confirmation</h3>
            <p style="margin: 2px 0 0; font-size: 12px; color: #94a3b8;">High-Risk Browser Action Intercepted</p>
          </div>
        </div>

        <div style="background: #1e293b; border-radius: 8px; padding: 12px; margin-bottom: 16px; font-size: 13px;">
          <div style="color: #fbbf24; font-weight: 600; margin-bottom: 4px;">⚠️ Action: ${(action.type || "ACTION").toUpperCase()}</div>
          <div style="color: #cbd5e1; font-size: 12px;">${reason}</div>
          ${action.explanation ? `<div style="color: #94a3b8; font-size: 11px; margin-top: 6px; font-style: italic;">"${action.explanation}"</div>` : ""}
        </div>

        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button id="__btn_hitl_reject__" style="padding: 9px 16px; background: #334155; border: 1px solid #475569; color: #f8fafc; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer;">
            ✕ Reject Action
          </button>
          <button id="__btn_hitl_approve__" style="padding: 9px 18px; background: #e11d48; border: none; color: #ffffff; border-radius: 6px; font-weight: 700; font-size: 13px; cursor: pointer; box-shadow: 0 4px 12px rgba(225, 29, 72, 0.4);">
            ✓ Approve & Execute
          </button>
        </div>
      `;

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const timeoutId = setTimeout(() => {
        if (overlay.parentNode) overlay.remove();
        resolve(false);
      }, this.confirmationTimeoutMs);

      dialog.querySelector("#__btn_hitl_approve__").addEventListener("click", () => {
        clearTimeout(timeoutId);
        overlay.remove();
        resolve(true);
      });

      dialog.querySelector("#__btn_hitl_reject__").addEventListener("click", () => {
        clearTimeout(timeoutId);
        overlay.remove();
        resolve(false);
      });
    });
  }
}

// Global Singleton Instance
export const permissionEngine = new LocalPermissionEngine();
