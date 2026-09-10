/**
 * Centralized Settings and Persistent Storage Management (Manifest V3)
 * Provides unified schema, reactive subscribers, and defaults.
 */

export const DEFAULT_SETTINGS = {
  // Global Protection State
  enabled: true,

  // Engine & Inference Configuration
  engineMode: "auto", // "auto" | "webgpu" | "wasm"
  detectionConfidence: 0.65, // 0.30 - 0.95
  faceProxyPercent: 0.30, // 0.15 - 0.50 (upper box slice for faces)
  failClosed: true, // If true, blocks execution if sanitization fails

  // Detection Categories Toggle
  categories: {
    passwords: true,
    creditCards: true,
    govIds: true,
    contactInfo: true,
    faces: true,
    screens: true,
    names: true,   // Layer G: person names in form fields and OCR'd text
  },

  // Server & VLM Backend
  serverUrl: "http://127.0.0.1:8001/api/act",
  serverHealthUrl: "http://127.0.0.1:8001/health",
  modelProvider: "auto", // "auto" (Gemini Cloud VLM preferred) | "gemini" | "ollama_qwen" | "nlp"
  requestTimeoutMs: 60000,
  apiKey: "",

  // User Interface & On-Page Preferences
  showPageBadge: true,
  showVisualOverlays: false,
  autoScanOnLoad: true,
  autoRefreshStream: false,
  uiAdvancedMode: false, // Popup: show power-user tools beyond the basic on/off view
  theme: "dark",         // Popup color theme: "dark" | "light"

  // Agent Budget
  // A real task ("find a bassy speaker deliverable to my pincode") needs search,
  // filter, compare and verify — 8 steps could not finish one, and the run died
  // on the cap rather than on the goal. The budget is now generous but *earned*:
  // maxUnproductiveSteps stops a stuck agent long before maxSteps is reached, so
  // raising the ceiling does not mean burning it.
  maxSteps: 25,
  maxUnproductiveSteps: 3, // consecutive no-effect / failed / repeated actions

  // Perception toggles
  ocrEnabled: true,       // L2C: Tesseract OCR pass over candidate visual regions
  secondPassGuard: true,  // L2D: post-blackout residual verification
  // OCR coverage. `ocrLanguages` is a "+"-joined Tesseract language list; only
  // "eng" ships with the extension, so non-Latin scripts are a known blind spot
  // until the matching .traineddata.gz files are added to lib/tesseract/.
  ocrLanguages: "eng",
  ocrMaxRegions: 8,       // was a hard-coded 2, which left most cards unscanned
  ocrBudgetMs: 2500,      // time budget; skipped regions are logged, never silent

  // Developer Observability
  devMode: false,        // Dashboard: reveal model/layer attribution panels
  maxDevTraces: 50,

  // Whitelist / Excluded Domains (Redaction bypassed on these domains)
  domainWhitelist: [],

  // Telemetry & Retention
  telemetryEnabled: true,
  maxAuditLogs: 200,
};

/**
 * Retrieves current extension settings merged with defaults.
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getSettings() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["settings"], (result) => {
        if (result && result.settings) {
          resolve({ ...DEFAULT_SETTINGS, ...result.settings });
        } else {
          resolve({ ...DEFAULT_SETTINGS });
        }
      });
    } else if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem("pii_agent_settings");
      if (saved) {
        try {
          resolve({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
        } catch {
          resolve({ ...DEFAULT_SETTINGS });
        }
      } else {
        resolve({ ...DEFAULT_SETTINGS });
      }
    } else {
      resolve({ ...DEFAULT_SETTINGS });
    }
  });
}

/**
 * Saves updated extension settings.
 * @param {Partial<typeof DEFAULT_SETTINGS>} newSettings 
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function saveSettings(newSettings) {
  const current = await getSettings();
  const updated = { ...current, ...newSettings };

  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ settings: updated }, () => {
        resolve(updated);
      });
    } else {
      localStorage.setItem("pii_agent_settings", JSON.stringify(updated));
      resolve(updated);
    }
  });
}

/**
 * Resets settings to default values.
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function resetSettings() {
  return saveSettings(DEFAULT_SETTINGS);
}

/**
 * Appends an audit log entry for telemetry and compliance tracking.
 * @param {Object} auditEntry 
 */
export async function logAuditEntry(auditEntry) {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["auditLogs", "settings"], (result) => {
        const settings = result.settings || DEFAULT_SETTINGS;
        const maxLogs = settings.maxAuditLogs || 200;
        let logs = result.auditLogs || [];

        const entry = {
          id: "audit_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
          timestamp: new Date().toISOString(),
          ...auditEntry,
        };

        logs.unshift(entry);
        if (logs.length > maxLogs) {
          logs = logs.slice(0, maxLogs);
        }

        chrome.storage.local.set({ auditLogs: logs }, () => resolve(entry));
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * Retrieves stored audit logs.
 * @returns {Promise<Array<Object>>}
 */
export async function getAuditLogs() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["auditLogs"], (result) => {
        resolve(result.auditLogs || []);
      });
    } else {
      resolve([]);
    }
  });
}

/**
 * Rolls a redaction manifest up into per-layer and per-category counts.
 *
 * `sources` (plural) is present when NMS merged overlapping detections from
 * several layers; fall back to the single `source` tag when it is not.
 *
 * @param {Array<Object>} redactionList
 * @returns {{counts: Object, categories: Object}}
 */
export function summarizeRedactions(redactionList = []) {
  const counts = {};
  const categories = {};

  for (const box of redactionList) {
    const sources = Array.isArray(box.sources) && box.sources.length
      ? box.sources
      : [box.source || "unknown"];

    for (const source of sources) {
      counts[source] = (counts[source] || 0) + 1;
    }

    const category = box.category || "unknown";
    categories[category] = (categories[category] || 0) + 1;
  }

  return { counts, categories };
}

/**
 * Correlation id shared by an audit entry and its matching pipeline trace.
 */
export function newTraceId() {
  return "trace_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
}

/**
 * Records a developer pipeline trace: model attribution, per-layer detection
 * counts and per-stage timings.
 *
 * Deliberately stored under its own key rather than in auditLogs — auditLogs is
 * the user-facing compliance record, and a trace carries a full redaction
 * manifest that would evict it several times faster and leak into its exports.
 *
 * @param {Object} trace
 * @returns {Promise<Object|null>}
 */
export async function logPipelineTrace(trace) {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["devTraces", "settings"], (result) => {
        const settings = result.settings || DEFAULT_SETTINGS;
        const maxTraces = settings.maxDevTraces || 50;
        let traces = result.devTraces || [];

        const safe = { ...trace };
        // Image data URLs run to hundreds of KB — never persist them in the ring buffer.
        delete safe.sanitizedImageUrl;
        delete safe.rawImageUrl;
        delete safe.sanitizedImage;

        const entry = {
          traceId: trace.traceId || newTraceId(),
          timestamp: new Date().toISOString(),
          ...safe,
        };

        traces.unshift(entry);
        if (traces.length > maxTraces) {
          traces = traces.slice(0, maxTraces);
        }

        chrome.storage.local.set({ devTraces: traces }, () => resolve(entry));
      });
    } else {
      resolve(null);
    }
  });
}

/**
 * Retrieves stored developer pipeline traces, newest first.
 * @returns {Promise<Array<Object>>}
 */
export async function getPipelineTraces() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["devTraces"], (result) => {
        resolve(result.devTraces || []);
      });
    } else {
      resolve([]);
    }
  });
}

/**
 * Clears all stored developer pipeline traces.
 */
export async function clearPipelineTraces() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ devTraces: [] }, () => resolve(true));
    } else {
      resolve(true);
    }
  });
}

/**
 * Clears all stored audit logs.
 */
export async function clearAuditLogs() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ auditLogs: [] }, () => resolve(true));
    } else {
      resolve(true);
    }
  });
}
