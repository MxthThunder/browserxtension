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
      model_provider: params.modelProvider || "auto",
      step: params.step || 1,
      max_steps: params.maxSteps || 8,
      history: params.history || []
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
        modelUsed: data.model_used || "vlm-server"
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
