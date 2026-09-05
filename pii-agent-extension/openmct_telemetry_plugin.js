/**
 * PriviBrowse-X OpenMCT Telemetry Bridge Plugin
 * Compatible with NASA OpenMCT v2.0+ and v3.0+
 *
 * Purpose:
 * Subscribes to active telemetry streams in NASA OpenMCT and bridges normalized
 * parameters into the PriviBrowse-X extension's local Data/Telemetry Adapter.
 * 
 * This completely eliminates the need for the browser agent to run OCR or visual
 * vision models over OpenMCT's WebGL / HTML5 <canvas> strip charts.
 *
 * Usage in OpenMCT:
 *   openmct.install(PriviBrowseOpenMCTPlugin({
 *     streamToWindow: true,
 *     filterSensors: ['BAT1_DOD', 'BAT1_SOC', 'BUS_V28', 'STR2_STAT', 'RWA3_RPM']
 *   }));
 */

export function PriviBrowseOpenMCTPlugin(options = {}) {
  return function install(openmct) {
    console.log("[PriviBrowse-X] Installing OpenMCT Telemetry Bridge Plugin...");

    const trackedMnemonics = new Set(options.filterSensors || []);

    // Listen to OpenMCT's telemetry subscription service
    if (openmct.telemetry && openmct.telemetry.subscribe) {
      // Intercept telemetry subscriptions
      const originalSubscribe = openmct.telemetry.subscribe.bind(openmct.telemetry);

      openmct.telemetry.subscribe = function (domainObject, callback, requestOptions) {
        const unsubscribe = originalSubscribe(domainObject, (telemetryDatum) => {
          // 1. Invoke original OpenMCT rendering callback
          callback(telemetryDatum);

          // 2. Extract mnemonic and value
          const mnemonic = domainObject.identifier?.key || domainObject.name || "UNKNOWN_PARAM";
          if (trackedMnemonics.size > 0 && !trackedMnemonics.has(mnemonic)) {
            return;
          }

          const value = telemetryDatum.value !== undefined ? telemetryDatum.value : telemetryDatum.val;
          const status = telemetryDatum.status || (value > 35 ? "WARN" : "OK");

          // 3. Dispatch structured telemetry frame to window for PriviBrowse-X
          window.postMessage({
            type: "PRIVIBROWSE_TELEMETRY_FRAME",
            payload: {
              mnemonic: mnemonic,
              value: value,
              unit: domainObject.telemetry?.values?.find(v => v.key === "value")?.unit || "",
              status: status,
              subsystem: domainObject.location || "OPERATIONS",
              limit_state: domainObject.limit || null,
              timestamp: telemetryDatum.utc || telemetryDatum.timestamp || new Date().toISOString()
            }
          }, "*");
        }, requestOptions);

        return unsubscribe;
      };
    }

    // Expose openmct instance reference on window for extension content script discovery
    if (typeof window !== "undefined") {
      window.__OPENMCT_INSTANCE__ = openmct;
    }

    console.log("[PriviBrowse-X] OpenMCT Telemetry Bridge Plugin active.");
  };
}
