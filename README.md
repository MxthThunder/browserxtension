# 🛡️ Visual Perception Privacy Agent (`browserxtension`)

> **Problem Statement ID:** 26171  
> **Problem Statement Title:** On-Device Visual Perception for Light-weight Browser Agents  
> **Organization:** Indian Space Research Organisation (ISRO) / Department of Space  
> **Category:** Software | **Theme:** Smart Automation  

[![WebGPU](https://img.shields.io/badge/Hardware-WebGPU%20Accelerated-brightgreen)](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Zero-Leakage](https://img.shields.io/badge/Privacy-Zero--Leakage%20Canvas%20Redaction-red)](#zero-leakage-privacy-guarantee)
[![Recall](https://img.shields.io/badge/PII%20Recall-100%25-success)](#official-5-metric-benchmark-results)

---

## 📌 Executive Summary

Modern AI browser agents (Google Gemini Auto Browse, OpenAI Operator, Claude for Chrome, Microsoft Edge Copilot Mode) perform web automation by streaming **unredacted, raw visual screen buffers to centralized cloud servers**. This exposes confidential passwords, financial credentials, Aadhaar/SSN cards, and biometric webcam feeds.

Existing privacy guardrails only sanitize *typed text*, leaving agents completely blind to **visual, on-screen PII**.

**`browserxtension`** is a lightweight, on-device visual perception layer for browser agents. It guarantees that **zero raw pixels ever exit the user's browser boundary** by combining deterministic DOM inspection with an on-device quantized Vision Transformer (`yolos-tiny`) running on **WebGPU**. Sensitive visual regions are permanently obliterated on an offscreen canvas prior to network serialization.

---

## 🏗️ System Architecture & Data Flow

```
+-----------------------------------------------------------------------------------------------+
| CLIENT BROWSER EXTENSION (MANIFEST V3 - ZERO-LEAKAGE BOUNDARY)                                |
|                                                                                               |
|  [Active Web Tab]                                                                             |
|         │                                                                                     |
|         ├── (1) Viewport Screenshot ────────┐                                                 |
|         │                                   ▼                                                 |
|         └── (2) DOM PII Scanner ───► [Offscreen Canvas & WebGPU Engine]                       |
|                 (Passwords, Cards,         │                                                  |
|                  Aadhaar/SSN, ARIA)        ├─► Local Vision Model (yolos-tiny on WebGPU)      |
|                                            │   - Detects person & computes ~30% face proxy    |
|                                            ▼                                                  |
|                                     [Canvas Blackout Redaction]                               |
|                                            │                                                  |
|                                            ▼                                                  |
|                        Sanitized Context Payload (0 Raw Pixels)                               |
+────────────────────────────────────────────┼──────────────────────────────────────────────────+
                                             │ POST /api/act (HTTP)
                                             ▼
+───────────────────────────────────────────────────────────────────────────────────────────────+
| CENTRALIZED VLM REASONING SERVER (FASTAPI)                                                    |
|                                                                                               |
|   Receives: Sanitized Visual Frame + DOM Element Digest + User Task Instruction               |
|   Reasoning Engine: Redaction-aware VLM (Gemini / OpenAI / Ollama / Semantic Reasoner)        |
|   Output: Structured Action JSON -> { "type": "click", "selector": "#submitBtn" }             |
+────────────────────────────────────────────┬──────────────────────────────────────────────────+
                                             │ Action JSON
                                             ▼
                                     [Client DOM Executor]
                              Synthesizes native click/type event
                      on target element with animated action indicator
```

---

## 📊 Official 5-Metric Benchmark Results (ISRO PS #26171)

Rigorously benchmarked across **15 labeled evaluation scenarios** (login forms, checkout flows, medical intake, webcam streams, tax statements, and negative control pages):

| Evaluation Criterion | Official Weight | Measured Score | Status & Verification |
| :--- | :---: | :---: | :--- |
| **1. Accuracy of Visual Context** | **25%** | **96.5%** | ViT detector (80 COCO classes) + DOM structural digest |
| **2. Sensitive/PII Recall & Precision** | **20%** | **100% Recall / 96.97% Precision** | **Zero missed sensitive targets** ($F_1$: **98.46%**) |
| **3. Precision of Redaction** | **20%** | **0.94 Mean IoU** | Solid canvas-level blackout; 100% zero-leakage verified |
| **4. Client Resource Utilization** | **20%** | **48.5 MB Peak RAM** | Model: **5.9 MB**, WebGPU utilization: **~24%**, CPU: **~11%** |
| **5. Overall End-to-End Latency** | **15%** | **504.8 ms** (Warm) | Total round-trip cycle: **~0.5 seconds** |

### Latency Waterfall Breakdown

```
DOM PII Scan               :   3.8 ms  ( 1%)
Viewport Screen Capture    :  16.4 ms  ( 3%)
WebGPU Vision Inference    : 462.0 ms  (91%)  [Cold start: 2365 ms]
Canvas Redaction Paint     :   6.5 ms  ( 1%)
Server Network Round-Trip  :  11.2 ms  ( 2%)
Server VLM Reasoning       :   0.12 ms ( 0%)
Client DOM Action Dispatch :   4.8 ms  ( 1%)
------------------------------------------------
TOTAL END-TO-END LATENCY   : 504.8 ms
```

---

## 📁 Repository Structure

```
browserxtension/
├── pii-agent-extension/          # Manifest V3 Extension Core
│   ├── manifest.json             # Extension permissions & CSP configuration
│   ├── background.js             # Service worker: capture bus & closed-loop agent dispatcher
│   ├── content.js                # DOM PII scanner (3-tier) & action executor (green pulse indicator)
│   ├── offscreen.html & .js      # Offscreen WebGPU inference pipeline & canvas redactor
│   ├── hud.html, .js, .css       # Live Side-by-Side Dual Viewport Telemetry Dashboard
│   ├── popup.html & .js          # Quick launcher popup
│   ├── demo.html & photo         # Mock banking KYC portal (with live webcam toggle)
│   └── lib/                      # Bundled Transformers.js & ONNX WebGPU runtime binaries
│
├── server/                       # Centralized VLM Reasoning Backend
│   ├── app.py                    # FastAPI server on http://127.0.0.1:8001/api/act
│   └── requirements.txt          # Python dependencies (fastapi, uvicorn, pydantic)
│
├── benchmark/                    # Benchmark & Profiling Suite
│   ├── annotations.json          # 15 Ground-truth benchmark test cases (32 targets)
│   ├── evaluate.py               # Automated rubric profiler
│   └── benchmark_results.json    # JSON audit dataset
│
└── presentation/                 # Presentation & Pitch Assets
    ├── pitch_deck.html           # Interactive 6-slide presentation deck
    └── PITCH_SCRIPT.md           # 5-minute pitch script & Judge Q&A defense guide
```

---

## 🚀 Quick Start Guide

### 1. Start the Local Web & VLM Servers
```bash
# Terminal 1: Start the FastAPI VLM Reasoning Backend
cd server
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8001

# Terminal 2: Serve the Extension Pages & Demo Target
cd pii-agent-extension
python -m http.server 8000
```

### 2. Load the Extension in Chrome
1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle on **Developer mode** in the top right.
3. Click **Load unpacked** and select the `pii-agent-extension/` directory.

### 3. Experience the Live Demo
1. Open [`http://localhost:8000/demo.html`](http://localhost:8000/demo.html) (Target KYC portal).
2. Open [`http://localhost:8000/hud.html`](http://localhost:8000/hud.html) (Side-by-Side HUD).
3. Observe:
   - **Left Viewport**: Raw client memory (never leaves machine).
   - **Right Viewport**: Sanitized frame with sensitive form fields and biometric face blacked out.
4. Click **"🚀 Send Sanitized Screen to Server & Execute"** to watch the server VLM make a decision and trigger an action pulse on the live demo page!
5. Click **"📊 Rubric & Benchmark Metrics"** to inspect the 5 evaluation criteria and latency waterfall.
6. Open [`http://localhost:8000/pitch_deck.html`](http://localhost:8000/pitch_deck.html) to present the interactive slide deck.

---

## ⚖️ Engineering Defense & FAQ

- **Q: Why the ~30% Face Proxy instead of a separate face detector?**  
  *A: Standard lightweight ViT detectors detect 80 COCO classes with a tiny 5.9MB footprint. Adding a secondary dedicated face model would double RAM and latency. The upper ~30% vertical slice of detected person boxes provides an instant zero-latency face shield with zero extra weight (100% recall on tested faces).*

- **Q: What if WebGPU is not supported on a user's machine?**  
  *A: Automated dual-runtime architecture. If WebGPU is supported, inference takes ~460ms. If running on older hardware or restricted machines, it automatically falls back to WASM SIMD without crashing.*

---

## 📜 License & Acknowledgements
Built for the **Smart India Hackathon / ISRO Problem Statement #26171**.
Distributed under the MIT License.
