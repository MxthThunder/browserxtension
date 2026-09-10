/**
 * Agent Client (Manifest V3)
 * Step 6 of Privacy-Preserving Browser-Agent Architecture.
 *
 * Connects the extension client to the centralized VLM Server / Main LLM Agent.
 * Transmits ONLY sanitized visual frames (with PII blacked out) and semantic
 * placeholder digests ([PERSON_1], [CARD_1]) to obtain structured browser actions.
 */

import { getSettings } from "./storage.js";
import { semanticRedactor } from "./semantic_redactor.js";

/**
 * Reduces a URL to what the model actually needs to recognise a tab: origin and
 * path. Query strings and fragments are dropped wholesale rather than scanned,
 * because that is where order ids, session tokens, emails and coordinates live
 * and a redactor can only catch the patterns it already knows.
 *
 * @param {string} raw
 * @returns {string} origin + path, or "" if unparseable
 */
function sanitizeUrlForModel(raw) {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return "";
    const path = semanticRedactor.sanitizeText(u.pathname || "");
    return `${u.origin}${path}`.slice(0, 120);
  } catch {
    return "";
  }
}

export class AgentClient {
  constructor(config = {}) {
    this.serverUrl = config.serverUrl || "http://127.0.0.1:8001/api/act";
    this.healthUrl = config.healthUrl || "http://127.0.0.1:8001/health";
    this.timeoutMs = config.timeoutMs || 60000;
  }

  /**
   * Probes the server health and capabilities.
   */
  async checkHealth() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(this.healthUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        return await res.json();
      }
      return { status: "error", code: res.status };
    } catch (err) {
      return { status: "offline", error: err.message };
    }
  }

  /**
   * Sends a sanitized browser state payload to the VLM reasoning server.
   *
   * @param {Object} params
   * @param {string} params.task User goal or instruction (e.g. "Fill form and submit")
   * @param {string} [params.sanitizedImageBase64] Zero-leakage redacted screenshot (Base64 JPEG/PNG)
   * @param {Array<Object>} [params.interactiveElements] Sanitized interactive DOM elements
   * @param {Array<Object>} [params.redactionManifest] List of masked bounding boxes / labels
   * @param {Object} [params.viewport] Viewport metadata {width, height, devicePixelRatio}
   * @param {string} [params.url] Active page URL
   * @param {string} [params.modelProvider] "auto" | "ollama_qwen" | "gemini" | "openai"
   * @param {Array<Object>} [params.openTabs] Open tabs [{index, title, url, active}], sanitized here
   * @param {Array<Object>} [params.pageContent] Result rows read from the page, sanitized here
   * @returns {Promise<{ok: boolean, action: Object, audit: Object, latencyMs: number, modelUsed: string}>}
   */
  async requestAction(params) {
    const settings = await getSettings();
    const targetUrl = settings.serverUrl || this.serverUrl;
    const timeoutMs = settings.requestTimeoutMs || this.timeoutMs || 60000;

    // 1. Sanitize user task prompt if it contains inline raw PII
    const sanitizedTask = semanticRedactor.sanitizeText(params.task || "");

    // 2. Format sanitized DOM elements list
    const sanitizedElements = (params.interactiveElements || []).map((el) => ({
      tag: el.tagName || el.tag || "element",
      id: el.id || "",
      name: el.name || "",
      type: el.type || "",
      text: el.text || "",
      placeholder: el.placeholder || "",
      aria_label: el.ariaLabel || el.aria_label || "",
      selector: el.selector || (el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : ""),
      role: el.role || null,
      rect: el.bbox || el.rect || null,
      is_interactive: el.is_interactive !== false,
      is_local_only: Boolean(el.is_local_only)
    }));

    // 3. Prepare payload (Strictly Zero-Leakage)
    const payload = {
      task: sanitizedTask,
      sanitized_image_base64: params.sanitizedImageBase64 || null,
      dom_elements: sanitizedElements,
      redaction_manifest: (params.redactionManifest || []).map((r) => ({
        source: r.source || "WebGPU",
        label: r.label || "PII",
        box: [r.x || 0, r.y || 0, r.w || r.width || 0, r.h || r.height || 0]
      })),
      viewport: params.viewport || null,
      url: params.url || null,
      // Fall back to the persisted setting: callers other than the popup
      // (HUD, background-initiated runs) never passed one, so an explicit
      // model choice in Settings was silently ignored.
      model_provider: params.modelProvider || settings.modelProvider || "auto",
      step: params.step || 1,
      max_steps: params.maxSteps || settings.maxSteps || 25,
      history: params.history || [],
      structured_data: params.structuredData || null,
      // Final-answer pass: no further browsing, just report what was found.
      synthesize_only: Boolean(params.synthesizeOnly),
      stop_reason: params.stopReason || null,
      // The plan established on step 1, replayed so the goal survives a context
      // window that only ever shows one page at a time.
      plan: params.plan || [],
      plan_step: params.planStep || null,
      // Result rows read from the page. A TEXT EGRESS CHANNEL: unlike the
      // element digest this carries free-form page copy, so every string field
      // goes through the redactor. ref/on_screen and the numeric fields are
      // structural and cannot carry PII on their own.
      page_content: (params.pageContent || []).slice(0, 24).map((r) => ({
        ref: typeof r.ref === "number" ? r.ref : null,
        on_screen: Boolean(r.onScreen),
        title: semanticRedactor.sanitizeText(String(r.title || "")).slice(0, 120),
        price: semanticRedactor.sanitizeText(String(r.price || "")).slice(0, 24),
        rating: String(r.rating || "").slice(0, 8),
        reviews: String(r.reviews || "").slice(0, 16),
        delivery: semanticRedactor.sanitizeText(String(r.delivery || "")).slice(0, 60),
        badge: semanticRedactor.sanitizeText(String(r.badge || "")).slice(0, 40),
      })),
      // Tab titles and URLs are a text egress channel too: a title is routinely
      // "Order #4821 - Priya Nair" and a URL carries ids and emails in its query
      // string. Both go through the same redactor as the task prompt.
      open_tabs: (params.openTabs || []).map((t) => ({
        index: t.index,
        active: Boolean(t.active),
        title: semanticRedactor.sanitizeText(t.title || "").slice(0, 90),
        url: sanitizeUrlForModel(t.url || ""),
      })),
      // Names of the personal details the user has stored, so the model knows
      // which {{VAULT:...}} tokens it is allowed to ask for. Values NEVER appear
      // here. The caller already filters, but this is the last checkpoint before
      // the network, so the pattern is enforced again rather than trusted.
      vault_keys: (params.vaultKeys || [])
        .filter((k) => typeof k === "string" && /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(k))
        .slice(0, 40),
    };

    const startTime = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException(`Reasoning request timed out after ${Math.round(timeoutMs / 1000)}s`, "TimeoutError"));
    }, timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const elapsedMs = performance.now() - startTime;

      if (!data.action || !data.action.type) {
        throw new Error("Invalid response format from VLM server (missing action object).");
      }

      return {
        ok: true,
        action: data.action,
        audit: data.audit || {},
        latencyMs: Math.round(elapsedMs),
        serverLatencyMs: data.server_latency_ms || 0,
        modelUsed: data.model_used || "vlm-server",
        modelId: data.model_id || null,
        providerRequested: data.provider_requested || null,
        providerAttempts: data.provider_attempts || []
      };
    } catch (err) {
      const elapsedMs = performance.now() - startTime;
      console.warn("[AgentClient] Server action request failed:", err.message);

      // Check Fail-Closed setting
      if (settings.failClosed) {
        throw new Error(`Agent Execution Blocked (Fail-Closed enabled): ${err.message}`);
      }

      return {
        ok: false,
        error: err.message,
        latencyMs: Math.round(elapsedMs)
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Global Singleton Instance
export const agentClient = new AgentClient();
