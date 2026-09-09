/**
 * Comprehensive Component Verification Test Suite
 * Tests:
 * 1. OWL-ViT Model & Config Assets
 * 2. MediaPipe Face Detection Assets & Bundle
 * 3. Tesseract OCR WASM & Core Assets & Regex Engine
 * 4. Qwen / Local Reasoner Decision Logic & Rules
 * 5. Unified Perception & Semantic Roles
 * 6. Privacy Engine & Zero-Leakage Blackout Manifest
 */

import fs from "fs";
import path from "path";
import assert from "assert";
import { fileURLToPath } from "url";

import { SEMANTIC_ROLES, computeIoU, computeContainment, determineSemanticRole, buildUnifiedPerceptionState } from "../pii-agent-extension/perception.js";
import { LocalPrivacyEngine, PRIVACY_DECISIONS, SANITIZATION_STRATEGIES } from "../pii-agent-extension/privacy_engine.js";
import { LocalPrivacyReasoner } from "../pii-agent-extension/local_reasoner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_DIR = path.resolve(__dirname, "../pii-agent-extension");

console.log("================================================================");
console.log("🚀 STARTING PRIVYBROWSE-X COMPREHENSIVE COMPONENT VERIFICATION");
console.log("================================================================\n");

async function runAllTests() {
  const tests = [];
  function test(name, fn) {
    tests.push({ name, fn });
  }

  // ============================================================================
  // 1. OWL-ViT ASSETS VERIFICATION
  // ============================================================================
  test("OWL-ViT Model Quantized ONNX weights exist and have valid size (>100MB)", () => {
    const modelPath = path.join(EXT_DIR, "models/Xenova/owlvit-base-patch32/onnx/model_quantized.onnx");
    assert.ok(fs.existsSync(modelPath), `Missing ${modelPath}`);
    const stats = fs.statSync(modelPath);
    assert.ok(stats.size > 100 * 1024 * 1024, `Model size too small: ${stats.size} bytes`);
  });

  test("OWL-ViT Tokenizer & Preprocessor configs exist and are valid JSON", () => {
    const configPath = path.join(EXT_DIR, "models/Xenova/owlvit-base-patch32/config.json");
    const prepPath = path.join(EXT_DIR, "models/Xenova/owlvit-base-patch32/preprocessor_config.json");
    const tokPath = path.join(EXT_DIR, "models/Xenova/owlvit-base-patch32/tokenizer.json");
    
    assert.ok(fs.existsSync(configPath), "Missing config.json");
    assert.ok(fs.existsSync(prepPath), "Missing preprocessor_config.json");
    assert.ok(fs.existsSync(tokPath), "Missing tokenizer.json");

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.strictEqual(config.model_type, "owlvit", "Invalid model_type in config.json");
  });

  test("Transformers.js & ONNX Runtime WASM binaries exist", () => {
    const tfJs = path.join(EXT_DIR, "lib/transformers.min.js");
    const ortWasmSimd = path.join(EXT_DIR, "lib/ort-wasm-simd.wasm");
    const ortWasm = path.join(EXT_DIR, "lib/ort-wasm.wasm");
    assert.ok(fs.existsSync(tfJs), "Missing transformers.min.js");
    assert.ok(fs.existsSync(ortWasmSimd), "Missing ort-wasm-simd.wasm");
    assert.ok(fs.existsSync(ortWasm), "Missing ort-wasm.wasm");
  });

  // ============================================================================
  // 2. MEDIAPIPE FACE DETECTION ASSETS VERIFICATION
  // ============================================================================
  test("MediaPipe BlazeFace TFLite model exists and has valid size (>200KB)", () => {
    const tflitePath = path.join(EXT_DIR, "lib/mediapipe/blaze_face_short_range.tflite");
    assert.ok(fs.existsSync(tflitePath), "Missing blaze_face_short_range.tflite");
    const size = fs.statSync(tflitePath).size;
    assert.ok(size > 200 * 1024, `TFLite model size unexpected: ${size} bytes`);
  });

  test("MediaPipe Vision WASM and ESM bundle exist", () => {
    const wasm = path.join(EXT_DIR, "lib/mediapipe/vision_wasm_internal.wasm");
    const bundle = path.join(EXT_DIR, "lib/mediapipe/vision_bundle.mjs");
    assert.ok(fs.existsSync(wasm), "Missing vision_wasm_internal.wasm");
    assert.ok(fs.existsSync(bundle), "Missing vision_bundle.mjs");
  });

  // ============================================================================
  // 3. TESSERACT OCR ASSETS & REGEX ENGINE VERIFICATION
  // ============================================================================
  test("Tesseract Core WASM, Worker and Trained Data exist", () => {
    const worker = path.join(EXT_DIR, "lib/tesseract/worker.min.js");
    const coreWasm = path.join(EXT_DIR, "lib/tesseract/tesseract-core.wasm");
    const trainedData = path.join(EXT_DIR, "lib/tesseract/eng.traineddata.gz");
    assert.ok(fs.existsSync(worker), "Missing worker.min.js");
    assert.ok(fs.existsSync(coreWasm), "Missing tesseract-core.wasm");
    assert.ok(fs.existsSync(trainedData), "Missing eng.traineddata.gz");
  });

  test("OCR PII Pattern Regex matching handles all critical PII formats", () => {
    const OCR_PII_PATTERNS = [
      { category: "creditCards", label: "Credit Card Number", re: /\b(?:\d[ -]?){13,16}\b/ },
      { category: "govIds",      label: "Aadhaar Number",     re: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
      { category: "govIds",      label: "SSN",                re: /\b\d{3}-\d{2}-\d{4}\b/ },
      { category: "govIds",      label: "PAN Card",           re: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
      { category: "govIds",      label: "Passport Number",    re: /\b[A-Z]\d{7}\b/ },
      { category: "contactInfo", label: "Email Address",      re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/ },
      { category: "contactInfo", label: "Phone Number",       re: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
      { category: "govIds",      label: "Bank IFSC Code",     re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
      { category: "govIds",      label: "Account Number",     re: /\b\d{9,18}\b/ },
    ];

    function matchOCR(text) {
      return OCR_PII_PATTERNS.find(p => p.re.test(text));
    }

    assert.ok(matchOCR("4532 7512 8934 1123"), "Should match Credit Card");
    assert.ok(matchOCR("9876 5432 1098"), "Should match Aadhaar");
    assert.ok(matchOCR("123-45-6789"), "Should match SSN");
    assert.ok(matchOCR("ABCDE1234F"), "Should match PAN");
    assert.ok(matchOCR("A1234567"), "Should match Passport");
    assert.ok(matchOCR("user.test@isro.gov.in"), "Should match Email");
    assert.ok(matchOCR("+1 555-432-1098"), "Should match Phone (intl standard)");
    assert.ok(matchOCR("(555) 123-4567"), "Should match Phone (bracketed)");
    assert.ok(matchOCR("SBIN0123456"), "Should match IFSC");
    assert.ok(matchOCR("123456789012"), "Should match Account Number");
  });

  // ============================================================================
  // 4. UNIFIED PERCEPTION & SEMANTIC ROLES VERIFICATION
  // ============================================================================
  test("IoU and Containment calculation accuracy", () => {
    const boxA = { x: 10, y: 10, w: 100, h: 100 };
    const boxB = { x: 10, y: 10, w: 100, h: 100 };
    assert.strictEqual(computeIoU(boxA, boxB), 1.0);

    const boxC = { x: 60, y: 10, w: 100, h: 100 };
    const iou = computeIoU(boxA, boxC);
    assert.ok(Math.abs(iou - (5000 / 15000)) < 0.001);

    const inner = { x: 20, y: 20, w: 40, h: 40 };
    assert.strictEqual(computeContainment(inner, boxA), 1.0);
  });

  test("Semantic role mapping for Multi-Modal inputs (DOM, OWL-ViT, MediaPipe, OCR)", () => {
    // MediaPipe Face
    assert.strictEqual(
      determineSemanticRole(null, null, { source: "MediaPipe-Face", label: "Face" }),
      SEMANTIC_ROLES.BIOMETRIC_FACE
    );

    // OWL-ViT Credit Card & Passport
    assert.strictEqual(
      determineSemanticRole(null, null, { source: "OWL-ViT", label: "credit card" }),
      SEMANTIC_ROLES.PHYSICAL_CREDENTIAL
    );
    assert.strictEqual(
      determineSemanticRole(null, null, { source: "OWL-ViT", label: "passport" }),
      SEMANTIC_ROLES.PHYSICAL_CREDENTIAL
    );

    // OCR Pattern
    assert.strictEqual(
      determineSemanticRole(null, { pattern: "CREDIT_CARD" }, null),
      SEMANTIC_ROLES.CREDIT_CARD_FIELD
    );
    assert.strictEqual(
      determineSemanticRole(null, { pattern: "AADHAAR" }, null),
      SEMANTIC_ROLES.GOV_ID_FIELD
    );

    // DOM password field
    assert.strictEqual(
      determineSemanticRole({ type: "password", name: "user_pwd" }, null, null),
      SEMANTIC_ROLES.PASSWORD_FIELD
    );
  });

  test("buildUnifiedPerceptionState fuses DOM, OWL-ViT, MediaPipe, and OCR into unified elements", () => {
    const state = buildUnifiedPerceptionState({
      domElements: [
        { id: "pwInput", tagName: "INPUT", type: "password", name: "pwd", label: "Password", x: 50, y: 100, w: 200, h: 40, isSensitive: true, category: "passwords" },
        { id: "btnSubmit", tagName: "BUTTON", type: "submit", text: "Log In", x: 50, y: 160, w: 100, h: 40 }
      ],
      domSensitiveBoxes: [
        { x: 50, y: 100, w: 200, h: 40, category: "passwords", reason: "Password input" }
      ],
      owlvitDetections: [
        { source: "OWL-ViT", label: "passport", category: "govIds", x: 400, y: 100, w: 150, h: 100, confidence: 0.88 }
      ],
      faceDetections: [
        { source: "MediaPipe-Face", label: "Face", category: "faces", x: 600, y: 80, w: 80, h: 80, confidence: 0.95 }
      ],
      ocrDetections: [
        { source: "OCR", label: "OCR: Aadhaar Number", category: "govIds", x: 410, y: 120, w: 120, h: 20, confidence: 0.9 }
      ],
      viewport: { width: 1280, height: 800, dpr: 1 },
      url: "https://isro.gov.in/portal"
    });

    assert.ok(state.elements.length >= 4, `Expected at least 4 unified elements, got ${state.elements.length}`);
    
    // Verify sources
    const sources = state.elements.flatMap(e => e.sources);
    assert.ok(sources.includes("DOM"), "Should contain DOM source");
    assert.ok(sources.includes("OWL-ViT"), "Should contain OWL-ViT source");
    assert.ok(sources.includes("MediaPipe-Face"), "Should contain MediaPipe-Face source");
  });

  // ============================================================================
  // 5. PRIVACY ENGINE & ZERO-LEAKAGE MANIFEST VERIFICATION
  // ============================================================================
  test("Privacy Engine evaluates unified state with BLOCK, REDACT, and ALLOW rules", () => {
    const engine = new LocalPrivacyEngine();
    const state = buildUnifiedPerceptionState({
      domElements: [
        { id: "pwInput", tagName: "INPUT", type: "password", name: "pwd", label: "Password", x: 50, y: 100, w: 200, h: 40, isSensitive: true, category: "passwords" },
        { id: "btnSubmit", tagName: "BUTTON", type: "submit", text: "Log In", x: 50, y: 160, w: 100, h: 40 }
      ],
      owlvitDetections: [
        { source: "OWL-ViT", label: "credit card", category: "creditCards", x: 400, y: 100, w: 150, h: 100, confidence: 0.9 }
      ],
      faceDetections: [
        { source: "MediaPipe-Face", label: "Face", category: "faces", x: 600, y: 80, w: 80, h: 80, confidence: 0.95 }
      ]
    });

    const manifest = engine.evaluatePerceptionState(state);
    assert.ok(manifest.decisions.length >= 4, `Expected at least 4 decisions, got ${manifest.decisions.length}`);

    const pwDec = manifest.decisions.find(d => d.element.role === SEMANTIC_ROLES.PASSWORD_FIELD);
    assert.ok(pwDec, "Password decision should exist");
    assert.strictEqual(pwDec.decision, PRIVACY_DECISIONS.BLOCK);
    assert.strictEqual(pwDec.strategy, SANITIZATION_STRATEGIES.OMIT_AND_BLACKOUT);

    const btnDec = manifest.decisions.find(d => d.element.role === SEMANTIC_ROLES.BUTTON);
    assert.ok(btnDec, "Button decision should exist");
    assert.strictEqual(btnDec.decision, PRIVACY_DECISIONS.ALLOW);

    const cardDec = manifest.decisions.find(d => d.element.role === SEMANTIC_ROLES.PHYSICAL_CREDENTIAL);
    assert.ok(cardDec, "Card decision should exist");
    assert.strictEqual(cardDec.decision, PRIVACY_DECISIONS.REDACT);

    const faceDec = manifest.decisions.find(d => d.element.role === SEMANTIC_ROLES.BIOMETRIC_FACE);
    assert.ok(faceDec, "Face decision should exist");
    assert.strictEqual(faceDec.decision, PRIVACY_DECISIONS.REDACT);
  });

  // ============================================================================
  // 6. LOCAL REASONER / QWEN DECISION BOUNDARIES VERIFICATION
  // ============================================================================
  test("LocalPrivacyReasoner fastpath rules correctly classify credentials and safe controls", async () => {
    const reasoner = new LocalPrivacyReasoner();

    // Test 1: High-risk passcode / secret / recovery phrase should BLOCK
    const res1 = await reasoner.resolveAmbiguity({
      type: "password",
      label: "Security Passcode",
      text: "Secret Auth Code",
    });
    assert.strictEqual(res1.decision, PRIVACY_DECISIONS.BLOCK);

    // Test 2: Medical / salary should REDACT
    const res2 = await reasoner.resolveAmbiguity({
      type: "input",
      label: "Medical Diagnosis",
      text: "Patient confidential diagnosis",
    });
    assert.strictEqual(res2.decision, PRIVACY_DECISIONS.REDACT);

    // Test 3: Search input / safe button should ALLOW
    const res3 = await reasoner.resolveAmbiguity({
      type: "submit",
      label: "Search Products",
      text: "Search catalog",
    });
    assert.strictEqual(res3.decision, PRIVACY_DECISIONS.ALLOW);
  });

  // Run all registered tests
  let passedCount = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✅ [PASS] ${t.name}`);
      passedCount++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${t.name}:`, err.message);
    }
  }

  console.log("\n================================================================");
  console.log(`📊 TEST SUMMARY: ${passedCount} / ${tests.length} PASSED`);
  console.log("================================================================\n");

  if (passedCount !== tests.length) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
