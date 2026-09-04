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
    # ORT WASM (ONNX Runtime Web 1.14.0 matching @xenova/transformers 2.17.2)
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm.wasm",
        "lib/ort-wasm.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm-simd.wasm",
        "lib/ort-wasm-simd.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm-threaded.wasm",
        "lib/ort-wasm-threaded.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm-simd-threaded.wasm",
        "lib/ort-wasm-simd-threaded.wasm",
    ),
    # Tesseract.js & Local Core WASM
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js",
        "lib/tesseract/tesseract.min.js",
    ),
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/worker.min.js",
        "lib/tesseract/worker.min.js",
    ),
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js",
        "lib/tesseract/tesseract-core.wasm.js",
    ),
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm",
        "lib/tesseract/tesseract-core.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core-simd.wasm",
        "lib/tesseract/tesseract-core-simd.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core-simd-lstm.wasm",
        "lib/tesseract/tesseract-core-simd-lstm.wasm",
    ),
    (
        "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core-lstm.wasm",
        "lib/tesseract/tesseract-core-lstm.wasm",
    ),
    (
        "https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz",
        "lib/tesseract/eng.traineddata.gz",
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
    # MediaPipe Face Model
    (
        "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite",
        "lib/mediapipe/blaze_face_short_range.tflite",
    ),
    # OWL-ViT Model Configs & Weights (Transformers.js / ONNX)
    (
        "https://huggingface.co/Xenova/owlvit-base-patch32/raw/main/config.json",
        "models/Xenova/owlvit-base-patch32/config.json",
    ),
    (
        "https://huggingface.co/Xenova/owlvit-base-patch32/raw/main/preprocessor_config.json",
        "models/Xenova/owlvit-base-patch32/preprocessor_config.json",
    ),
    (
        "https://huggingface.co/Xenova/owlvit-base-patch32/raw/main/tokenizer.json",
        "models/Xenova/owlvit-base-patch32/tokenizer.json",
    ),
    (
        "https://huggingface.co/Xenova/owlvit-base-patch32/raw/main/tokenizer_config.json",
        "models/Xenova/owlvit-base-patch32/tokenizer_config.json",
    ),
    (
        "https://huggingface.co/Xenova/owlvit-base-patch32/raw/main/special_tokens_map.json",
        "models/Xenova/owlvit-base-patch32/special_tokens_map.json",
    ),
    (
        "https://huggingface.co/Xenova/owlvit-base-patch32/resolve/main/onnx/model_quantized.onnx",
        "models/Xenova/owlvit-base-patch32/onnx/model_quantized.onnx",
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
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
        size_kb = os.path.getsize(dest) // 1024
        print(f"          -> {size_kb} KB")
    except Exception as e:
        print(f"  [FAIL]  {dest_rel}: {e}", file=sys.stderr)


if __name__ == "__main__":
    print("=" * 60)
    print("PrivyBrowse-X -- Vendor File Setup")
    print("=" * 60)
    for url, dest in FILES:
        download(url, dest)
    print()
    print(MODEL_INSTRUCTIONS)
    print("=" * 60)
    print("Done. Reload the extension at chrome://extensions")

