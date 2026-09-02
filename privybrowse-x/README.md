# PrivyBrowse X

On-device visual perception for light-weight browser agents.
SIH problem statement **26171** — ISRO, Department of Space, Smart Automation.

A browser extension that runs a Vision Transformer locally, finds sensitive
regions on screen, destroys them in the pixels **before** any network call, and
sends only a redacted frame plus a scrubbed DOM digest to a server.

---

## The one-paragraph version, for a judge

The extension detects sensitive content twice over — cheap deterministic DOM
rules for anything the page describes structurally, and a local ONNX vision
model for the pixels the DOM is blind to (webcam feeds, canvas, images, embedded
PDFs). Both feed **one** detection set, which drives **two** sinks: opaque masks
burned into the captured bitmap, and typed redaction tokens substituted into the
text digest. Nothing leaves the device until both sinks have run, and if the
vision layer is unhealthy the frame is refused rather than sent half-protected.

---

## Setup

Requires Chrome 116+ (or Edge 116+) and Node 18+.

```bash
cd privybrowse-x
npm install @huggingface/transformers@3.7.6
node tools/vendor-deps.mjs
node tools/verify.mjs
```

`vendor-deps.mjs` needs internet **once**. It copies the Transformers.js browser
bundle into `vendor/`, the ONNX Runtime WASM binaries into `wasm/`, and the
`Xenova/yolos-tiny` weights into `models/`. After that the extension never makes
an outbound request for code or weights — which is both an MV3 CSP requirement
and the reason the demo doesn't depend on venue wifi.

Then load it:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `privybrowse-x` folder
3. Open `demo/bank-verification.html` as a file URL, or serve it:
   `python3 -m http.server 8000 --directory demo`

If you loaded the extension before running `vendor-deps.mjs`, hit the reload
icon on the extension card afterwards. The offscreen document caches its failed
load attempt.

---

## Browser smoke test

`tools/verify.mjs` runs 68 unit tests, a parity check, and static analysis — but
it runs in Node. It cannot exercise canvas compositing, WebGPU, or any `chrome.*`
API. **Everything below has to be checked by hand in a real browser**, and this
is the list to run before any demo.

| # | Step | Pass condition |
|---|------|----------------|
| 1 | Click the extension icon on the demo page | Backend badge reads `webgpu` (or `wasm` — see note), model load time shown |
| 2 | Click **Highlight** | Red boxes over the identity, payment, and account-summary sections |
| 3 | Look at the **control group** section | **Zero** boxes. Any box here is a false positive and a scoring problem |
| 4 | Click **Clear** | All boxes removed, no leftovers after scrolling |
| 5 | Scroll with highlights on | Boxes stay glued to their fields; no visible lag |
| 6 | Click **Open live redaction HUD**, then **Capture & redact** in the HUD | Side-by-side raw vs redacted panels populate |
| 7 | Compare the two HUD panels | Password, card, Aadhaar, PAN, UPI, email fully **opaque black** in the redacted panel — not blurred, not translucent |
| 8 | Read the sanitized payload `<pre>` | Contains `[REDACTED:EMAIL]`, `[REDACTED:FIELD]` etc. Search it for `Str0ngPassPhrase`, `4111`, `7412` — **zero hits** |
| 9 | Click **Start camera** on the demo page, re-run the HUD | Person/face region masked in the redacted panel, visible in the raw panel |
| 10 | Check the latency card | Stage breakdown present; cold-start separated from steady-state p50/p95 |
| 11 | Open the offscreen console (`chrome://extensions` → *service worker* / *offscreen*) | No CSP violations, no 404s for `wasm/` or `models/` |

**On step 1:** if the badge says `wasm` on a machine with a working GPU,
something silently fell back and your latency number is roughly 4× worse than it
should be. Check `chrome://gpu`. Report whichever provider actually ran — a
claimed WebGPU number that was really CPU is the kind of thing that unravels
under questioning.

**On step 8:** this is the test that matters most. Steps 7 and 8 are separate
sinks and can fail independently — a frame can be perfectly masked in pixels
while the digest still ships the password as a string.

---

## Layout

```
manifest.json          MV3. CSP carries 'wasm-unsafe-eval' — ORT will not init without it
src/
  background.js        Service worker. Pure router: capture → offscreen → HUD
  offscreen.html/.js   Inference host. Exists because a SW has no DOM, no canvas,
                       and no navigator.gpu, and dies after ~30s idle
  content.js           DOM scan + digest build + detection overlay (runs in-page)
  detector.js          ONE detector. L1 type=password → L2 autocomplete → L3 label
                       regex → L4 value regex, gated on Luhn / Verhoeff
  redact.js            Pixel sink. Opaque masks, box merging, fail-closed gate
  coords.js            All four coordinate spaces, in one tested place
  metrics.js           Per-stage timing, cold vs steady state, p50/p95
  hud.html/.js         Raw vs redacted, latency bar, mask inventory, payload
  popup.html/.js       Backend badge + highlight/clear
demo/
  bank-verification.html   Synthetic page: every layer + a false-positive control group
tools/
  vendor-deps.mjs      One-time offline bundling
  verify.mjs           Pre-flight. Run before every demo
```

---

## Design decisions worth defending

**Masks are opaque, never blurred.** Blur and pixelation over text are
reversible, and partial alpha leaves text legible. `drawSolidMask` sets
`globalAlpha = 1.0` explicitly. The translucent boxes you see in the page
overlay are *detection* markers for the operator — a separate thing from
redaction, and conflating the two was the main flaw in the Day 1 prototype.

**Fail-closed.** If the vision layer is unhealthy, `redact.js` throws rather
than transmitting. A DOM-only redaction looks fine and can still contain a face.
The HUD surfaces this as intended behaviour, not as a crash.

**Typed redaction tokens.** `[REDACTED:EMAIL]`, not a bare `[REDACTED]`. The
server model learns that a field *is* an email without learning *which* email —
this is the problem statement's "the server should be aware of this redaction
scheme", implemented rather than asserted.

**Checksum gating.** Aadhaar goes through Verhoeff, cards through Luhn. Without
these, a 12-digit order number is an Aadhaar and precision collapses. A run-guard
(`notPartOfLongerRun`) additionally rejects a 12-digit match sitting inside a
16-digit run — that bug was real, was caught by the control group, and is now a
regression test.

**Two copies of the detection logic, one parity test.** MV3 content scripts
aren't ES modules, so `content.js` inlines what `detector.js` exports. Two copies
drift. `verify.mjs` extracts both and runs them against identical inputs, so
drift fails at pre-flight instead of appearing as "the overlay flags it but the
payload leaks it".

**DOM first, vision only where DOM is blind.** Attribute rules are essentially
free and near-perfect on structured pages. Vision is expensive and is scored
against you twice (client resource utilization 20%, end-to-end latency 15%).
Running it on regions the DOM already explains is paying twice for one answer.

---

## Scoring map

| Metric | Weight | Where it lives |
|--------|--------|----------------|
| Accuracy of visual context | 25% | `content.js` digest + `offscreen.js` detections |
| PII recall & precision | 20% | `detector.js`, measured by `verify.mjs` §4 |
| Precision of redaction | 20% | `redact.js` — `leakedPixelRate`, box IoU |
| Client resource utilization | 20% | `metrics.js` — heap sampling, execution provider |
| End-to-end latency | 15% | `metrics.js` — per-stage, p50/p95, cold vs warm |

75% of the total is client-side and measured. Every number quoted in the deck
should come out of `metrics.js` or `verify.mjs`, not from a stopwatch.

---

## Current seed metrics

```
TP=13  FN=0  TN=8  FP=0   (n=21 strings)
precision=1.000  recall=1.000  F1=1.000
```

String-level text detection only, on the demo page's labelled content. **n is
small — quote the counts next to the ratios.** Box-level IoU and leaked-pixel
rate come from the Day 5 labelled screenshot set and are not measured yet.

---

## Known gaps

- **No OCR.** Text baked into images and canvas is invisible to every layer.
  The 25% visual-context metric is the one most affected.
- **`yolos-tiny` is a COCO detector.** It returns a whole-body `person` box, not
  a tight face box. Masking is conservative and over-redacts. A dedicated face
  model would fix this.
- **`captureVisibleTab` is rate-limited** to roughly 2 calls/sec and only sees
  the foreground tab, so the HUD is snapshot-driven rather than live.
  `chrome.tabCapture.getMediaStreamId` is the upgrade path to video-rate.
- **Chrome only so far.** The statement names Firefox too. `offscreen` is
  Chrome-specific; Firefox needs a background page equivalent.
- **No server yet.** Day 4: the endpoint, the VLM call, structured actions, and
  risk gating on high-risk verbs (buy / pay / transfer / delete / submit).
