#!/usr/bin/env node
/**
 * vendor-deps.mjs — pull every runtime dependency into the extension folder
 * so the extension runs with the network cable unplugged.
 *
 * WHY THIS EXISTS
 * ---------------
 * MV3's content security policy blocks remote code. The Day 2 test harness
 * imported Transformers.js straight from jsDelivr, which is fine in a plain
 * local page and *illegal inside an extension*. On top of that, letting
 * Transformers.js lazily fetch weights from huggingface.co on first run means
 * your live demo depends on venue wifi. Both problems are solved the same way:
 * copy everything local, then tell the library never to phone home.
 *
 * RUN THIS ONCE, LOCALLY (needs internet):
 *
 *   cd privybrowse-x
 *   npm install @huggingface/transformers@3.7.6
 *   node tools/vendor-deps.mjs
 *
 * Then `npm uninstall` / delete node_modules if you like — the extension only
 * reads from vendor/, wasm/ and models/ after this.
 *
 * Re-run with --force to overwrite an existing vendored copy.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FORCE = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Pin the version. Transformers.js moves fast and v3 vs v4 differ in how the
// WebGPU device is requested; an unpinned upgrade mid-hackathon is a bad day.
const TRANSFORMERS_PKG = "@huggingface/transformers";

// The detector. yolos-tiny is a ViT-based detector, which matters because the
// problem statement asks for "a Vision Transformer (ViT) or equivalent" — say
// this out loud to the judges, it's a spec compliance point you get for free.
const MODEL_ID = "Xenova/yolos-tiny";

// Files Transformers.js expects to find under models/<MODEL_ID>/
const MODEL_FILES = [
  "config.json",
  "preprocessor_config.json",
  "onnx/model_quantized.onnx",
];

const HF_BASE = "https://huggingface.co";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log("[vendor]", ...args);
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function copyDirFiltered(src, dest, filter) {
  ensureDir(dest);
  let count = 0;
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      count += copyDirFiltered(srcPath, destPath, filter);
    } else if (filter(entry)) {
      copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

async function download(url, destPath) {
  ensureDir(dirname(destPath));
  if (existsSync(destPath) && !FORCE) {
    log(`skip (exists): ${destPath.replace(ROOT + "/", "")}`);
    return;
  }
  log(`GET ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed ${res.status} ${res.statusText} for ${url}`);
  }
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  const kb = (statSync(destPath).size / 1024).toFixed(0);
  log(`  -> ${destPath.replace(ROOT + "/", "")} (${kb} KB)`);
}

// ---------------------------------------------------------------------------
// Step 1: copy the Transformers.js browser bundle into vendor/
// ---------------------------------------------------------------------------

function vendorLibrary() {
  const pkgDist = join(ROOT, "node_modules", TRANSFORMERS_PKG, "dist");
  if (!existsSync(pkgDist)) {
    console.error(
      `\n  Could not find ${pkgDist}\n` +
      `  Run this first, from the privybrowse-x folder:\n\n` +
      `      npm install ${TRANSFORMERS_PKG}@3.7.6\n`
    );
    process.exit(1);
  }

  const dest = join(ROOT, "vendor");
  // We want the ESM browser build + its sourcemaps, not the node CJS variants.
  const n = copyDirFiltered(pkgDist, dest, (f) =>
    /\.(js|mjs|map)$/.test(f) && !f.includes(".node.")
  );
  log(`vendored ${n} library file(s) into vendor/`);
}

// ---------------------------------------------------------------------------
// Step 2: copy the ONNX Runtime Web WASM binaries into wasm/
// ---------------------------------------------------------------------------

function vendorWasm() {
  // Transformers.js depends on onnxruntime-web; its .wasm/.mjs artifacts must
  // be served from the extension or ORT will try to fetch them from a CDN at
  // init time and fail silently-ish under CSP.
  const candidates = [
    join(ROOT, "node_modules", "onnxruntime-web", "dist"),
    join(ROOT, "node_modules", TRANSFORMERS_PKG, "node_modules", "onnxruntime-web", "dist"),
  ];
  const ortDist = candidates.find(existsSync);
  if (!ortDist) {
    console.error(
      "\n  Could not find onnxruntime-web/dist in node_modules.\n" +
      "  It normally installs as a dependency of Transformers.js.\n" +
      "  Try:  npm install onnxruntime-web\n"
    );
    process.exit(1);
  }

  const dest = join(ROOT, "wasm");
  const n = copyDirFiltered(ortDist, dest, (f) => /\.(wasm|mjs)$/.test(f));
  log(`vendored ${n} ORT runtime file(s) into wasm/  (from ${ortDist.replace(ROOT + "/", "")})`);
}

// ---------------------------------------------------------------------------
// Step 3: download the model weights into models/
// ---------------------------------------------------------------------------

async function vendorModel() {
  const modelDir = join(ROOT, "models", MODEL_ID);
  ensureDir(modelDir);

  for (const rel of MODEL_FILES) {
    const url = `${HF_BASE}/${MODEL_ID}/resolve/main/${rel}`;
    await download(url, join(modelDir, rel));
  }

  writeFileSync(
    join(ROOT, "models", "VENDORED.txt"),
    `Model: ${MODEL_ID}\nVendored: ${new Date().toISOString()}\n` +
    `Files: ${MODEL_FILES.join(", ")}\n\n` +
    `These weights are bundled so the extension runs fully offline.\n` +
    `Do not delete — the extension will NOT fetch them at runtime\n` +
    `(env.allowRemoteModels is false in src/offscreen.js).\n`
  );
  log(`model vendored into models/${MODEL_ID}/`);
}

// ---------------------------------------------------------------------------

async function main() {
  log(`root: ${ROOT}`);
  vendorLibrary();
  vendorWasm();
  await vendorModel();

  log("");
  log("Done. Sanity check before loading the extension:");
  log("  - vendor/  should contain transformers*.js");
  log("  - wasm/    should contain ort-wasm-simd-threaded*.wasm (or similar)");
  log(`  - models/${MODEL_ID}/onnx/  should contain model_quantized.onnx`);
  log("");
  log("If a filename differs from what src/offscreen.js expects, fix the");
  log("constant there rather than renaming files — the name encodes the build.");
}

main().catch((err) => {
  console.error("\n[vendor] FAILED:", err.message);
  process.exit(1);
});
