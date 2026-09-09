# Privacy Agent — UI redesign

Nine files changed. Everything else in the extension is untouched.

## Copy these over your extension folder

    options.html   options.css   options.js      settings page, rebuilt
    hud.html       hud.css       hud.js          live view, rebuilt
    content.js                                   the chip and overlays drawn on pages
    background.js                                toolbar badge, context menu
    action_engine.js                             the flash when the agent acts

Then open `chrome://extensions`, press reload on the extension, and reopen the
settings page. The service worker caches `background.js`, so a reload is
required, not just a page refresh.

## If you diff against your own copy

The settings page markup was rewritten, so a few ids moved:

    chkEnabled      -> toggleProtection      the master switch, now a hero toggle
    vaultTableBody  -> vaultList             a <ul>, no longer a table
    saveToast       -> savedNote             the autosave whisper
    btnSave         removed                  every control saves itself
    pageTitle       removed                  the page title is the brand
    the nav rail    removed                  four groups need no navigation

New: `btnOpenHud` and `btnOpenDemo` under Advanced, and `menu_open_live_view`
in the context menu — `hud.html` previously had no entry point anywhere in the
extension, so it could only be reached by typing its URL.

## What changed, by surface

The settings page now opens as one 640px column: a sentence that says whether
protection is on, six switches for what gets hidden, your saved details, sites
to skip, shortcuts. Everything else — engine, server, history, thresholds,
backup, reset — sits behind one Advanced switch that shares its state with the
popup, so the two surfaces open in the same mode. Nothing is saved by a button;
each control writes as it changes and a small "Saved" line confirms it.

The live view keeps every id `hud.js` reads, but the four telemetry figures and
the five rubric scores are now one hairline-divided strip instead of nine
identical cards, the latency waterfall uses a single fill colour so width tells
the story, and the metrics modal is closed properly (it was nested inside an
unclosed `<section>`).

On-page: the floating chip is a neutral pill reading "Protected · 4 hidden"
with a five-pixel dot, no shield emoji and no glow. Highlight boxes label
themselves with the same red-on-dark pill the audit table uses. The flash when
the agent acts says "Clicked" rather than "🤖 Action: CLICK".

The toolbar badge no longer paints a count red. Finding four things to hide is
the extension working, so the chip is green with the count, and grey with "off"
when paused.

## Two things fixed on the way through

The live view claimed "~460 ms WebGPU latency" in a hint while your own
`benchmark_results.json` records `latency_warm_ms: 504.8`. The page now states
504 ms and breaks it down honestly. The old settings page also carried a stray
`$\rightarrow` in the engine dropdown.

Both the old `options.js` and `hud.js` built list and table rows by
interpolating page-derived strings into `innerHTML`. Those values come off
whatever page was inspected, so every cell is now a text node.

## Verified here, and not

Checked without a browser: both pages parse with balanced tags and no duplicate
ids; all 47 ids `options.js` reads and all 22 `hud.js` reads exist in the
markup; every class used has a rule; no blue-leaning colour and no emoji
survives in any of the nine files; every setting the page writes exists in
`DEFAULT_SETTINGS` and is read by some module; every `vault.*` call resolves;
every page the UI offers to open exists. All five scripts pass `node --check`.

Not checked: how it actually looks. There is no browser in this environment, so
the visual pass is yours.
