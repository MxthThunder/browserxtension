#!/usr/bin/env node
/**
 * verify.mjs — the pre-flight check. Run before every demo.
 *
 *   node tools/verify.mjs
 *
 * Covers four things, in order of how badly they bite:
 *
 *   1. Every module's self-tests pass.
 *   2. content.js and detector.js still AGREE. content.js has to inline its
 *      detection rules because MV3 content scripts are not ES modules, so
 *      there are two copies of the logic. Two copies drift. This harness
 *      extracts both and runs them against identical inputs, so drift fails
 *      loudly here rather than showing up as "the overlay flags it but the
 *      payload still leaks it".
 *   3. Static checks: JSON validity, manifest sanity, every file the manifest
 *      references actually exists, no CDN imports left anywhere.
 *   4. The demo page scores precision/recall against its own labelled content,
 *      which is your seed metrics run.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let checks = 0;

const pass = (m) => { checks++; console.log(`  ok    ${m}`); };
const fail = (m) => { checks++; failures++; console.log(`  FAIL  ${m}`); };
const section = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

// ---------------------------------------------------------------------------
section("1. Module self-tests");
// ---------------------------------------------------------------------------

for (const mod of ["coords.js", "detector.js", "redact.js", "metrics.js"]) {
  try {
    const out = execFileSync("node", [join(ROOT, "src", mod)], { encoding: "utf8", stdio: "pipe" });
    const m = out.match(/(\d+) passed, (\d+) failed/);
    if (m && m[2] === "0") pass(`${mod}: ${m[1]} tests passed`);
    else fail(`${mod}: ${m ? m[0] : "no test summary found"}`);
  } catch (err) {
    fail(`${mod} threw: ${String(err.stdout || err.message).split("\n").slice(-4).join(" ")}`);
  }
}

// ---------------------------------------------------------------------------
section("2. content.js <-> detector.js parity");
// ---------------------------------------------------------------------------

/**
 * Pull the inlined scanText implementation out of the content script and eval
 * it in isolation, then compare against the module version on shared inputs.
 */
async function loadContentScanner() {
  const src = readFileSync(join(ROOT, "src", "content.js"), "utf8");

  const grab = (startMarker, endMarker) => {
    const a = src.indexOf(startMarker);
    if (a === -1) throw new Error(`marker not found: ${startMarker}`);
    const b = src.indexOf(endMarker, a);
    if (b === -1) throw new Error(`end marker not found: ${endMarker}`);
    return src.slice(a, b);
  };

  const body = [
    grab("function luhnValid", "function labelHaystack"),
  ].join("\n");

  const factory = new Function(`
    ${body}
    return { scanText, luhnValid, verhoeffValid };
  `);
  return factory();
}

try {
  const contentImpl = await loadContentScanner();
  const mod = await import(join(ROOT, "src", "detector.js"));

  const CASES = [
    "arjun.mehta@example.in",
    "7412 8536 0906",
    "ABCDE1234F",
    "4111 1111 1111 1111",
    "5500 0055 5555 5559",
    "arjun@okicici",
    "HDFC0001234",
    "9876543210",
    "1234 5678 1234 5678",          // the run-guard regression
    "2345 6789 0123",
    "order 999988887777666655554444",
    "52,999 for 16GB RAM",
    "REF-2026-00814",
    "no pii at all here",
    "123-45-6789",
    "Contact a@b.co or c@d.org today",
  ];

  let mismatches = 0;
  for (const c of CASES) {
    const a = contentImpl.scanText(c).map((h) => `${h.id}@${h.index}`).sort().join(",");
    const b = mod.scanText(c).map((h) => `${h.id}@${h.index}`).sort().join(",");
    if (a !== b) {
      mismatches++;
      console.log(`        DRIFT on "${c}"\n          content.js : ${a || "(none)"}\n          detector.js: ${b || "(none)"}`);
    }
  }
  if (mismatches === 0) pass(`detection logic identical across ${CASES.length} inputs`);
  else fail(`${mismatches} input(s) produce different results in content.js vs detector.js`);
} catch (err) {
  fail(`parity check could not run: ${err.message}`);
}

// ---------------------------------------------------------------------------
section("3. Static checks");
// ---------------------------------------------------------------------------

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  pass("manifest.json is valid JSON");
} catch (err) {
  fail(`manifest.json invalid: ${err.message}`);
}

if (manifest) {
  const csp = manifest.content_security_policy?.extension_pages || "";
  csp.includes("wasm-unsafe-eval")
    ? pass("CSP allows wasm-unsafe-eval (required by ORT)")
    : fail("CSP is missing 'wasm-unsafe-eval' — the WASM backend will not initialise");

  manifest.permissions?.includes("offscreen")
    ? pass("offscreen permission present")
    : fail("missing 'offscreen' permission — the inference host cannot be created");

  const refs = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...(manifest.content_scripts?.flatMap((c) => c.js) || []),
  ].filter(Boolean);

  let missing = 0;
  for (const r of refs) {
    if (!existsSync(join(ROOT, r))) { console.log(`        missing: ${r}`); missing++; }
  }
  missing === 0 ? pass(`all ${refs.length} manifest-referenced files exist`)
                : fail(`${missing} manifest-referenced file(s) missing`);
}

// Remote imports are the #1 MV3 CSP failure. The Day 2 harness had one.
const SRC_FILES = ["background.js", "content.js", "offscreen.js", "hud.js", "popup.js",
                   "coords.js", "detector.js", "redact.js", "metrics.js"];
let cdnHits = 0;
for (const f of SRC_FILES) {
  const p = join(ROOT, "src", f);
  if (!existsSync(p)) continue;
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(/(?:from|import)\s*\(?["'](https?:\/\/[^"']+)["']/g)) {
    console.log(`        ${f} imports remote: ${m[1]}`);
    cdnHits++;
  }
}
cdnHits === 0 ? pass("no remote imports in src/ (MV3 CSP would block them)")
              : fail(`${cdnHits} remote import(s) found — these WILL be blocked at runtime`);

// Vendored assets. Check for actual FILES, not just the directory — the
// scaffold creates empty dirs, and "directory exists" would report a
// reassuring green while the model is entirely absent.
for (const [label, path, pattern, hint] of [
  ["Transformers.js bundle", "vendor", /\.(js|mjs)$/, "node tools/vendor-deps.mjs"],
  ["ORT wasm binaries", "wasm", /\.(wasm|mjs)$/, "node tools/vendor-deps.mjs"],
  ["model weights", "models/Xenova/yolos-tiny/onnx", /\.onnx$/, "node tools/vendor-deps.mjs"],
]) {
  const dir = join(ROOT, path);
  let found = 0;
  if (existsSync(dir)) {
    try { found = readdirSync(dir).filter((f) => pattern.test(f)).length; } catch { /* ignore */ }
  }
  if (found > 0) pass(`${label}: ${found} file(s) in ${path}/`);
  else console.log(`  todo  ${label} not vendored yet (${path}/ is empty) — run: ${hint}`);
}

// ---------------------------------------------------------------------------
section("4. Seed metrics on the demo page");
// ---------------------------------------------------------------------------

try {
  const { scanText } = await import(join(ROOT, "src", "detector.js"));

  // Labelled from demo/bank-verification.html. This is the beginning of the
  // Day 5 test set: expand it with real screenshots, keep the format.
  const POSITIVES = [
    "arjun.mehta@example.in", "7412 8536 0906", "7412 8536 1907",
    "ABCDE1234F", "QWERT5678G", "4111 1111 1111 1111", "5500 0055 5555 5559",
    "arjun.mehta@okicici", "arjun@paytm", "HDFC0001234", "SBIN0001234",
    "9876543210", "+91 9876543210",
  ];
  const NEGATIVES = [
    "1234 5678 1234 5678", "2345 6789 0123", "52,999", "REF-2026-00814",
    "TPX1C-16GB-512", "0900 to 1800 IST", "v4.11.2 build 20260415", "BR-4471",
  ];

  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (const s of POSITIVES) (scanText(s).length ? tp++ : (fn++, console.log(`        MISSED: ${s}`)));
  for (const s of NEGATIVES) {
    const h = scanText(s);
    if (h.length) { fp++; console.log(`        FALSE POSITIVE: "${s}" -> ${h.map((x) => x.id).join(",")}`); }
    else tn++;
  }

  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);

  console.log(`\n  TP=${tp}  FN=${fn}  TN=${tn}  FP=${fp}   (n=${POSITIVES.length + NEGATIVES.length} strings)`);
  console.log(`  precision=${precision.toFixed(3)}  recall=${recall.toFixed(3)}  F1=${f1.toFixed(3)}`);
  console.log(`\n  Note for the slide: n is small, so quote the counts alongside the`);
  console.log(`  ratios. These are string-level text metrics only — box-level IoU and`);
  console.log(`  leaked-pixel rate come from the Day 5 screenshot set.`);

  (fn === 0 && fp === 0) ? pass("demo page: no false negatives or false positives")
                         : fail(`demo page: ${fn} miss(es), ${fp} false positive(s)`);
} catch (err) {
  fail(`seed metrics failed: ${err.message}`);
}

// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(56)}`);
console.log(failures === 0
  ? `ALL CHECKS PASSED (${checks})`
  : `${failures} of ${checks} CHECKS FAILED`);
console.log("=".repeat(56));
process.exit(failures === 0 ? 0 : 1);
