"""
Synthetic Dataset Generator for ISRO Privacy Browser Agent
Problem Statement #26171 - Zero-Leakage Privacy Engine

Generates high-quality instruction-tuning pairs for Qwen 2.5 (1.5B)
spanning 5 critical privacy domains:
1. Passwords, Credentials, Private Keys, Crypto Seeds (BLOCK)
2. Indian & Global PII: Aadhaar, PAN, Voter ID, Passport, Phone, Email (REDACT)
3. Aerospace & ISRO Telemetry: Cryogenic stage psi, azimuth, payload mass, launch codes (BLOCK/REDACT)
4. Local Vault & Account Scoped Inputs (LOCAL_ONLY)
5. Non-Sensitive Public UI Elements, Navigation, Search Filters (ALLOW)
"""

import json
import random
import os

SYSTEM_PROMPT = """You are an on-device zero-leakage privacy classification filter for an autonomous browser automation agent.
Classify each web element into one of the following privacy decisions:
- ALLOW: Public info, search queries, navigation labels, safe buttons, filters.
- REDACT: Personal names, Aadhaar, PAN, email addresses, phone numbers, postal addresses, account numbers, government IDs, payroll, health data.
- BLOCK: Passwords, PINs, OTP codes, CVV codes, private encryption keys, authentication tokens, recovery phrases, crypto seeds, mission telemetry secrets, launch authorization codes.
- LOCAL_ONLY: Account settings, user preferences, and internal vault data handled strictly on-device without cloud transmission.

Respond with ONLY a JSON object:
{"decisions": [{"id": "element_id", "decision": "ALLOW" | "REDACT" | "BLOCK" | "LOCAL_ONLY", "reason": "short explanation"}]}"""

SAMPLE_TEMPLATES = [
    # 1. BLOCK: Authentication & Security Credentials
    {"id": "pwd_input", "tag": "input", "label": "Enter Password", "val": "••••••••", "dec": "BLOCK", "reason": "Password field must never leave device."},
    {"id": "otp_field", "tag": "input", "label": "6-Digit One-Time Password (OTP)", "val": "492019", "dec": "BLOCK", "reason": "High-risk time-based authentication code."},
    {"id": "cvv_card", "tag": "input", "label": "Card CVV / Security Code", "val": "831", "dec": "BLOCK", "reason": "Card verification value is strictly blocked from transmission."},
    {"id": "seed_phrase", "tag": "textarea", "label": "Secret 12-Word Recovery Seed", "val": "witch collapse practice feed...", "dec": "BLOCK", "reason": "Cryptographic recovery seed gives full wallet access."},
    {"id": "api_token", "tag": "input", "label": "Private API Bearer Key", "val": "sk-proj-98124...", "dec": "BLOCK", "reason": "Private API key allows unauthorized API usage."},
    {"id": "ssh_key", "tag": "textarea", "label": "RSA / Ed25519 Private Key", "val": "-----BEGIN OPENSSH...", "dec": "BLOCK", "reason": "SSH private key grants server root access."},
    {"id": "pin_code", "tag": "input", "label": "ATM / Transaction PIN", "val": "9021", "dec": "BLOCK", "reason": "Financial transaction PIN must be blocked."},

    # 2. BLOCK & REDACT: ISRO & Aerospace Telemetry
    {"id": "cryo_pressure", "tag": "input", "label": "C25 Cryogenic Stage Chamber Pressure (bar)", "val": "58.4", "dec": "BLOCK", "reason": "Proprietary launch vehicle propulsion telemetry."},
    {"id": "launch_auth", "tag": "input", "label": "SDSC Launch Authorization Security Code", "val": "L-AUTH-7712", "dec": "BLOCK", "reason": "Mission critical launch command clearance code."},
    {"id": "payload_spec", "tag": "textarea", "label": "Confidential Satellite Transponder Frequency Matrix", "val": "Ku-band 14.25 GHz...", "dec": "REDACT", "reason": "Sensitive defense/space communications spectrum."},
    {"id": "orbital_traj", "tag": "input", "label": "GTO Insertion Delta-V Vector (m/s)", "val": "1782.4", "dec": "REDACT", "reason": "Mission orbital trajectory parameters."},
    {"id": "tracking_coord", "tag": "input", "label": "ISTRAC Telemetry Tracking Station Coordinates", "val": "12.9716° N, 77.5946° E", "dec": "REDACT", "reason": "Ground station operational coordinates."},

    # 3. REDACT: Personal Identifiable Information (Indian & Global)
    {"id": "aadhaar_num", "tag": "input", "label": "Aadhaar Card Number (UIDAI)", "val": "5481 9023 1184", "dec": "REDACT", "reason": "Indian National UIDAI 12-digit identity identifier."},
    {"id": "pan_num", "tag": "input", "label": "Permanent Account Number (PAN)", "val": "ABCDE1234F", "dec": "REDACT", "reason": "Indian Income Tax Permanent Account Number."},
    {"id": "voter_id", "tag": "input", "label": "Election Commission EPIC Voter ID", "val": "WBD0912834", "dec": "REDACT", "reason": "Electoral photo identity card number."},
    {"id": "mobile_phone", "tag": "input", "label": "Primary Contact Mobile (+91)", "val": "+91 98450 12345", "dec": "REDACT", "reason": "Direct personal telecommunication number."},
    {"id": "personal_email", "tag": "input", "label": "Personal Email Address", "val": "scientist.isro@gmail.com", "dec": "REDACT", "reason": "Personal email address allows direct contact."},
    {"id": "home_address", "tag": "textarea", "label": "Permanent Residential Address", "val": "Flat 402, Antariksh Apts, ISRO Colony, Bangalore", "dec": "REDACT", "reason": "Physical residential address represents sensitive personal location."},
    {"id": "kin_contact", "tag": "input", "label": "Emergency Next of Kin Contact", "val": "Priya Sharma (Spouse)", "dec": "REDACT", "reason": "Family relationship and emergency personal data."},
    {"id": "salary_slip", "tag": "input", "label": "Monthly Basic Pay (7th CPC)", "val": "₹82,400", "dec": "REDACT", "reason": "Confidential employee salary and compensation."},

    # 4. LOCAL_ONLY: Vault & Account Settings
    {"id": "vault_pref", "tag": "input", "label": "Local Vault Profile Alias", "val": "WorkProfile_A", "dec": "LOCAL_ONLY", "reason": "Local vault identifier injected on-device."},
    {"id": "autofill_tag", "tag": "input", "label": "Credential Tag for Local Keyring", "val": "ISRO_PORTAL", "dec": "LOCAL_ONLY", "reason": "Internal keyring mapping tag."},
    {"id": "browser_sync", "tag": "input", "label": "Local Extension Storage Key", "val": "session_state_v2", "dec": "LOCAL_ONLY", "reason": "Browser-scoped internal state parameter."},

    # 5. ALLOW: Safe Public UI, Search, Navigation
    {"id": "search_query", "tag": "input", "label": "Search missions, satellites or tenders", "val": "Chandrayaan-3 rover findings", "dec": "ALLOW", "reason": "Public scientific information search query."},
    {"id": "category_filter", "tag": "select", "label": "Select Launch Vehicle Category", "val": "LVM3", "dec": "ALLOW", "reason": "Public mission category selection."},
    {"id": "submit_btn", "tag": "button", "label": "View Mission Overview", "val": "", "dec": "ALLOW", "reason": "Safe navigational action button."},
    {"id": "page_next", "tag": "a", "label": "Next Page (Page 2)", "val": "", "dec": "ALLOW", "reason": "Standard pagination hyperlink."},
    {"id": "faq_accordion", "tag": "button", "label": "How do satellites maintain geostationary orbit?", "val": "", "dec": "ALLOW", "reason": "Public FAQ accordion toggle."},
    {"id": "lang_picker", "tag": "select", "label": "Select Language", "val": "English", "dec": "ALLOW", "reason": "Public UI language preference."},
    {"id": "theme_toggle", "tag": "button", "label": "Toggle Dark Mode", "val": "", "dec": "ALLOW", "reason": "Client appearance setting."},
]

def generate_batch_sample(batch_size=3):
    chosen = random.sample(SAMPLE_TEMPLATES, batch_size)
    items_text = []
    expected_decisions = []

    for idx, item in enumerate(chosen):
        id_str = f"el_{idx+1}_{item['id']}"
        items_text.append(f"{idx+1}. ID: \"{id_str}\" | Tag: <{item['tag']}> | Label: \"{item['label']}\" | ValuePreview: \"{item['val']}\"")
        expected_decisions.append({
            "id": id_str,
            "decision": item["dec"],
            "reason": item["reason"]
        })

    user_prompt = f"Elements to classify:\n" + "\n".join(items_text)
    assistant_response = json.dumps({"decisions": expected_decisions}, indent=2)

    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
            {"role": "assistant", "content": assistant_response}
        ]
    }

def main():
    output_dir = os.path.dirname(__file__)
    output_path = os.path.join(output_dir, "isro_privacy_dataset.jsonl")
    
    num_samples = 600
    print(f"Generating {num_samples} fine-tuning pairs for Qwen 2.5 (1.5B)...")
    
    with open(output_path, "w", encoding="utf-8") as f:
        for _ in range(num_samples):
            # Batches of 2 to 4 elements to mirror realistic DOM scan batches
            batch_size = random.choice([2, 3, 4])
            sample = generate_batch_sample(batch_size=batch_size)
            f.write(json.dumps(sample) + "\n")

    print(f"[OK] Dataset written to: {output_path} ({os.path.getsize(output_path) // 1024} KB)")

if __name__ == "__main__":
    main()
