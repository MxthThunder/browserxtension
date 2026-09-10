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
    BROWSER_ACTION_TYPES,
    DOMElement,
    build_action_output,
    build_checkpoint_hint,
    build_elements_digest,
    build_history_text,
    build_page_content_text,
    build_plan_text,
    build_system_instruction,
    build_tabs_text,
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

print("\nbrowser-level actions")
nav = build_action_output({"type": "navigate", "value": "https://www.flipkart.com/search?q=speaker",
                           "explanation": "go to results", "confidence": 0.9}, elements, "Gemini")
check("navigate keeps its type", nav.type == "navigate")
check("navigate carries the URL", nav.value == "https://www.flipkart.com/search?q=speaker")
check("navigate takes no DOM selector", nav.selector is None)
check("navigate is not flagged as a bad target", "unverified target" not in nav.explanation)

bare = build_action_output({"type": "new_tab", "value": "flipkart.com/x", "explanation": "open",
                            "confidence": 0.9}, elements, "Gemini")
check("scheme-less host is upgraded to https", bare.value == "https://flipkart.com/x")

# Security boundary: only ordinary web navigation may reach chrome.tabs.
for scheme in ("javascript:alert(1)", "data:text/html,<script>x</script>",
               "file:///C:/Users/fredd/.ssh/id_rsa", "chrome://settings"):
    blocked = build_action_output({"type": "navigate", "value": scheme, "explanation": "go",
                                   "confidence": 0.9}, elements, "Gemini")
    check(f"refuses {scheme.split(':')[0]}: URLs",
          blocked.type == "finish" and "rejected navigate" in blocked.explanation)

nourl = build_action_output({"type": "navigate", "explanation": "go", "confidence": 0.9}, elements, "Gemini")
check("navigate with no URL is refused", nourl.type == "finish" and "no URL given" in nourl.explanation)

tab = build_action_output({"type": "switch_tab", "value": "tab 3", "explanation": "back to results",
                           "confidence": 0.9}, elements, "Gemini")
check("switch_tab extracts the tab number", tab.value == "3")

badtab = build_action_output({"type": "switch_tab", "value": "the results one", "explanation": "x",
                              "confidence": 0.9}, elements, "Gemini")
check("non-numeric tab ref is refused", badtab.type == "finish" and "not a tab number" in badtab.explanation)

back = build_action_output({"type": "go_back", "explanation": "return", "confidence": 0.9}, elements, "Gemini")
check("go_back needs no value", back.type == "go_back" and back.value is None)

# A new_tab naming a page link must NOT carry a model-authored URL: the browser
# reads the element's real href instead. Asked to open a search result,
# gemini-3.5-flash-lite produced a correctly-shaped but wholly invented
# ".../p/itm5a840c5f0a374" path.
results = [
    el(id="", tag="a", text="boAt Stone 1200F", selector='[data-agent-id="1"]'),
    el(id="", tag="a", text="Sony SRS-XB100", selector='[data-agent-id="2"]'),
]
byref = build_action_output({"type": "new_tab", "target_ref": "1", "explanation": "inspect specs",
                             "confidence": 0.9}, results, "Gemini")
check("new_tab by ref keeps the element selector", byref.selector == '[data-agent-id="2"]')
check("new_tab by ref carries no guessed URL", byref.value is None)
check("new_tab by ref stays a new_tab", byref.type == "new_tab")

# A ref the model invented must not silently become a link-open.
badref = build_action_output({"type": "new_tab", "target_ref": "99", "value": "https://example.com/x",
                              "explanation": "open", "confidence": 0.9}, results, "Gemini")
check("unresolvable ref falls back to the URL path", badref.value == "https://example.com/x")

# The observed behaviour: it ignores target_ref and writes a URL anyway. When
# that URL clearly refers to a link on the page, the real link must win.
invented = build_action_output(
    {"type": "new_tab",
     "value": "https://www.flipkart.com/boat-stone-1200f-14w-bluetooth-speaker/p/itmd0cb47e9ca92e",
     "explanation": "Opening the first candidate (boAt Stone 1200F) to inspect details",
     "confidence": 0.9},
    results, "Gemini")
check("invented product URL is replaced by the page link",
      invented.selector == '[data-agent-id="1"]' and invented.value is None)
check("the substitution is disclosed", "instead of a reconstructed URL" in invented.explanation)

# A genuinely unrelated destination must still be allowed through as a URL.
offsite = build_action_output(
    {"type": "new_tab", "value": "https://www.rtings.com/speaker/reviews/best/bass",
     "explanation": "Check independent bass measurements", "confidence": 0.9},
    results, "Gemini")
check("an unrelated URL is left alone", offsite.value == "https://www.rtings.com/speaker/reviews/best/bass")

# One shared generic word is a coincidence, not a match.
weak = build_action_output(
    {"type": "new_tab", "value": "https://example.com/speaker-guide",
     "explanation": "read a speaker guide", "confidence": 0.9},
    results, "Gemini")
check("a single generic word does not trigger substitution",
      weak.value == "https://example.com/speaker-guide")

print("\nPII field enforcement  (the model must never supply personal data)")
pii_page = [
    el(id="", tag="input", name="pincode", placeholder="Enter Delivery Pincode",
       selector='input[name="pincode"]'),
    el(id="", tag="input", name="email", placeholder="Email Address", selector='input[name="email"]'),
    el(id="", tag="input", name="cardnum", placeholder="Card Number", selector='input[name="cardnum"]'),
    el(id="", tag="input", name="fullname", placeholder="Full Name", selector='input[name="fullname"]'),
    el(id="", tag="input", name="q", placeholder="Search products", selector='input[name="q"]'),
]

# The real observed failure: asked to check delivery, the model typed a real
# Bangalore pincode it had invented.
pin = build_action_output({"type": "type", "target_ref": "0", "value": "560001",
                           "explanation": "check delivery", "confidence": 0.9}, pii_page, "Gemini")
check("invented pincode is replaced by a vault token", pin.value == "{{VAULT:address.pincode}}")
check("substitution is disclosed, not silent", "replaced a model-supplied value" in pin.explanation)

for ref, guess, token in (
    ("1", "someone@example.com", "{{VAULT:contact.email}}"),
    ("2", "4111111111111111", "{{VAULT:financial.card_number}}"),
    ("3", "Priya Nair", "{{VAULT:personal.name}}"),
):
    out = build_action_output({"type": "type", "target_ref": ref, "value": guess,
                               "explanation": "fill", "confidence": 0.9}, pii_page, "Gemini")
    check(f"invented value for {token} is replaced", out.value == token)

# A non-PII field must be left completely alone.
search = build_action_output({"type": "type", "target_ref": "4", "value": "extra bass speaker",
                              "explanation": "search", "confidence": 0.9}, pii_page, "Gemini")
check("ordinary search text is untouched", search.value == "extra bass speaker")
check("ordinary field gets no substitution note", "replaced a model-supplied" not in search.explanation)

# An already-correct token passes through unchanged and unremarked.
good = build_action_output({"type": "type", "target_ref": "0", "value": "{{VAULT:address.pincode}}",
                            "explanation": "check delivery", "confidence": 0.9}, pii_page, "Gemini")
check("an existing vault token is left as-is", good.value == "{{VAULT:address.pincode}}")
check("no note when nothing was substituted", "replaced a model-supplied" not in good.explanation)

# An empty PII field still gets the token rather than being left blank.
blank = build_action_output({"type": "type", "target_ref": "1", "explanation": "fill",
                             "confidence": 0.9}, pii_page, "Gemini")
check("empty PII field is filled from the vault", blank.value == "{{VAULT:contact.email}}")

# Clicks carry no value, so nothing should be coerced onto them.
clicked = build_action_output({"type": "click", "target_ref": "0", "explanation": "focus",
                               "confidence": 0.9}, pii_page, "Gemini")
check("click is not given a vault value", clicked.value is None)

print("\nbuild_checkpoint_hint")
digest_now = build_elements_digest(pii_page)
hint = build_checkpoint_hint(
    ["Search for speakers", "Check deliverability to the user's pincode", "Compare"], 2, digest_now)
check("names the element that completes the checkpoint", "ref 0" in hint)
check("quotes the checkpoint it matched", "deliverability" in hint)
check("no plan means no hint", build_checkpoint_hint(None, 1, digest_now) == "")
check("out-of-range plan_step is safe", build_checkpoint_hint(["a"], 9, digest_now) == "")
check("an unmatched checkpoint produces no hint",
      build_checkpoint_hint(["Reticulate the splines"], 1, digest_now) == "")

print("\nbuild_plan_text")
ptext = build_plan_text(["search", "filter", "compare", "recommend"], 3)
check("completed checkpoints are marked done", ptext.count("[done]") == 2)
check("current checkpoint is marked NOW", "[NOW]" in ptext)
check("later checkpoints are pending", "[pending]" in ptext)
check("no plan renders nothing", build_plan_text(None, 1) == "" and build_plan_text([], 1) == "")

print("\nbuild_page_content_text")
content = build_page_content_text([
    {"ref": 3, "on_screen": True, "title": "boAt Stone 1200F 14W", "price": "Rs 2,499",
     "rating": "4.3", "reviews": "12,455", "delivery": "Free Delivery", "badge": "Assured"},
    {"ref": 4, "on_screen": False, "title": "Sony SRS-XB100 Extra Bass", "price": "Rs 3,490",
     "rating": "4.4", "reviews": "5,003", "delivery": "", "badge": ""},
])
check("rows are addressable by ref", "ref 3" in content and "ref 4" in content)
check("prices reach the model", "2,499" in content and "3,490" in content)
check("ratings reach the model", "rated 4.3" in content)
check("review counts reach the model", "12,455" in content)
check("delivery text reaches the model", "Free Delivery" in content)
check("off-screen rows are flagged for scrolling", "(needs scrolling)" in content)
check("on-screen rows are not flagged", content.count("(needs scrolling)") == 1)
check("a row without a ref still renders", "ref -" in build_page_content_text([{"title": "x"}]))
check("empty content renders nothing",
      build_page_content_text([]) == "" and build_page_content_text(None) == "")
check("row count is capped",
      build_page_content_text([{"ref": i, "title": f"t{i}"} for i in range(100)]).count("\n  - ") == 24)

print("\nbuild_tabs_text")
tabs_text = build_tabs_text([
    {"index": 1, "title": "Flipkart speakers", "url": "https://www.flipkart.com/search", "active": True},
    {"index": 2, "title": "boAt Stone 1200F", "url": "https://www.flipkart.com/boat", "active": False},
])
check("tabs are numbered", "tab 1" in tabs_text and "tab 2" in tabs_text)
check("active tab is marked", "(active)" in tabs_text)
check("empty tab list renders nothing", build_tabs_text([]) == "" and build_tabs_text(None) == "")

print("\nbuild_system_instruction  (browser actions)")
shopping_now = build_system_instruction("best bassy speaker", 1, 25)
check("prompt documents new_tab", "new_tab" in shopping_now)
check("prompt documents switch_tab", "switch_tab" in shopping_now)
check("action vocabulary includes browser actions",
      set(BROWSER_ACTION_TYPES).issubset(set(ACTION_TYPES)))

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
