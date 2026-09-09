// Native fetch available in Node.js 22+

const TEST_CASES = [
  // 1. BLOCK: Credentials, Passwords, Security Keys, Telemetry secrets
  { id: "c1", tag: "input", label: "Master Password", val: "••••••••", expected: "BLOCK", reason: "Password field" },
  { id: "c2", tag: "input", label: "One-Time Password (OTP)", val: "894210", expected: "BLOCK", reason: "OTP Code" },
  { id: "c3", tag: "input", label: "Card Security Code (CVV)", val: "731", expected: "BLOCK", reason: "CVV Code" },
  { id: "c4", tag: "textarea", label: "Wallet Seed Recovery Phrase", val: "witch collapse practice...", expected: "BLOCK", reason: "Crypto seed phrase" },
  { id: "c5", tag: "input", label: "ISRO Telemetry Flight Access Token", val: "isro_sec_9941a8e", expected: "BLOCK", reason: "Mission secret / access token" },

  // 2. REDACT: Personal identifiers, Aadhaar, PAN, Emails, Phones, Health
  { id: "p1", tag: "input", label: "Aadhaar Card Number", val: "4920 1823 9012", expected: "REDACT", reason: "National ID" },
  { id: "p2", tag: "input", label: "Permanent Account Number (PAN)", val: "ABCDE1234F", expected: "REDACT", reason: "Tax ID" },
  { id: "p3", tag: "input", label: "Personal Email Address", val: "scientist.rohit@isro.gov.in", expected: "REDACT", reason: "Personal email" },
  { id: "p4", tag: "input", label: "Contact Phone Number", val: "+91 9876543210", expected: "REDACT", reason: "Mobile phone" },
  { id: "p5", tag: "textarea", label: "Patient Clinical Diagnosis", val: "Type 2 diabetes, Hypertension", expected: "REDACT", reason: "Medical record" },
  { id: "p6", tag: "input", label: "Monthly Gross Salary", val: "₹1,85,000", expected: "REDACT", reason: "Financial/Payroll info" },

  // 3. ALLOW: Public controls, search queries, pagination, safe buttons
  { id: "a1", tag: "input", label: "Search Chandrayaan-3 Mission Data", val: "pragyan rover spectrography", expected: "ALLOW", reason: "Public search query" },
  { id: "a2", tag: "button", label: "Next Page", val: "Page 2 of 50", expected: "ALLOW", reason: "Pagination navigation" },
  { id: "a3", tag: "select", label: "Sort Mission Archives", val: "Date: Newest First", expected: "ALLOW", reason: "Catalog sorting" },
  { id: "a4", tag: "a", label: "Read ISRO Public Press Release", val: "Press Release #402", expected: "ALLOW", reason: "Public article link" },

  // 4. LOCAL_ONLY: Vault / Browser settings
  { id: "l1", tag: "input", label: "Preferred UI Theme", val: "Dark Space Blue", expected: "LOCAL_ONLY", reason: "Local user preference" },
  { id: "l2", tag: "input", label: "Auto-Refresh Telemetry Interval", val: "5000ms", expected: "LOCAL_ONLY", reason: "Local browser setting" }
];

async function classifyElement(item) {
  const prompt = `Classify this web element for privacy handling:
- Label/Placeholder: "${item.label}"
- Input Tag/Type: <${item.tag}>
- Current Value: "${item.val}"
- Context: ${item.reason}

Decide: ALLOW, REDACT, BLOCK, or LOCAL_ONLY.
Respond with ONLY JSON: {"decision": "ALLOW"|"REDACT"|"BLOCK"|"LOCAL_ONLY", "reason": "short explanation"}`;

  try {
    const resp = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "isro-privacy-qwen",
        prompt: prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.0,
          top_p: 0.5
        }
      })
    });
    if (!resp.ok) return { decision: "ERROR", reason: resp.statusText };
    const json = await resp.json();
    let text = (json.response || "").trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
    return JSON.parse(text);
  } catch (err) {
    return { decision: "ERROR", reason: err.message };
  }
}

async function runBenchmark() {
  console.log("================================================================");
  console.log("🎯 RUNNING ACCURACY BENCHMARK ON 'isro-privacy-qwen'");
  console.log("================================================================\n");

  let correctCount = 0;
  console.log("┌──────┬──────────────────────────────────────┬──────────┬──────────┬───────────┬────────┐");
  console.log("│ ID   │ Element Label / Description          │ Expected │ Qwen Got │ Status    │ Engine │");
  console.log("├──────┼──────────────────────────────────────┼──────────┼──────────┼───────────┼────────┤");

  const startAll = Date.now();
  for (const tc of TEST_CASES) {
    const res = await classifyElement(tc);
    const gotDecision = (res.decision || "UNKNOWN").toUpperCase();
    const isCorrect = gotDecision === tc.expected;
    if (isCorrect) correctCount++;

    const paddedLabel = (tc.label.length > 36 ? tc.label.substring(0, 33) + "..." : tc.label).padEnd(36, " ");
    const paddedExp = tc.expected.padEnd(8, " ");
    const paddedGot = gotDecision.padEnd(8, " ");
    const status = isCorrect ? "✅ PASS   " : "❌ FAIL   ";

    console.log(`│ ${tc.id.padEnd(4, " ")} │ ${paddedLabel} │ ${paddedExp} │ ${paddedGot} │ ${status} │ Qwen   │`);
  }
  console.log("└──────┴──────────────────────────────────────┴──────────┴──────────┴───────────┴────────┘");

  const totalTime = Date.now() - startAll;
  const accuracy = (correctCount / TEST_CASES.length) * 100;
  console.log(`\n⏱️ Total Benchmark Latency: ${totalTime} ms (${(totalTime / TEST_CASES.length).toFixed(1)} ms / element)`);
  console.log(`🎯 Accuracy Score: ${correctCount} / ${TEST_CASES.length} (${accuracy.toFixed(1)}%)\n`);
}

runBenchmark().catch(err => {
  console.error("Fatal benchmark error:", err);
  process.exit(1);
});
