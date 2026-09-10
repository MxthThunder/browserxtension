/**
 * Privacy Agent — Dashboard & Analytics controller
 * Pure client-side SVG rendering, zero external CDNs, air-gapped.
 *
 * Every panel is driven by data that is actually persisted (`auditLogs`,
 * `devTraces`). Nothing here synthesises a series — a panel with no data
 * renders its own empty state instead.
 */

import {
  getSettings,
  saveSettings,
  getAuditLogs,
  clearAuditLogs,
  getPipelineTraces,
  clearPipelineTraces,
} from "./storage.js";
import { vault } from "./vault.js";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";

let currentTheme = "dark";
let devMode = false;
let activePane = "dashboard";
let lastStats = null;   // kept so a tab switch or resize can redraw without refetching

/* ── Palette ──────────────────────────────────────────────────────────────
   Six categorical slots, one fixed category each. Colour follows the entity,
   never its rank, so these bindings must not be reassigned by sort order.
   `screens` and every detector-only bucket (opsSecurity, input, unknown,
   image-region) fold into "Other": there are six validated slots and folding
   the tail is the prescribed move, versus inventing a seventh hue that would
   be indistinguishable under CVD. */
const CATEGORY_COLORS = {
  govIds:      { label: "Identity & gov IDs",  color: "var(--cat-1)" },
  creditCards: { label: "Financial & cards",   color: "var(--cat-2)" },
  contactInfo: { label: "Contact & addresses", color: "var(--cat-3)" },
  passwords:   { label: "Passwords & tokens",  color: "var(--cat-4)" },
  faces:       { label: "Faces & biometrics",  color: "var(--cat-5)" },
  names:       { label: "Person names",        color: "var(--cat-6)" },
  other:       { label: "Other",               color: "var(--text-3)" },
};
const KNOWN_CATEGORIES = Object.keys(CATEGORY_COLORS);

const LAYERS = ["DOM", "OWL-ViT", "MediaPipe-Face", "OCR", "Ollama"];
const LAYER_LABELS = {
  "DOM": "DOM scanner",
  "OWL-ViT": "OWL-ViT zero-shot",
  "MediaPipe-Face": "BlazeFace detector",
  "OCR": "Tesseract OCR",
  "Ollama": "Local reasoner (G3)",
};
const LAYER_COLORS = {
  "DOM": "var(--cat-1)",
  "OWL-ViT": "var(--cat-2)",
  "MediaPipe-Face": "var(--cat-3)",
  "OCR": "var(--cat-4)",
  "Ollama": "var(--cat-5)",
};

/* Every measured stage in `timings`, in pipeline order. The old dashboard
   plotted six of these; the rest were recorded and never shown. */
const PIPELINE_STAGES = [
  ["Image load",          (t) => t.imageLoadMs],
  ["DOM scan",            (t) => (t.domScanMs || 0) + (t.domMapMs || 0)],
  ["OWL-ViT zero-shot",   (t) => t.owlvitMs],
  ["BlazeFace detection", (t) => t.faceMs],
  ["Tesseract OCR",       (t) => t.ocrLatencyMs],
  ["Name disambiguation (G3)", (t) => t.g3Ms],
  ["Non-max suppression", (t) => t.nmsMs],
  ["Canvas redaction",    (t) => t.paintLatencyMs],
  ["Zero-leakage guard",  (t) => t.guardMs],
];

/* ── Formatting ───────────────────────────────────────────────────────── */

/** Single source of truth for millisecond display — was duplicated inline. */
function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "—";
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

/** SVG needs a literal colour; `var(--x)` in a stroke attribute does nothing. */
function resolveVar(cssVar) {
  const name = cssVar.match(/--[\w-]+/);
  if (!name) return cssVar;
  return getComputedStyle(document.documentElement).getPropertyValue(name[0]).trim();
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Sizes an SVG to its own box and clears it. Charts draw in real pixel
 * coordinates, so text and markers never stretch.
 * Returns null when the element is not laid out yet (e.g. inside a hidden pane).
 */
function prepSvg(svg) {
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w < 2 || h < 2) return null;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.replaceChildren();
  return { w, h };
}

function toggleEmpty(id, isEmpty) {
  const node = $(id);
  if (node) node.classList.toggle("hidden", !isEmpty);
}

/* ── Tooltip ──────────────────────────────────────────────────────────── */

const tipEl = $("chartTip");

function showTip(html, evt) {
  if (!tipEl) return;
  tipEl.innerHTML = html;
  tipEl.classList.add("show");
  tipEl.setAttribute("aria-hidden", "false");
  moveTip(evt);
}

function moveTip(evt) {
  if (!tipEl) return;
  const pad = 14;
  const box = tipEl.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + box.width > window.innerWidth - 8) x = evt.clientX - box.width - pad;
  if (y + box.height > window.innerHeight - 8) y = evt.clientY - box.height - pad;
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${Math.max(8, y)}px`;
}

function hideTip() {
  if (!tipEl) return;
  tipEl.classList.remove("show");
  tipEl.setAttribute("aria-hidden", "true");
}

function tipRow(color, label, value) {
  return `<span class="tip-row"><i style="background:${color}"></i>${escapeHtml(label)} <b>${escapeHtml(value)}</b></span>`;
}

/* ── Chart primitives ─────────────────────────────────────────────────── */

/**
 * Line or area chart for one series, with a crosshair + nearest-point tooltip.
 * One series only, so it carries no legend — the card title names it.
 */
function drawSeries(svg, points, { color, area = false, fmt = fmtInt, emptyId }) {
  const box = prepSvg(svg);
  if (!box) return;
  if (!points.length) { toggleEmpty(emptyId, true); return; }
  toggleEmpty(emptyId, false);

  const padL = 38, padR = 10, padT = 12, padB = 22;
  const { w, h } = box;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  if (plotW < 10 || plotH < 10) return;

  const values = points.map((p) => p.value);
  const rawMax = Math.max(...values);
  const max = rawMax > 0 ? rawMax * 1.15 : 1;
  const stroke = resolveVar(color);

  const xAt = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => padT + plotH - (v / max) * plotH;

  // Horizontal grid + y labels (4 ticks is enough to orient without clutter)
  for (let t = 0; t <= 3; t++) {
    const v = (max / 3) * t;
    const y = yAt(v);
    svg.appendChild(svgEl("line", { x1: padL, y1: y, x2: w - padR, y2: y, class: "grid-line" }));
    const label = svgEl("text", { x: padL - 6, y: y + 3, class: "axis-text", "text-anchor": "end" });
    label.textContent = rawMax > 0 ? Math.round(v) : "0";
    svg.appendChild(label);
  }

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(" ");

  if (area) {
    const fill = `${line} L${xAt(points.length - 1).toFixed(1)},${padT + plotH} L${xAt(0).toFixed(1)},${padT + plotH} Z`;
    svg.appendChild(svgEl("path", { d: fill, fill: stroke, class: "series-area" }));
  }

  const path = svgEl("path", { d: line, stroke, class: "series-line" });
  svg.appendChild(path);

  // Draw-in: dash the whole length, then release it.
  const len = path.getTotalLength?.() || 0;
  if (len && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    path.setAttribute("data-draw", "");
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    path.getBoundingClientRect();
    path.style.transition = "stroke-dashoffset 760ms var(--ease)";
    path.style.strokeDashoffset = "0";
  }

  // X labels: first and last only — every tick would collide at this width.
  const firstLab = svgEl("text", { x: padL, y: h - 6, class: "axis-text" });
  firstLab.textContent = points[0].label;
  svg.appendChild(firstLab);
  if (points.length > 1) {
    const lastLab = svgEl("text", { x: w - padR, y: h - 6, class: "axis-text", "text-anchor": "end" });
    lastLab.textContent = points[points.length - 1].label;
    svg.appendChild(lastLab);
  }

  const crosshair = svgEl("line", { x1: 0, y1: padT, x2: 0, y2: padT + plotH, class: "crosshair", opacity: 0 });
  const marker = svgEl("circle", { r: 4.5, fill: stroke, class: "series-dot", opacity: 0 });
  svg.appendChild(crosshair);
  svg.appendChild(marker);

  // One transparent overlay carries the hover — a far bigger hit target than
  // the 2px stroke itself.
  const overlay = svgEl("rect", { x: padL, y: padT, width: plotW, height: plotH, fill: "transparent" });
  overlay.style.cursor = "crosshair";
  svg.appendChild(overlay);

  overlay.addEventListener("mousemove", (evt) => {
    const rect = svg.getBoundingClientRect();
    const rel = ((evt.clientX - rect.left) / rect.width) * w;
    const ratio = plotW > 0 ? (rel - padL) / plotW : 0;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    const p = points[idx];
    const x = xAt(idx), y = yAt(p.value);
    crosshair.setAttribute("x1", x); crosshair.setAttribute("x2", x); crosshair.setAttribute("opacity", 1);
    marker.setAttribute("cx", x); marker.setAttribute("cy", y); marker.setAttribute("opacity", 1);
    showTip(`<span class="tip-title">${escapeHtml(p.title || p.label)}</span>${tipRow(stroke, p.name || "value", fmt(p.value))}`, evt);
  });
  overlay.addEventListener("mouseleave", () => {
    crosshair.setAttribute("opacity", 0);
    marker.setAttribute("opacity", 0);
    hideTip();
  });
}

/** Horizontal stacked bar — part-to-whole across a handful of series. */
function drawStackedBar(svg, segments, { emptyId, legendId }) {
  const box = prepSvg(svg);
  if (!box) return;
  const total = segments.reduce((s, x) => s + x.value, 0);
  const legendNode = legendId ? $(legendId) : null;
  if (!segments.length || total <= 0) {
    toggleEmpty(emptyId, true);
    if (legendNode) legendNode.innerHTML = "";
    return;
  }
  toggleEmpty(emptyId, false);

  const { w, h } = box;
  const barH = Math.min(26, h - 8);
  const y = (h - barH) / 2;
  const gap = 2;                              // surface gap between segments
  const usable = w - gap * (segments.length - 1);
  let x = 0;

  segments.forEach((seg) => {
    const segW = Math.max(2, (seg.value / total) * usable);
    const color = resolveVar(seg.color);
    const rect = svgEl("rect", { x, y, width: segW, height: barH, rx: 4, fill: color });
    rect.style.cursor = "default";
    rect.addEventListener("mousemove", (evt) => {
      showTip(
        `<span class="tip-title">${escapeHtml(seg.label)}</span>` +
        tipRow(color, "entities", `${fmtInt(seg.value)} · ${Math.round((seg.value / total) * 100)}%`),
        evt
      );
    });
    rect.addEventListener("mouseleave", hideTip);
    svg.appendChild(rect);
    x += segW + gap;
  });

  if (legendNode) {
    legendNode.innerHTML = segments.map((s) =>
      `<span class="legend-chip"><i style="background:${resolveVar(s.color)}"></i>${escapeHtml(s.label)} · ${fmtInt(s.value)}</span>`
    ).join("");
  }
}

/** Vertical histogram — magnitude across ordered buckets, single hue. */
function drawHistogram(svg, buckets, { color, emptyId }) {
  const box = prepSvg(svg);
  if (!box) return;
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (!total) { toggleEmpty(emptyId, true); return; }
  toggleEmpty(emptyId, false);

  const { w, h } = box;
  const padB = 20, padT = 8;
  const plotH = h - padB - padT;
  const gap = 4;
  const barW = (w - gap * (buckets.length - 1)) / buckets.length;
  const max = Math.max(...buckets.map((b) => b.count));
  const fill = resolveVar(color);

  buckets.forEach((b, i) => {
    const bh = max > 0 ? Math.max(b.count > 0 ? 3 : 0, (b.count / max) * plotH) : 0;
    const x = i * (barW + gap);
    if (bh > 0) {
      const rect = svgEl("rect", {
        x, y: padT + plotH - bh, width: barW, height: bh, rx: 4, fill,
      });
      rect.addEventListener("mousemove", (evt) => {
        showTip(
          `<span class="tip-title">confidence ${escapeHtml(b.label)}</span>` +
          tipRow(fill, "boxes", `${fmtInt(b.count)} · ${Math.round((b.count / total) * 100)}%`),
          evt
        );
      });
      rect.addEventListener("mouseleave", hideTip);
      svg.appendChild(rect);
    }
    const lab = svgEl("text", { x: x + barW / 2, y: h - 6, class: "axis-text", "text-anchor": "middle" });
    lab.textContent = b.label;
    svg.appendChild(lab);
  });
}

/** Sparkline for a KPI tile — no axes, no labels, pure shape. */
function drawSpark(svg, values, color) {
  if (!svg) return;
  svg.replaceChildren();
  if (values.length < 2) return;

  const w = 120, h = 36, pad = 3;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => pad + (h - pad * 2) * (1 - (v - min) / span);

  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const stroke = resolveVar(color);
  svg.appendChild(svgEl("path", {
    d: `${d} L${w},${h} L0,${h} Z`, fill: stroke, opacity: 0.13, stroke: "none",
  }));
  svg.appendChild(svgEl("path", {
    d, fill: "none", stroke, "stroke-width": 2,
    "stroke-linecap": "round", "stroke-linejoin": "round",
  }));
}

/** Bar rows (pipeline stages, layer cost) — sequential, one hue. */
function renderBars(container, rows, { valueFmt = fmtMs, emptyText }) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<p class="muted-note">${escapeHtml(emptyText)}</p>`;
    return;
  }
  const max = Math.max(...rows.map((r) => r.value));
  container.innerHTML = rows.map((r) => `
    <div class="bar-row">
      <div class="bar-meta">
        <span class="bar-title">${escapeHtml(r.label)}</span>
        <span class="bar-val">${escapeHtml(r.display ?? valueFmt(r.value))}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" data-w="${max > 0 ? Math.max(2, (r.value / max) * 100) : 2}"></div></div>
    </div>
  `).join("");
  // Set width on the next frame so the CSS transition actually animates.
  requestAnimationFrame(() => {
    container.querySelectorAll(".bar-fill").forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  });
}

/** Count-up on a KPI value. */
function countUp(node, to, fmt) {
  if (!node) return;
  if (!Number.isFinite(to) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.textContent = Number.isFinite(to) ? fmt(to) : "—";
    return;
  }
  const dur = 600;
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    node.textContent = fmt(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ── Aggregation ──────────────────────────────────────────────────────── */

function aggregateTraces(traces, logs, session) {
  const categoryCounts = {};
  const layerCounts = {};
  const layerTotalMs = {};
  const providers = {};
  const g3Engines = {};
  const confidence = [0, 0, 0, 0, 0];   // <60, 60-70, 70-80, 80-90, 90+

  let totalShielded = 0;
  let qwenDecisions = 0;
  let latencySum = 0;
  let latencySamples = 0;
  let guardBlocks = 0;
  let framesWithGuard = 0;
  let guardResidual = 0;

  for (const trace of traces) {
    totalShielded += trace.redactions || 0;

    if (typeof trace.latencyMs === "number" && trace.latencyMs > 0) {
      latencySum += trace.latencyMs;
      latencySamples++;
    }

    for (const [layer, n] of Object.entries(trace.perception?.counts || {})) {
      layerCounts[layer] = (layerCounts[layer] || 0) + n;
    }

    for (const [rawCategory, n] of Object.entries(trace.perception?.categories || {})) {
      const key = KNOWN_CATEGORIES.includes(rawCategory) ? rawCategory : "other";
      categoryCounts[key] = (categoryCounts[key] || 0) + n;
    }

    accumulateLayerMs(layerTotalMs, trace.perception?.timings || {});

    const guard = trace.perception?.guard;
    if (guard) {
      framesWithGuard++;
      if (guard.emergencyBlackout) guardBlocks++;
      if (guard.residualFound) guardResidual++;
    }

    if (trace.qwen?.invoked) qwenDecisions += trace.qwen.decisions?.length || 0;

    const engine = trace.perception?.timings?.g3Engine;
    if (engine) {
      const bucket = engine.startsWith("ollama") ? "ollama" : engine;
      g3Engines[bucket] = (g3Engines[bucket] || 0) + 1;
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

  // Time series and confidence come from the audit log — it is capped at 200
  // against the traces' 50, so it carries the longer history.
  const series = [];
  for (const entry of [...logs].reverse()) {
    const when = entry.timestamp ? new Date(entry.timestamp) : null;
    series.push({
      label: when ? when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—",
      title: when ? when.toLocaleString() : "unknown time",
      redactions: entry.redactions ?? entry.redactionsCount ?? 0,
      latencyMs: entry.latencyMs ?? null,
    });
    for (const box of entry.redactionManifest || []) {
      const c = typeof box.confidence === "number" ? box.confidence : null;
      if (c === null) continue;
      const idx = c < 0.6 ? 0 : c < 0.7 ? 1 : c < 0.8 ? 2 : c < 0.9 ? 3 : 4;
      confidence[idx]++;
    }
  }

  if (traces.length === 0) {
    for (const entry of logs) {
      totalShielded += entry.redactions ?? entry.redactionsCount ?? 0;
      if (entry.latencyMs) { latencySum += entry.latencyMs; latencySamples++; }
    }
  }

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

  const latestTimings = traces[0]?.perception?.timings || session.latestCapture?.timings || null;

  return {
    totalShielded,
    categoryCounts,
    layerCounts,
    layerLatency,
    providers: Object.values(providers),
    qwenDecisions,
    avgLatencyMs: latencySamples > 0 ? Math.round(latencySum / latencySamples) : null,
    assuranceRate: framesWithGuard === 0
      ? (traces.length ? 100 : null)
      : Math.round(((framesWithGuard - guardBlocks) / framesWithGuard) * 100),
    framesWithGuard,
    guardBlocks,
    guardResidual,
    latestTimings,
    series,
    confidence,
    g3Engines,
    traceCount: traces.length,
  };
}

function accumulateLayerMs(acc, timings) {
  const map = {
    "DOM": (timings.domScanMs || 0) + (timings.domMapMs || 0),
    "OWL-ViT": timings.owlvitMs || 0,
    "MediaPipe-Face": timings.faceMs || 0,
    "OCR": timings.ocrLatencyMs || 0,
    "Ollama": timings.g3Ms || 0,
  };
  for (const [layer, ms] of Object.entries(map)) acc[layer] = (acc[layer] || 0) + ms;
}

/* ── Renderers ────────────────────────────────────────────────────────── */

function renderKpis(stats) {
  if (!stats) return;
  const redactions = stats.series.map((s) => s.redactions);
  const latencies = stats.series.filter((s) => s.latencyMs !== null).map((s) => s.latencyMs);

  countUp($("metricTotalShielded"), stats.totalShielded, fmtInt);
  countUp($("metricQwenDecisions"), stats.qwenDecisions, fmtInt);

  $("metricAvgLatency").textContent = stats.avgLatencyMs === null ? "—" : fmtMs(stats.avgLatencyMs);
  $("metricAssuranceRate").textContent = stats.assuranceRate === null ? "—" : `${stats.assuranceRate}%`;

  // Only the two tiles whose per-capture history is genuinely recorded get a
  // sparkline. The audit log carries no per-entry verdict count or guard
  // result, so the other two tiles show their value alone rather than a shape
  // derived from unrelated data.
  drawSpark($("sparkShielded"), redactions, "var(--accent-brand)");
  drawSpark($("sparkLatency"), latencies, "var(--accent-brand)");

  $("subShielded").textContent = stats.traceCount
    ? `across ${fmtInt(stats.traceCount)} traced capture${stats.traceCount === 1 ? "" : "s"}`
    : "across all captures";

  renderDelta($("deltaShielded"), redactions);
  renderDelta($("deltaLatency"), latencies, true);
}

/**
 * Compares the latest reading against the mean of the ones before it.
 * `lowerIsBetter` flips the colour for latency, where a drop is good.
 */
function renderDelta(node, values, lowerIsBetter = false) {
  if (!node) return;
  if (values.length < 2) { node.textContent = ""; node.className = "kpi-delta"; return; }
  const latest = values[values.length - 1];
  const prior = values.slice(0, -1);
  const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (!mean) { node.textContent = ""; node.className = "kpi-delta"; return; }
  const pct = ((latest - mean) / mean) * 100;
  const rising = pct >= 0;
  const good = lowerIsBetter ? !rising : rising;
  node.textContent = `${rising ? "+" : ""}${pct.toFixed(1)}%`;
  node.className = `kpi-delta ${good ? "up" : "down"}`;
}

function renderDonut(categoryCounts, totalCount) {
  const svg = $("svgDonut");
  const legend = $("donutLegend");
  if (!svg || !legend) return;

  svg.querySelectorAll(".donut-slice").forEach((el) => el.remove());
  legend.innerHTML = "";
  $("donutTotalCount").textContent = fmtInt(totalCount);
  $("pillTotalEntities").textContent = `${fmtInt(totalCount)} total`;

  const entries = Object.entries(categoryCounts).filter(([, n]) => n > 0);
  if (!entries.length || totalCount <= 0) {
    legend.innerHTML = `<p class="muted-note">Nothing shielded yet.</p>`;
    return;
  }

  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  // Fixed taxonomy order, not count order, so a category keeps its colour and
  // its position as the data changes.
  for (const key of KNOWN_CATEGORIES) {
    const count = categoryCounts[key];
    if (!count) continue;
    const info = CATEGORY_COLORS[key];
    const color = resolveVar(info.color);
    const pct = count / totalCount;

    const circle = svgEl("circle", {
      cx: 120, cy: 120, r: radius, fill: "none", stroke: color, "stroke-width": 26,
      "stroke-dasharray": `${(pct * circumference).toFixed(2)} ${circumference.toFixed(2)}`,
      "stroke-dashoffset": (-(cumulative * circumference)).toFixed(2),
      class: "donut-slice",
    });
    circle.addEventListener("mousemove", (evt) => {
      showTip(
        `<span class="tip-title">${escapeHtml(info.label)}</span>` +
        tipRow(color, "entities", `${fmtInt(count)} · ${Math.round(pct * 100)}%`),
        evt
      );
    });
    circle.addEventListener("mouseleave", hideTip);
    svg.appendChild(circle);

    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <div class="legend-label-group">
        <span class="legend-color-dot" style="background-color:${color}"></span>
        <span>${escapeHtml(info.label)}</span>
      </div>
      <span class="legend-pct">${Math.round(pct * 100)}%</span>`;
    legend.appendChild(item);

    cumulative += pct;
  }
}

function renderMeter(stats) {
  const arc = $("meterArc");
  const value = $("meterValue");
  const sub = $("meterSub");
  const facts = $("meterFacts");
  if (!arc || !value) return;

  const LEN = 251.2;
  const rate = stats.assuranceRate;

  if (rate === null) {
    arc.style.strokeDashoffset = String(LEN);
    value.textContent = "—";
    sub.textContent = "no frames yet";
    if (facts) facts.innerHTML = "";
    return;
  }

  arc.setAttribute("stroke", resolveVar(
    rate >= 100 ? "var(--status-good)" : rate >= 90 ? "var(--status-warn)" : "var(--status-critical)"
  ));
  requestAnimationFrame(() => { arc.style.strokeDashoffset = String(LEN * (1 - rate / 100)); });

  value.textContent = `${rate}%`;
  sub.textContent = stats.framesWithGuard
    ? `${fmtInt(stats.framesWithGuard)} frame${stats.framesWithGuard === 1 ? "" : "s"} verified`
    : "assumed clean · no guard report";

  if (facts) {
    facts.innerHTML = `
      <li><span>Frames verified</span><b>${fmtInt(stats.framesWithGuard)}</b></li>
      <li><span>Residual pixels caught</span><b>${fmtInt(stats.guardResidual)}</b></li>
      <li><span>Emergency blackouts</span><b>${fmtInt(stats.guardBlocks)}</b></li>`;
  }
}

function renderPipeline(timings) {
  const total = $("lblTotalPipelineLatency");
  if (!timings) {
    renderBars($("pipelineBars"), [], { emptyText: "No capture recorded yet — run a capture to measure the pipeline." });
    if (total) total.textContent = "no data";
    return;
  }
  const rows = PIPELINE_STAGES
    .map(([label, pick]) => ({ label, value: pick(timings) || 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);

  renderBars($("pipelineBars"), rows, { emptyText: "No per-stage timings in the latest capture." });
  if (total) total.textContent = `${fmtMs(timings.totalRedactionLatencyMs || 0)} total`;
}

function renderAttribution(layerCounts) {
  const segments = LAYERS
    .map((layer) => ({ label: LAYER_LABELS[layer], value: layerCounts[layer] || 0, color: LAYER_COLORS[layer] }))
    .filter((s) => s.value > 0);
  drawStackedBar($("chartAttribution"), segments, { emptyId: "emptyAttribution", legendId: "attributionLegend" });
}

function renderLayerCost(layerCounts, layerLatency) {
  const rows = LAYERS
    .map((layer) => ({
      label: LAYER_LABELS[layer],
      value: layerLatency[layer] || 0,
      count: layerCounts[layer] || 0,
    }))
    .filter((r) => r.value > 0 || r.count > 0)
    .map((r) => ({ ...r, display: `${fmtInt(r.count)} found · ${fmtMs(r.value)}` }));
  renderBars($("layerAttribution"), rows, { emptyText: "No detections recorded yet." });
}

function renderOcrAndG3(stats) {
  const t = stats.latestTimings || {};
  const box = $("ocrBudget");
  if (box) {
    const scanned = t.ocrRegionsScanned ?? 0;
    const skipped = t.ocrRegionsSkipped ?? 0;
    box.innerHTML = `
      <div><span class="s-val">${fmtInt(scanned)}</span><span class="s-lab">regions scanned</span></div>
      <div><span class="s-val">${fmtInt(skipped)}</span><span class="s-lab">skipped on budget</span></div>
      <div><span class="s-val">${fmtInt(t.g3CandidatesFound ?? 0)}</span><span class="s-lab">G3 candidates</span></div>`;
  }

  const G3_COLORS = { cache: "var(--cat-2)", ollama: "var(--cat-1)", unavailable: "var(--text-3)", none: "var(--text-3)", error: "var(--cat-6)" };
  const G3_LABELS = { cache: "Served from cache", ollama: "Queried Ollama", unavailable: "Ollama unreachable", none: "No candidates", error: "Errored" };
  const segments = Object.entries(stats.g3Engines)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => ({ label: G3_LABELS[k] || k, value: n, color: G3_COLORS[k] || "var(--text-3)" }));

  drawStackedBar($("chartG3"), segments, { emptyId: "emptyG3", legendId: "g3Legend" });
}

function renderReasoning(providers) {
  const container = $("reasoningAttribution");
  if (!container) return;
  if (!providers.length) {
    container.innerHTML = `<p class="muted-note">No agent steps recorded yet — run a task to see model attribution.</p>`;
    return;
  }
  container.innerHTML = providers.map((p) => {
    const mean = p.latencySamples ? Math.round(p.latencySum / p.latencySamples) : null;
    const served = p.steps > 0;
    const detail = served
      ? `${p.modelId ? escapeHtml(p.modelId) + " · " : ""}${p.steps} step${p.steps === 1 ? "" : "s"}${mean ? ` · ${fmtMs(mean)} mean` : ""}`
      : `${p.failures} failed attempt${p.failures === 1 ? "" : "s"}`;
    return `
      <div class="stack-item">
        <div class="stack-info">
          <span class="stack-name">${escapeHtml(p.provider)}</span>
          <span class="stack-status ${served ? "good" : "muted"}">${detail}</span>
        </div>
        <span class="status-dot ${served ? "on" : "off"}"></span>
      </div>`;
  }).join("");
}

function renderAuditTable(logs = [], traces = []) {
  const body = $("auditTableBody");
  if (!body) return;
  body.innerHTML = "";

  if (!logs.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty-state">No audit logs recorded yet. Start an agent task to view live compliance events.</td></tr>`;
    return;
  }

  const tracesById = new Map(traces.map((t) => [t.traceId, t]));

  logs.slice(0, 50).forEach((entry) => {
    const row = document.createElement("tr");
    const trace = entry.traceId ? tracesById.get(entry.traceId) : null;
    const count = entry.redactions ?? entry.redactionsCount ?? 0;

    row.innerHTML = `
      <td class="cell-mono">${entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "--"}</td>
      <td>${escapeHtml((entry.task || "Visual redaction step").substring(0, 36))}</td>
      <td><span class="badge-pill neutral">${escapeHtml(entry.actionType || "DOM sanitize")}</span></td>
      <td>${escapeHtml(entry.modelId || entry.model || "Local heuristics")}</td>
      <td><span class="badge-pill success">${fmtInt(count)} items</span></td>
      <td class="cell-mono">${entry.latencyMs ? fmtMs(entry.latencyMs) : "--"}</td>
      <td><span class="badge-pill success">Shielded</span></td>`;
    body.appendChild(row);

    if (devMode && trace) body.appendChild(buildTraceDetailRow(trace));
  });
}

function buildTraceDetailRow(trace) {
  const row = document.createElement("tr");
  row.className = "trace-detail-row";

  const attempts = trace.reasoning?.attempts || [];
  const attemptsHtml = attempts.length
    ? attempts.map((a) => `
        <li><span class="${a.ok ? "ok" : "fail"}">${escapeHtml(a.provider)}</span>
        ${a.modelId ? escapeHtml(a.modelId) : ""} — ${a.ok ? "served" : escapeHtml(a.error || "failed")}
        ${a.latencyMs ? ` (${fmtMs(a.latencyMs)})` : ""}</li>`).join("")
    : `<li class="muted-note">No provider attempt log for this step.</li>`;

  const qwen = trace.qwen;
  const qwenHtml = qwen?.invoked
    ? `<p class="trace-sub">Trigger: ${escapeHtml(qwen.trigger || "—")} ·
         ${qwen.candidateCount} candidate${qwen.candidateCount === 1 ? "" : "s"} ·
         batch ${qwen.batchSize} · ${fmtMs(qwen.latencyMs)} ·
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
        <div><span class="trace-heading">Provider attempts</span><ul class="trace-list">${attemptsHtml}</ul></div>
        <div><span class="trace-heading">Local reasoner (Qwen)</span>${qwenHtml}</div>
      </div>
    </td>`;
  return row;
}

/** Charts need a laid-out box, so only the visible pane is drawn. */
function renderCharts(stats) {
  if (!stats) return;

  if (activePane === "dashboard") {
    drawSeries($("chartRedactions"), stats.series.map((s) => ({
      label: s.label, title: s.title, value: s.redactions, name: "entities",
    })), { color: "var(--accent-brand)", area: true, fmt: fmtInt, emptyId: "emptyRedactions" });

    const pill = $("pillRedactionWindow");
    if (pill) pill.textContent = stats.series.length ? `last ${fmtInt(stats.series.length)} captures` : "—";

    renderDonut(stats.categoryCounts, stats.totalShielded);
    renderMeter(stats);
  } else {
    renderPipeline(stats.latestTimings);
    renderAttribution(stats.layerCounts);

    const latencyPoints = stats.series
      .filter((s) => s.latencyMs !== null)
      .map((s) => ({ label: s.label, title: s.title, value: s.latencyMs, name: "latency" }));
    drawSeries($("chartLatency"), latencyPoints, {
      color: "var(--cat-2)", area: false, fmt: fmtMs, emptyId: "emptyLatency",
    });
    const range = $("pillLatencyRange");
    if (range) {
      range.textContent = latencyPoints.length
        ? `${fmtMs(Math.min(...latencyPoints.map((p) => p.value)))} – ${fmtMs(Math.max(...latencyPoints.map((p) => p.value)))}`
        : "—";
    }

    drawHistogram($("chartConfidence"), [
      { label: "<60%", count: stats.confidence[0] },
      { label: "60–70", count: stats.confidence[1] },
      { label: "70–80", count: stats.confidence[2] },
      { label: "80–90", count: stats.confidence[3] },
      { label: "90%+", count: stats.confidence[4] },
    ], { color: "var(--cat-3)", emptyId: "emptyConfidence" });

    renderOcrAndG3(stats);
    renderLayerCost(stats.layerCounts, stats.layerLatency);
    renderReasoning(stats.providers);
  }
}

/* ── Identity (local vault) ───────────────────────────────────────────── */

/* The fields worth offering as a form. Keys match vault.js's semantic aliases,
   so `findMatchingValue()` can also match them against real page inputs.
   Passwords and card numbers are deliberately absent: they belong to the
   guarded raw editor in Settings, not a always-visible autofill sheet. */
const IDENTITY_FIELDS = [
  ["Personal", [
    ["personal", "first_name", "First name", "Alice"],
    ["personal", "last_name", "Last name", "Johnson"],
  ]],
  ["Contact", [
    ["contact", "email", "Email", "alice@example.com"],
    ["contact", "phone", "Phone", "+91 98765 43210"],
  ]],
  ["Address", [
    ["address", "street", "Street", "12 MG Road"],
    ["address", "city", "City", "Bengaluru"],
    ["address", "state", "State", "Karnataka"],
    ["address", "zip", "PIN / ZIP", "560001"],
    ["address", "country", "Country", "India"],
  ]],
  ["Government ID", [
    ["gov_id", "aadhaar", "Aadhaar", "1234 5678 9012"],
    ["gov_id", "pan", "PAN", "ABCDE1234F"],
  ]],
];

function buildIdentityForm() {
  const form = $("identityForm");
  if (!form || form.dataset.built) return;

  form.innerHTML = IDENTITY_FIELDS.map(([group, fields]) => `
    <div class="id-group">${escapeHtml(group)}</div>
    ${fields.map(([cat, key, label, placeholder]) => `
      <div class="id-field">
        <label for="id_${cat}_${key}">
          ${escapeHtml(label)}
          <span class="id-token">${cat}.${key}</span>
        </label>
        <input type="text" id="id_${cat}_${key}" data-cat="${cat}" data-key="${key}"
               placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />
      </div>`).join("")}
  `).join("");

  form.dataset.built = "1";
}

async function loadIdentity() {
  buildIdentityForm();
  const badge = $("vaultStateBadge");

  try {
    await vault.init();
  } catch (err) {
    if (badge) badge.textContent = "unavailable";
    setIdentityStatus(`Vault could not be opened: ${err.message}`, false);
    return;
  }

  if (badge) badge.textContent = vault.isUnlocked() ? "unlocked on this device" : "locked";

  // Values are read straight into the inputs. This page is itself local, so the
  // real value is shown here — it is the one surface the user is allowed to see
  // it on, and it never travels further.
  for (const [, fields] of IDENTITY_FIELDS) {
    for (const [cat, key] of fields) {
      const input = $(`id_${cat}_${key}`);
      if (!input) continue;
      try {
        const entry = vault.get(cat, key);
        input.value = entry?.value ?? entry ?? "";
      } catch { input.value = ""; }
    }
  }

  renderTokenPreview();
}

/** Mirrors exactly what agent_loop sends: token paths, never values. */
function renderTokenPreview() {
  const node = $("tokenPreview");
  if (!node) return;
  let paths = [];
  try {
    if (vault.isUnlocked()) {
      for (const [category, entries] of Object.entries(vault.listKeys() || {})) {
        for (const entry of entries || []) paths.push(`${category}.${entry.key}`);
      }
    }
  } catch { paths = []; }

  node.textContent = paths.length
    ? `Sent to the model:\n${paths.sort().map((p) => `  {{VAULT:${p}}}`).join("\n")}\n\nValues stay on this device.`
    : "Nothing saved yet — the model is told you have no details on file, and is\ninstructed not to invent any.";
}

function setIdentityStatus(text, ok = true) {
  const node = $("identityStatus");
  if (!node) return;
  node.textContent = text;
  node.className = `identity-status${ok ? " ok" : ""}`;
  if (text) setTimeout(() => { if (node.textContent === text) node.textContent = ""; }, 4000);
}

async function saveIdentity() {
  let saved = 0;
  let removed = 0;
  try {
    for (const [, fields] of IDENTITY_FIELDS) {
      for (const [cat, key] of fields) {
        const input = $(`id_${cat}_${key}`);
        if (!input) continue;
        const value = input.value.trim();
        if (value) {
          await vault.set(cat, key, value);
          saved++;
        } else if (vault.has(cat, key)) {
          // Emptying a field is how you delete it.
          await vault.delete(cat, key);
          removed++;
        }
      }
    }
  } catch (err) {
    setIdentityStatus(`Could not save: ${err.message}`, false);
    return;
  }

  renderTokenPreview();
  setIdentityStatus(
    removed ? `Saved ${saved} · removed ${removed}` : `Saved ${saved} detail${saved === 1 ? "" : "s"}`
  );
}

async function clearIdentity() {
  if (!confirm("Remove every saved detail from this device?")) return;
  try {
    for (const [category, entries] of Object.entries(vault.listKeys() || {})) {
      for (const entry of entries || []) await vault.delete(category, entry.key);
    }
  } catch (err) {
    setIdentityStatus(`Could not clear: ${err.message}`, false);
    return;
  }
  for (const [, fields] of IDENTITY_FIELDS) {
    for (const [cat, key] of fields) {
      const input = $(`id_${cat}_${key}`);
      if (input) input.value = "";
    }
  }
  renderTokenPreview();
  setIdentityStatus("All details removed");
}

/* ── Load & wire ──────────────────────────────────────────────────────── */

async function loadDashboardData() {
  const sessionPromise = typeof chrome !== "undefined" && chrome.runtime
    ? chrome.runtime.sendMessage({ type: "GET_AGENT_SESSION_STATE" }).catch(() => ({ ok: false }))
    : Promise.resolve({ ok: false });

  const [logs, traces, sessionResp] = await Promise.all([
    getAuditLogs(), getPipelineTraces(), sessionPromise,
  ]);

  const stats = aggregateTraces(traces, logs, sessionResp?.session || {});
  lastStats = stats;

  renderKpis(stats);
  renderCharts(stats);
  renderAuditTable(logs, traces);
}

const PANES = {
  dashboard: {
    tab: "tabDashboard", pane: "paneDashboard", title: "Dashboard",
    subtitle: "On-device redaction activity across your browsing sessions",
  },
  analytics: {
    tab: "tabAnalytics", pane: "paneAnalytics", title: "Analytics",
    subtitle: "Per-stage timings, detector attribution and the full audit trail",
  },
  identity: {
    tab: "tabIdentity", pane: "paneIdentity", title: "My details",
    subtitle: "Personal details the agent can fill in, stored encrypted on this device",
  },
};

function switchPane(name) {
  if (!PANES[name]) return;
  activePane = name;

  for (const [key, cfg] of Object.entries(PANES)) {
    const on = key === name;
    const pane = $(cfg.pane);
    const tab = $(cfg.tab);
    if (pane) { pane.classList.toggle("active", on); pane.hidden = !on; }
    if (tab) { tab.classList.toggle("active", on); tab.setAttribute("aria-selected", String(on)); }
  }

  $("paneTitle").textContent = PANES[name].title;
  $("paneSubtitle").textContent = PANES[name].subtitle;

  if (name === "identity") {
    loadIdentity();
    return;
  }
  // The pane was display:none until now, so its charts had no box to measure.
  requestAnimationFrame(() => renderCharts(lastStats));
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);
}

function applyDevMode(enabled) {
  devMode = enabled;
  document.documentElement.setAttribute("data-devmode", enabled ? "on" : "off");
  const btn = $("btnDevMode");
  if (btn) {
    btn.classList.toggle("active", enabled);
    btn.setAttribute("aria-pressed", String(enabled));
  }
}

async function probeHardware() {
  const gpu = $("lblWebGPUStatus");
  const qwen = $("lblQwenStatus");

  if (navigator.gpu) {
    try {
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200)),
      ]);
      gpu.textContent = adapter ? "Active · hardware accelerated" : "WASM fallback (no GPU adapter)";
      gpu.className = `stack-status ${adapter ? "good" : "muted"}`;
    } catch {
      gpu.textContent = "WASM fallback mode";
      gpu.className = "stack-status muted";
    }
  } else {
    gpu.textContent = "WASM engine (WebGPU unavailable)";
    gpu.className = "stack-status muted";
  }

  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const models = ((await res.json()).models || []).map((m) => (m.name || "").toLowerCase());
      qwen.textContent = models.some((m) => m.includes("isro-privacy-qwen"))
        ? "Connected · ISRO-tuned model active"
        : models.some((m) => m.includes("1.5b"))
          ? "Connected · Qwen2.5 1.5B active"
          : "Connected · Qwen2.5 active";
      qwen.className = "stack-status good";
    } else {
      qwen.textContent = "Fastpath semantic fallback active";
      qwen.className = "stack-status muted";
    }
  } catch {
    qwen.textContent = "Fastpath semantic reasoner active";
    qwen.className = "stack-status muted";
  }
}

function downloadJson(data, prefix) {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2)));
  anchor.setAttribute("download", `${prefix}_${Date.now()}.json`);
  anchor.click();
}

function setupEventListeners() {
  $("tabDashboard").addEventListener("click", () => switchPane("dashboard"));
  $("tabAnalytics").addEventListener("click", () => switchPane("analytics"));
  $("tabIdentity").addEventListener("click", () => switchPane("identity"));

  $("btnSaveIdentity").addEventListener("click", saveIdentity);
  $("btnClearIdentity").addEventListener("click", clearIdentity);

  $("btnTheme").addEventListener("click", async () => {
    applyTheme(currentTheme === "dark" ? "light" : "dark");
    await saveSettings({ theme: currentTheme });
    renderKpis(lastStats);      // colours are resolved to literals, so redraw
    renderCharts(lastStats);
  });

  $("btnOpenOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

  $("btnDevMode").addEventListener("click", async () => {
    applyDevMode(!devMode);
    await saveSettings({ devMode });
    await loadDashboardData();
  });

  const btnClearTraces = $("btnClearTraces");
  if (btnClearTraces) {
    btnClearTraces.addEventListener("click", async () => {
      if (confirm("Clear all developer pipeline traces?")) {
        await clearPipelineTraces();
        await loadDashboardData();
      }
    });
  }

  const btnExportTraces = $("btnExportTraces");
  if (btnExportTraces) {
    btnExportTraces.addEventListener("click", async () => {
      downloadJson(await getPipelineTraces(), "privacy_agent_traces");
    });
  }

  const btnRefresh = $("btnRefresh");
  btnRefresh.addEventListener("click", async () => {
    btnRefresh.disabled = true;
    $("btnRefreshLabel").textContent = "Refreshing…";
    await loadDashboardData();
    setTimeout(() => {
      $("btnRefreshLabel").textContent = "Refresh";
      btnRefresh.disabled = false;
    }, 400);
  });

  $("btnExportLogs").addEventListener("click", async () => {
    downloadJson(await getAuditLogs(), "privacy_agent_audit");
  });

  $("btnClearLogs").addEventListener("click", async () => {
    if (confirm("Clear the audit stream?")) {
      await clearAuditLogs();
      await loadDashboardData();
    }
  });

  // Charts are drawn at measured pixel size, so they must be redrawn on resize.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderCharts(lastStats), 150);
  });

  if (tipEl) window.addEventListener("scroll", hideTip, { passive: true });
}

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await getSettings();
  applyTheme(settings.theme || "dark");
  applyDevMode(Boolean(settings.devMode));

  probeHardware();              // never let a stalled GPU/Ollama probe block the charts
  await loadDashboardData();
  setupEventListeners();
});
