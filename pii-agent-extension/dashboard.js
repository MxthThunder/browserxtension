/**
 * Privacy Agent — Analytics Dashboard Controller
 * Pure client-side SVG rendering, zero external CDNs, air-gapped security.
 */

import {
  getSettings,
  saveSettings,
  getAuditLogs,
  clearAuditLogs,
  getPipelineTraces,
  clearPipelineTraces,
} from "./storage.js";

const btnTheme = document.getElementById("btnTheme");
const btnOpenOptions = document.getElementById("btnOpenOptions");

const svgDonut = document.getElementById("svgDonut");
const donutLegend = document.getElementById("donutLegend");
const donutTotalCount = document.getElementById("donutTotalCount");
const pillTotalEntities = document.getElementById("pillTotalEntities");

const metricTotalShielded = document.getElementById("metricTotalShielded");
const metricAssuranceRate = document.getElementById("metricAssuranceRate");
const metricAvgLatency = document.getElementById("metricAvgLatency");
const metricQwenDecisions = document.getElementById("metricQwenDecisions");

const lblWebGPUStatus = document.getElementById("lblWebGPUStatus");
const lblQwenStatus = document.getElementById("lblQwenStatus");

const auditTableBody = document.getElementById("auditTableBody");
const btnRefresh = document.getElementById("btnRefresh");
const btnRefreshLabel = document.getElementById("btnRefreshLabel");
const btnExportLogs = document.getElementById("btnExportLogs");
const btnClearLogs = document.getElementById("btnClearLogs");

let currentTheme = "dark";

// Validated non-blue categorical palette (dataviz-checked: CVD-safe adjacency,
// >=3:1 contrast on the dark surface). Order matters — do not reshuffle without
// re-validating adjacency.
const CATEGORY_COLORS = {
  govIds:      { label: "Identity & Gov IDs",   color: "var(--cat-1)" },
  screens:     { label: "Screens & Displays",   color: "var(--cat-2)" },
  creditCards: { label: "Financial & Cards",    color: "var(--cat-3)" },
  contactInfo: { label: "Contact & Addresses",  color: "var(--cat-4)" },
  faces:       { label: "Faces & Biometrics",   color: "var(--cat-5)" },
  passwords:   { label: "Passwords & Tokens",   color: "var(--cat-6)" },
  other:       { label: "Other",                color: "var(--text-3)" },
};

// Detectors also emit `opsSecurity`, `input` and `unknown`; they roll into
// "other" rather than being silently miscounted as contact info.
const KNOWN_CATEGORIES = Object.keys(CATEGORY_COLORS);

// Perception layers, in pipeline order.
const LAYERS = ["DOM", "OWL-ViT", "MediaPipe-Face", "OCR"];

const LAYER_LABELS = {
  "DOM": "DOM scanner",
  "OWL-ViT": "OWL-ViT zero-shot",
  "MediaPipe-Face": "BlazeFace detector",
  "OCR": "Tesseract OCR",
};

let devMode = false;

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await getSettings();
  currentTheme = settings.theme || "dark";
  applyTheme(currentTheme);
  devMode = Boolean(settings.devMode);
  applyDevMode(devMode);

  // Hardware probing runs independently — never let a stalled GPU/Ollama
  // probe hold up the metrics, chart and audit table below.
  probeHardware();
  await loadDashboardData();
  setupEventListeners();
});

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);
}

function applyDevMode(enabled) {
  devMode = enabled;
  document.documentElement.setAttribute("data-devmode", enabled ? "on" : "off");
  const btn = document.getElementById("btnDevMode");
  if (btn) {
    btn.classList.toggle("active", enabled);
    btn.setAttribute("aria-pressed", String(enabled));
  }
}

function resolveVar(cssVar) {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar.match(/--[\w-]+/)[0]).trim();
}

async function probeHardware() {
  if (navigator.gpu) {
    try {
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200)),
      ]);
      if (adapter) {
        lblWebGPUStatus.textContent = "Active · hardware accelerated";
        lblWebGPUStatus.className = "stack-status green";
      } else {
        lblWebGPUStatus.textContent = "WASM fallback (no GPU adapter)";
        lblWebGPUStatus.className = "stack-status muted";
      }
    } catch {
      lblWebGPUStatus.textContent = "WASM fallback mode";
      lblWebGPUStatus.className = "stack-status muted";
    }
  } else {
    lblWebGPUStatus.textContent = "WASM engine (WebGPU unavailable)";
    lblWebGPUStatus.className = "stack-status muted";
  }

  // Probe local Ollama availability
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || []).map((m) => (m.name || "").toLowerCase());
      const hasCustom = models.some((m) => m.includes("isro-privacy-qwen"));
      const has15b = models.some((m) => m.includes("1.5b"));
      if (hasCustom) {
        lblQwenStatus.textContent = "Connected · ISRO-tuned model active";
      } else if (has15b) {
        lblQwenStatus.textContent = "Connected · Qwen2.5 1.5B active";
      } else {
        lblQwenStatus.textContent = "Connected · Qwen2.5 0.5B active";
      }
      lblQwenStatus.className = "stack-status green";
    } else {
      lblQwenStatus.textContent = "Fastpath semantic fallback active";
      lblQwenStatus.className = "stack-status muted";
    }
  } catch {
    lblQwenStatus.textContent = "Fastpath semantic reasoner active";
    lblQwenStatus.className = "stack-status muted";
  }
}

async function loadDashboardData() {
  const sessionPromise = typeof chrome !== "undefined" && chrome.runtime
    ? chrome.runtime.sendMessage({ type: "GET_AGENT_SESSION_STATE" }).catch(() => ({ ok: false }))
    : Promise.resolve({ ok: false });

  const [logs, traces, sessionResp] = await Promise.all([
    getAuditLogs(),
    getPipelineTraces(),
    sessionPromise,
  ]);

  const session = sessionResp?.session || {};
  const stats = aggregateTraces(traces, logs, session);

  metricTotalShielded.textContent = stats.totalShielded;
  metricAssuranceRate.textContent = stats.assuranceRate;
  metricAvgLatency.textContent = stats.avgLatencyMs === null ? "—" : `${stats.avgLatencyMs} ms`;
  metricQwenDecisions.textContent = stats.qwenDecisions;
  pillTotalEntities.textContent = `${stats.totalShielded} total`;

  renderDonutChart(stats.categoryCounts, stats.totalShielded);
  renderPipelineLatency(stats.latestTimings);
  renderLayerAttribution(stats.layerCounts, stats.layerLatency);
  renderReasoningAttribution(stats.providers);
  renderAuditTable(logs, traces);
}

/**
 * Rolls stored traces up into everything the dashboard displays.
 *
 * Traces are the source of truth. The audit log is a fallback for installs that
 * have history from before tracing existed, and the live session supplies the
 * most recent capture when it has not been written to a trace yet.
 */
function aggregateTraces(traces, logs, session) {
  const categoryCounts = {};
  const layerCounts = {};
  const layerTotalMs = {};
  const providers = {};

  let totalShielded = 0;
  let qwenDecisions = 0;
  let latencySum = 0;
  let latencySamples = 0;
  let guardBlocks = 0;
  let framesWithGuard = 0;

  for (const trace of traces) {
    totalShielded += trace.redactions || 0;

    if (typeof trace.latencyMs === "number" && trace.latencyMs > 0) {
      latencySum += trace.latencyMs;
      latencySamples++;
    }

    const counts = trace.perception?.counts || {};
    for (const [layer, n] of Object.entries(counts)) {
      layerCounts[layer] = (layerCounts[layer] || 0) + n;
    }

    const categories = trace.perception?.categories || {};
    for (const [rawCategory, n] of Object.entries(categories)) {
      const key = KNOWN_CATEGORIES.includes(rawCategory) ? rawCategory : "other";
      categoryCounts[key] = (categoryCounts[key] || 0) + n;
    }

    const timings = trace.perception?.timings || {};
    accumulateLayerMs(layerTotalMs, timings);

    const guard = trace.perception?.guard;
    if (guard) {
      framesWithGuard++;
      if (guard.emergencyBlackout) guardBlocks++;
    }

    if (trace.qwen?.invoked) {
      qwenDecisions += trace.qwen.decisions?.length || 0;
    }

    const provider = trace.reasoning?.provider;
    if (provider) {
      const bucket = providers[provider] || (providers[provider] = {
        provider, modelId: null, steps: 0, latencySum: 0, latencySamples: 0, failures: 0,
      });
      bucket.steps++;
      bucket.modelId = trace.reasoning.modelId || bucket.modelId;
      const serverMs = trace.reasoning.serverLatencyMs;
      if (typeof serverMs === "number") {
        bucket.latencySum += serverMs;
        bucket.latencySamples++;
      }
      for (const attempt of trace.reasoning.attempts || []) {
        if (attempt.ok === false) {
          const failed = providers[attempt.provider] || (providers[attempt.provider] = {
            provider: attempt.provider, modelId: attempt.modelId || null,
            steps: 0, latencySum: 0, latencySamples: 0, failures: 0,
          });
          failed.failures++;
        }
      }
    }
  }

  // Pre-trace history: fall back to the audit log for totals only.
  if (traces.length === 0) {
    for (const entry of logs) {
      totalShielded += entry.redactions ?? entry.redactionsCount ?? 0;
      if (entry.latencyMs) {
        latencySum += entry.latencyMs;
        latencySamples++;
      }
    }
  }

  // The live session may hold a capture newer than the newest trace.
  const liveManifest = session.latestCapture?.redactionList;
  if (traces.length === 0 && Array.isArray(liveManifest)) {
    for (const box of liveManifest) {
      const raw = box.category || "other";
      const key = KNOWN_CATEGORIES.includes(raw) ? raw : "other";
      categoryCounts[key] = (categoryCounts[key] || 0) + 1;
      for (const layer of (box.sources?.length ? box.sources : [box.source])) {
        if (layer) layerCounts[layer] = (layerCounts[layer] || 0) + 1;
      }
    }
  }

  const layerLatency = {};
  for (const [layer, total] of Object.entries(layerTotalMs)) {
    layerLatency[layer] = traces.length ? Math.round(total / traces.length) : null;
  }

  return {
    totalShielded,
    categoryCounts,
    layerCounts,
    layerLatency,
    providers: Object.values(providers),
    qwenDecisions,
    avgLatencyMs: latencySamples > 0 ? Math.round(latencySum / latencySamples) : null,
    // Honest: every frame that shipped was fully sanitized unless the guard
    // reported an emergency blackout, and "unknown" until a frame is seen.
    assuranceRate: framesWithGuard === 0
      ? (traces.length ? "100%" : "—")
      : `${Math.round(((framesWithGuard - guardBlocks) / framesWithGuard) * 100)}%`,
    latestTimings: traces[0]?.perception?.timings
      || session.latestCapture?.timings
      || null,
  };
}

function accumulateLayerMs(acc, timings) {
  const map = {
    "DOM": (timings.domScanMs || 0) + (timings.domMapMs || 0),
    "OWL-ViT": timings.owlvitMs || 0,
    "MediaPipe-Face": timings.faceMs || 0,
    "OCR": timings.ocrLatencyMs || 0,
  };
  for (const [layer, ms] of Object.entries(map)) {
    acc[layer] = (acc[layer] || 0) + ms;
  }
}

function renderDonutChart(categoryCounts, totalCount) {
  const radius = 80;
  const circumference = 2 * Math.PI * radius;

  svgDonut.querySelectorAll(".donut-slice").forEach((el) => el.remove());
  donutLegend.innerHTML = "";

  donutTotalCount.textContent = totalCount;

  let cumulativePercent = 0;

  Object.entries(categoryCounts).forEach(([catKey, count]) => {
    if (count <= 0) return;
    const info = CATEGORY_COLORS[catKey] || { label: catKey, color: "var(--text-3)" };
    const resolvedColor = resolveVar(info.color);
    const pct = count / totalCount;
    const strokeDash = pct * circumference;
    const strokeOffset = -(cumulativePercent * circumference);

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "120");
    circle.setAttribute("cy", "120");
    circle.setAttribute("r", String(radius));
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", resolvedColor);
    circle.setAttribute("stroke-width", "28");
    circle.setAttribute("stroke-dasharray", `${strokeDash.toFixed(2)} ${circumference.toFixed(2)}`);
    circle.setAttribute("stroke-dashoffset", strokeOffset.toFixed(2));
    circle.setAttribute("class", "donut-slice");

    const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
    titleEl.textContent = `${info.label}: ${count} (${Math.round(pct * 100)}%)`;
    circle.appendChild(titleEl);

    svgDonut.appendChild(circle);

    const legendItem = document.createElement("div");
    legendItem.className = "legend-item";
    legendItem.innerHTML = `
      <div class="legend-label-group">
        <span class="legend-color-dot" style="background-color: ${resolvedColor}"></span>
        <span>${info.label} (${count})</span>
      </div>
      <span class="legend-pct">${Math.round(pct * 100)}%</span>
    `;
    donutLegend.appendChild(legendItem);

    cumulativePercent += pct;
  });
}

/**
 * Replaces what used to be five hardcoded latency bars in the markup with the
 * measured per-stage timings from the most recent trace.
 */
function renderPipelineLatency(timings) {
  const container = document.getElementById("pipelineBars");
  const totalLabel = document.getElementById("lblTotalPipelineLatency");
  if (!container) return;

  if (!timings) {
    container.innerHTML = `<p class="muted-note">No capture recorded yet — run a capture to measure the pipeline.</p>`;
    if (totalLabel) totalLabel.textContent = "no data";
    return;
  }

  const stages = [
    ["DOM scan", (timings.domScanMs || 0) + (timings.domMapMs || 0)],
    ["OWL-ViT zero-shot", timings.owlvitMs || 0],
    ["BlazeFace detection", timings.faceMs || 0],
    ["Tesseract OCR", timings.ocrLatencyMs || 0],
    ["Non-max suppression", timings.nmsMs || 0],
    ["Canvas redaction", timings.paintLatencyMs || 0],
  ].filter(([, ms]) => ms > 0);

  if (stages.length === 0) {
    container.innerHTML = `<p class="muted-note">No per-stage timings in the latest capture.</p>`;
    if (totalLabel) totalLabel.textContent = "no data";
    return;
  }

  const slowest = Math.max(...stages.map(([, ms]) => ms));
  container.innerHTML = stages.map(([label, ms]) => `
    <div class="waterfall-row">
      <div class="bar-meta">
        <span class="bar-title">${escapeHtml(label)}</span>
        <span class="bar-val">${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (ms / slowest) * 100)}%"></div></div>
    </div>
  `).join("");

  if (totalLabel) {
    const total = timings.totalRedactionLatencyMs || 0;
    totalLabel.textContent = `${Math.round(total)} ms total`;
  }
}

/**
 * Which perception layer actually caught the PII.
 */
function renderLayerAttribution(layerCounts, layerLatency) {
  const container = document.getElementById("layerAttribution");
  if (!container) return;

  const rows = LAYERS
    .map((layer) => ({ layer, count: layerCounts[layer] || 0, ms: layerLatency[layer] }))
    .filter((r) => r.count > 0 || (r.ms !== null && r.ms !== undefined && r.ms > 0));

  if (rows.length === 0) {
    container.innerHTML = `<p class="muted-note">No detections recorded yet.</p>`;
    return;
  }

  const most = Math.max(...rows.map((r) => r.count), 1);
  container.innerHTML = rows.map((r) => `
    <div class="waterfall-row">
      <div class="bar-meta">
        <span class="bar-title">${escapeHtml(LAYER_LABELS[r.layer] || r.layer)}</span>
        <span class="bar-val">${r.count}${r.ms ? ` · ${r.ms} ms` : ""}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (r.count / most) * 100)}%"></div></div>
    </div>
  `).join("");
}

/**
 * Which reasoning model answered, and which ones failed on the way there.
 */
function renderReasoningAttribution(providers) {
  const container = document.getElementById("reasoningAttribution");
  if (!container) return;

  if (!providers || providers.length === 0) {
    container.innerHTML = `<p class="muted-note">No agent steps recorded yet — run a task to see model attribution.</p>`;
    return;
  }

  container.innerHTML = providers.map((p) => {
    const mean = p.latencySamples ? Math.round(p.latencySum / p.latencySamples) : null;
    const served = p.steps > 0;
    const detail = served
      ? `${p.modelId ? escapeHtml(p.modelId) + " · " : ""}${p.steps} step${p.steps === 1 ? "" : "s"}${mean ? ` · ${mean} ms mean` : ""}`
      : `${p.failures} failed attempt${p.failures === 1 ? "" : "s"}`;

    return `
      <div class="stack-item">
        <div class="stack-info">
          <span class="stack-name">${escapeHtml(p.provider)}</span>
          <span class="stack-status ${served ? "green" : "muted"}">${detail}</span>
        </div>
        <span class="status-dot ${served ? "on" : "off"}"></span>
      </div>
    `;
  }).join("");
}

function renderAuditTable(logs = [], traces = []) {
  auditTableBody.innerHTML = "";

  if (!logs || logs.length === 0) {
    auditTableBody.innerHTML = `
      <tr><td colspan="7" class="empty-state">No audit logs recorded yet. Start an agent task to view live compliance events.</td></tr>
    `;
    return;
  }

  const tracesById = new Map(traces.map((t) => [t.traceId, t]));

  logs.slice(0, 50).forEach((entry) => {
    const row = document.createElement("tr");
    const trace = entry.traceId ? tracesById.get(entry.traceId) : null;

    const timeStr = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "--";
    const taskStr = (entry.task || "Visual redaction step").substring(0, 36);
    const actionStr = entry.actionType || "DOM sanitize";
    const modelStr = entry.modelId || entry.model || "Local heuristics";
    const redactions = entry.redactions !== undefined
      ? `${entry.redactions} items`
      : `${entry.redactionsCount ?? 0} items`;
    const latencyStr = entry.latencyMs ? `${entry.latencyMs} ms` : "--";

    row.innerHTML = `
      <td class="cell-mono">${timeStr}</td>
      <td>${escapeHtml(taskStr)}</td>
      <td><span class="badge-pill neutral">${escapeHtml(actionStr)}</span></td>
      <td>${escapeHtml(modelStr)}</td>
      <td><span class="badge-pill success">${redactions}</span></td>
      <td class="cell-mono">${latencyStr}</td>
      <td><span class="badge-pill success">Shielded</span></td>
    `;
    auditTableBody.appendChild(row);

    if (devMode && trace) {
      auditTableBody.appendChild(buildTraceDetailRow(trace));
    }
  });
}

/**
 * Developer-mode expansion under an audit row: provider attempts and the
 * per-element verdicts the local reasoner returned for that step.
 */
function buildTraceDetailRow(trace) {
  const row = document.createElement("tr");
  row.className = "trace-detail-row";

  const attempts = trace.reasoning?.attempts || [];
  const attemptsHtml = attempts.length
    ? attempts.map((a) => `
        <li><span class="${a.ok ? "ok" : "fail"}">${escapeHtml(a.provider)}</span>
        ${a.modelId ? escapeHtml(a.modelId) : ""} — ${a.ok ? "served" : escapeHtml(a.error || "failed")}
        ${a.latencyMs ? ` (${a.latencyMs} ms)` : ""}</li>`).join("")
    : `<li class="muted-note">No provider attempt log for this step.</li>`;

  const qwen = trace.qwen;
  const qwenHtml = qwen?.invoked
    ? `
      <p class="trace-sub">Trigger: ${escapeHtml(qwen.trigger || "—")} ·
         ${qwen.candidateCount} candidate${qwen.candidateCount === 1 ? "" : "s"} ·
         batch ${qwen.batchSize} · ${qwen.latencyMs} ms ·
         ${escapeHtml(qwen.engine || "—")}${qwen.timedOut ? " · timed out → fastpath" : ""}</p>
      <ul class="trace-list">
        ${(qwen.decisions || []).map((d) => `
          <li><code>${escapeHtml(String(d.elementId))}</code> →
          <strong>${escapeHtml(d.decision || "—")}</strong>
          ${d.reason ? ` — ${escapeHtml(d.reason)}` : ""}</li>`).join("")}
      </ul>`
    : `<p class="trace-sub muted-note">Local reasoner not invoked for this step.</p>`;

  row.innerHTML = `
    <td colspan="7">
      <div class="trace-detail">
        <div>
          <span class="trace-heading">Provider attempts</span>
          <ul class="trace-list">${attemptsHtml}</ul>
        </div>
        <div>
          <span class="trace-heading">Local reasoner (Qwen)</span>
          ${qwenHtml}
        </div>
      </div>
    </td>
  `;
  return row;
}

function setupEventListeners() {
  btnTheme.addEventListener("click", async () => {
    const next = currentTheme === "dark" ? "light" : "dark";
    applyTheme(next);
    await saveSettings({ theme: next });
    await loadDashboardData();
  });

  btnOpenOptions.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  const btnDevMode = document.getElementById("btnDevMode");
  if (btnDevMode) {
    btnDevMode.addEventListener("click", async () => {
      applyDevMode(!devMode);
      await saveSettings({ devMode });
      await loadDashboardData();
    });
  }

  const btnClearTraces = document.getElementById("btnClearTraces");
  if (btnClearTraces) {
    btnClearTraces.addEventListener("click", async () => {
      if (confirm("Clear all developer pipeline traces?")) {
        await clearPipelineTraces();
        await loadDashboardData();
      }
    });
  }

  const btnExportTraces = document.getElementById("btnExportTraces");
  if (btnExportTraces) {
    btnExportTraces.addEventListener("click", async () => {
      const traces = await getPipelineTraces();
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(traces, null, 2));
      const anchor = document.createElement("a");
      anchor.setAttribute("href", dataStr);
      anchor.setAttribute("download", `privacy_agent_traces_${Date.now()}.json`);
      anchor.click();
    });
  }

  btnRefresh.addEventListener("click", async () => {
    btnRefresh.disabled = true;
    btnRefreshLabel.textContent = "Refreshing…";
    await loadDashboardData();
    setTimeout(() => {
      btnRefreshLabel.textContent = "Refresh";
      btnRefresh.disabled = false;
    }, 400);
  });

  btnExportLogs.addEventListener("click", async () => {
    const logs = await getAuditLogs();
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(logs, null, 2));
    const dlAnchor = document.createElement("a");
    dlAnchor.setAttribute("href", dataStr);
    dlAnchor.setAttribute("download", `privacy_agent_audit_${Date.now()}.json`);
    dlAnchor.click();
  });

  btnClearLogs.addEventListener("click", async () => {
    if (confirm("Clear the audit stream?")) {
      await clearAuditLogs();
      await loadDashboardData();
    }
  });
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[m]));
}
