/**
 * Local Reasoning Engine (Step 3 - ISRO Privacy Browser Agent)
 * 
 * Lightweight on-device reasoning engine (Qwen / compact LLM interface) designed
 * specifically for resolving ambiguous privacy classifications that deterministic
 * heuristic rules cannot definitively classify.
 * 
 * Key Principles:
 *   1. Selective Invocation: Invoked ONLY for ambiguous / borderline elements (~5% of elements)
 *      to maintain high throughput and sub-second latency.
 *   2. Strict On-Device Execution: Queries stay local to the browser.
 *   3. Structured JSON Schema: Produces validated decision { decision, reason, confidence }.
 *   4. Decision Caching: LRU cache prevents redundant inferences on recurring UI elements.
 */

import { PRIVACY_DECISIONS, SANITIZATION_STRATEGIES } from "./privacy_engine.js";

/**
 * Prompt Template for Local Privacy Classification
 */
const PRIVACY_REASONING_PROMPT = `You are an on-device privacy filter for a browser automation agent.
Classify whether the given web element or text content contains sensitive personal data (PII), credentials, or confidential information.

Decision Options:
- ALLOW: Non-sensitive public information, search queries, navigation labels, safe buttons.
- REDACT: Personal names, email addresses, phone numbers, postal addresses, account numbers, government IDs.
- BLOCK: Passwords, PINs, OTP codes, CVV codes, private encryption keys, authentication tokens.
- LOCAL_ONLY: Fields that require user vault data injected directly on-device without cloud transmission.

Element Context:
- Label/Placeholder: {LABEL}
- Input Type / Tag: {TAG}
- Value Preview: {VALUE}
- Surrounding Text: {CONTEXT}
- Current User Task: {TASK}

Respond with ONLY a JSON object in this format:
{"decision": "ALLOW" | "REDACT" | "BLOCK" | "LOCAL_ONLY", "reason": "brief explanation", "confidence": 0.0-1.0}`;

export class LocalPrivacyReasoner {
  constructor(config = {}) {
    this.modelName = config.modelName || "Xenova/Qwen2.5-0.5B-Instruct";
    this.decisionCache = new Map(); // Key: hash(label + tag + value), Value: decision
    this.maxCacheSize = config.maxCacheSize || 250;
    this.isModelLoaded = false;
    this.isLoading = false;
    this.pipeline = null;
    this.loadPromise = null;
    this.localOllamaUrl = config.localOllamaUrl || "http://127.0.0.1:11434/api/generate";
  }

  /**
   * Generates a deterministic cache key for an element's context.
   */
  _getCacheKey(element = {}, context = {}) {
    const el = element.element || element;
    const label = el.label || el.placeholder || "";
    const tag = el.tag || el.type || "";
    const text = (el.text || "").substring(0, 50);
    const task = (context.userTask || "").substring(0, 50);
    return `${tag}::${label}::${text}::${task}`.toLowerCase();
  }

  /**
   * Fast rule-based semantic reasoner fallback for instant responses.
   * Emulates local LLM decision boundaries when offline or pre-warming.
   */
  _fallbackReasoning(element = {}, context = {}) {
    const el = element.element || element;
    const text = [
      el.label,
      el.placeholder,
      el.text,
      el.attributes?.reason,
      el.attributes?.name,
      el.attributes?.id,
    ].filter(Boolean).join(" ").toLowerCase();

    // High Risk Keywords -> BLOCK
    if (/secret|token|private.?key|recovery.?phrase|seed|auth.?code|passcode/i.test(text)) {
      return {
        decision: PRIVACY_DECISIONS.BLOCK,
        strategy: SANITIZATION_STRATEGIES.OMIT_AND_BLACKOUT,
        reason: "Local Reasoner: Identified high-risk confidential security token/credential.",
        confidence: 0.95,
        engine: "local-reasoner-fastpath",
      };
    }

    // Personal / Medical / Financial Details -> REDACT
    if (/medical|diagnosis|prescription|salary|income|tax|beneficiary|nominee|relationship|spouse|emergency.?contact/i.test(text)) {
      return {
        decision: PRIVACY_DECISIONS.REDACT,
        strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
        reason: "Local Reasoner: Identified sensitive personal/financial context.",
        confidence: 0.88,
        engine: "local-reasoner-fastpath",
      };
    }

    // Account identifiers -> LOCAL_ONLY
    if (/account|profile|settings|billing|subscription/i.test(text) && el.type === "input") {
      return {
        decision: PRIVACY_DECISIONS.LOCAL_ONLY,
        strategy: SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER,
        reason: "Local Reasoner: Account-scoped input appropriate for local vault handling.",
        confidence: 0.82,
        engine: "local-reasoner-fastpath",
      };
    }

    // Generic safe text -> ALLOW
    return {
      decision: PRIVACY_DECISIONS.ALLOW,
      strategy: SANITIZATION_STRATEGIES.NONE,
      reason: "Local Reasoner: Context determined non-sensitive.",
      confidence: 0.80,
      engine: "local-reasoner-fastpath",
    };
  }

  /**
   * Evaluates an ambiguous element using local reasoning.
   * Checks LRU cache -> Local LLM / Ollama -> Fastpath fallback.
   * 
   * @param {Object} element - Ambiguous element
   * @param {Object} context - { userTask, domain, url }
   * @returns {Promise<Object>} Refined PrivacyDecision
   */
  async resolveAmbiguity(element = {}, context = {}) {
    const el = element.element || element;
    const cacheKey = this._getCacheKey(el, context);

    // 1. Check LRU Cache
    if (this.decisionCache.has(cacheKey)) {
      const cached = this.decisionCache.get(cacheKey);
      return {
        ...cached,
        elementId: el.id,
        role: el.role,
        cached: true,
      };
    }

    let decision = null;

    // 2. Optional: Query Local Ollama if available on user machine
    try {
      decision = await this._queryOllama(el, context);
    } catch {
      decision = null;
    }

    // 3. Fallback to optimized fastpath reasoning
    if (!decision) {
      decision = this._fallbackReasoning(el, context);
    }

    // 4. Store in LRU Cache
    if (this.decisionCache.size >= this.maxCacheSize) {
      const firstKey = this.decisionCache.keys().next().value;
      this.decisionCache.delete(firstKey);
    }
    this.decisionCache.set(cacheKey, decision);

    return {
      elementId: el.id,
      role: el.role,
      category: el.piiCategory || "custom",
      ...decision,
      isAmbiguous: false,
    };
  }

  /**
   * Resolves all ambiguous elements in a PrivacyDecisionManifest.
   * @param {Object} manifest - Output of evaluatePerceptionState()
   * @param {Object} context - Context options
   * @returns {Promise<Object>} Enriched manifest with resolved decisions
   */
  async resolveManifestAmbiguities(manifest, context = {}) {
    if (!manifest.ambiguousElements || manifest.ambiguousElements.length === 0) {
      return manifest;
    }

    const resolvedDecisions = await Promise.all(
      manifest.ambiguousElements.map((ambiguousItem) =>
        this.resolveAmbiguity(ambiguousItem.element, context)
      )
    );

    // Update decisions list and statistics
    for (const resolved of resolvedDecisions) {
      const index = manifest.decisions.findIndex((d) => d.elementId === resolved.elementId);
      if (index !== -1) {
        manifest.decisions[index] = {
          ...manifest.decisions[index],
          decision: resolved.decision,
          strategy: resolved.strategy,
          reason: resolved.reason,
          confidence: resolved.confidence,
          isAmbiguous: false,
          resolvedBy: resolved.engine || "local-reasoner",
        };
      }
    }

    // Recalculate summary stats
    const stats = {
      [PRIVACY_DECISIONS.ALLOW]: 0,
      [PRIVACY_DECISIONS.REDACT]: 0,
      [PRIVACY_DECISIONS.BLOCK]: 0,
      [PRIVACY_DECISIONS.LOCAL_ONLY]: 0,
    };

    for (const d of manifest.decisions) {
      stats[d.decision] = (stats[d.decision] || 0) + 1;
    }

    manifest.stats = stats;
    manifest.ambiguousElements = [];
    manifest.summary = {
      ...manifest.summary,
      allowedCount: stats[PRIVACY_DECISIONS.ALLOW],
      redactedCount: stats[PRIVACY_DECISIONS.REDACT],
      blockedCount: stats[PRIVACY_DECISIONS.BLOCK],
      localOnlyCount: stats[PRIVACY_DECISIONS.LOCAL_ONLY],
      ambiguousCount: 0,
      resolvedCount: resolvedDecisions.length,
    };

    return manifest;
  }

  /**
   * Queries local Ollama instance if available.
   */
  async _queryOllama(element, context = {}) {
    const prompt = PRIVACY_REASONING_PROMPT
      .replace("{LABEL}", element.label || element.placeholder || "None")
      .replace("{TAG}", element.tag || element.type || "input")
      .replace("{VALUE}", (element.text || "").substring(0, 40))
      .replace("{CONTEXT}", element.attributes?.reason || "Web form")
      .replace("{TASK}", context.userTask || "General Web Navigation");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200); // Strict 1.2s timeout

    const resp = await fetch(this.localOllamaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5:0.5b",
        prompt: prompt,
        stream: false,
        format: "json",
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) return null;
    const json = await resp.json();
    const parsed = JSON.parse(json.response);

    const decision = parsed.decision?.toUpperCase();
    if (!Object.values(PRIVACY_DECISIONS).includes(decision)) return null;

    let strategy = SANITIZATION_STRATEGIES.NONE;
    if (decision === PRIVACY_DECISIONS.BLOCK) strategy = SANITIZATION_STRATEGIES.OMIT_AND_BLACKOUT;
    else if (decision === PRIVACY_DECISIONS.REDACT) strategy = SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER;
    else if (decision === PRIVACY_DECISIONS.LOCAL_ONLY) strategy = SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER;

    return {
      decision: decision,
      strategy: strategy,
      reason: `Qwen Local LLM: ${parsed.reason || "Context evaluation"}`,
      confidence: parsed.confidence || 0.90,
      engine: "ollama-qwen2.5",
    };
  }
}

export const defaultPrivacyReasoner = new LocalPrivacyReasoner();
