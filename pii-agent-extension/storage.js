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
  },

  // Server & VLM Backend
  serverUrl: "http://127.0.0.1:8001/api/act",
  serverHealthUrl: "http://127.0.0.1:8001/health",
  apiKey: "",

  // User Interface & On-Page Preferences
  showPageBadge: true,
  showVisualOverlays: false,
  autoScanOnLoad: true,
  autoRefreshStream: false,

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
