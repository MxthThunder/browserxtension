# OpenMCT & Mission Operations Telemetry Simulation Guide
### PriviBrowse-X: Zero-Leakage Privacy Agent for Dynamic Mission Consoles (ISRO PS #26171)

This guide details how to launch and demonstrate the **Mission Operations Telemetry Simulation** with PriviBrowse-X.

---

## 1. Quick Launch: Built-in Mission Operations Console (Recommended)

You don't need to build or install heavy dependencies to test the complete mission operations workflow. A high-fidelity, dark-themed ISRO ISTRAC Mission Operations Console is built right into the server.

### Step 1: Ensure Backend Server is Running
```bash
cd d:\SIH2026\browserxtension\server
python -m uvicorn app:app --port 8001 --reload
```

### Step 2: Open Console in Chrome
Navigate to:
```
http://127.0.0.1:8001/console
```
*(Or open `d:\SIH2026\browserxtension\pii-agent-extension\mission_console.html` directly in your browser)*

### Step 3: Open PriviBrowse-X Extension
1. Click the **PriviBrowse-X** extension icon in your Chrome toolbar.
2. Notice the live floating badge in the top right:
   - Automatically detects and redacts the **Operator Badge** (`Operator A R Venkatesan · USRC/SCI-SE/20911`) and **Internal Network IP** (`MOX-CON-07 · 10.42.7.61`).
3. In the extension popup, enter:
   > *"Check the battery depth of discharge (BAT1_DOD), verify if any excursions breached the soft limit, and inspect the contingency procedure in the documents tab."*
4. Click **Run Autonomous Agent**.

### What Happens:
- **No OCR on Charts**: The agent reads exact parameters (`BAT1_DOD = 12.6%`, `limit = 35.0%`) directly from the structured WebSocket stream.
- **Event-Driven Tab Switching**: When the agent clicks the **Documents** or **Events** tab, the SPA updates routes via client-side hashes (`#documents`). The debounced mutation observer instantly triggers and rescans without full page reloads.
- **Accessible Iframe Exploration**: The agent can inspect and interact with the embedded contingency document inside the same-origin iframe (`FOM-R2A rev 11`).

---

## 2. Integration with Full NASA OpenMCT (`d:\OpenMCT\openmct`)

If you are running the official NASA OpenMCT repository locally:

### Step 1: Install the PriviBrowse Plugin in OpenMCT
Copy `pii-agent-extension/openmct_telemetry_plugin.js` into your OpenMCT plugins folder, or import it into your OpenMCT index file:

```javascript
import { PriviBrowseOpenMCTPlugin } from './openmct_telemetry_plugin.js';

// Install during OpenMCT initialization:
openmct.install(PriviBrowseOpenMCTPlugin({
  streamToWindow: true,
  filterSensors: ['BAT1_DOD', 'BAT1_SOC', 'BUS_V28', 'STR2_STAT', 'RWA3_RPM']
}));
```

### Step 2: Connect to the Telemetry Stream
You can point OpenMCT to our FastAPI WebSocket stream:
```
ws://127.0.0.1:8001/ws/telemetry
```
Every second, the server broadcasts binary/JSON telemetry frames. The plugin receives them, renders them onto OpenMCT's plots, and dispatches them to PriviBrowse-X's `window` message bus.

---

## 3. Architecture Hierarchy Validated in this Demo

```text
Browser Application (OpenMCT / Mission Console SPA)
  │
  ├── [WebSocket Feed (1 Hz)] ──► Pluggable Telemetry Adapter (data_adapter.js)
  │                                 │
  │                                 ▼
  │                               Local Ring Buffer & MSOD Privacy Filter
  │                               (Redacts IP, Operator ID, Coordinates)
  │                                 │
  │                                 ▼
  │                             Sanitized Structured Telemetry Digest
  │                                 │
  └── [In-Place DOM Mutations] ──► Unified Perception Layer (content.js)
                                    │
                                    ▼
                             FastAPI Reasoner (/api/act)
                             [Gemini / Ollama Local Qwen]
                             (Exact Values Cited with Confidence 1.0)
```
