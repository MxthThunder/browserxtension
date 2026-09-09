/**
 * End-to-End Closed-Loop Autonomous Agent Loop (Manifest V3)
 * Step 10 (Final Step) of Privacy-Preserving Browser-Agent Architecture.
 *
 * Orchestrates the full 9-layer autonomous cycle:
 *   [1. Observe] -> [2. Perceive (DOM+OCR+OWL-ViT+Face)] -> [3. Local Privacy Filter] ->
 *   [4. Local Reasoner] -> [5. Semantic Redaction] -> [6. Prompt Guard] ->
 *   [7. VLM Server / Qwen] -> [8. Permission & HITL Safety] -> [9. Local Actuation] -> [Loop]
 *
 * Guarantees Zero-Leakage:
 * - Every observation is sanitized on-device before external network transmission.
 * - Form values and vault secrets are de-anonymized strictly on-device at the actuation phase.
 */

import { getSettings, logAuditEntry } from "./storage.js";
import { agentClient } from "./agent_client.js";
import { permissionEngine, PERMISSION_OUTCOMES } from "./permission_engine.js";
import { promptGuard } from "./prompt_guard.js";
import { semanticRedactor } from "./semantic_redactor.js";
import { vault } from "./vault.js";

/**
 * De-anonymizes an action value locally before any DOM insertion.
 * Resolves vault tokens ({{VAULT:category.key}}) then session placeholders ([PERSON_1], etc.).
 * NEVER call this before sending to the external VLM — only call it right before DOM execution.
 * @param {string|null} value
 * @returns {string}
 */
function resolveLocalActionValue(value) {
  if (!value || typeof value !== "string") return value || "";

  // 1. Vault token syntax: {{VAULT:category.key}}
  if (value.startsWith("{{VAULT:") && value.endsWith("}}")) {
    try {
      if (vault.isUnlocked()) {
        const resolved = vault.resolveToken(value);
        if (resolved !== null) return resolved;
      }
    } catch {
      // Vault locked or error — fall through
    }
  }

  // 2. Inline vault tokens anywhere in the string
  const vaultTokenPattern = /\{\{VAULT:([a-z0-9_]+)\.([a-z0-9_]+)\}\}/gi;
  if (vault.isUnlocked() && vaultTokenPattern.test(value)) {
    value = value.replace(
      /\{\{VAULT:([a-z0-9_]+)\.([a-z0-9_]+)\}\}/gi,
      (_match, cat, key) => {
        try { return vault.get(cat, key) ?? _match; } catch { return _match; }
      }
    );
  }

  // 3. Session-scoped semantic placeholders ([PERSON_1], [EMAIL_1], etc.)
  return semanticRedactor.deAnonymize(value);
}

export const AGENT_LOOP_STATUS = {
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  STOPPED: "STOPPED",
  ERROR: "ERROR"
};

export class AutonomousAgentLoop {
  constructor(options = {}) {
    this.maxSteps = options.maxSteps || 10;
    this.settleDelayMs = options.settleDelayMs || 350;
    this.status = AGENT_LOOP_STATUS.IDLE;
    this._abortController = null;
    this.currentStep = 0;
    this.stepHistory = [];
  }

  /**
   * Stops any currently running autonomous agent loop.
   */
  stop() {
    this.status = AGENT_LOOP_STATUS.STOPPED;
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  /**
   * Executes a multi-step goal autonomously until completion or max steps reached.
   *
   * @param {string} userTask The goal instruction (e.g. "Fill form and submit identity KYC")
   * @param {Object} [options]
   * @param {Function} [onStepCallback] Invoked after every step with telemetry and action details
   * @returns {Promise<{status: string, stepsExecuted: number, history: Array<Object>, summary: string}>}
   */
  async runLoop(userTask, options = {}, onStepCallback = null) {
    if (!userTask || typeof userTask !== "string") {
      throw new Error("A valid user task prompt is required to run the autonomous agent loop.");
    }

    const settings = await getSettings();
    const maxSteps = options.maxSteps || settings.maxSteps || this.maxSteps;

    this.status = AGENT_LOOP_STATUS.RUNNING;
    this.currentStep = 0;
    this.stepHistory = [];
    this._abortController = new AbortController();

    // Reset session-scoped placeholder mappings for a clean task run
    semanticRedactor.resetSession();

    let loopSummary = "Task completed successfully.";

    try {
      while (this.status === AGENT_LOOP_STATUS.RUNNING && this.currentStep < maxSteps) {
        this.currentStep += 1;
        const stepStartTime = performance.now();

        // Check if aborted
        if (this._abortController?.signal?.aborted) {
          this.status = AGENT_LOOP_STATUS.STOPPED;
          loopSummary = "Agent loop stopped by user.";
          break;
        }

        // ── Phase 1: Zero-Leakage Viewport Capture & Local Perception ──────────
        const captureResult = await this._captureAndRedact(options);
        if (!captureResult || !captureResult.ok) {
          throw new Error(`Capture and local perception failed: ${captureResult?.error || "Unknown"}`);
        }

        // ── Phase 2: Fetch & Sanitize DOM Interactive Elements & Telemetry ──
        let domElements = [];
        let structuredData = null;
        try {
          const tab = await this._getActiveTab();
          if (tab && tab.id) {
            const domResp = await chrome.tabs.sendMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
            if (domResp) {
              if (domResp.interactiveElements) domElements = domResp.interactiveElements;
              if (domResp.structuredData) structuredData = domResp.structuredData;
            }
          }
        } catch {
          // Tab unavailable or restricted
        }

        // Apply Prompt-Guard & Semantic Redaction to DOM text
        const guardedElements = promptGuard.sanitizeElements(domElements);
        const sanitizedElements = semanticRedactor.sanitizePerceptionElements(guardedElements);

        // Build concise action history of previous steps in this session
        const historyDigest = this.stepHistory.map((s) => ({
          step: s.step,
          action: s.action?.type || "action",
          selector: s.action?.selector || "",
          value: s.action?.value || "",
          explanation: s.action?.explanation || ""
        }));

        // ── Phase 3: Query Main Agent LLM / VLM (Sanitized Context Only) ───────
        const actionResult = await agentClient.requestAction({
          task: userTask,
          sanitizedImageBase64: captureResult.sanitizedImageUrl,
          interactiveElements: sanitizedElements,
          structuredData: structuredData,
          redactionManifest: captureResult.redactionList || [],
          viewport: captureResult.resolution,
          url: captureResult.tabUrl,
          modelProvider: options.modelProvider || "auto",
          step: this.currentStep,
          maxSteps: maxSteps,
          history: historyDigest
        });

        if (!actionResult.ok || !actionResult.action) {
          throw new Error(`VLM Reasoning Server error: ${actionResult.error || "No action returned"}`);
        }

        const action = actionResult.action;

        // ── Phase 4: Permission & Human-in-the-Loop Safety Check ──────────────
        const permission = permissionEngine.evaluate(action);

        if (permission.outcome === PERMISSION_OUTCOMES.BLOCK) {
          throw new Error(`Security Policy Violation: ${permission.reason}`);
        }

        let userApproved = true;
        if (permission.outcome === PERMISSION_OUTCOMES.REQUIRE_CONFIRMATION) {
          // Trigger on-page confirmation dialog
          try {
            const tab = await this._getActiveTab();
            if (tab && tab.id) {
              userApproved = await permissionEngine.requestUserConfirmation(action, permission.reason);
            }
          } catch {
            userApproved = false;
          }

          if (!userApproved) {
            this.status = AGENT_LOOP_STATUS.STOPPED;
            loopSummary = `Agent action rejected by user: ${action.type}`;
            break;
          }
        }

        // ── Phase 5: Check for Finish State ──────────────────────────────────
        if (action.type === "finish") {
          const stepData = {
            step: this.currentStep,
            action,
            permission,
            modelUsed: actionResult.modelUsed,
            latencyMs: Math.round(performance.now() - stepStartTime),
            sanitizedImage: captureResult.sanitizedImageUrl,
            redactionCount: (captureResult.redactionList || []).length
          };
          this.stepHistory.push(stepData);

          if (onStepCallback) onStepCallback(stepData);
          this.status = AGENT_LOOP_STATUS.COMPLETED;
          loopSummary = action.explanation || "Goal achieved.";
          break;
        }

        // ── Phase 6: Execute Action in DOM with Local Token De-anonymization ──
        // De-anonymize all values strictly on-device BEFORE sending to content script.
        // The VLM only ever sees [PERSON_1] / {{VAULT:contact.email}} — never raw PII.
        const execAction = {
          ...action,
          value: resolveLocalActionValue(action.value),
        };
        // Also de-anonymize selector if it contains a token (rare edge case)
        if (execAction.selector && execAction.selector.includes("{{VAULT:")) {
          execAction.selector = resolveLocalActionValue(execAction.selector);
        }

        let executionReport = null;
        try {
          const tab = await this._getActiveTab();
          if (tab && tab.id) {
            executionReport = await chrome.tabs.sendMessage(tab.id, {
              type: "EXECUTE_ACTION",
              action: execAction
            });
          }
        } catch (execErr) {
          executionReport = { ok: false, error: execErr.message };
        }

        const stepLatencyMs = Math.round(performance.now() - stepStartTime);

        const stepRecord = {
          step: this.currentStep,
          action,
          permission,
          executionReport,
          modelUsed: actionResult.modelUsed,
          serverLatencyMs: actionResult.serverLatencyMs,
          totalStepLatencyMs: stepLatencyMs,
          sanitizedImage: captureResult.sanitizedImageUrl,
          redactionCount: (captureResult.redactionList || []).length
        };

        this.stepHistory.push(stepRecord);

        // Record audit entry
        await logAuditEntry({
          type: "AGENT_LOOP_STEP",
          step: this.currentStep,
          task: userTask,
          actionType: action.type,
          model: actionResult.modelUsed,
          latencyMs: stepLatencyMs,
          redactions: (captureResult.redactionList || []).length
        });

        // Notify caller
        if (onStepCallback) {
          onStepCallback(stepRecord);
        }

        // Settle delay before next observation
        if (this.status === AGENT_LOOP_STATUS.RUNNING) {
          await new Promise((res) => setTimeout(res, this.settleDelayMs));
        }
      }
    } catch (err) {
      this.status = AGENT_LOOP_STATUS.ERROR;
      loopSummary = `Loop terminated with error: ${err.message}`;
      console.error("[AutonomousAgentLoop] Error in execution loop:", err);
    }

    if (this.currentStep >= maxSteps && this.status === AGENT_LOOP_STATUS.RUNNING) {
      this.status = AGENT_LOOP_STATUS.COMPLETED;
      loopSummary = `Reached maximum step limit (${maxSteps}).`;
    }

    return {
      status: this.status,
      stepsExecuted: this.currentStep,
      history: this.stepHistory,
      summary: loopSummary
    };
  }

  /**
   * Allows registering a direct capture handler function (e.g. from background service worker).
   */
  setCaptureHandler(fn) {
    this._customCaptureHandler = fn;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  async _getActiveTab() {
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.query) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab;
    }
    return null;
  }

  async _captureAndRedact(options = {}) {
    if (options.captureFn) {
      return await options.captureFn(options);
    }
    if (this._customCaptureHandler) {
      return await this._customCaptureHandler(options);
    }

    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: "CAPTURE_AND_REDACT", options }, (response) => {
          resolve(response || { ok: false, error: "Empty capture response" });
        });
      } else {
        resolve({
          ok: true,
          sanitizedImageUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
          redactionList: [],
          resolution: { width: 1280, height: 720 },
          tabUrl: "http://localhost:8000/demo.html"
        });
      }
    });
  }
}

// Global Singleton Instance
export const agentLoop = new AutonomousAgentLoop();
