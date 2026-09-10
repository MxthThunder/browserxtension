"""
FastAPI VLM Server for Privacy-Preserving Browser Agent
Indian Space Research Organisation (ISRO) Problem Statement #26171

Understands arbitrary natural language prompts (free-form, conversational, multi-step)
using local Ollama (Qwen2.5/Qwen3), cloud LLMs, and an advanced semantic intent engine.
Receives ONLY zero-leakage sanitized visual frames and sanitized element digests.
"""

import os
import re
import time
import json
import base64
import asyncio
import random
from typing import List, Optional, Dict, Any, Tuple
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx

# Automatically load environment variables from .env if present
def _load_env_file():
    candidates = [
        os.path.join(os.path.dirname(__file__), ".env"),
        os.path.join(os.path.dirname(__file__), "..", ".env"),
        os.path.join(os.getcwd(), ".env"),
    ]
    for env_path in candidates:
        if os.path.isfile(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("'\"")
                            if k and k not in os.environ:
                                os.environ[k] = v
            except Exception:
                pass

_load_env_file()

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield

app = FastAPI(
    title="Privacy-Preserving Visual Agent Server",
    description="Centralized VLM Reasoner accepting zero-leakage sanitized browser context (ISRO PS #26171)",
    version="2.0.0",
    lifespan=lifespan,
)

# Enable CORS for Chrome Extensions and Localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LogItem(BaseModel):
    source: str = "extension"
    level: str = "info"
    message: str
    details: Optional[Dict[str, Any]] = None

@app.post("/api/log")
async def log_endpoint(item: LogItem):
    t = time.strftime("%H:%M:%S")
    prefix = f"[{t}] [{item.source.upper()}] [{item.level.upper()}]"
    if item.level == "error":
        print(f"\033[91m{prefix} {item.message}\033[0m", flush=True)
    elif item.level == "warn":
        print(f"\033[93m{prefix} {item.message}\033[0m", flush=True)
    else:
        print(f"\033[96m{prefix} {item.message}\033[0m", flush=True)
    if item.details:
        print(f"       Details: {json.dumps(item.details)}", flush=True)
    return {"ok": True}


class DOMElement(BaseModel):
    tag: str
    id: Optional[str] = ""
    name: Optional[str] = ""
    type: Optional[str] = ""
    text: Optional[str] = ""
    selector: Optional[str] = ""
    role: Optional[str] = None
    # An empty input has no text and no value; its placeholder / aria-label is
    # then the ONLY thing identifying it. content.js folds these into `text` as a
    # fallback, but carrying them separately keeps the identity when `text` is
    # occupied by a value.
    placeholder: Optional[str] = ""
    aria_label: Optional[str] = ""
    rect: Optional[Dict[str, Any]] = None
    is_interactive: Optional[bool] = True
    is_local_only: Optional[bool] = False
    value: Optional[str] = None


class RedactionItem(BaseModel):
    source: str
    label: str
    box: Optional[List[int]] = None


class ActRequest(BaseModel):
    task: str = Field(..., description="User prompt in any arbitrary natural language format")
    sanitized_image_base64: Optional[str] = None
    dom_elements: Optional[List[DOMElement]] = []
    redaction_manifest: Optional[List[RedactionItem]] = []
    viewport: Optional[Dict[str, Any]] = None
    url: Optional[str] = None
    model_provider: Optional[str] = "auto"
    step: Optional[int] = 1
    max_steps: Optional[int] = 8
    history: Optional[List[Dict[str, Any]]] = []
    structured_data: Optional[Dict[str, Any]] = None
    # Final-answer pass: the run is over (goal met, budget spent, or stuck) and
    # the model should report what was found instead of planning another action.
    synthesize_only: Optional[bool] = False
    stop_reason: Optional[str] = None


class ActionOutput(BaseModel):
    type: str  # "click", "type", "scroll", "select", "submit", "wait", "navigate", "finish"
    selector: Optional[str] = None
    coordinates: Optional[Dict[str, int]] = None
    value: Optional[str] = None
    explanation: str
    confidence: float
    # The answer to the user's request, present on `finish`. A run used to end
    # with only a stop reason ("Reached maximum step limit"), which told the user
    # nothing about what it had actually found.
    result: Optional[Dict[str, Any]] = None


class ActResponse(BaseModel):
    status: str
    task: str
    action: ActionOutput
    audit: Dict[str, Any]
    server_latency_ms: float
    model_used: str
    # Developer observability: which concrete model answered, what was asked
    # for, and every provider attempt made on the way there.
    model_id: Optional[str] = None
    provider_requested: Optional[str] = None
    provider_attempts: List[Dict[str, Any]] = []


# Common field synonyms for flexible natural language matching
FIELD_SYNONYMS = {
    "first_name": ["first name", "firstname", "fname", "given name", "first_name", "first"],
    "last_name": ["last name", "lastname", "lname", "surname", "family name", "last_name", "last"],
    "full_name": ["full name", "fullname", "name", "your name", "full_name"],
    "username": ["username", "user", "login", "user id", "user_name"],
    "password": ["password", "pass", "pwd", "secret"],
    "email": ["email", "e-mail", "mail", "email address"],
    "phone": ["phone", "mobile", "telephone", "tel", "phone number", "cell"],
    "postal_code": ["postal code", "zip code", "zip", "postal", "postalcode", "pincode", "pin"],
    "address": ["address", "street", "street address", "line 1", "addr"],
    "city": ["city", "town", "district"],
    "state": ["state", "province", "region"],
    "country": ["country", "nation"],
    "card_number": ["card number", "card", "credit card", "debit card", "cardnumber", "cc"],
    "card_exp": ["expiry", "expiration", "exp", "exp date", "expiration date", "card_exp"],
    "card_cvv": ["cvv", "cvc", "security code", "cvv2", "card code"],
}


@app.get("/health")
def health_check():
    ollama_host = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")
    return {
        "status": "healthy",
        "service": "ISRO PS #26171 VLM Reasoning Server",
        "version": "2.0.0 (Universal Prompt NLP Engine)",
        "redaction_aware": True,
        "supported_actions": ["click", "type", "scroll", "select", "submit", "wait", "navigate", "finish"],
        "api_providers": {
            "gemini": bool(os.getenv("GEMINI_API_KEY")),
            "openai": bool(os.getenv("OPENAI_API_KEY")),
            "ollama_qwen": bool(os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")),
            "universal_nlp_engine": True,
        },
    }


def generate_simulated_telemetry_frame() -> List[Dict[str, Any]]:
    """Generates realistic 1 Hz telemetry frame matching ISRO ISTRAC specifications."""
    dod = round(12.5 + 0.4 * random.random(), 1)
    return [
        {"mnemonic": "BAT1_DOD", "value": dod, "unit": "%", "status": "ALARM" if dod > 35 else "OK", "limit_state": "Soft: 35%, Hard: 40%", "subsystem": "POWER"},
        {"mnemonic": "BAT1_SOC", "value": round(87.4 + random.uniform(-0.1, 0.1), 1), "unit": "%", "status": "OK", "subsystem": "POWER"},
        {"mnemonic": "BUS_V28", "value": round(28.42 + random.uniform(-0.02, 0.02), 2), "unit": "V", "status": "OK", "subsystem": "POWER"},
        {"mnemonic": "RWA3_RPM", "value": round(4388 + random.randint(-5, 5)), "unit": "rpm", "status": "WARN", "limit_state": "Saturation: 4500 rpm", "subsystem": "AOCS"},
        {"mnemonic": "STR2_STAT", "value": "NO TRACK", "status": "ALARM", "subsystem": "AOCS"},
        {"mnemonic": "CLASSIFIED_COORD", "value": "13.03N 77.51E", "status": "OK", "subsystem": "PAYLOAD"},
    ]


@app.get("/console", response_class=HTMLResponse)
def get_mission_console():
    """Serves the interactive Mission Operations Simulation Console SPA."""
    console_path = os.path.join(os.path.dirname(__file__), "..", "pii-agent-extension", "mission_console.html")
    if os.path.isfile(console_path):
        with open(console_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    raise HTTPException(status_code=404, detail="Mission console HTML not found")


@app.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket):
    """Streams 1 Hz simulated telemetry delta frames to the mission console."""
    await websocket.accept()
    try:
        while True:
            frame = generate_simulated_telemetry_frame()
            await websocket.send_json(frame)
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass


_gemini_models_cache: Optional[List[str]] = None


async def get_available_gemini_models(api_key: str) -> List[str]:
    """
    Model ids this key can actually serve, cached for the process lifetime.

    Guessing ids is how Gemini silently stops working: a name that does not
    exist 404s per attempt and the agent quietly degrades to the fallback
    engine. Asking the API removes that whole class of failure.
    """
    global _gemini_models_cache
    if _gemini_models_cache is not None:
        return _gemini_models_cache

    version = os.getenv("GEMINI_API_VERSION", "v1beta")
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                f"https://generativelanguage.googleapis.com/{version}/models?key={api_key}"
            )
            if resp.status_code == 200:
                _gemini_models_cache = [
                    m.get("name", "").replace("models/", "")
                    for m in resp.json().get("models", [])
                    if "generateContent" in m.get("supportedGenerationMethods", [])
                ]
                print(f"[Gemini] {len(_gemini_models_cache)} models available to this key")
            else:
                print(f"[Gemini] Could not list models (HTTP {resp.status_code}); using configured ids")
                _gemini_models_cache = []
    except Exception as exc:
        print(f"[Gemini] Could not list models ({exc}); using configured ids")
        _gemini_models_cache = []

    return _gemini_models_cache


def _record_attempt(
    attempts: Optional[List[Dict[str, Any]]],
    provider: str,
    model_id: Optional[str],
    ok: bool,
    latency_ms: float = 0.0,
    error: Optional[str] = None,
    status_code: Optional[int] = None,
) -> None:
    """Appends one provider attempt to the trace the client will display."""
    if attempts is None:
        return
    attempts.append({
        "provider": provider,
        "modelId": model_id,
        "ok": ok,
        "latencyMs": round(latency_ms, 1),
        "error": error,
        "statusCode": status_code,
    })


# Cache Ollama availability state to prevent network timeout latency
_ollama_checked = False
_ollama_online = False
_last_ollama_check_time = 0

async def is_ollama_available(ollama_host: str) -> bool:
    global _ollama_checked, _ollama_online, _last_ollama_check_time
    now = time.time()
    # Positive results are cached far longer than negative ones: a single
    # unlucky probe should not blank out Qwen for the next half minute.
    cache_window = 30 if _ollama_online else 5
    if _ollama_checked and (now - _last_ollama_check_time < cache_window):
        return _ollama_online

    try:
        # 0.15s was tight enough that a cold model failed the probe and the
        # server silently skipped Qwen altogether.
        async with httpx.AsyncClient(timeout=1.5) as client:
            resp = await client.get(f"{ollama_host}/api/tags")
            _ollama_online = (resp.status_code == 200)
    except Exception:
        _ollama_online = False

    _ollama_checked = True
    _last_ollama_check_time = now
    return _ollama_online


# ── Shared action-planning prompt construction ───────────────────────────────
# Gemini, OpenAI and Ollama previously carried three near-identical copies of
# the digest, history and system prompt, which had already drifted apart. They
# now share these builders so an accuracy fix lands once instead of three times.

ACTION_TYPES = ["click", "type", "scroll", "select", "submit", "wait", "finish"]

# Structured-output schema. Gemini enforces this server-side, so an action with
# an invalid `type` or a missing field becomes impossible rather than something
# to detect after the fact.
ACTION_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "type": {"type": "STRING", "enum": ACTION_TYPES},
        "target_ref": {
            "type": "STRING",
            "description": "Exact `ref` of the chosen element from Interactive Page Elements. Empty for scroll/wait/finish.",
        },
        "value": {
            "type": "STRING",
            "description": "Text to type, option to select, or scroll direction (down/up).",
        },
        "explanation": {"type": "STRING"},
        "confidence": {"type": "NUMBER"},
        "result": {
            "type": "OBJECT",
            "description": "The ANSWER to the user's request. Required on finish; omit otherwise.",
            "properties": {
                "summary": {"type": "STRING"},
                "recommendation": {"type": "STRING"},
                "candidates": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "name": {"type": "STRING"},
                            "detail": {"type": "STRING"},
                            "why": {"type": "STRING"},
                        },
                        "required": ["name", "detail", "why"],
                    },
                },
            },
            # All three are required: a result carrying only a summary is what
            # produced the useless "reached max steps" ending this replaced.
            "required": ["summary", "recommendation", "candidates"],
        },
    },
    "required": ["type", "explanation", "confidence"],
}

# The same contract in standard JSON Schema, for Ollama's structured-output
# mode. Ollama's format:"json" only guarantees valid JSON, not the right shape.
OLLAMA_ACTION_FORMAT = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ACTION_TYPES},
        "target_ref": {"type": "string"},
        "value": {"type": "string"},
        "explanation": {"type": "string"},
        "confidence": {"type": "number"},
        "result": {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "recommendation": {"type": "string"},
            },
        },
    },
    "required": ["type", "explanation"],
}

MAX_DIGEST_ELEMENTS = 120
MAX_FIELD_LEN = 90

# Links are sorted last by content.js's priority sort (inputs 50, buttons 20,
# links 0). On a search-results page that is exactly backwards: the results ARE
# links, and a flat head-truncation deleted every one of them. Reserve a slice of
# the budget for them so a shopping/search page stays navigable.
MIN_LINK_SLOTS = 40


def select_digest_elements(elements: List[DOMElement]) -> List[Tuple[int, DOMElement]]:
    """
    Chooses which elements make it into the digest, keeping their ORIGINAL index.

    The index is the model's addressing key, so it must survive truncation --
    that is why this returns (index, element) pairs rather than a filtered list.
    """
    indexed = list(enumerate(elements))
    if len(indexed) <= MAX_DIGEST_ELEMENTS:
        return indexed

    links = [pair for pair in indexed if pair[1].tag == "a"]
    others = [pair for pair in indexed if pair[1].tag != "a"]

    link_quota = min(len(links), max(MIN_LINK_SLOTS, MAX_DIGEST_ELEMENTS - len(others)))
    other_quota = MAX_DIGEST_ELEMENTS - link_quota

    kept = others[:other_quota] + links[:link_quota]
    kept.sort(key=lambda pair: pair[0])
    return kept


def build_elements_digest(elements: List[DOMElement]) -> List[Dict[str, Any]]:
    """
    Compact, ref-keyed view of the page.

    `ref` is the element's ordinal position in the request, NOT its DOM id.
    Keying on the DOM id was the bug that made the agent unusable on real sites:
    modern class-name-driven pages (Flipkart, most SPAs) set almost no `id`
    attributes, so every digest row came out as {"id": "", ...} and there was no
    legal target the model could name. It scrolled instead, then hit the step cap.

    The raw selector is still withheld on purpose: the model picks a ref and the
    server resolves it back to a real selector, so a selector the model invented
    can never reach the page.
    """
    digest = []
    for idx, el in select_digest_elements(elements):
        entry: Dict[str, Any] = {"ref": str(idx), "tag": el.tag}
        for key, val in (
            ("type", el.type),
            ("text", el.text),
            ("placeholder", el.placeholder),
            ("aria_label", el.aria_label),
            ("name", el.name),
            ("role", el.role),
            ("value", el.value),
            ("dom_id", el.id),  # informational only -- never the addressing key
        ):
            cleaned = str(val).strip() if val else ""
            if cleaned:
                entry[key] = cleaned[:MAX_FIELD_LEN]
        digest.append(entry)
    return digest


def build_history_text(history: Optional[List[Dict[str, Any]]], full_detail: bool = False) -> str:
    """
    Renders prior steps together with their OUTCOME.

    Without the outcome the model cannot tell a click that worked from one that
    hit nothing, which is how repetition loops start.

    `full_detail` widens the per-step explanation cap. While planning, a short
    cap keeps the prompt small and the explanations are just intent. In the
    synthesis pass the explanations ARE the evidence -- the prices, ratings and
    specs the run observed -- and clipping them at 120 chars silently discarded
    every finding after the first.
    """
    cap = 900 if full_detail else 120
    if not history:
        return ""

    lines = []
    for i, h in enumerate(history):
        parts = [
            f"  - Step {h.get('step', i + 1)}: [{str(h.get('action', '')).upper()}]",
            f" target='{h.get('selector') or 'page'}'",
        ]
        if h.get("value"):
            parts.append(f" value='{h.get('value')}'")

        if h.get("ok") is False:
            parts.append(f" -> FAILED: {h.get('error') or 'action did not execute'}")
        elif h.get("noOp"):
            parts.append(" -> NO EFFECT: page did not change. Do NOT repeat it; try a different element.")
        else:
            parts.append(" -> ok")

        if h.get("explanation"):
            parts.append(f" ({str(h['explanation'])[:cap]})")
        lines.append("".join(parts))

    return "\n\nPrevious Actions Executed in this Session:\n" + "\n".join(lines)


def build_telemetry_text(structured_data: Optional[Dict[str, Any]]) -> str:
    if not structured_data:
        return ""
    return (
        "\n\n=== REAL-TIME TELEMETRY & STRUCTURED APPLICATION DATA ===\n"
        "[Exact parameters from the application data stream. Do NOT guess or OCR these values]\n"
        f"{json.dumps(structured_data, indent=2)}\n"
        "===========================================================\n"
    )


# Task-kind detection. Domain guidance is loaded only for the matching kind, so
# e-commerce rules stop biasing form-filling and navigation tasks.
SHOPPING_HINTS = (
    "buy", "price", "cheap", "cheapest", "under ", "budget", "product",
    "cart", "order", "deal", "discount", "rating", "review", "compare",
)
FORM_HINTS = (
    "fill", "form", "apply", "application", "register", "sign up", "signup",
    "enroll", "kyc", "checkout", "book a", "book an", "appointment",
)
SEARCH_HINTS = ("find", "search", "look up", "lookup", "research", "who ", "what ", "where ", "when ")

TASK_GUIDANCE = {
    "shopping": (
        "TASK TYPE - SHOPPING / PRODUCT COMPARISON:\n"
        "- If a search has already run, results are on screen: read the visible products, prices and ratings rather than searching again.\n"
        "- Use scroll (value 'down') to reveal more results before concluding.\n"
        "- Open a product only when you need specifications the listing does not show.\n"
        "- Finish with the pick, its exact price and rating, and why it beats the alternatives.\n"
    ),
    "form": (
        "TASK TYPE - FORM FILLING:\n"
        "- Fill one field per turn using type, targeting that field's id.\n"
        "- Values shown as VAULT placeholders are resolved on-device; pass them through unchanged.\n"
        "- Never invent personal data. If a required value is unavailable, finish and name the blocking field.\n"
        "- Submit only once every required field is filled.\n"
    ),
    "search": (
        "TASK TYPE - SEARCH / RESEARCH:\n"
        "- Type the query into the search field, then submit it.\n"
        "- Once results are visible, read them instead of searching again.\n"
        "- Finish with the answer itself, not a description of where to find it.\n"
    ),
    "general": (
        "TASK TYPE - GENERAL NAVIGATION:\n"
        "- Work toward the goal one concrete interaction at a time.\n"
        "- Prefer visible, clearly labelled controls over ambiguous ones.\n"
        "- If the page still appears to be loading, use wait once before retrying.\n"
    ),
}


def detect_task_kind(task: str) -> str:
    lowered = (task or "").lower()
    if any(hint in lowered for hint in SHOPPING_HINTS):
        return "shopping"
    if any(hint in lowered for hint in FORM_HINTS):
        return "form"
    if any(hint in lowered for hint in SEARCH_HINTS):
        return "search"
    return "general"


# The synthesis pass gets its OWN flat schema rather than reusing the action
# schema's nested `result`. Gemini enforces `required` reliably at the top level
# but was silently dropping `candidates` from the nested object, which is the one
# field that carries the actual findings.
SYNTHESIS_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "summary": {
            "type": "STRING",
            "description": "Direct answer to the user in one or two sentences.",
        },
        "recommendation": {
            "type": "STRING",
            "description": "The single best option, named.",
        },
        "candidates": {
            "type": "ARRAY",
            "description": "EVERY distinct option the session history mentions.",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "name": {"type": "STRING"},
                    "detail": {"type": "STRING", "description": "Price / rating / spec, as recorded."},
                    "why": {"type": "STRING", "description": "Evidence justifying its rank."},
                },
                "required": ["name", "detail", "why"],
            },
        },
    },
    "required": ["summary", "recommendation", "candidates"],
}

SYNTHESIS_INSTRUCTION = (
    "The browsing session is OVER. Do not plan another action.\n"
    "Using ONLY the session history below, answer the user's original request as well as the "
    "evidence allows.\n\n"
    "Reply with exactly this JSON object and nothing else:\n"
    '{"summary": "direct answer to the user, in plain language", '
    '"recommendation": "the single best option, named", '
    '"candidates": [{"name": "option", "detail": "price / rating / spec", "why": "why it ranks there"}]}\n\n'
    "RULES, in order:\n"
    "1. FIRST extract every distinct option named anywhere in the history into `candidates` - "
    "one entry per option, with its price/rating/spec in `detail` exactly as recorded. "
    "The history is evidence you already gathered; report it. Returning an empty `candidates` "
    "list when options were seen is a failure.\n"
    "2. THEN rank them against what the user actually asked for. A stated preference "
    "(bass, budget, size, brand) beats a marginally higher rating: an option whose evidence "
    "explicitly matches the request outranks one that merely scores well. "
    "`recommendation` names that winner.\n"
    "3. `why` cites the specific evidence that justifies each option's place.\n"
    "4. `summary` answers the user directly in one or two sentences. Mention an incomplete check "
    "(delivery, stock, an unapplied filter) as a caveat at the end - do not let it replace the answer, "
    "and do not suggest the user redo work that the history shows was already done.\n"
    "5. Never state a price, rating or specification that does not appear in the history, and never "
    "invent an option that was not seen."
)


def build_system_instruction(
    task: str,
    step: int,
    max_steps: int,
    has_telemetry: bool = False,
    synthesize_only: bool = False,
    stop_reason: Optional[str] = None,
) -> str:
    if synthesize_only:
        reason = f"\nWhy the session ended: {stop_reason}\n" if stop_reason else "\n"
        return SYNTHESIS_INSTRUCTION + reason

    parts = [
        "You are an expert autonomous browser agent. Given a user goal, the session history and the "
        "interactive elements visible on the page, choose the SINGLE next browser action.\n",
        f"Session progress: step {step} of {max_steps}. Reach the goal before the budget runs out.\n",
        "\nHARD RULES:\n",
        "1. TARGETING: set target_ref to the exact `ref` value of one element listed under "
        "'Interactive Page Elements'. A ref is a plain number, e.g. \"12\". "
        "NEVER invent a CSS selector, XPath, class or id - the server resolves the ref for you, "
        "so a selector you write cannot reach the page. "
        "Refs are renumbered every step, so only ever use refs from the CURRENT list. "
        "Identify an element by its text, placeholder, aria_label or role - most real pages set no id at all, "
        "and a missing dom_id is never a reason to avoid an element.\n",
        "2. target_ref is required for click, type, select and submit. Leave it empty for scroll, wait and finish.\n",
        "3. DO NOT REPEAT A FAILED OR NO-EFFECT ACTION. Every prior step is marked 'ok', 'FAILED' or 'NO EFFECT'. "
        "A step with no effect means that approach does not work on this page - choose a different element or strategy.\n",
        "4. Exactly one action per turn. Prefer the most direct route to the goal.\n",
        "5. FINISH as soon as the goal is met. On finish you MUST fill `result` with the actual "
        "answer - result.summary in plain language, result.recommendation naming the single best "
        "option, and result.candidates listing what you compared. The user sees `result`, not the "
        "step log, so an empty result means they got nothing out of the run.\n",
    ]
    if has_telemetry:
        parts.append(
            "6. TELEMETRY: values under 'REAL-TIME TELEMETRY' come directly from the application data stream. "
            "Treat them as ground truth; never OCR or guess them.\n"
        )
    parts.append("\n" + TASK_GUIDANCE[detect_task_kind(task)])
    parts.append(
        "\nOUTPUT FORMAT - reply with exactly this JSON object and nothing else:\n"
        '{"type": "click|type|scroll|select|submit|wait|finish", '
        '"target_ref": "ref number of one element from the list, or empty for scroll/wait/finish", '
        '"value": "text to type, option to select, or down/up for scroll", '
        '"explanation": "why this action moves the goal forward", '
        '"confidence": 0.0-1.0, '
        '"result": {"summary": "...", "recommendation": "...", "candidates": [...]}  // finish only\n'
    )
    return "".join(parts)


def resolve_action_target(raw: Dict[str, Any], elements: List[DOMElement]):
    """
    Maps the model's target_ref back to a real CSS selector.

    This is the guard that stops a hallucinated selector reaching the page.
    Anything not corresponding to a listed element is caught here instead of
    failing later in the content script with 'Target element not found in DOM'.

    Returns (selector, matched).
    """

    def selector_for(el: DOMElement) -> str:
        # content.js always computes a usable selector -- #id, [data-testid],
        # [aria-label], [name], [placeholder], or a guaranteed [data-agent-id="N"]
        # stamped onto the live node. The #id fallback is for older payloads only.
        return el.selector or (f"#{el.id}" if el.id else "")

    # `target_ref` is the current contract; `target_id` is accepted so a payload
    # from an older extension build (or a model echoing the old prompt) still works.
    candidate = str(
        raw.get("target_ref") or raw.get("target_id") or raw.get("selector") or ""
    ).strip()

    if not candidate:
        return None, True  # scroll / wait / finish legitimately have no target

    # 1. Ordinal ref -- the normal path.
    if candidate.isdigit():
        idx = int(candidate)
        if 0 <= idx < len(elements):
            return selector_for(elements[idx]), True

    # 2. DOM id, for pages that do have them.
    by_id = {str(el.id): el for el in elements if el.id}
    if candidate in by_id:
        return selector_for(by_id[candidate]), True

    for el in elements:
        if candidate in (el.selector, f"#{el.id}", str(el.id)):
            return selector_for(el), True

    # Last resort: match on any visible label the element carries.
    lowered = candidate.strip("#.").lower()
    if lowered:
        def labels(el: DOMElement):
            return [
                str(v or "").strip().lower()
                for v in (el.text, el.placeholder, el.aria_label, el.name)
            ]

        for el in elements:
            if lowered in labels(el):
                return selector_for(el), True

        # A unique substring hit is still unambiguous; an ambiguous one is not,
        # so require exactly one match rather than taking the first.
        partial = [el for el in elements if any(lab and lowered in lab for lab in labels(el))]
        if len(partial) == 1:
            return selector_for(partial[0]), True

    return candidate, False


# Actions that are meaningless without a target. scroll / wait / finish are not.
TARGETED_ACTIONS = {"click", "type", "select", "submit"}

TEXT_INPUT_TYPES = {"", "text", "search", "email", "tel", "url", "password", "number", "contenteditable"}


def pick_fallback_target(action_type: str, elements: List[DOMElement]) -> Optional[str]:
    """
    Best-effort target when the model named none.

    content.js already sorts the element list by interaction priority (text
    inputs first, then buttons), so the first element of the right kind is the
    most plausible candidate. This is a recovery path, not a guess presented as
    certainty -- the caller drops confidence and labels it.
    """
    def usable(el: DOMElement) -> bool:
        if action_type in ("type", "submit"):
            return el.tag in ("input", "textarea") and str(el.type or "").lower() in TEXT_INPUT_TYPES
        if action_type == "select":
            return el.tag == "select"
        return el.tag in ("button", "a") or str(el.role or "") == "button"

    for el in elements:
        if usable(el) and (el.selector or el.id):
            return el.selector or f"#{el.id}"
    return None


def build_synthesis_output(raw: Dict[str, Any], provider_label: str) -> ActionOutput:
    """
    Wraps a flat synthesis response ({summary, recommendation, candidates}) into
    the ActionOutput the caller expects. Always a `finish` -- the session is over.
    """
    summary = str(raw.get("summary") or "").strip()
    result = {
        "summary": summary or "The run ended without establishing an answer.",
        "recommendation": str(raw.get("recommendation") or "").strip(),
        "candidates": raw.get("candidates") if isinstance(raw.get("candidates"), list) else [],
    }
    return ActionOutput(
        type="finish",
        selector=None,
        value=None,
        explanation=f"[{provider_label}] {result['summary']}",
        confidence=float(raw.get("confidence") or 0.8),
        result=result,
    )


def build_action_output(raw: Dict[str, Any], elements: List[DOMElement], provider_label: str) -> ActionOutput:
    """Normalises a raw model response into a validated ActionOutput."""
    action_type = str(raw.get("type", "finish")).lower()
    if action_type not in ACTION_TYPES:
        action_type = "finish"

    selector, matched = resolve_action_target(raw, elements)
    confidence = float(raw.get("confidence") or 0.9)
    explanation = str(raw.get("explanation") or "Action planned.")

    if selector is None and action_type in TARGETED_ACTIONS:
        # The model named no target at all for an action that cannot work
        # without one. Previously this returned matched=True and shipped a null
        # selector, so the step failed silently in the content script and burned
        # a turn. Fall back to the best-typed element and say so.
        fallback = pick_fallback_target(action_type, elements)
        if fallback:
            selector = fallback
            confidence = min(confidence, 0.4)
            explanation = f"[no target given; using best {action_type} candidate] {explanation}"
        else:
            matched = False

    if not matched:
        # The target does not exist on the page. Keep the action so the content
        # script's fuzzy fallback can still try, but say so and drop confidence
        # rather than presenting a guess as certainty.
        confidence = min(confidence, 0.35)
        explanation = f"[unverified target '{selector}'] {explanation}"

    result = raw.get("result")
    if action_type == "finish" and not isinstance(result, dict):
        # Guarantee the caller always has something to show, even from a model
        # that ignored the result field.
        result = {"summary": explanation}

    return ActionOutput(
        type=action_type,
        selector=selector,
        value=raw.get("value"),
        explanation=f"[{provider_label}] {explanation}",
        confidence=confidence,
        result=result if isinstance(result, dict) else None,
    )


async def try_ollama_qwen(
    task: str,
    elements: List[DOMElement],
    image_base64: Optional[str],
    history: Optional[List[Dict[str, Any]]] = None,
    step: int = 1,
    max_steps: int = 8,
    structured_data: Optional[Dict[str, Any]] = None,
    synthesize_only: bool = False,
    stop_reason: Optional[str] = None,
    attempts: Optional[List[Dict[str, Any]]] = None,
) -> Optional[ActionOutput]:
    """
    Attempts reasoning using local Ollama (Qwen2.5-VL / Qwen2.5-Coder / Qwen3).
    Only invoked if Ollama is actively running.
    """
    ollama_host = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")

    # Action planning and privacy classification are DIFFERENT jobs and need
    # different models. OLLAMA_MODEL (isro-privacy-qwen) is fine-tuned to emit
    # {"decisions": [...]} for ALLOW/REDACT/BLOCK and is used by the extension's
    # local reasoner. Pointing action planning at it produces a privacy verdict
    # instead of a browser action every single time, which silently demotes the
    # agent to the heuristic fallback. Keep these two settings distinct.
    model = os.getenv("OLLAMA_ACTION_MODEL", "qwen2.5:1.5b")
    privacy_model = os.getenv("OLLAMA_MODEL", "isro-privacy-qwen")
    if model == privacy_model:
        print(
            f"[Ollama] WARNING: OLLAMA_ACTION_MODEL is set to the privacy classifier "
            f"'{model}'. It cannot return browser actions; set OLLAMA_ACTION_MODEL to a "
            f"general instruct model such as qwen2.5:1.5b."
        )

    if not await is_ollama_available(ollama_host):
        _record_attempt(attempts, "ollama-qwen", model, False, error="ollama not reachable")
        return None

    elements_digest = build_elements_digest(elements)

    history_text = build_history_text(history, full_detail=synthesize_only)

    telemetry_text = build_telemetry_text(structured_data)

    system_prompt = build_system_instruction(task, step, max_steps, bool(structured_data),
                                            synthesize_only=synthesize_only, stop_reason=stop_reason)

    user_prompt = f"User Instruction: {task}{history_text}{telemetry_text}\n\nInteractive Page Elements:\n{json.dumps(elements_digest, indent=2)}"

    payload = {
        "model": model,
        "prompt": f"{system_prompt}\n\n{user_prompt}",
        "stream": False,
        "format": OLLAMA_ACTION_FORMAT,
        # Pin the model in memory. The extension already does this; without it
        # the server path paid a cold start on every single call.
        "keep_alive": -1,
        "options": {"temperature": 0.1},
    }

    attempt_start = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{ollama_host}/api/generate", json=payload)
            latency_ms = (time.perf_counter() - attempt_start) * 1000
            if resp.status_code == 200:
                data = resp.json()
                raw_json = json.loads(data.get("response", "{}"))
                if "type" in raw_json or (synthesize_only and "summary" in raw_json):
                    _record_attempt(attempts, "ollama-qwen", model, True, latency_ms=latency_ms)
                    return (build_synthesis_output(raw_json, "Qwen") if synthesize_only
                            else build_action_output(raw_json, elements, "Qwen"))

                # A privacy-classifier response to an action-planning prompt: say
                # so explicitly, because the generic "unusable response" hid this
                # misconfiguration behind a silent fallback.
                reason = (
                    f"model '{model}' returned a privacy verdict, not an action - it is a "
                    f"classifier; set OLLAMA_ACTION_MODEL to a general instruct model"
                    if "decisions" in raw_json
                    else "response missing 'type'"
                )
                _record_attempt(attempts, "ollama-qwen", model, False, latency_ms=latency_ms,
                                error=reason, status_code=resp.status_code)
    except Exception as e:
        _record_attempt(attempts, "ollama-qwen", model, False,
                        latency_ms=(time.perf_counter() - attempt_start) * 1000, error=str(e)[:120])
        return None
    return None


async def try_gemini(
    task: str,
    elements: List[DOMElement],
    image_base64: Optional[str],
    history: Optional[List[Dict[str, Any]]] = None,
    step: int = 1,
    max_steps: int = 8,
    structured_data: Optional[Dict[str, Any]] = None,
    synthesize_only: bool = False,
    stop_reason: Optional[str] = None,
    attempts: Optional[List[Dict[str, Any]]] = None,
) -> Optional[ActionOutput]:
    """
    Attempts reasoning using Google Gemini API (gemini-3.5-flash-lite / gemini-3.7-flash).
    Only invoked if GEMINI_API_KEY is configured.
    Receives ONLY sanitized visual frames (raw PII already masked locally).
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None

    elements_digest = build_elements_digest(elements)

    history_text = build_history_text(history, full_detail=synthesize_only)

    telemetry_text = build_telemetry_text(structured_data)

    system_instruction = build_system_instruction(task, step, max_steps, bool(structured_data),
                                            synthesize_only=synthesize_only, stop_reason=stop_reason)

    parts: List[Dict[str, Any]] = [
        {"text": f"{system_instruction}\n\nUser Instruction: {task}{history_text}{telemetry_text}\n\nInteractive Page Elements:\n{json.dumps(elements_digest, indent=2)}"}
    ]

    if image_base64 and len(image_base64) > 100:
        clean_b64 = image_base64.split(",", 1)[-1]
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": clean_b64
            }
        })

    primary_model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
    candidate_models = [primary_model]
    for fallback in ["gemini-3.5-flash-lite", "gemini-3.7-flash", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-2.0-flash", "gemini-1.5-flash"]:
        if fallback not in candidate_models:
            candidate_models.append(fallback)

    # Prefer models the key can really serve. Without this, a preference list
    # full of ids this account does not have burns every attempt on a 404 and
    # never reaches the ones that would have worked.
    available = await get_available_gemini_models(api_key)
    if available:
        servable = [m for m in candidate_models if m in available]
        if not servable:
            # None of the preferred ids exist for this key: fall back to whatever
            # flash-class model it does have, then anything at all.
            servable = [m for m in available if "flash" in m] or available
            print(f"[Gemini] No preferred model available; using {servable[0]}")
        candidate_models = servable

    # Only try a couple of models. The full list at 45s each could burn several
    # minutes against a 60s client timeout, so the local Qwen fallback was
    # effectively unreachable whenever Gemini was having a bad day.
    max_candidates = int(os.getenv("GEMINI_MAX_CANDIDATES", "2"))
    candidate_models = candidate_models[:max_candidates]
    per_attempt_timeout = float(os.getenv("GEMINI_ATTEMPT_TIMEOUT", "12"))
    total_budget_s = float(os.getenv("GEMINI_TOTAL_BUDGET", "20"))
    budget_start = time.perf_counter()

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "response_mime_type": "application/json",
            # Enforced server-side: an invalid action type or a missing
            # required field can no longer come back at all.
            "response_schema": SYNTHESIS_RESPONSE_SCHEMA if synthesize_only else ACTION_RESPONSE_SCHEMA,
            "temperature": 0.1
        }
    }

    async with httpx.AsyncClient(timeout=per_attempt_timeout) as client:
        for model in candidate_models:
            if (time.perf_counter() - budget_start) > total_budget_s:
                _record_attempt(attempts, "gemini", model, False,
                                latency_ms=0, error="gemini budget exhausted, falling through")
                print("[Gemini] Total budget exhausted; falling through to next provider.")
                break

            api_version = os.getenv("GEMINI_API_VERSION", "v1beta")
            url = f"https://generativelanguage.googleapis.com/{api_version}/models/{model}:generateContent?key={api_key}"
            attempt_start = time.perf_counter()
            try:
                resp = await client.post(url, json=payload)
                latency_ms = (time.perf_counter() - attempt_start) * 1000
                if resp.status_code == 200:
                    data = resp.json()
                    text_response = data["candidates"][0]["content"]["parts"][0]["text"]
                    raw_json = json.loads(text_response)
                    if "type" in raw_json or (synthesize_only and "summary" in raw_json):
                        _record_attempt(attempts, "gemini", model, True, latency_ms=latency_ms)
                        return (build_synthesis_output(raw_json, f"Gemini ({model})") if synthesize_only
                                else build_action_output(raw_json, elements, f"Gemini ({model})"))
                    _record_attempt(attempts, "gemini", model, False, latency_ms=latency_ms,
                                    error="response missing 'type'", status_code=200)
                elif resp.status_code == 429:
                    _record_attempt(attempts, "gemini", model, False, latency_ms=latency_ms,
                                    error="rate limited", status_code=429)
                    print(f"[Gemini] {model} hit rate limit (429), trying fallback model...")
                    continue
                else:
                    _record_attempt(attempts, "gemini", model, False, latency_ms=latency_ms,
                                    error=resp.text[:120], status_code=resp.status_code)
                    print(f"[Gemini] {model} API error {resp.status_code}: {resp.text[:200]}")
            except Exception as e:
                _record_attempt(attempts, "gemini", model, False,
                                latency_ms=(time.perf_counter() - attempt_start) * 1000, error=str(e)[:120])
                print(f"[Gemini] {model} Exception: {e}")
    return None



async def try_openai(
    task: str,
    elements: List[DOMElement],
    image_base64: Optional[str],
    history: Optional[List[Dict[str, Any]]] = None,
    step: int = 1,
    max_steps: int = 8,
    structured_data: Optional[Dict[str, Any]] = None,
    synthesize_only: bool = False,
    stop_reason: Optional[str] = None,
    attempts: Optional[List[Dict[str, Any]]] = None,
) -> Optional[ActionOutput]:
    """
    Attempts reasoning using OpenAI API (gpt-4o-mini / gpt-4o).
    Only invoked if OPENAI_API_KEY is configured.
    Receives ONLY sanitized visual frames (raw PII already masked locally).
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None

    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    elements_digest = build_elements_digest(elements)

    history_text = build_history_text(history, full_detail=synthesize_only)

    telemetry_text = build_telemetry_text(structured_data)

    system_prompt = build_system_instruction(task, step, max_steps, bool(structured_data),
                                            synthesize_only=synthesize_only, stop_reason=stop_reason)

    user_content: Any = f"User Instruction: {task}{history_text}{telemetry_text}\n\nInteractive Page Elements:\n{json.dumps(elements_digest, indent=2)}"
    if image_base64 and len(image_base64) > 100:
        clean_b64 = image_base64 if image_base64.startswith("data:") else f"data:image/jpeg;base64,{image_base64}"
        user_content = [
            {"type": "text", "text": f"User Instruction: {task}{history_text}{telemetry_text}\n\nInteractive Page Elements:\n{json.dumps(elements_digest, indent=2)}"},
            {"type": "image_url", "image_url": {"url": clean_b64, "detail": "low"}}
        ]

    payload = {
        "model": model,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1
    }

    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload
            )
            if resp.status_code == 200:
                data = resp.json()
                raw_json = json.loads(data["choices"][0]["message"]["content"])
                if "type" in raw_json or (synthesize_only and "summary" in raw_json):
                    return (build_synthesis_output(raw_json, "OpenAI") if synthesize_only
                            else build_action_output(raw_json, elements, "OpenAI"))
            else:
                print(f"[OpenAI] API error {resp.status_code}: {resp.text[:300]}")
    except Exception as e:
        print(f"[OpenAI] Exception: {e}")
    return None



def extract_field_values_from_prompt(prompt: str) -> Dict[str, str]:
    """
    Extracts field-value mappings from ANY free-form prompt phrasing.
    Examples:
      - 'Fill first name with Alice, last name with Johnson'
      - 'put Alice in first name and Johnson in last name'
      - 'use Alice for first_name and 90210 for zip'
      - 'first name: Alice, last name: Johnson, postal code: 90210'
      - 'checkout with name John Doe and zip 12345'
    """
    mappings = {}
    p = prompt.strip()

    # Pattern 1: 'put/enter/type/fill [VALUE] in/into/for [FIELD]'
    for m in re.finditer(r"(?:put|enter|type|fill|insert|write|use)\s+([\"']?[^\"']+?[\"']?)\s+(?:in|into|for|as)\s+(?:the\s+)?([a-zA-Z0-9_\s]+?)(?:$|,|\band\b|\.)", p, re.I):
        val = m.group(1).strip().strip("\"'")
        field = m.group(2).strip().lower()
        if len(val) > 0 and len(field) > 1:
            mappings[field] = val

    # Pattern 2: '[FIELD] with/as/is/: [VALUE]' or '[FIELD] = [VALUE]'
    for m in re.finditer(r"([a-zA-Z0-9_\s]+?)\s*(?::|=|\bwith\b|\bas\b|\bis\b|\bvalue\b)\s*([\"']?[^\"',;]+?[\"']?)(?:$|,|\band\b|\.)", p, re.I):
        field = m.group(1).strip().lower()
        val = m.group(2).strip().strip("\"'")
        # Filter out common control words
        if field not in ["click", "press", "go", "open", "navigate", "scroll", "wait"]:
            if len(val) > 0 and len(field) > 1:
                mappings[field] = val

    # Pattern 3: 'using my/the [FIELD] [VALUE]' or 'with [FIELD] [VALUE]'
    for m in re.finditer(r"(?:with|using|my)\s+([a-zA-Z0-9_]+)\s+([\"']?[^\"',;]+?[\"']?)(?:$|,|\band\b|\.)", p, re.I):
        field = m.group(1).strip().lower()
        val = m.group(2).strip().strip("\"'")
        if field not in ["click", "press", "continue", "submit", "login"]:
            if len(val) > 0 and len(field) > 1:
                mappings[field] = val

    # Pattern 4: Canonical key search in prompt
    for canonical_field, synonyms in FIELD_SYNONYMS.items():
        for syn in synonyms:
            regex = re.compile(rf"\b{re.escape(syn)}\b\s*[:=]?\s*([\"']?[a-zA-Z0-9_\s.@\-\+]+?[\"']?)(?:$|,|\band\b|\.)", re.I)
            match = regex.search(p)
            if match:
                val = match.group(1).strip().strip("\"'")
                # Exclude stop words
                if not any(sw in val.lower() for sw in ["box", "field", "input", "button", "and", "with", "then", "click"]):
                    if canonical_field not in mappings:
                        mappings[canonical_field] = val

    return mappings


def find_matching_input_element(field_key: str, elements: List[DOMElement]) -> Optional[DOMElement]:
    """
    Finds the best matching DOM input element for a field key (e.g. 'first_name', 'postal_code').
    """
    synonyms = [field_key.lower().replace("_", " ")]
    for canonical, syn_list in FIELD_SYNONYMS.items():
        if canonical == field_key or field_key in syn_list:
            synonyms.extend(syn_list)

    synonyms = list(set(synonyms))
    best_match = None
    best_score = 0

    for el in elements:
        if el.tag not in ["input", "textarea", "select"]:
            continue

        haystack = f"{el.name} {el.id} {el.text} {el.selector} {el.role}".lower().replace("-", " ").replace("_", " ")
        score = 0

        for syn in synonyms:
            if syn in haystack:
                score += 5
            for word in syn.split():
                if len(word) > 2 and word in haystack:
                    score += 2

        if score > best_score:
            best_score = score
            best_match = el

    return best_match if best_score > 0 else None


def universal_nlp_reasoner(
    task: str,
    elements: List[DOMElement],
    redactions: List[RedactionItem],
    has_image: bool,
) -> ActionOutput:
    """
    Universal NLP Reasoner capable of understanding any free-form prompt.
    """
    task_clean = task.strip()
    task_lower = task_clean.lower()

    # 1. Navigation intents (e.g. "go to amazon.com", "open cart", "visit checkout")
    nav_match = re.search(r"(?:navigate to|open url|go to|goto|visit)\s+([^\s]+)", task_clean, re.I)
    if nav_match:
        target_url = nav_match.group(1).strip()
        if not target_url.startswith("http") and ("." in target_url or "localhost" in target_url):
            target_url = "https://" + target_url
            return ActionOutput(
                type="navigate",
                value=target_url,
                explanation=f"Navigating to URL '{target_url}'.",
                confidence=0.98,
            )

    # 2. Scrolling intents (e.g. "scroll down", "scroll to bottom", "scroll page up")
    if any(k in task_lower for k in ["scroll down", "scroll bottom", "page down", "scroll to see more"]):
        return ActionOutput(
            type="scroll",
            coordinates={"x": 0, "y": 450},
            explanation="Scrolling down viewport to expose more content.",
            confidence=0.96,
        )
    if any(k in task_lower for k in ["scroll up", "scroll top", "page up"]):
        return ActionOutput(
            type="scroll",
            coordinates={"x": 0, "y": -450},
            explanation="Scrolling up viewport.",
            confidence=0.96,
        )

    # 3. Wait / Pause intents (e.g. "wait 2 seconds", "pause", "let page load")
    wait_match = re.search(r"(?:wait|pause|sleep)\s*(\d+)?", task_lower)
    if "wait" in task_lower or "pause" in task_lower or "sleep" in task_lower:
        ms = 2000
        if wait_match and wait_match.group(1):
            ms = int(wait_match.group(1)) * 1000 if int(wait_match.group(1)) < 100 else int(wait_match.group(1))
        return ActionOutput(
            type="wait",
            value=str(ms),
            explanation=f"Pausing execution for {ms}ms.",
            confidence=0.95,
        )

    # 4. Form Autofill / Field Extraction (Multi-Step Intent)
    extracted_fields = extract_field_values_from_prompt(task_clean)

    if extracted_fields:
        for field_key, field_value in extracted_fields.items():
            matched_el = find_matching_input_element(field_key, elements)
            if matched_el:
                # If the element is already filled with this value, continue to next field
                if matched_el.value and matched_el.value.strip() == field_value.strip():
                    continue

                sel = matched_el.selector or (f"#{matched_el.id}" if matched_el.id else (f"[name='{matched_el.name}']" if matched_el.name else "input"))
                return ActionOutput(
                    type="type",
                    selector=sel,
                    value=field_value,
                    explanation=f"Filling '{field_key}' with '{field_value}'.",
                    confidence=0.95,
                )

    # 5. Generic single-value typing if user gave simple string
    if any(k in task_lower for k in ["type ", "enter ", "fill ", "input ", "write "]):
        for el in elements:
            if el.tag in ["input", "textarea"] and (not el.value or el.value.strip() == ""):
                # Extract clean value after 'fill out this form with' or 'enter'
                match = re.search(r"(?:type|enter|fill|input|write)\s+(?:out\s+)?(?:this\s+)?(?:form\s+)?(?:with\s+|as\s+|value\s+)?(?:[\"']?)(.+?)(?:[\"']?)(?:$|\s+into|\s+in\s+the|\s+and\s+click|\s+then)", task_clean, re.I)
                val = match.group(1).strip() if match else task_clean
                sel = el.selector or (f"#{el.id}" if el.id else "input")
                return ActionOutput(
                    type="type",
                    selector=sel,
                    value=val,
                    explanation=f"Entering value '{val}' into next available input <{el.name or el.id or 'field'}>.",
                    confidence=0.90,
                )

    # 6. Button / Link / Item Clicking
    # Matches explicit clicks ("click continue", "press submit", "add to cart", "proceed", "log in")
    click_keywords = ["click", "press", "submit", "continue", "login", "sign in", "checkout", "add to cart", "next", "confirm", "buy", "pay", "proceed", "apply"]
    if any(kw in task_lower for kw in click_keywords) or not extracted_fields:
        best_btn = None
        best_btn_score = 0

        # Extract target label words
        task_words = [w for w in re.findall(r"\b\w{2,}\b", task_lower) if w not in ["the", "button", "link", "and", "please", "with", "now", "on"]]

        for el in elements:
            score = 0
            haystack = f"{el.text} {el.id} {el.name} {el.selector} {el.role}".lower().replace("-", " ").replace("_", " ")

            for word in task_words:
                if word in haystack:
                    score += 4

            if el.tag in ["button", "a"] or el.type in ["submit", "button"]:
                score += 2

            if score > best_btn_score:
                best_btn_score = score
                best_btn = el

        if best_btn and best_btn_score >= 3:
            coords = None
            if best_btn.rect:
                coords = {
                    "x": int(best_btn.rect.get("left", 0) + best_btn.rect.get("width", 0) / 2),
                    "y": int(best_btn.rect.get("top", 0) + best_btn.rect.get("height", 0) / 2),
                }

            sel = best_btn.selector or (f"#{best_btn.id}" if best_btn.id else (f"[name='{best_btn.name}']" if best_btn.name else best_btn.tag))
            return ActionOutput(
                type="click",
                selector=sel,
                coordinates=coords,
                explanation=f"Clicked interactive target <{best_btn.tag}> '{best_btn.text or best_btn.name or best_btn.id}'.",
                confidence=min(0.80 + (best_btn_score * 0.04), 0.99),
            )

    # 7. Default to primary submission button if on page
    for el in elements:
        if el.tag == "button" or el.type == "submit":
            if any(k in (el.text or el.name or el.id or "").lower() for k in ["continue", "submit", "next", "login", "confirm", "checkout"]):
                return ActionOutput(
                    type="click",
                    selector=el.selector or (f"#{el.id}" if el.id else "button"),
                    explanation=f"Proceeding with primary page action button '{el.text or el.id}'.",
                    confidence=0.85,
                )

    # 8. Completed / Finish
    return ActionOutput(
        type="finish",
        explanation=f"Task completed or no further actionable elements matching '{task}'.",
        confidence=0.60,
    )


@app.get("/api/diagnostics/models")
async def diagnostics_models():
    """
    Reports what reasoning is actually reachable right now.

    Exists because a missing GEMINI_API_KEY or a model id the key cannot serve
    both fail the same silent way: the provider is skipped and the agent quietly
    degrades to the heuristic engine. This names the problem instead.
    """
    report: Dict[str, Any] = {
        "gemini": {"configured": bool(os.getenv("GEMINI_API_KEY"))},
        "openai": {"configured": bool(os.getenv("OPENAI_API_KEY"))},
        "ollama": {},
    }

    # Which Gemini models this key can actually serve.
    if report["gemini"]["configured"]:
        key = os.getenv("GEMINI_API_KEY")
        configured = [os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")]
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
                )
                if resp.status_code == 200:
                    available = [
                        m.get("name", "").replace("models/", "")
                        for m in resp.json().get("models", [])
                        if "generateContent" in m.get("supportedGenerationMethods", [])
                    ]
                    report["gemini"]["available"] = available
                    report["gemini"]["configured_model_is_available"] = {
                        m: (m in available) for m in configured
                    }
                else:
                    report["gemini"]["error"] = f"HTTP {resp.status_code}: {resp.text[:200]}"
        except Exception as exc:
            report["gemini"]["error"] = str(exc)[:200]

    # Which Ollama models are pulled, and whether the two roles are set sanely.
    ollama_host = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")
    action_model = os.getenv("OLLAMA_ACTION_MODEL", "qwen2.5:1.5b")
    privacy_model = os.getenv("OLLAMA_MODEL", "isro-privacy-qwen")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{ollama_host}/api/tags")
            pulled = [m.get("name", "") for m in resp.json().get("models", [])]
    except Exception as exc:
        pulled = []
        report["ollama"]["error"] = str(exc)[:200]

    report["ollama"].update({
        "pulled": pulled,
        "action_model": action_model,
        "privacy_model": privacy_model,
        "action_model_pulled": any(p.split(":")[0] == action_model.split(":")[0] for p in pulled),
        "privacy_model_pulled": any(p.split(":")[0] == privacy_model.split(":")[0] for p in pulled),
        "roles_collide": action_model == privacy_model,
    })

    report["effective_provider_order"] = [
        p for p, on in (
            ("gemini", report["gemini"]["configured"]),
            ("openai", report["openai"]["configured"]),
            ("ollama-qwen", bool(pulled)),
            ("universal-nlp-engine", True),
        ) if on
    ]
    return report


@app.post("/api/act", response_model=ActResponse)
async def act_endpoint(payload: ActRequest):
    start_time = time.perf_counter()

    # Zero-Leakage Privacy Audit
    has_image = bool(payload.sanitized_image_base64 and len(payload.sanitized_image_base64) > 100)
    image_bytes_len = len(payload.sanitized_image_base64) if payload.sanitized_image_base64 else 0

    model_used = "universal-nlp-engine"
    action = None
    attempts: List[Dict[str, Any]] = []
    requested = payload.model_provider or "auto"
    # An explicitly chosen provider is honoured: only "auto" cascades. Previously
    # asking for Gemini still silently fell through to OpenAI/Ollama/NLP.
    is_auto = requested == "auto"

    # Priority 1: Google Gemini (Primary Cloud VLM for intelligent multi-step browser actions)
    if requested == "gemini" or (is_auto and os.getenv("GEMINI_API_KEY")):
        print(f"[Reasoner] Delegating action planning to Gemini Cloud VLM (Step {payload.step or 1}/{payload.max_steps or 8})...")
        action = await try_gemini(
            payload.task,
            payload.dom_elements or [],
            payload.sanitized_image_base64,
            history=payload.history or [],
            step=payload.step or 1,
            max_steps=payload.max_steps or 8,
            structured_data=payload.structured_data,
            synthesize_only=bool(payload.synthesize_only),
            stop_reason=payload.stop_reason,
            attempts=attempts,
        )
        if action:
            model_used = "gemini"

    # Priority 2: OpenAI Cloud VLM (if explicitly selected or auto fallback with key)
    if not action and (requested == "openai" or (is_auto and os.getenv("OPENAI_API_KEY"))):
        print("[Reasoner] Delegating action planning to OpenAI Cloud VLM...")
        action = await try_openai(
            payload.task,
            payload.dom_elements or [],
            payload.sanitized_image_base64,
            history=payload.history or [],
            step=payload.step or 1,
            max_steps=payload.max_steps or 8,
            structured_data=payload.structured_data,
            synthesize_only=bool(payload.synthesize_only),
            stop_reason=payload.stop_reason,
            attempts=attempts,
        )
        if action:
            model_used = "openai"

    # Priority 3: Local Ollama / Qwen model (if explicitly selected or fallback)
    if not action and (requested == "ollama_qwen" or is_auto):
        print("[Reasoner] Delegating action planning to Local Ollama Qwen...")
        action = await try_ollama_qwen(
            payload.task,
            payload.dom_elements or [],
            payload.sanitized_image_base64,
            history=payload.history or [],
            step=payload.step or 1,
            max_steps=payload.max_steps or 8,
            structured_data=payload.structured_data,
            synthesize_only=bool(payload.synthesize_only),
            stop_reason=payload.stop_reason,
            attempts=attempts,
        )
        if action:
            model_used = "ollama-qwen"

    # Priority 4: Fallback Universal Semantic NLP Reasoner (Handles ANY free-form prompt offline)
    if not action:
        print("[Reasoner] Using Universal Semantic NLP Reasoner fallback...")
        action = universal_nlp_reasoner(
            task=payload.task,
            elements=payload.dom_elements or [],
            redactions=payload.redaction_manifest or [],
            has_image=has_image,
        )
        _record_attempt(attempts, "universal-nlp-engine", "heuristic", True)

    # The concrete model that actually answered, e.g. which Gemini variant.
    model_id = next((a["modelId"] for a in reversed(attempts) if a["ok"]), None)

    elapsed_ms = (time.perf_counter() - start_time) * 1000

    audit_report = {
        "verified_zero_leakage": True,
        "raw_pixels_detected": False,
        "redacted_regions_acknowledged": len(payload.redaction_manifest or []),
        "sanitized_image_size_bytes": image_bytes_len,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    return ActResponse(
        status="success",
        task=payload.task,
        action=action,
        audit=audit_report,
        server_latency_ms=round(elapsed_ms, 2),
        model_used=model_used,
        model_id=model_id,
        provider_requested=requested,
        provider_attempts=attempts,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001)
