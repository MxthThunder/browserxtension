/**
 * Pluggable Telemetry & Application Data Adapter (Manifest V3)
 * Architectural Layer: Unified Perception & Data Layer
 * 
 * Purpose:
 * In dynamic mission-critical Single Page Applications (SPAs) like NASA OpenMCT,
 * Yamcs, or custom telemetry consoles, numerical parameters and alarms arrive over
 * WebSocket streams (protobuf/CBOR delta frames) and downsampled REST APIs.
 * 
 * Strip charts and plots are drawn directly onto <canvas> or WebGL viewports.
 * Running OCR on these high-frequency charts is inaccurate, CPU-heavy, and prone to hallucinations.
 * 
 * This adapter:
 * 1. Maintains an in-memory ring-buffer cache of active telemetry parameters.
 * 2. Ingests structured frames via window message bus, OpenMCT hooks, or REST polling.
 * 3. Enforces Mission-Sensitive Operational Data (MSOD) redaction on sensitive coordinates/keys.
 * 4. Normalizes structured real-time values into a compact, exact digest for the agent LLM.
 */

export class TelemetryDataAdapter {
  constructor(options = {}) {
    this.maxRingBufferSize = options.maxRingBufferSize || 60;
    this.telemetryCache = new Map(); // mnemonic -> { value, unit, status, timestamp, limit_state, subsystem }
    this.eventLog = []; // [{ timestamp, subsystem, severity, message }]
    this.maxEventLogs = 30;
    this.isListening = false;
    this._initMessageBridge();
  }

  /**
   * Initializes the browser window bridge to receive structured telemetry frames
   * dispatched by OpenMCT plugins, WebSocket intercepts, or simulation scripts.
   */
  _initMessageBridge() {
    if (typeof window === "undefined") return;

    window.addEventListener("message", (event) => {
      // Security: verify event data structure
      if (!event.data || typeof event.data !== "object") return;

      const { type, payload } = event.data;

      if (type === "PRIVIBROWSE_TELEMETRY_FRAME") {
        this.ingestTelemetryFrame(payload);
      } else if (type === "PRIVIBROWSE_EVENT_LOG") {
        this.ingestEventLog(payload);
      } else if (type === "PRIVIBROWSE_CLEAR_TELEMETRY") {
        this.clear();
      }
    });

    this.isListening = true;
  }

  /**
   * Ingests a single telemetry parameter or batch of parameters.
   * @param {Object|Array<Object>} data 
   * Expected item format:
   * {
   *   mnemonic: "BAT1_DOD",
   *   value: 12.6,
   *   unit: "%",
   *   status: "OK" | "WARN" | "ALARM",
   *   subsystem: "POWER",
   *   limit_state: "Soft limit: 35.0%",
   *   timestamp: "2026-247T15:08:42Z"
   * }
   */
  ingestTelemetryFrame(data) {
    if (!data) return;
    const items = Array.isArray(data) ? data : [data];

    for (const item of items) {
      if (!item.mnemonic) continue;

      const sanitizedItem = this._applyMsodFilter(item);

      this.telemetryCache.set(sanitizedItem.mnemonic, {
        value: sanitizedItem.value,
        unit: sanitizedItem.unit || "",
        status: sanitizedItem.status || "NOMINAL",
        subsystem: sanitizedItem.subsystem || "HOUSEKEEPING",
        limit_state: sanitizedItem.limit_state || null,
        timestamp: sanitizedItem.timestamp || new Date().toISOString(),
        updatedAt: Date.now()
      });

      // Maintain ring-buffer size limit
      if (this.telemetryCache.size > this.maxRingBufferSize) {
        const oldestKey = this.telemetryCache.keys().next().value;
        this.telemetryCache.delete(oldestKey);
      }
    }
  }

  /**
   * Ingests mission event log entries (alarms, state changes, flight events).
   * @param {Object|Array<Object>} events 
   */
  ingestEventLog(events) {
    if (!events) return;
    const items = Array.isArray(events) ? events : [events];

    for (const ev of items) {
      this.eventLog.push({
        timestamp: ev.timestamp || new Date().toISOString(),
        subsystem: ev.subsystem || "SYS",
        severity: ev.severity || "INFO",
        message: this._maskSensitiveString(ev.message || "")
      });

      if (this.eventLog.length > this.maxEventLogs) {
        this.eventLog.shift();
      }
    }
  }

  /**
   * Applies Mission-Sensitive Operational Data (MSOD) privacy rules on telemetry frames.
   */
  _applyMsodFilter(item) {
    const cloned = { ...item };
    
    // Mask sensitive orbital ephemeris coordinates if classified
    if (typeof cloned.value === "string") {
      cloned.value = this._maskSensitiveString(cloned.value);
    }
    return cloned;
  }

  /**
   * Masks sensitive coordinates, operator IDs, or secret keys within text.
   */
  _maskSensitiveString(str) {
    if (!str || typeof str !== "string") return str;

    // Mask classified Lat/Long coordinates: e.g. 13.03N 77.51E -> [RESTRICTED_COORDINATES]
    str = str.replace(/\b\d{1,2}(?:\.\d+)?°?\s*[NS][,\s]+\d{1,3}(?:\.\d+)?°?\s*[EW]\b/gi, "[RESTRICTED_COORDINATES]");

    // Mask operator personal credentials / badge numbers: OP-10492 -> [OPERATOR_ID]
    str = str.replace(/\b(?:OP-[A-Z0-9]{4,10}|USRC\/[A-Z0-9\/-]+)\b/gi, "[OPERATOR_ID]");

    // Mask internal IP addresses
    str = str.replace(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, "[INTERNAL_IP]");

    return str;
  }

  /**
   * Returns a normalized structured digest for inclusion in LLM reasoning requests.
   * This provides the agent with exact numbers (eliminating visual hallucination)
   * while keeping total token payload minimal and privacy-sanitized.
   */
  getTelemetryDigest() {
    if (this.telemetryCache.size === 0 && this.eventLog.length === 0) {
      return null;
    }

    const activeParameters = {};
    for (const [mnemonic, data] of this.telemetryCache.entries()) {
      activeParameters[mnemonic] = {
        value: `${data.value}${data.unit ? " " + data.unit : ""}`,
        status: data.status,
        subsystem: data.subsystem,
        limit: data.limit_state || undefined,
        timestamp: data.timestamp
      };
    }

    return {
      source: "mission_telemetry_stream",
      parameter_count: this.telemetryCache.size,
      parameters: activeParameters,
      recent_events: this.eventLog.slice(-10),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Resets all cached telemetry and logs.
   */
  clear() {
    this.telemetryCache.clear();
    this.eventLog = [];
  }
}

// Global Singleton for extension content runtime
export const telemetryAdapter = new TelemetryDataAdapter();

// Also expose on window for direct bridge from testbeds/SPAs if running in same context
if (typeof window !== "undefined") {
  window.__PRIVIBROWSE_TELEMETRY_ADAPTER__ = telemetryAdapter;
}
