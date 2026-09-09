/**
 * hud.js — drives the side-by-side demo view.
 *
 * Presentation only: it asks the service worker to run the pipeline and draws
 * what comes back. No detection or redaction logic lives here, deliberately —
 * if the HUD could redact, there would be two implementations to keep honest.
 *
 * The raw panel exists to prove the redaction is real. It is drawn from a
 * field the offscreen document only populates when wantRawPreview is set, and
 * it is never included in the payload sent onward.
 */

const $ = (id) => document.getElementById(id);

const STAGE_COLORS = {
  capture: "#c0392b",
  decode: "#d98324",
  domScan: "#1f4fd8",
  preprocess: "#8a3ffc",
  inference: "#1a7f4b",
  postprocess: "#0a9396",
  merge: "#6b6a63",
  composite: "#b5179e",
  encode: "#4a4e69",
  scrub: "#457b9d",
};

let looping = false;
let loopTimer = null;

// ---------------------------------------------------------------------------

function setAlert(kind, html) {
  const el = $("alert");
  if (!kind) { el.className = "alert"; el.innerHTML = ""; return; }
  el.className = `alert ${kind}`;
  el.innerHTML = html;
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res ?? { ok: false, error: "no response" });
    });
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function refreshStatus() {
  const s = await send({ type: "GET_STATUS" });
  const badge = $("backendBadge");

  if (!s?.ok) {
    badge.textContent = "error";
    badge.className = "badge none";
    setAlert("err", `Could not reach the inference host: <code>${s?.error || "unknown"}</code>`);
    return false;
  }

  if (!s.modelReady) {
    badge.textContent = "loading";
    badge.className = "badge none";
    if (s.loadError) {
      setAlert("err",
        `<strong>Model failed to load.</strong> <code>${s.loadError}</code><br>` +
        `Check that <code>tools/vendor-deps.mjs</code> has been run — the weights ` +
        `must be on disk, since remote fetching is disabled by design.`);
    }
    return false;
  }

  badge.textContent = s.executionProvider;
  badge.className = `badge ${s.executionProvider === "webgpu" ? "webgpu" : "wasm"}`;
  $("loadMs").textContent = s.modelLoadMs ? `${Math.round(s.modelLoadMs)} ms` : "—";

  if (s.executionProvider === "wasm") {
    // Say this plainly rather than quietly reporting a slow number later.
    setAlert("warn",
      "<strong>Running on the WASM fallback.</strong> WebGPU was unavailable, so " +
      "latency figures from this session are not representative of the accelerated path.");
  } else {
    setAlert("ok", "WebGPU backend active. Model warm and ready.");
  }

  $("btnCapture").disabled = false;
  $("btnLoop").disabled = false;
  $("btnExport").disabled = false;
  return true;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

async function drawToCanvas(canvasId, placeholderId, dataUrl, dimsId, boxes) {
  const canvas = $(canvasId);
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());

  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);

  // On the RAW panel only: outline what was detected, so the audience can see
  // the correspondence between a detection here and a black box on the right.
  if (boxes?.length) {
    for (const b of boxes) {
      ctx.strokeStyle = b.source === "dom" ? "#1f4fd8" : "#8a3ffc";
      ctx.lineWidth = Math.max(2, canvas.width / 500);
      ctx.strokeRect(b.rect.x, b.rect.y, b.rect.w, b.rect.h);

      const label = `${b.kind}`;
      ctx.font = `${Math.max(11, canvas.width / 110)}px ui-monospace, monospace`;
      const tw = ctx.measureText(label).width + 8;
      const th = Math.max(15, canvas.width / 85);
      ctx.fillStyle = b.source === "dom" ? "#1f4fd8" : "#8a3ffc";
      ctx.fillRect(b.rect.x, Math.max(0, b.rect.y - th), tw, th);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, b.rect.x + 4, Math.max(11, b.rect.y - 4));
    }
  }

  bmp.close?.();
  canvas.hidden = false;
  $(placeholderId).hidden = true;
  $(dimsId).textContent = `${canvas.width}x${canvas.height}`;
}

function renderStages(timing) {
  const stages = timing.stages || {};
  const entries = Object.entries(stages).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;

  $("stageBar").innerHTML = entries
    .map(([k, v]) => `<span style="width:${(v / total) * 100}%;background:${STAGE_COLORS[k] || "#999"}" title="${k}: ${v}ms"></span>`)
    .join("");

  $("stageList").innerHTML = entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `
      <div class="kv">
        <span class="k"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${STAGE_COLORS[k] || "#999"};margin-right:6px"></span>${k}</span>
        <span class="v">${v.toFixed(1)} ms</span>
      </div>`)
    .join("");
}

function renderMasks(masks) {
  const rows = $("maskRows");
  if (!masks?.length) {
    rows.innerHTML = `<tr><td colspan="4" style="color:var(--muted)">No sensitive regions found.</td></tr>`;
    return;
  }
  rows.innerHTML = masks.slice(0, 40).map((m) => `
    <tr>
      <td class="src-${m.source}">${m.source}</td>
      <td>${escapeHtml(String(m.kind))}</td>
      <td>${m.layer || "—"}</td>
      <td class="num">${(m.confidence * 100).toFixed(0)}%</td>
    </tr>`).join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function capture() {
  $("btnCapture").disabled = true;

  // The HUD itself is the active tab, so target the last normal tab instead.
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const target = tabs
    .filter((t) => !t.url?.startsWith("chrome-extension://") &&
                   !/^(chrome|edge|about|moz-extension):/.test(t.url || ""))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];

  if (!target) {
    setAlert("err", "No ordinary web page open in this window. Open the demo page in another tab, then capture.");
    $("btnCapture").disabled = false;
    return;
  }

  // captureVisibleTab only grabs the FOREGROUND tab, so briefly focus the
  // target, capture, then come back. Visible on screen, but honest — and it
  // is why the loop runs at ~1.5s rather than at video rate.
  const hudTab = await chrome.tabs.getCurrent();
  await chrome.tabs.update(target.id, { active: true });
  await new Promise((r) => setTimeout(r, 220)); // let the compositor settle

  const res = await send({ type: "RUN_PIPELINE", tabId: target.id, wantRawPreview: true });

  if (hudTab) await chrome.tabs.update(hudTab.id, { active: true });

  if (!res?.ok) {
    if (res?.failClosed) {
      setAlert("err",
        `<strong>Failed closed — nothing was transmitted.</strong><br>` +
        `<code>${escapeHtml(res.error || "")}</code><br>` +
        `This is the intended behaviour: a frame that cannot be fully verified ` +
        `as redacted is never emitted.`);
    } else {
      setAlert("err", `Pipeline error: <code>${escapeHtml(res?.error || "unknown")}</code>`);
    }
    $("btnCapture").disabled = false;
    return;
  }

  if (res.rawDataUrl) {
    await drawToCanvas("rawCanvas", "rawPlaceholder", res.rawDataUrl, "rawDims", res.masks);
  }
  await drawToCanvas("safeCanvas", "safePlaceholder", res.redactedDataUrl, "safeDims", null);

  const t = res.timing || {};
  $("totalMs").textContent = t.total != null ? t.total.toFixed(0) : "—";
  renderStages(t);
  renderMasks(res.masks);

  $("domCount").textContent = t.domBoxes ?? "—";
  $("visionCount").textContent = t.visionBoxes ?? "—";
  $("maskCount").textContent = res.masks?.length ?? "—";
  $("digestCount").textContent = res.digestStats?.redactionCount ?? "—";

  $("digestOut").textContent = JSON.stringify(res.digest, null, 2).slice(0, 4000);

  await refreshMetrics();
  $("btnCapture").disabled = false;
}

async function refreshMetrics() {
  const m = await send({ type: "GET_METRICS" });
  if (!m?.ok) return;
  const s = m.metrics.summary;
  $("p50").textContent = s.steadyState.p50 != null ? `${s.steadyState.p50.toFixed(0)} ms` : "—";
  $("p95").textContent = s.steadyState.p95 != null ? `${s.steadyState.p95.toFixed(0)} ms` : "—";
  $("frameCount").textContent = s.steadyState.n ?? "—";
  $("coldStart").textContent = s.coldStartMs != null ? `${s.coldStartMs.toFixed(0)} ms` : "—";
  const heap = s.resources?.jsHeapUsedMB;
  $("heap").textContent = heap ? `${heap.last} MB (peak ${heap.peak})` : "—";
}

// ---------------------------------------------------------------------------

$("btnCapture").addEventListener("click", capture);

$("btnLoop").addEventListener("click", () => {
  looping = !looping;
  $("btnLoop").textContent = looping ? "Stop loop" : "Start loop";
  if (looping) {
    const tick = async () => {
      if (!looping) return;
      await capture();
      // captureVisibleTab is rate-limited to roughly 2/sec, and this loop also
      // switches tabs, so it is a stepped view rather than a live one. For a
      // truly live HUD, move to tabCapture.getMediaStreamId + getUserMedia in
      // the offscreen document.
      loopTimer = setTimeout(tick, 1500);
    };
    tick();
  } else {
    clearTimeout(loopTimer);
  }
});

$("btnExport").addEventListener("click", async () => {
  const m = await send({ type: "GET_METRICS" });
  if (!m?.ok) { setAlert("err", "Could not read metrics."); return; }
  const blob = new Blob([JSON.stringify(m.metrics, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `privybrowse-metrics-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Poll until the model finishes loading, then stop.
(async function init() {
  for (let i = 0; i < 60; i++) {
    if (await refreshStatus()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  setAlert("err", "Model did not become ready within 60s. Check the offscreen document console.");
})();
