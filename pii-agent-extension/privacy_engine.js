/**
 * Local Privacy Engine (Step 2 - ISRO Privacy Browser Agent)
 * 
 * Determines privacy decisions for every perceived element on the page:
 *   - ALLOW: Safe to transmit to the cloud/server Agent LLM.
 *   - REDACT: Sensitive data that must be visually obliterated and replaced with semantic placeholders.
 *   - BLOCK: High-risk secrets (passwords, CVV, OTP, private keys) that must never leave the device.
 *   - LOCAL-ONLY: Elements/actions reserved exclusively for on-device processing via the Local Vault.
 * 
 * Implements deterministic rule tables, category policies, domain-level constraints,
 * and sanitization strategy mapping.
 */

import { SEMANTIC_ROLES } from "./perception.js";

/**
 * Fundamental Privacy Decisions
 */
export const PRIVACY_DECISIONS = {
  ALLOW: "ALLOW",           // Safe to send to cloud agent
  REDACT: "REDACT",         // Hide raw value, replace with placeholder
  BLOCK: "BLOCK",           // Strictly confidential, never send
  LOCAL_ONLY: "LOCAL_ONLY", // Process/use exclusively on-device
};

/**
 * Sanitization Strategies
 */
export const SANITIZATION_STRATEGIES = {
  NONE: "NONE",                               // Transmit as-is
  CANVAS_BLACKOUT: "CANVAS_BLACKOUT",         // Solid visual blackout
  SEMANTIC_PLACEHOLDER: "SEMANTIC_PLACEHOLDER", // Replace text with placeholder token
  OMIT_AND_BLACKOUT: "OMIT_AND_BLACKOUT",     // Omit from digest + black out visual canvas
  LOCAL_INJECT: "LOCAL_INJECT",               // Inject value locally from local data vault
};

/**
 * Deterministic Privacy Rule Set
 */
const DEFAULT_ROLE_RULES = {
  // Passwords & Auth
  [SEMANTIC_ROLES.PASSWORD_FIELD]: {
    decision: PRIVACY_DECISIONS.BLOCK,
    strategy: SANITIZATION_STRATEGIES.OMIT_AND_BLACKOUT,
    reason: "Credential confidentiality: Passwords must never leave the local boundary.",
    vaultKey: "password",
  },
  [SEMANTIC_ROLES.USERNAME_FIELD]: {
    decision: PRIVACY_DECISIONS.LOCAL_ONLY,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "Account identifier: Processed locally or masked as username placeholder.",
    vaultKey: "username",
  },

  // Payment & Financial
  [SEMANTIC_ROLES.CVV_FIELD]: {
    decision: PRIVACY_DECISIONS.BLOCK,
    strategy: SANITIZATION_STRATEGIES.OMIT_AND_BLACKOUT,
    reason: "Payment security: Card security codes (CVV/CVC) must never be transmitted.",
    vaultKey: "cvv",
  },
  [SEMANTIC_ROLES.CREDIT_CARD_FIELD]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "Financial PII: Credit card numbers masked with semantic placeholder.",
    vaultKey: "creditCard",
  },
  [SEMANTIC_ROLES.EXPIRY_FIELD]: {
    decision: PRIVACY_DECISIONS.LOCAL_ONLY,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "Financial metadata: Handled locally via payment vault.",
    vaultKey: "cardExpiry",
  },

  // Identity & Government IDs
  [SEMANTIC_ROLES.GOV_ID_FIELD]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "National Identity: SSN, Aadhaar, PAN or Passport masked with placeholder.",
    vaultKey: "govId",
  },
  [SEMANTIC_ROLES.PHYSICAL_CREDENTIAL]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.CANVAS_BLACKOUT,
    reason: "Physical credential in viewport: Visual canvas blackout applied.",
    vaultKey: null,
  },
  [SEMANTIC_ROLES.CONFIDENTIAL_DOC]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.CANVAS_BLACKOUT,
    reason: "Confidential document/screen: Visual canvas blackout applied.",
    vaultKey: null,
  },

  // Biometrics
  [SEMANTIC_ROLES.BIOMETRIC_FACE]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.CANVAS_BLACKOUT,
    reason: "Biometric privacy: Facial region permanently redacted from visual stream.",
    vaultKey: null,
  },

  // Contact Info
  [SEMANTIC_ROLES.EMAIL_FIELD]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "Personal contact: Email masked with semantic placeholder.",
    vaultKey: "email",
  },
  [SEMANTIC_ROLES.PHONE_FIELD]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "Personal contact: Phone number masked with semantic placeholder.",
    vaultKey: "phone",
  },
  [SEMANTIC_ROLES.NAME_FIELD]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "Personally identifiable name: Masked with semantic person placeholder.",
    vaultKey: "fullName",
  },
  [SEMANTIC_ROLES.ADDRESS_FIELD]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "Physical address: Masked with semantic location placeholder.",
    vaultKey: "address",
  },
  [SEMANTIC_ROLES.FILE_UPLOAD]: {
    decision: PRIVACY_DECISIONS.LOCAL_ONLY,
    strategy: SANITIZATION_STRATEGIES.CANVAS_BLACKOUT,
    reason: "Document upload: File selection must be initiated locally with user confirmation.",
    vaultKey: "documents",
  },
  [SEMANTIC_ROLES.SENSITIVE_TEXT]: {
    decision: PRIVACY_DECISIONS.REDACT,
    strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
    reason: "Sensitive inline text pattern detected.",
    vaultKey: null,
  },

  // Safe Interactive Roles
  [SEMANTIC_ROLES.BUTTON]: {
    decision: PRIVACY_DECISIONS.ALLOW,
    strategy: SANITIZATION_STRATEGIES.NONE,
    reason: "Safe interactive button: Actionable element visible to Agent LLM.",
    vaultKey: null,
  },
  [SEMANTIC_ROLES.LINK]: {
    decision: PRIVACY_DECISIONS.ALLOW,
    strategy: SANITIZATION_STRATEGIES.NONE,
    reason: "Safe navigation link: Accessible to Agent LLM.",
    vaultKey: null,
  },
  [SEMANTIC_ROLES.SELECT]: {
    decision: PRIVACY_DECISIONS.ALLOW,
    strategy: SANITIZATION_STRATEGIES.NONE,
    reason: "Interactive dropdown selector: Structure safe to transmit.",
    vaultKey: null,
  },
  [SEMANTIC_ROLES.CHECKBOX]: {
    decision: PRIVACY_DECISIONS.ALLOW,
    strategy: SANITIZATION_STRATEGIES.NONE,
    reason: "Safe checkbox control.",
    vaultKey: null,
  },
  [SEMANTIC_ROLES.RADIO]: {
    decision: PRIVACY_DECISIONS.ALLOW,
    strategy: SANITIZATION_STRATEGIES.NONE,
    reason: "Safe radio option control.",
    vaultKey: null,
  },
  [SEMANTIC_ROLES.SEARCH_INPUT]: {
    decision: PRIVACY_DECISIONS.ALLOW,
    strategy: SANITIZATION_STRATEGIES.NONE,
    reason: "Public search input field.",
    vaultKey: null,
  },
  [SEMANTIC_ROLES.TEXT_INPUT]: {
    decision: PRIVACY_DECISIONS.ALLOW,
    strategy: SANITIZATION_STRATEGIES.NONE,
    reason: "General non-sensitive input field.",
    vaultKey: null,
  },
  [SEMANTIC_ROLES.GENERIC_INTERACTIVE]: {
    decision: PRIVACY_DECISIONS.ALLOW,
    strategy: SANITIZATION_STRATEGIES.NONE,
    reason: "Standard interactive element.",
    vaultKey: null,
  },
};

/**
 * Local Privacy Engine Class
 */
export class LocalPrivacyEngine {
  constructor(customConfig = {}) {
    this.roleRules = { ...DEFAULT_ROLE_RULES, ...(customConfig.roleRules || {}) };
    this.categoryPolicies = {
      passwords: PRIVACY_DECISIONS.BLOCK,
      creditCards: PRIVACY_DECISIONS.REDACT,
      govIds: PRIVACY_DECISIONS.REDACT,
      contactInfo: PRIVACY_DECISIONS.REDACT,
      faces: PRIVACY_DECISIONS.REDACT,
      screens: PRIVACY_DECISIONS.REDACT,
      ...(customConfig.categoryPolicies || {}),
    };
    this.whitelistedDomains = new Set(customConfig.whitelistedDomains || []);
  }

  /**
   * Evaluates a single unified element and computes its privacy decision.
   * @param {Object} element - UnifiedElement from UnifiedPerceptionState
   * @param {Object} context - { url, domain, userTask }
   * @returns {Object} PrivacyDecision
   */
  evaluateElement(element, context = {}) {
    // 1. Check if domain is whitelisted for bypass
    if (context.domain && this.whitelistedDomains.has(context.domain)) {
      return {
        elementId: element.id,
        role: element.role,
        decision: PRIVACY_DECISIONS.ALLOW,
        strategy: SANITIZATION_STRATEGIES.NONE,
        reason: `Domain "${context.domain}" is in user whitelist.`,
        category: element.piiCategory || "none",
        vaultKey: null,
        isAmbiguous: false,
      };
    }

    // 2. Deterministic Rule Matching by Semantic Role
    const rule = this.roleRules[element.role];
    if (rule) {
      // Check category override if user disabled protection for this category
      if (element.piiCategory && this.categoryPolicies[element.piiCategory]) {
        const categoryDecision = this.categoryPolicies[element.piiCategory];
        // If category is set to ALLOW explicitly by user, allow it
        if (categoryDecision === PRIVACY_DECISIONS.ALLOW && rule.decision !== PRIVACY_DECISIONS.BLOCK) {
          return {
            elementId: element.id,
            role: element.role,
            decision: PRIVACY_DECISIONS.ALLOW,
            strategy: SANITIZATION_STRATEGIES.NONE,
            reason: `Category "${element.piiCategory}" set to ALLOW by user configuration.`,
            category: element.piiCategory,
            vaultKey: rule.vaultKey,
            isAmbiguous: false,
          };
        }
      }

      // Check if context has ambiguous keywords requiring local reasoning
      const haystack = [
        element.label,
        element.placeholder,
        element.text,
        element.attributes?.name,
        element.attributes?.id,
      ].filter(Boolean).join(" ").toLowerCase();

      const isAmbiguous = rule.decision === PRIVACY_DECISIONS.ALLOW &&
        /medical|diagnosis|prescription|salary|income|recovery|seed|confidential|secret|memo|beneficiary|nominee|notes|token|auth/i.test(haystack);

      return {
        elementId: element.id,
        role: element.role,
        decision: rule.decision,
        strategy: rule.strategy,
        reason: rule.reason,
        category: element.piiCategory || "none",
        vaultKey: rule.vaultKey,
        isAmbiguous: isAmbiguous,
      };
    }

    // 3. Fallback: If marked sensitive by any perception source but role is unrecognized
    if (element.isSensitive) {
      const piiCat = element.piiCategory || "contactInfo";
      const decision = this.categoryPolicies[piiCat] || PRIVACY_DECISIONS.REDACT;
      const strategy = decision === PRIVACY_DECISIONS.BLOCK
        ? SANITIZATION_STRATEGIES.OMIT_AND_BLACKOUT
        : SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER;

      return {
        elementId: element.id,
        role: element.role || SEMANTIC_ROLES.GENERIC_INTERACTIVE,
        decision: decision,
        strategy: strategy,
        reason: `Sensitive flag set by perception sources: [${(element.sources || []).join(", ")}]`,
        category: piiCat,
        vaultKey: null,
        isAmbiguous: true, // Candidate for local reasoning model check
      };
    }

    // 4. Default: Safe interactive element
    const haystack = [
      element.label,
      element.placeholder,
      element.text,
      element.attributes?.name,
      element.attributes?.id,
    ].filter(Boolean).join(" ").toLowerCase();

    const isAmbiguous = /medical|diagnosis|prescription|salary|income|recovery|seed|confidential|secret|memo|beneficiary|nominee|notes|token|auth/i.test(haystack);

    return {
      elementId: element.id,
      role: element.role || SEMANTIC_ROLES.GENERIC_INTERACTIVE,
      decision: PRIVACY_DECISIONS.ALLOW,
      strategy: SANITIZATION_STRATEGIES.NONE,
      reason: "Non-sensitive standard element.",
      category: "none",
      vaultKey: null,
      isAmbiguous: isAmbiguous,
    };
  }

  /**
   * Evaluates the entire UnifiedPerceptionState and generates a complete Privacy Decision Manifest.
   * @param {Object} perceptionState - Output from buildUnifiedPerceptionState()
   * @param {Object} context - Optional context (url, domain, userTask)
   * @returns {Object} PrivacyDecisionManifest
   */
  evaluatePerceptionState(perceptionState, context = {}) {
    let domain = "";
    try {
      if (perceptionState.url || context.url) {
        domain = new URL(perceptionState.url || context.url).hostname.toLowerCase();
      }
    } catch {
      domain = "";
    }

    const evalContext = { ...context, domain };
    const elementDecisions = [];
    const stats = {
      [PRIVACY_DECISIONS.ALLOW]: 0,
      [PRIVACY_DECISIONS.REDACT]: 0,
      [PRIVACY_DECISIONS.BLOCK]: 0,
      [PRIVACY_DECISIONS.LOCAL_ONLY]: 0,
    };
    const ambiguousElements = [];

    for (const element of perceptionState.elements || []) {
      const decision = this.evaluateElement(element, evalContext);
      const decisionRecord = {
        ...decision,
        element: element,
      };
      elementDecisions.push(decisionRecord);

      stats[decision.decision] = (stats[decision.decision] || 0) + 1;
      if (decision.isAmbiguous) {
        ambiguousElements.push(decisionRecord);
      }
    }

    return {
      timestamp: Date.now(),
      url: perceptionState.url || context.url || "",
      domain: domain,
      decisions: elementDecisions,
      ambiguousElements: ambiguousElements,
      stats: stats,
      summary: {
        totalEvaluated: elementDecisions.length,
        allowedCount: stats[PRIVACY_DECISIONS.ALLOW],
        redactedCount: stats[PRIVACY_DECISIONS.REDACT],
        blockedCount: stats[PRIVACY_DECISIONS.BLOCK],
        localOnlyCount: stats[PRIVACY_DECISIONS.LOCAL_ONLY],
        ambiguousCount: ambiguousElements.length,
      },
    };
  }
}

/**
 * Singleton instance for quick usage
 */
export const defaultPrivacyEngine = new LocalPrivacyEngine();
