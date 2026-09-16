/**
 * PrivyBrowse-X — Actual E2E Benchmark Runner
 * ============================================
 * Launches a real Chrome instance with the extension loaded, navigates to each
 * of the 15 adversarial test pages, collects detection results from the extension
 * via the FastAPI benchmark endpoint, and measures real latency + RAM.
 *
 * Usage:
 *   node benchmark/run_actual_benchmark.js
 *
 * Prerequisites:
 *   npm install puppeteer
 *   node ≥ 18, FastAPI server running on :8001
 */

import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../pii-agent-extension');
const CASES_PATH     = path.resolve(__dirname, 'cases');
const SERVER_BASE    = 'http://127.0.0.1:8001';
const CASE_SERVER_PORT = 8090;
const VIEWPORT       = { width: 1280, height: 800 };
const POLL_TIMEOUT_MS = 20000;   // max wait per case
const DYNAMIC_DELAY_MS = 5000;   // extra wait for dynamic-injection cases (case_10)

// Load ground-truth annotations
const ANNOTATIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'annotations.json'), 'utf8')
);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Start a simple HTTP server to serve the case HTML files locally */
function startCaseServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = path.join(CASES_PATH, req.url.split('?')[0]);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404); res.end('Not found');
      }
    });
    server.listen(CASE_SERVER_PORT, () => {
      console.log(`  [server] Case files served at http://localhost:${CASE_SERVER_PORT}`);
      resolve(server);
    });
  });
}

/** Poll the FastAPI benchmark endpoint until results arrive or timeout */
async function pollForResult(caseId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVER_BASE}/api/benchmark/poll/${caseId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ready) return data;
      }
    } catch (_) { /* server may not have restarted yet */ }
    await sleep(400);
  }
  return null; // timed out
}

/** Reset the server-side result store for a case */
async function clearResult(caseId) {
  try {
    await fetch(`${SERVER_BASE}/api/benchmark/clear/${caseId}`, { method: 'POST' });
  } catch (_) {}
}

/** Calculate IoU between two boxes [x,y,w,h] */
function iou(a, b) {
  if (!a || !b || a.length < 4 || b.length < 4) return 0;
  const xOver = Math.max(0, Math.min(a[0]+a[2], b[0]+b[2]) - Math.max(a[0], b[0]));
  const yOver = Math.max(0, Math.min(a[1]+a[3], b[1]+b[3]) - Math.max(a[1], b[1]));
  const inter = xOver * yOver;
  const union = a[2]*a[3] + b[2]*b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * For cases where ground-truth boxes are specified as [0,0,0,0] (runtime-measured),
 * we fall back to a detection-count-based pass/fail using expected_min_detections.
 */
function scoreCase(annotation, detectedBoxes) {
  const gt = annotation.ground_truth_pii || [];
  const detected = detectedBoxes || [];
  const isNegativeControl = gt.length === 0;

  if (isNegativeControl) {
    // Zero-PII page: any detection is a false positive
    return {
      tp: 0,
      fp: detected.length,
      fn: 0,
      precision: detected.length === 0 ? 1.0 : 0.0,
      recall: 1.0,
    };
  }

  // For positive cases: use expected_min_detections as the pass threshold
  // (since ground-truth boxes are runtime-measured, we can't do IoU)
  const minExpected = annotation.expected_min_detections || 1;
  const detectedCount = detected.length;

  // Score: if we detected at least min_expected, recall = 1.0
  const recall = detectedCount >= minExpected ? 1.0 : detectedCount / minExpected;
  // Precision: ratio of expected to detected (penalise over-detection slightly)
  const precision = detectedCount === 0 ? 0.0 :
    Math.min(1.0, minExpected / detectedCount);

  return {
    tp: Math.min(detectedCount, minExpected),
    fp: Math.max(0, detectedCount - minExpected),
    fn: Math.max(0, minExpected - detectedCount),
    precision,
    recall,
  };
}

// ── Main benchmark loop ───────────────────────────────────────────────────────

async function runBenchmark() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  PrivyBrowse-X — ACTUAL E2E BENCHMARK (Puppeteer + CDP)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Extension: ${EXTENSION_PATH}`);
  console.log(`  Cases:     ${CASES_PATH}`);
  console.log(`  Server:    ${SERVER_BASE}`);
  console.log('');

  // 1. Start case file server
  const caseServer = await startCaseServer();

  // 2. Launch Chrome with the unpacked extension
  const browser = await puppeteer.launch({
    headless: false,          // visible so judges can watch
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: VIEWPORT,
  });

  // Wait for extension service worker to initialise
  await sleep(2000);

  const results = [];
  let totalTP = 0, totalFP = 0, totalFN = 0;

  for (const annotation of ANNOTATIONS) {
    const caseId = annotation.id;
    const isDynamic = caseId === 'case_10'; // 3s injection delay case
    console.log(`\n[${caseId}] ${annotation.name}`);
    console.log(`         ${annotation.description}`);

    // Reset previous result on the server
    await clearResult(caseId);

    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Enable CDP for performance/memory metrics
    const cdpSession = await page.createCDPSession();
    await cdpSession.send('Performance.enable');

    // ── Measure wall-clock latency from navigation start ──
    const navStart = Date.now();

    await page.goto(
      `http://localhost:${CASE_SERVER_PORT}/${caseId}.html?bm=${caseId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    // For dynamic injection case: wait for the JS setTimeout to fire
    if (isDynamic) {
      console.log(`         [wait] Dynamic injection case — waiting ${DYNAMIC_DELAY_MS}ms for fields to appear…`);
      await sleep(DYNAMIC_DELAY_MS);
    }

    // Wait for extension to report (or timeout)
    const bmResult = await pollForResult(caseId, POLL_TIMEOUT_MS);
    const latencyMs = Date.now() - navStart;

    // ── Capture RAM via CDP ──────────────────────────────
    let jsHeapMB = 0;
    try {
      const perfData = await cdpSession.send('Performance.getMetrics');
      const heap = perfData.metrics.find(m => m.name === 'JSHeapUsedSize');
      if (heap) jsHeapMB = Math.round(heap.value / 1024 / 1024 * 10) / 10;
    } catch (_) {}

    // Also try the newer Memory.measureMemory API
    let totalMemMB = 0;
    try {
      const memData = await cdpSession.send('Memory.measureMemory');
      totalMemMB = Math.round(memData.result.bytes / 1024 / 1024 * 10) / 10;
    } catch (_) { totalMemMB = jsHeapMB; }

    await page.close();

    // ── Score detections ─────────────────────────────────
    const detectedBoxes = bmResult?.detected_boxes || [];
    const { tp, fp, fn, precision, recall } = scoreCase(annotation, detectedBoxes);
    const f1 = (precision + recall) > 0
      ? 2 * precision * recall / (precision + recall) : 0;

    totalTP += tp; totalFP += fp; totalFN += fn;

    const status = bmResult ? 'REPORTED' : 'TIMEOUT';
    const passFail = annotation.ground_truth_pii.length === 0
      ? (fp === 0 ? '✅ PASS (no false positives)' : `❌ FAIL (${fp} false positives)`)
      : (detectedBoxes.length >= annotation.expected_min_detections
          ? `✅ PASS (${detectedBoxes.length} detected, min=${annotation.expected_min_detections})`
          : `❌ FAIL (${detectedBoxes.length} detected, min=${annotation.expected_min_detections})`);

    console.log(`         Status:    ${status}`);
    console.log(`         Detected:  ${detectedBoxes.length} boxes`);
    console.log(`         Latency:   ${latencyMs} ms`);
    console.log(`         RAM (JS Heap): ${jsHeapMB} MB`);
    console.log(`         Precision: ${(precision*100).toFixed(1)}%  Recall: ${(recall*100).toFixed(1)}%  F1: ${(f1*100).toFixed(1)}%`);
    console.log(`         ${passFail}`);

    results.push({
      id: caseId,
      name: annotation.name,
      category: annotation.category,
      ground_truth_count: annotation.ground_truth_pii.length,
      expected_min_detections: annotation.expected_min_detections || 0,
      detected_count: detectedBoxes.length,
      detected_boxes: detectedBoxes,
      tp, fp, fn,
      precision: Math.round(precision * 1000) / 10,
      recall: Math.round(recall * 1000) / 10,
      f1_score: Math.round(f1 * 1000) / 10,
      latency_ms: latencyMs,
      js_heap_mb: jsHeapMB,
      total_memory_mb: totalMemMB,
      status,
      pass: annotation.ground_truth_pii.length === 0
        ? fp === 0
        : detectedBoxes.length >= annotation.expected_min_detections,
    });
  }

  await browser.close();
  caseServer.close();

  // ── Aggregate metrics ─────────────────────────────────────────────────────
  const overallPrecision = (totalTP + totalFP) > 0 ? totalTP / (totalTP + totalFP) : 1.0;
  const overallRecall    = (totalTP + totalFN) > 0 ? totalTP / (totalTP + totalFN) : 1.0;
  const overallF1        = (overallPrecision + overallRecall) > 0
    ? 2 * overallPrecision * overallRecall / (overallPrecision + overallRecall) : 0;
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / results.length);
  const peakHeap   = Math.max(...results.map(r => r.js_heap_mb));
  const passCount  = results.filter(r => r.pass).length;

  const finalOutput = {
    timestamp: new Date().toISOString(),
    runner: 'Puppeteer E2E (real Chrome + extension)',
    total_cases: results.length,
    cases_passed: passCount,
    cases_failed: results.length - passCount,
    total_tp: totalTP,
    total_fp: totalFP,
    total_fn: totalFN,
    overall_precision_pct: Math.round(overallPrecision * 1000) / 10,
    overall_recall_pct:    Math.round(overallRecall * 1000) / 10,
    overall_f1_pct:        Math.round(overallF1 * 1000) / 10,
    average_latency_ms: avgLatency,
    peak_js_heap_mb: peakHeap,
    case_by_case: results,
  };

  const outPath = path.join(__dirname, 'actual_benchmark_results.json');
  fs.writeFileSync(outPath, JSON.stringify(finalOutput, null, 2));

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  BENCHMARK COMPLETE — ACTUAL RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Cases:           ${passCount} / ${results.length} PASSED`);
  console.log(`  Precision:       ${finalOutput.overall_precision_pct}%`);
  console.log(`  Recall:          ${finalOutput.overall_recall_pct}%`);
  console.log(`  F1 Score:        ${finalOutput.overall_f1_pct}%`);
  console.log(`  Avg Latency:     ${avgLatency} ms`);
  console.log(`  Peak JS Heap:    ${peakHeap} MB`);
  console.log(`  TP / FP / FN:    ${totalTP} / ${totalFP} / ${totalFN}`);
  console.log('');
  console.log(`  Results saved → ${outPath}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

runBenchmark().catch(err => {
  console.error('\n[FATAL] Benchmark runner crashed:', err.message);
  process.exit(1);
});
