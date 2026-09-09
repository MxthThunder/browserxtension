"""
Server & Qwen Reasoner Verification Test Suite
Tests:
1. FastAPI app initialization & health endpoint
2. Universal Prompt / Qwen reasoner fallback and structured action generation
3. Sanitized zero-leakage payload processing
"""

import sys
import os
import unittest
from fastapi.testclient import TestClient

# Ensure server module is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from server.app import app

client = TestClient(app)

class TestServerAndQwenReasoner(unittest.TestCase):

    def test_health_endpoint(self):
        response = client.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "healthy")
        self.assertTrue(data["redaction_aware"])
        self.assertIn("click", data["supported_actions"])
        print("  [PASS] /health endpoint healthy and redaction-aware")

    def test_log_endpoint(self):
        response = client.post("/api/log", json={
            "source": "test-runner",
            "level": "info",
            "message": "Testing telemetry endpoint",
            "details": {"test": True}
        })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])
        print("  [PASS] /api/log telemetry endpoint functional")

    def test_act_endpoint_with_sanitized_context(self):
        # Simulated sanitized DOM digest (Zero raw PII)
        payload = {
            "task": "Click on the Search button to find ISRO missions",
            "sanitized_image_base64": None,
            "dom_elements": [
                {
                    "tag": "input",
                    "id": "search_input",
                    "type": "search",
                    "text": "",
                    "selector": "#search_input",
                    "role": "search_input",
                    "rect": {"x": 100, "y": 50, "width": 200, "height": 30}
                },
                {
                    "tag": "button",
                    "id": "search_btn",
                    "type": "submit",
                    "text": "Search Missions",
                    "selector": "#search_btn",
                    "role": "button",
                    "rect": {"x": 310, "y": 50, "width": 120, "height": 30}
                }
            ],
            "redaction_manifest": [
                {
                    "source": "OWL-ViT",
                    "label": "credit card",
                    "box": [400, 100, 150, 100]
                }
            ],
            "model_provider": "auto",
            "step": 1,
            "max_steps": 8
        }

        response = client.post("/api/act", json=payload)
        self.assertEqual(response.status_code, 200)
        res_data = response.json()
        self.assertIn(res_data["status"], ["success", "executing"])
        self.assertIn("action", res_data)
        action = res_data["action"]
        self.assertIn(action["type"], ["click", "type", "navigate", "submit"])
        print(f"  [PASS] /api/act generated action: {action['type']} -> {action.get('selector', action.get('explanation'))} (Model: {res_data.get('model_used')})")

    def test_act_endpoint_blocks_leakage_of_passwords(self):
        # Test case: User prompt asking to interact with form, verifying secret password inputs remain protected
        payload = {
            "task": "Enter username 'isro_scientist' into username field",
            "dom_elements": [
                {
                    "tag": "input",
                    "id": "user_name_input",
                    "type": "text",
                    "name": "username",
                    "selector": "#user_name_input",
                    "role": "username_field"
                },
                {
                    "tag": "input",
                    "id": "user_password_input",
                    "type": "password",
                    "name": "password",
                    "selector": "#user_password_input",
                    "role": "password_field"
                }
            ],
            "model_provider": "auto"
        }

        response = client.post("/api/act", json=payload)
        self.assertEqual(response.status_code, 200)
        res_data = response.json()
        action = res_data["action"]
        # Action should target the username field, never leak password
        self.assertNotEqual(action.get("selector"), "#user_password_input")
        print(f"  [PASS] Zero-Leakage: Safe target selected ({action.get('selector')}), password input unexposed")

if __name__ == "__main__":
    print("\n================================================================")
    print("[SERVER TEST] RUNNING SERVER & VLM REASONER TEST SUITE")
    print("================================================================")
    unittest.main(verbosity=2)
