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

import { getSettings, logAuditEntry, logPipelineTrace, newTraceId, summarizeRedactions } from "./storage.js";
import { agentClient } from "./agent_client.js";
import { permissionEngine, PERMISSION_OUTCOMES } from "./permission_engine.js";
import { promptGuard } from "./prompt_guard.js";
import { semanticRedactor } from "./semantic_redactor.js";
import { vault } from "./vault.js";
import { defaultPrivacyReasoner } from "./local_reasoner.js";
import { logEvent } from "./telemetry.js";

/**
 * Cheap stable fingerprint of the interactive page state (FNV-1a).
 * Used only to tell "the page changed" from "nothing happened".
 */
function digestElements(elements = []) {
  const shape = elements
    .map((el) => `${el.id || ""}|${el.tagName || el.tag || ""}|${el.value || ""}|${(el.text || "").slice(0, 40)}`)
    .join("~");

  let hash = 0x811c9dc5;
  for (let i = 0; i < shape.length; i++) {
    hash ^= shape.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${shape.length}:${hash.toString(16)}`;
}

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
    const maxUnproductive = options.maxUnproductiveSteps
      || settings.maxUnproductiveSteps
      || 3;

    this.options = options || {};
    this.status = AGENT_LOOP_STATUS.RUNNING;
    this.currentStep = 0;
    this.stepHistory = [];
    this._lastDomDigest = null;
    this._unproductiveRun = 0;
    this._abortController = new AbortController();

    // Reset session-scoped placeholder mappings for a clean task run
    semanticRedactor.resetSession();

    logEvent("agent", `Starting autonomous loop: "${userTask}" (Max steps: ${maxSteps})`);
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
        logEvent("agent", `Step ${this.currentStep}/${maxSteps}: Capturing & redacting tab viewport...`);
        const captureResult = await this._captureAndRedact({ ...options, userTask, resolveAmbiguities: false });
        if (!captureResult || !captureResult.ok) {
          throw new Error(`Capture and local perception failed: ${captureResult?.error || "Unknown"}`);
        }

        // ── Phase 2: Fetch & Sanitize DOM Interactive Elements & Telemetry ──
        let domElements = [];
        let structuredData = null;
        try {
          const tab = await this._getActiveTab();
          if (tab && tab.id) {
            const domResp = await this._sendTabMessage(tab.id, { type: "GET_DOM_PII_BOXES" });
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

        // Local Privacy Reasoner (Qwen on ambiguous situations) — single BATCH call
        const ambiguousInputs = sanitizedElements.filter((el) => {
          if (el.isRedacted) return false;
          const tag = (el.tagName || el.tag || "").toLowerCase();
          const isInput = tag === "input" || tag === "textarea" || tag === "select" || Boolean(el.isContentEditable);
          if (!isInput) return false;
          const text = [el.label, el.placeholder, el.name, el.id, el.text].filter(Boolean).join(" ").toLowerCase();
          return /recovery|seed|private.?key|secret.?key|medical|prescription|diagnosis|salary|payroll|telemetry|launch.?code|confidential|kyc|identity/i.test(text);
        });

        let qwenTrace = {
          invoked: false,
          trigger: null,
          candidateCount: ambiguousInputs.length,
          batchSize: 0,
          latencyMs: 0,
          engine: null,
          cacheHits: null,
          timedOut: false,
          decisions: [],
        };

        if (ambiguousInputs.length > 0) {
          // Use the batch resolver — one LLM call covers all elements
          const batchManifest = {
            ambiguousElements: ambiguousInputs.map((el) => ({ element: el })),
            decisions: ambiguousInputs.map((el, i) => ({ elementId: el.id || `el_${i}`, element: el })),
          };
          const tReasonerStart = performance.now();
          const resolved = await defaultPrivacyReasoner.resolveManifestAmbiguities(batchManifest, { userTask });
          const reasonerLatencyMs = Math.round(performance.now() - tReasonerStart);
          const decisions = resolved.decisions || [];

          for (const decision of decisions) {
            const el = sanitizedElements.find((e) => (e.id || "") === String(decision.elementId));
            if (el && (decision.decision === "BLOCK" || decision.decision === "REDACT")) {
              el.value = semanticRedactor.anonymize(el.value || "SENSITIVE", decision.category || "custom");
              el.isRedacted = true;
            }
            if (el) {
              el.evaluated_by = decision.resolvedBy || "qwen-local-reasoner";
              el.privacyDecision = decision.decision;
            }
          }

          qwenTrace = {
            invoked: true,
            trigger: "keyword-prefilter",
            candidateCount: ambiguousInputs.length,
            batchSize: decisions.length,
            latencyMs: reasonerLatencyMs,
            engine: resolved.reasonerTrace?.engine || decisions[0]?.resolvedBy || "local-reasoner",
            cacheHits: resolved.reasonerTrace?.cacheHits ?? null,
            timedOut: resolved.reasonerTrace?.timedOut ?? false,
            decisions: decisions.map((d) => ({
              elementId: d.elementId,
              decision: d.decision,
              category: d.category || null,
              engine: d.resolvedBy || null,
              reason: d.reason || null,
            })),
          };
        }


        // No-op detection: if the page looks identical to the last observation,
        // the previous action changed nothing. Without this the loop can repeat
        // a dead action until it runs out of steps.
        const domDigest = digestElements(sanitizedElements);
        if (this._lastDomDigest && this._lastDomDigest === domDigest && this.stepHistory.length > 0) {
          const previous = this.stepHistory[this.stepHistory.length - 1];
          previous.noOp = true;
          logEvent(
            "agent",
            `Step ${previous.step} (${previous.action?.type || "action"}) had no observable effect — instructing model to try a different approach.`,
            null,
            "warn"
          );
        }
        this._lastDomDigest = domDigest;

        // Productivity accounting. The step budget is a ceiling, not a target:
        // a run that is genuinely progressing should be allowed to use it, while
        // one that is stuck should stop long before it. Judged on the PREVIOUS
        // step, because its outcome is only observable now.
        if (this.stepHistory.length > 0) {
          const previous = this.stepHistory[this.stepHistory.length - 1];
          const beforeThat = this.stepHistory[this.stepHistory.length - 2];
          const signature = (s) =>
            `${s?.action?.type || ""}|${s?.action?.selector || ""}|${s?.action?.value || ""}`;

          const failed = previous.executionReport?.ok === false;
          const repeated = Boolean(beforeThat) && signature(previous) === signature(beforeThat);
          const unproductive = Boolean(previous.noOp) || failed || repeated;

          if (unproductive) {
            this._unproductiveRun += 1;
            previous.unproductive = true;
            previous.unproductiveReason = previous.noOp ? "no-effect" : failed ? "failed" : "repeated";
          } else {
            this._unproductiveRun = 0;
          }

          if (this._unproductiveRun >= maxUnproductive) {
            logEvent(
              "agent",
              `Stopping: ${this._unproductiveRun} consecutive steps made no progress (last: ${previous.unproductiveReason}). ` +
              `Reporting what was found rather than spending the remaining ${maxSteps - this.currentStep + 1} steps.`,
              null,
              "warn"
            );
            this.currentStep -= 1; // this step was never executed
            this.status = AGENT_LOOP_STATUS.COMPLETED;
            loopSummary = `Stopped after ${this._unproductiveRun} steps with no progress (${previous.unproductiveReason}).`;
            break;
          }
        }

        // Build concise action history of previous steps in this session
        const historyDigest = this.stepHistory.map((s) => ({
          step: s.step,
          action: s.action?.type || "action",
          selector: s.action?.selector || "",
          value: s.action?.value || "",
          // Outcome, not just intent: without these the model cannot tell a
          // click that worked from one that hit nothing, and starts looping.
          ok: s.executionReport ? s.executionReport.ok !== false : true,
          error: s.executionReport?.error || "",
          noOp: Boolean(s.noOp),
          repeated: s.unproductiveReason === "repeated",
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
            redactionCount: (captureResult.redactionList || []).length,
            redactionList: captureResult.redactionList || []
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
            executionReport = await this._sendTabMessage(tab.id, {
              type: "EXECUTE_ACTION",
              action: execAction
            });
          }
        } catch (execErr) {
          executionReport = { ok: false, error: execErr.message };
        }

        const stepLatencyMs = Math.round(performance.now() - stepStartTime);

        const stepRedactions = captureResult.redactionList || [];
        const traceId = newTraceId();
        const { counts, categories } = summarizeRedactions(stepRedactions);

        const perceptionTrace = {
          counts,
          categories,
          timings: captureResult.timings || {},
          nmsSuppressed: captureResult.timings?.nmsSuppressed ?? 0,
          guard: captureResult.guard || null,
        };

        const reasoningTrace = {
          providerRequested: options.modelProvider || "auto",
          provider: actionResult.modelUsed || null,
          modelId: actionResult.modelId || null,
          serverLatencyMs: actionResult.serverLatencyMs ?? null,
          clientLatencyMs: actionResult.latencyMs ?? null,
          attempts: actionResult.providerAttempts || [],
        };

        const stepRecord = {
          step: this.currentStep,
          action,
          permission,
          executionReport,
          modelUsed: actionResult.modelUsed,
          serverLatencyMs: actionResult.serverLatencyMs,
          totalStepLatencyMs: stepLatencyMs,
          sanitizedImage: captureResult.sanitizedImageUrl,
          redactionCount: stepRedactions.length,
          redactionList: stepRedactions,
          perception: perceptionTrace,
          reasoning: reasoningTrace,
          qwen: qwenTrace,
          traceId,
        };

        this.stepHistory.push(stepRecord);

        // Record audit entry
        await logAuditEntry({
          type: "AGENT_LOOP_STEP",
          traceId,
          step: this.currentStep,
          task: userTask,
          actionType: action.type,
          model: actionResult.modelUsed,
          modelId: actionResult.modelId || null,
          latencyMs: stepLatencyMs,
          redactions: stepRedactions.length
        });

        // Record developer pipeline trace
        await logPipelineTrace({
          traceId,
          kind: "agent_step",
          step: this.currentStep,
          url: captureResult.tabUrl || "",
          redactions: stepRedactions.length,
          latencyMs: stepLatencyMs,
          perception: perceptionTrace,
          reasoning: reasoningTrace,
          qwen: qwenTrace,
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
      loopSummary = `Reached the ${maxSteps}-step budget.`;
    }

    // Whatever ended the run, the user asked a question and deserves an answer.
    // Previously an exhausted budget returned only the stop reason, so a run that
    // had actually gathered useful information reported nothing at all.
    const finishStep = [...this.stepHistory].reverse().find((s) => s.action?.type === "finish");
    let result = finishStep?.action?.result || null;

    if (!result && this.status !== AGENT_LOOP_STATUS.STOPPED) {
      result = await this._synthesizeBestEffort(userTask, options, loopSummary).catch((err) => {
        logEvent("agent", `Could not synthesize a final answer: ${err.message}`, null, "warn");
        return null;
      });
    }

    if (result?.summary) {
      loopSummary = result.summary;
    }

    return {
      status: this.status,
      stepsExecuted: this.currentStep,
      history: this.stepHistory,
      summary: loopSummary,
      result
    };
  }

  /**
   * Allows registering a direct capture handler function (e.g. from background service worker).
   */
  setCaptureHandler(fn) {
    this._customCaptureHandler = fn;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Asks the model to answer the user's question from what the run actually saw,
   * for runs that ended without a `finish` (budget exhausted, or stuck).
   *
   * Sends only the sanitized step history — no new capture, no raw page text —
   * so this adds no new egress surface beyond what each step already sent.
   *
   * @returns {Promise<Object|null>} A result object, or null if nothing to report.
   */
  async _synthesizeBestEffort(userTask, options, stopReason) {
    const observed = this.stepHistory
      .filter((s) => s.action && s.action.type !== "wait")
      .map((s) => ({
        step: s.step,
        action: s.action.type,
        value: s.action.value || "",
        explanation: s.action.explanation || "",
        ok: s.executionReport ? s.executionReport.ok !== false : true,
      }));

    if (observed.length === 0) return null;

    logEvent("agent", "Synthesizing a best-effort answer from what the run observed...");

    const res = await agentClient.requestAction({
      task: userTask,
      interactiveElements: [],
      redactionManifest: [],
      url: this.stepHistory[this.stepHistory.length - 1]?.url || "",
      modelProvider: options.modelProvider || "auto",
      step: this.currentStep,
      maxSteps: this.currentStep,
      history: observed,
      synthesizeOnly: true,
      stopReason,
    });

    return res?.ok ? (res.action?.result || null) : null;
  }

  async _getActiveTab() {
    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.query) {
      if (this.options?.tabId) {
        try {
          const tab = await chrome.tabs.get(this.options.tabId);
          if (tab && tab.id) return tab;
        } catch {}
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) return tab;
      const allTabs = await chrome.tabs.query({ active: true });
      return allTabs[0];
    }
    return null;
  }

  async _sendTabMessage(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      if (
        err.message?.includes("Receiving end does not exist") ||
        err.message?.includes("Could not establish connection")
      ) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
          });
          await new Promise((r) => setTimeout(r, 120));
          return await chrome.tabs.sendMessage(tabId, message);
        } catch (injectErr) {
          console.warn("[AgentLoop] Could not re-inject content script:", injectErr.message);
        }
      }
      throw err;
    }
  }

  async _captureAndRedact(options = {}) {
    if (options.captureFn) {
      return await options.captureFn(options);
    }
    if (this._customCaptureHandler) {
      return await this._customCaptureHandler(options);
    }

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await chrome.runtime.sendMessage({ type: "CAPTURE_AND_REDACT", options });
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    return {
      ok: true,
      sanitizedImageUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      redactionList: [],
      resolution: { width: 1280, height: 720 },
      tabUrl: "http://localhost:8000/demo.html"
    };
  }
}

// Global Singleton Instance
export const agentLoop = new AutonomousAgentLoop();
