#!/usr/bin/env python3
"""
setup_vendor.py — Downloads all large vendor/library files that are excluded from git.

These files are NOT committed to git because:
  1. transformers.min.js / transformers.web.min.js contain token-like strings that
     trigger GitHub's secret scanning push protection (false positives).
  2. ONNX model weights (.onnx) and WASM binaries (.wasm) exceed GitHub's 100MB limit.

Run this script once after cloning:
    python setup_vendor.py
"""

import os
import sys
import urllib.request
import shutil

BASE = os.path.join(os.path.dirname(__file__), "pii-agent-extension")

FILES = [
    # Transformers.js (Hugging Face)
    (
        "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js",
        "lib/transformers.min.js",
    ),
    (
        "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.web.min.js",
        "lib/transformers.web.min.js",
    ),
    # ORT WASM (ONNX Runtime Web)
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort-wasm-simd-threaded.asyncify.mjs",
        "lib/ort-wasm-simd-threaded.asyncify.mjs",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort-wasm-simd-threaded.asyncify.wasm",
        "lib/ort-wasm-simd-threaded.asyncify.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort-wasm-simd-threaded.jsep.mjs",
        "lib/ort-wasm-simd-threaded.jsep.mjs",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort-wasm-simd-threaded.jsep.wasm",
        "lib/ort-wasm-simd-threaded.jsep.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort-wasm-simd-threaded.mjs",
        "lib/ort-wasm-simd-threaded.mjs",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort-wasm-simd-threaded.wasm",
        "lib/ort-wasm-simd-threaded.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort-wasm-simd.wasm",
        "lib/ort-wasm-simd.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort-wasm.wasm",
        "lib/ort-wasm.wasm",
    ),
    # Tesseract.js
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js",
        "lib/tesseract/tesseract.min.js",
    ),
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/worker.min.js",
        "lib/tesseract/worker.min.js",
    ),
    # MediaPipe Vision
    (
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js",
        "lib/mediapipe/vision_wasm_internal.js",
    ),
    (
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm",
        "lib/mediapipe/vision_wasm_internal.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.js",
        "lib/mediapipe/vision_wasm_nosimd_internal.js",
    ),
    (
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.wasm",
        "lib/mediapipe/vision_wasm_nosimd_internal.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
        "lib/mediapipe/vision_bundle.mjs",
    ),
]

MODEL_INSTRUCTIONS = """
NOTE: OWL-ViT ONNX model weights are NOT downloaded automatically.
The model must be downloaded separately and placed at:
  pii-agent-extension/models/Xenova/owlvit-base-patch32/onnx/model.onnx   (~148MB)
  pii-agent-extension/models/Xenova/owlvit-base-patch32/onnx/model_quantized.onnx

Download from Hugging Face:
  https://huggingface.co/Xenova/owlvit-base-patch32/tree/main/onnx

IMPORTANT: Use the Float32-patched versions from the project maintainer, not the
           raw HuggingFace export (the HF export has a DOUBLE Cast node that
           crashes ONNX Runtime Web WASM).
"""


def download(url, dest_rel):
    dest = os.path.join(BASE, dest_rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        print(f"  [SKIP]  {dest_rel} (already exists)")
        return
    print(f"  [DL]    {dest_rel} ...")
    try:
        with urllib.request.urlopen(url, timeout=60) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
        size_kb = os.path.getsize(dest) // 1024
        print(f"          → {size_kb} KB")
    except Exception as e:
        print(f"  [FAIL]  {dest_rel}: {e}", file=sys.stderr)


if __name__ == "__main__":
    print("=" * 60)
    print("PrivyBrowse-X — Vendor File Setup")
    print("=" * 60)
    for url, dest in FILES:
        download(url, dest)
    print()
    print(MODEL_INSTRUCTIONS)
    print("=" * 60)
    print("Done. Reload the extension at chrome://extensions")
