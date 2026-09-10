"""
Tests for the shared action-planning prompt layer in server/app.py.

Covers the accuracy guards: task-kind routing, target resolution (the defence
against hallucinated selectors), digest trimming and outcome-aware history.

Run:  python scripts/test_action_planning.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))

from app import (  # noqa: E402
    ACTION_RESPONSE_SCHEMA,
    ACTION_TYPES,
    DOMElement,
    build_action_output,
    build_elements_digest,
    build_history_text,
    build_system_instruction,
    detect_task_kind,
    resolve_action_target,
)

PASS, FAIL = [], []


def check(name, cond):
    (PASS if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name)


def el(**kw):
    kw.setdefault("tag", "input")
    return DOMElement(**kw)


print("detect_task_kind")
check("shopping task routes to shopping", detect_task_kind("find me the best headphones under 3000") == "shopping")
check("form task routes to form", detect_task_kind("Fill the application form and submit") == "form")
check("kyc routes to form", detect_task_kind("complete my KYC verification") == "form")
check("search task routes to search", detect_task_kind("find the contact email on this page") == "search")
check("unknown task routes to general", detect_task_kind("open the settings panel") == "general")
check("empty task is safe", detect_task_kind("") == "general")

print("\nbuild_system_instruction")
shopping = build_system_instruction("best laptop under 50000", 1, 8)
form = build_system_instruction("fill the KYC form", 1, 8)
check("shopping prompt carries e-commerce guidance", "SHOPPING / PRODUCT COMPARISON" in shopping)
check("form prompt does NOT carry e-commerce guidance", "SHOPPING / PRODUCT COMPARISON" not in form)
check("form prompt carries form guidance", "FORM FILLING" in form)
check("selector rule always present", "NEVER invent a CSS selector" in form and "NEVER invent a CSS selector" in shopping)
check("no-repeat rule always present", "DO NOT REPEAT A FAILED OR NO-EFFECT ACTION" in form)
check("step budget is stated", "step 1 of 8" in form)
check("telemetry rule only when telemetry present", "TELEMETRY" not in form
      and "TELEMETRY" in build_system_instruction("fill the KYC form", 1, 8, has_telemetry=True))

print("\nbuild_elements_digest")
digest = build_elements_digest([
    el(id="e1", tag="button", text="  Submit  ", name="", role="button", value=None, selector="#e1"),
    el(id="e2", tag="input", type="text", text="", name="email", value="x" * 200, selector=".form .email"),
])
check("empty fields are dropped", "name" not in digest[0] and "value" not in digest[0])
check("text is stripped", digest[0]["text"] == "Submit")
check("raw selector is withheld from the model", all("selector" not in d for d in digest))
check("long values are truncated", len(digest[1]["value"]) == 90)
check("refs are the ordinal position, not the DOM id", [d["ref"] for d in digest] == ["0", "1"])
check("dom_id is carried informationally", digest[0]["dom_id"] == "e1")
check("digest is capped", len(build_elements_digest([el(id=f"e{i}") for i in range(400)])) == 120)

# The Flipkart case: a page whose elements have NO id attribute at all. Every
# row must still be addressable, or the planner has no legal move.
idless = build_elements_digest([
    el(id="", tag="input", type="text", placeholder="Search for Products, Brands and More",
       selector='input[placeholder="Search for Products, Brands and More"]'),
    el(id="", tag="button", aria_label="Search", selector='button[aria-label="Search"]'),
])
check("id-less elements still get refs", [d["ref"] for d in idless] == ["0", "1"])
check("id-less elements carry no empty dom_id", all("dom_id" not in d for d in idless))
check("placeholder reaches the model", idless[0]["placeholder"].startswith("Search for Products"))
check("aria_label reaches the model", idless[1]["aria_label"] == "Search")

# Truncation must not delete every search result: results are <a> elements and
# content.js sorts links last.
many = [el(id="", tag="input") for _ in range(100)] + [el(id="", tag="a", text=f"result {i}") for i in range(100)]
trimmed = build_elements_digest(many)
check("link slots survive truncation", sum(1 for d in trimmed if d["tag"] == "a") >= 40)
check("refs stay valid indices after truncation",
      all(many[int(d["ref"])].tag == d["tag"] for d in trimmed))

print("\nresolve_action_target  (hallucinated-selector defence)")
elements = [
    el(id="e1", tag="button", text="Sign in", selector="#login-btn"),
    el(id="e2", tag="input", name="email", selector=".form input[name=email]"),
]
sel, ok = resolve_action_target({"target_ref": "0"}, elements)
check("ordinal ref resolves to the real selector", sel == "#login-btn" and ok)

sel, ok = resolve_action_target({"target_ref": "1"}, elements)
check("second ref resolves independently", sel == ".form input[name=email]" and ok)

sel, ok = resolve_action_target({"target_ref": "99"}, elements)
check("out-of-range ref is flagged unmatched", ok is False)

sel, ok = resolve_action_target({"target_id": "e1"}, elements)
check("legacy target_id still resolves", sel == "#login-btn" and ok)

sel, ok = resolve_action_target({"target_ref": "#totally-made-up"}, elements)
check("invented selector is flagged unmatched", ok is False)

sel, ok = resolve_action_target({"selector": "#login-btn"}, elements)
check("legacy selector field still accepted when real", sel == "#login-btn" and ok)

sel, ok = resolve_action_target({"target_ref": "Sign in"}, elements)
check("falls back to matching visible label", sel == "#login-btn" and ok)

# An id-less page must resolve by ref alone.
flipkart = [
    el(id="", tag="input", placeholder="Search for Products, Brands and More",
       selector='input[placeholder="Search for Products, Brands and More"]'),
    el(id="", tag="a", text="boAt Stone 1200", selector='[data-agent-id="2"]'),
]
sel, ok = resolve_action_target({"target_ref": "0"}, flipkart)
check("id-less search box is addressable", sel.startswith("input[placeholder=") and ok)
sel, ok = resolve_action_target({"target_ref": "1"}, flipkart)
check("data-agent-id fallback selector is returned", sel == '[data-agent-id="2"]' and ok)
sel, ok = resolve_action_target({"target_ref": "Search for Products, Brands and More"}, flipkart)
check("placeholder text resolves as a label", sel.startswith("input[placeholder=") and ok)

sel, ok = resolve_action_target({"type": "scroll"}, elements)
check("no target is legitimate for scroll/wait/finish", sel is None and ok)

print("\nbuild_action_output")
out = build_action_output({"type": "click", "target_ref": "0", "explanation": "log in", "confidence": 0.9},
                          elements, "Gemini")
check("resolves target into selector", out.selector == "#login-btn")
check("keeps high confidence when target is real", out.confidence == 0.9)
check("labels the provider", out.explanation.startswith("[Gemini]"))

bad = build_action_output({"type": "click", "target_ref": "#nope", "explanation": "go", "confidence": 0.99},
                          elements, "Qwen")
check("hallucinated target is capped to low confidence", bad.confidence <= 0.35)
check("hallucinated target is called out in the explanation", "unverified target" in bad.explanation)

# A targeted action with no target used to ship selector=null and fail silently
# in the content script, burning a step. It must now recover and say so.
notarget = build_action_output({"type": "type", "value": "bassy speaker", "explanation": "search",
                                "confidence": 0.95}, elements, "Gemini")
check("missing target falls back to a real input", notarget.selector == ".form input[name=email]")
check("fallback is flagged in the explanation", "no target given" in notarget.explanation)
check("fallback drops confidence", notarget.confidence <= 0.4)

clickfb = build_action_output({"type": "click", "explanation": "submit", "confidence": 0.9}, elements, "Gemini")
check("click falls back to a button, not an input", clickfb.selector == "#login-btn")

# Untargetable actions must NOT acquire a spurious target.
scrolled = build_action_output({"type": "scroll", "value": "down", "explanation": "reveal",
                                "confidence": 0.9}, elements, "Gemini")
check("scroll keeps a null selector", scrolled.selector is None)
check("scroll keeps full confidence", scrolled.confidence == 0.9)

# Nothing suitable on the page: flag it rather than inventing one.
empty = build_action_output({"type": "select", "explanation": "choose", "confidence": 0.9}, elements, "Gemini")
check("no suitable fallback is reported unverified", "unverified target" in empty.explanation)

weird = build_action_output({"type": "teleport", "explanation": "x", "confidence": 0.5}, elements, "Qwen")
check("invalid action type falls back to finish", weird.type == "finish")

missing = build_action_output({}, elements, "Qwen")
check("empty response does not crash", missing.type == "finish")

print("\nbuild_history_text  (outcome feedback)")
text = build_history_text([
    {"step": 1, "action": "click", "selector": "#a", "ok": True, "explanation": "opened menu"},
    {"step": 2, "action": "click", "selector": "#b", "ok": False, "error": "Target element not found"},
    {"step": 3, "action": "type", "selector": "#c", "value": "hi", "noOp": True},
])
check("successful step marked ok", "-> ok" in text)
check("failed step surfaces the error", "FAILED: Target element not found" in text)
check("no-effect step is called out", "NO EFFECT" in text)
check("no-effect step tells the model not to repeat", "Do NOT repeat it" in text)
check("empty history renders nothing", build_history_text([]) == "" and build_history_text(None) == "")

print("\nschema")
check("schema enum matches ACTION_TYPES", ACTION_RESPONSE_SCHEMA["properties"]["type"]["enum"] == ACTION_TYPES)
check("schema requires explanation", "explanation" in ACTION_RESPONSE_SCHEMA["required"])
check("schema exposes target_ref", "target_ref" in ACTION_RESPONSE_SCHEMA["properties"])

print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
sys.exit(1 if FAIL else 0)
