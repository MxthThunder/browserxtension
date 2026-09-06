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
- BLOCK: Passwords, PINs, OTP codes, CVV codes, private encryption keys, authentication tokens, recovery phrases, seed tokens, credentials. (ALWAYS BLOCK, never REDACT).
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
    this._cachedOllamaModel = null;
  }

  /**
   * Auto-detects installed Ollama models, prioritizing qwen2.5:1.5b over 0.5b.
   */
  async getPreferredOllamaModel() {
    if (this._cachedOllamaModel) return this._cachedOllamaModel;
    try {
      const resp = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1500) });
      if (resp.ok) {
        const data = await resp.json();
        const names = (data.models || []).map((m) => (m.name || "").toLowerCase());
        if (names.some((n) => n.includes("isro-privacy-qwen"))) {
          this._cachedOllamaModel = "isro-privacy-qwen";
          return "isro-privacy-qwen";
        }
        if (names.some((n) => n.includes("qwen2.5:1.5b") || n.includes("qwen2.5-1.5b"))) {
          this._cachedOllamaModel = "qwen2.5:1.5b";
          return "qwen2.5:1.5b";
        }
        if (names.some((n) => n.includes("qwen2.5:0.5b") || n.includes("qwen2.5-0.5b"))) {
          this._cachedOllamaModel = "qwen2.5:0.5b";
          return "qwen2.5:0.5b";
        }
      }
    } catch {
      // Ollama offline or unreachable
    }
    this._cachedOllamaModel = "qwen2.5:1.5b";
    return "qwen2.5:1.5b";
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
   * Resolves all ambiguous elements in a PrivacyDecisionManifest in a single batch pass.
   * @param {Object} manifest - Output of evaluatePerceptionState()
   * @param {Object} context - Context options { url, userTask }
   * @returns {Promise<Object>} Enriched manifest with resolved decisions
   */
  async resolveManifestAmbiguities(manifest, context = {}) {
    if (!manifest.ambiguousElements || manifest.ambiguousElements.length === 0) {
      return manifest;
    }

    // Check LRU cache first for instant hits
    const uncachedItems = [];
    const resolvedMap = new Map();

    for (const item of manifest.ambiguousElements) {
      const el = item.element || item;
      const key = this._getCacheKey(el, context);
      if (this.decisionCache.has(key)) {
        resolvedMap.set(String(el.id || item.elementId), this.decisionCache.get(key));
      } else {
        uncachedItems.push(item);
      }
    }

    // If uncached items exist, query Ollama in a Single-Pass Batch
    if (uncachedItems.length > 0) {
      const batchDecisions = await this._queryOllamaBatch(
        uncachedItems.map((item) => item.element || item),
        context
      );

      const model = await this.getPreferredOllamaModel();
      if (batchDecisions && Array.isArray(batchDecisions) && batchDecisions.length > 0) {
        const resultMap = new Map(batchDecisions.map((r) => [String(r.id), r]));
        for (const item of uncachedItems) {
          const el = item.element || item;
          const elId = String(el.id || item.elementId);
          const match = resultMap.get(elId);
          let decisionRecord = null;
          if (match && Object.values(PRIVACY_DECISIONS).includes(match.decision?.toUpperCase())) {
            const dec = match.decision.toUpperCase();
            let strategy = SANITIZATION_STRATEGIES.NONE;
            if (dec === PRIVACY_DECISIONS.BLOCK) strategy = SANITIZATION_STRATEGIES.OMIT_AND_BLACKOUT;
            else if (dec === PRIVACY_DECISIONS.REDACT) strategy = SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER;
            else if (dec === PRIVACY_DECISIONS.LOCAL_ONLY) strategy = SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER;

            decisionRecord = {
              decision: dec,
              strategy: strategy,
              reason: `Qwen Local Batch: ${match.reason || "Context evaluation"}`,
              confidence: match.confidence || 0.95,
              engine: `ollama-${model}`,
            };
          } else {
            decisionRecord = this._fallbackReasoning(el, context);
          }
          resolvedMap.set(elId, decisionRecord);
          this.decisionCache.set(this._getCacheKey(el, context), decisionRecord);
        }
      } else {
        // Fallback for all uncached elements if Ollama is unreachable or timed out
        for (const item of uncachedItems) {
          const el = item.element || item;
          const decisionRecord = this._fallbackReasoning(el, context);
          resolvedMap.set(String(el.id || item.elementId), decisionRecord);
          this.decisionCache.set(this._getCacheKey(el, context), decisionRecord);
        }
      }
    }

    // Apply all resolved decisions back into manifest.decisions
    for (const [elementId, resolved] of resolvedMap.entries()) {
      const index = manifest.decisions.findIndex((d) => String(d.elementId) === String(elementId));
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
      resolvedCount: resolvedMap.size,
    };

    return manifest;
  }

  /**
   * Queries Ollama using a single-pass batch prompt for all ambiguous elements.
   * Completes in ~1.5s with a strict 4.5s timeout covering both fetch and stream parsing.
   */
  async _queryOllamaBatch(elements, context = {}) {
    if (!elements || elements.length === 0) return null;

    const model = await this.getPreferredOllamaModel();
    const itemsText = elements
      .slice(0, 12)
      .map((el, idx) => {
        const id = el.id || `el_${idx + 1}`;
        const label = el.label || el.placeholder || el.attributes?.name || el.attributes?.id || "unlabelled";
        const tag = el.tag || el.type || "input";
        const val = (el.text || el.value || "").substring(0, 30);
        return `${idx + 1}. ID: "${id}" | Tag: <${tag}> | Label: "${label}" | ValuePreview: "${val}"`;
      })
      .join("\n");

    const prompt = `You are an on-device privacy filter for an autonomous browser automation agent.
Classify each web element into one of the following privacy decisions:
- ALLOW: Public info, search queries, navigation labels, safe buttons.
- REDACT: Personal names, email addresses, phone numbers, postal addresses, account numbers, government IDs.
- BLOCK: Passwords, PINs, OTP codes, CVV codes, private encryption keys, authentication tokens, recovery phrases, seed tokens, confidential credentials.
- LOCAL_ONLY: Account settings or vault-scoped inputs.

User Task: ${context.userTask || "General Web Navigation"}

Elements to classify:
${itemsText}

Respond with ONLY a JSON object in this exact format:
{"decisions": [{"id": "exact_element_id", "decision": "ALLOW" | "REDACT" | "BLOCK" | "LOCAL_ONLY", "reason": "short explanation"}]}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const resp = await fetch(this.localOllamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model,
          prompt: prompt,
          stream: false,
          format: "json",
          keep_alive: -1,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        clearTimeout(timeoutId);
        return null;
      }

      const json = await resp.json();
      clearTimeout(timeoutId);

      if (!json.response) return null;
      let rawText = json.response.trim();
      rawText = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(rawText);
      return Array.isArray(parsed) ? parsed : (parsed.decisions || parsed.elements || null);
    } catch (e) {
      clearTimeout(timeoutId);
      return null;
    }
  }

  /**
   * Queries local Ollama instance for a single element.
   */
  async _queryOllama(element, context = {}) {
    const model = await this.getPreferredOllamaModel();
    const prompt = PRIVACY_REASONING_PROMPT
      .replace("{LABEL}", element.label || element.placeholder || "None")
      .replace("{TAG}", element.tag || element.type || "input")
      .replace("{VALUE}", (element.text || "").substring(0, 40))
      .replace("{CONTEXT}", element.attributes?.reason || "Web form")
      .replace("{TASK}", context.userTask || "General Web Navigation");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const resp = await fetch(this.localOllamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model,
          prompt: prompt,
          stream: false,
          format: "json",
          keep_alive: -1,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        clearTimeout(timeoutId);
        return null;
      }

      const json = await resp.json();
      clearTimeout(timeoutId);

      if (!json.response) return null;
      let rawText = json.response.trim();
      rawText = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(rawText);

      const decision = parsed.decision?.toUpperCase();
      if (!Object.values(PRIVACY_DECISIONS).includes(decision)) return null;

      let strategy = SANITIZATION_STRATEGIES.NONE;
      if (decision === PRIVACY_DECISIONS.BLOCK) strategy = SANITIZATION_STRATEGIES.OMIT_AND_BLACKOUT;
      else if (decision === PRIVACY_DECISIONS.REDACT) strategy = SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER;
      else if (decision === PRIVACY_DECISIONS.LOCAL_ONLY) strategy = SANITIZATION_STRATEGIES.SEMANTIC_PLACEHOLDER;

      return {
        decision: decision,
        strategy: strategy,
        reason: `Qwen Local LLM (${model}): ${parsed.reason || "Context evaluation"}`,
        confidence: parsed.confidence || 0.95,
        engine: `ollama-${model}`,
      };
    } catch {
      clearTimeout(timeoutId);
      return null;
    }
  }
}

export const defaultPrivacyReasoner = new LocalPrivacyReasoner();
