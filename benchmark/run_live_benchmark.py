"""
Live Benchmark Evaluation for ISRO PS #26171
Calls the real FastAPI /api/classify endpoint and measures actual Qwen+rule-based
classification accuracy against ground truth annotations.

Usage:
    python benchmark/run_live_benchmark.py

Requirements:
    - Server running at http://127.0.0.1:8001
    - Ollama running with isro-privacy-qwen:latest
"""

import json
import os
import time
import sys
import urllib.request
import urllib.error

# Ensure stdout handles unicode characters safely on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

SERVER_URL = "http://127.0.0.1:8001"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ANNOTATIONS_FILE = os.path.join(SCRIPT_DIR, "annotations.json")
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "benchmark_results.json")

PII_TYPE_TO_ELEMENT = {
    "password":    {"tag": "input", "type": "password", "name": "password", "id": "password_field"},
    "card_number": {"tag": "input", "type": "text", "name": "cc-number", "id": "card_number", "text": "Card Number"},
    "card_exp":    {"tag": "input", "type": "text", "name": "cc-exp", "id": "card_exp", "text": "Expiry Date"},
    "cvv":         {"tag": "input", "type": "text", "name": "cvv", "id": "cvv", "text": "CVV"},
    "email":       {"tag": "input", "type": "email", "name": "email", "id": "email", "text": "Email Address"},
    "name":        {"tag": "input", "type": "text", "name": "full-name", "id": "name", "text": "Full Name"},
    "national_id": {"tag": "input", "type": "text", "name": "aadhaar", "id": "national_id", "text": "Aadhaar / SSN"},
    "dob":         {"tag": "input", "type": "date", "name": "dob", "id": "dob", "text": "Date of Birth"},
    "face_proxy":  {"tag": "video", "type": "", "name": "webcam", "id": "face_proxy", "text": "Live Webcam Feed"},
    "otp":         {"tag": "input", "type": "text", "name": "otp", "id": "otp", "text": "OTP Code"},
    "pin":         {"tag": "input", "type": "password", "name": "pin", "id": "pin", "text": "PIN"},
    "biometric":   {"tag": "input", "type": "text", "name": "biometric", "id": "biometric", "text": "Biometric / Fingerprint"},
    "doc_image":   {"tag": "input", "type": "file", "name": "document", "id": "doc_image", "text": "Upload Document"},
    "phone":       {"tag": "input", "type": "tel", "name": "phone", "id": "phone", "text": "Phone Number"},
    "address":     {"tag": "input", "type": "text", "name": "address", "id": "address", "text": "Street Address"},
    "ssn":         {"tag": "input", "type": "text", "name": "ssn", "id": "ssn", "text": "SSN / Government ID"},
    "private_key": {"tag": "textarea", "type": "", "name": "private_key", "id": "private_key", "text": "Private Key / Seed Phrase"},
    "telemetry_secret": {"tag": "input", "type": "text", "name": "launch_code", "id": "telemetry_secret", "text": "ISRO Launch Authorization Code"},
}

SENSITIVE_DECISIONS = {"REDACT", "BLOCK", "LOCAL_ONLY"}


def post_json(url, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  Request error: {e}")
        return None


def check_server():
    try:
        req = urllib.request.Request(f"{SERVER_URL}/health", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            health = json.loads(resp.read())
            prov = health.get("api_providers", {})
            print(f"[OK] Server v{health.get('version','?')} at {SERVER_URL}")
            print(f"     Ollama: {'ONLINE' if prov.get('ollama_online') else 'OFFLINE'} | Model: {prov.get('ollama_model','unknown')}")
            return True
    except Exception as e:
        print(f"[ERROR] Cannot reach server: {e}")
        return False


def run_benchmark():
    print("=" * 70)
    print("      ISRO PS #26171 LIVE BENCHMARK (Real Pipeline)")
    print("=" * 70)
    if not check_server():
        sys.exit(1)

    with open(ANNOTATIONS_FILE, "r") as f:
        cases = json.load(f)

    print(f"\nRunning {len(cases)} test cases...\n")
    total_gt = total_tp = total_fp = total_fn = 0
    case_metrics = []
    model_counts = {}

    for case in cases:
        gt_list = case.get("ground_truth_pii", [])
        gt_count = len(gt_list)
        total_gt += gt_count

        if gt_count == 0:
            safe_els = [
                {"tag": "input", "type": "text", "name": "search", "id": "search_box", "text": "Search", "selector": "#search_box", "is_interactive": True},
                {"tag": "button", "type": "submit", "name": "go", "id": "btn_go", "text": "Go", "selector": "#btn_go", "is_interactive": True},
            ]
            resp = post_json(f"{SERVER_URL}/api/classify", {"elements": safe_els, "task": case.get("description", "Navigation")})
            tp, fp, fn = 0, 0, 0
            if resp:
                for d in resp.get("decisions", []):
                    if d.get("decision", "").upper() in SENSITIVE_DECISIONS:
                        fp += 1
                model_counts[resp.get("model_used", "?")] = model_counts.get(resp.get("model_used", "?"), 0) + 1
            precision = 1.0 if fp == 0 else 0.0
            recall = 1.0
            f1 = 1.0 if fp == 0 else 0.0
        else:
            elements = []
            for i, gt in enumerate(gt_list):
                pii_type = gt.get("type", "")
                base = PII_TYPE_TO_ELEMENT.get(pii_type, {"tag": "input", "type": "text", "name": pii_type, "id": pii_type, "text": pii_type.replace("_", " ").title()})
                elements.append({"tag": base.get("tag", "input"), "id": f"{base.get('id',pii_type)}_{i}", "name": base.get("name", pii_type), "type": base.get("type", "text"), "text": base.get("text", gt.get("label", "")), "selector": f"#{base.get('id',pii_type)}_{i}", "is_interactive": True})

            resp = post_json(f"{SERVER_URL}/api/classify", {"elements": elements, "task": case.get("description", "General")})
            tp, fp, fn = 0, 0, 0
            if resp:
                for d in resp.get("decisions", []):
                    if d.get("decision", "").upper() in SENSITIVE_DECISIONS:
                        tp += 1
                    else:
                        fn += 1
                model_counts[resp.get("model_used", "?")] = model_counts.get(resp.get("model_used", "?"), 0) + 1
            else:
                fn = gt_count

            precision = tp / (tp + fp) if (tp + fp) > 0 else 1.0
            recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
            f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

        total_tp += tp; total_fp += fp; total_fn += fn
        icon = "OK" if recall >= 0.9 else ("WARN" if recall >= 0.5 else "FAIL")
        print(f"  [{icon}] [{case['id']}] {case['name'][:38]:38s} GT={gt_count} TP={tp} FP={fp} FN={fn} F1={f1*100:.0f}%")
        case_metrics.append({"id": case["id"], "name": case["name"], "category": case["category"], "ground_truth_pii": gt_count, "tp": tp, "fp": fp, "fn": fn, "precision": round(precision*100,1), "recall": round(recall*100,1), "f1_score": round(f1*100,1)})

    op = total_tp / (total_tp + total_fp) if (total_tp + total_fp) > 0 else 1.0
    or_ = total_tp / (total_tp + total_fn) if (total_tp + total_fn) > 0 else 0.0
    of1 = 2 * (op * or_) / (op + or_) if (op + or_) > 0 else 0.0

    results = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "server": SERVER_URL, "model_used_distribution": model_counts, "total_test_cases": len(cases), "total_ground_truth_pii": total_gt, "total_true_positives": total_tp, "total_false_positives": total_fp, "total_false_negatives": total_fn, "overall_precision": round(op*100,2), "overall_recall": round(or_*100,2), "overall_f1": round(of1*100,2), "case_by_case": case_metrics}

    with open(OUTPUT_FILE, "w") as f:
        json.dump(results, f, indent=2)

    print()
    print("=" * 70)
    print(f"  Precision: {op*100:.2f}%  |  Recall: {or_*100:.2f}%  |  F1: {of1*100:.2f}%")
    print(f"  TP={total_tp}  FP={total_fp}  FN={total_fn}  |  Models: {model_counts}")
    print(f"  Saved: {OUTPUT_FILE}")
    print("=" * 70)


if __name__ == "__main__":
    run_benchmark()
