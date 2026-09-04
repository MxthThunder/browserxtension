/**
 * Unit Test Suite for DOM PII Scanner & Coordinate Logic
 */

const assert = require("assert");

console.log("🧪 Running Visual Privacy Perception Unit Tests...\n");

// Test 1: Autocomplete Token Matcher
const SENSITIVE_AUTOCOMPLETE_TOKENS = [
  "cc-number", "cc-exp", "cc-csc", "email", "tel", "current-password", "new-password", "one-time-code"
];

function isSensitiveAutocomplete(token) {
  return SENSITIVE_AUTOCOMPLETE_TOKENS.some((t) => token.includes(t));
}

assert.strictEqual(isSensitiveAutocomplete("cc-number"), true, "Should flag cc-number");
assert.strictEqual(isSensitiveAutocomplete("current-password"), true, "Should flag current-password");
assert.strictEqual(isSensitiveAutocomplete("off"), false, "Should not flag off");
console.log("✓ Test 1: Autocomplete token classification passed.");

// Test 2: Field Name & Regex Pattern
const SENSITIVE_NAME_PATTERN =
  /pass(word)?|ssn|aadhar|aadhaar|passport|credit|card.?number|cvv|cvc|pin\b|otp|email|phone|mobile|dob|birth|address|salary|account.?number|ifsc|pan[_\b]/i;

assert.strictEqual(SENSITIVE_NAME_PATTERN.test("user_password_input"), true);
assert.strictEqual(SENSITIVE_NAME_PATTERN.test("aadhaar_number"), true);
assert.strictEqual(SENSITIVE_NAME_PATTERN.test("credit_card_cvv"), true);
assert.strictEqual(SENSITIVE_NAME_PATTERN.test("pan_card_holder"), true);
assert.strictEqual(SENSITIVE_NAME_PATTERN.test("search_query"), false);
assert.strictEqual(SENSITIVE_NAME_PATTERN.test("submit_button"), false);
console.log("✓ Test 2: PII Regex pattern matching passed.");

// Test 3: Face Proxy Calculation
function computeFaceProxy(personBox, sliceRatio = 0.30) {
  const { xmin, ymin, xmax, ymax } = personBox;
  const w = xmax - xmin;
  const h = ymax - ymin;
  return {
    x: xmin,
    y: ymin,
    w,
    h: h * sliceRatio,
  };
}

const mockPersonBox = { xmin: 100, ymin: 200, xmax: 300, ymax: 600 }; // w=200, h=400
const faceBox = computeFaceProxy(mockPersonBox, 0.30);
assert.strictEqual(faceBox.w, 200);
assert.strictEqual(faceBox.h, 120); // 400 * 0.30 = 120
assert.strictEqual(faceBox.y, 200); // starts at top of person
console.log("✓ Test 3: 30% upper vertical face proxy calculation passed.");

console.log("\n🎉 ALL 3 TEST SUITES PASSED (100% SUCCESS)!");
