/**
 * Two changes that share a failure mode: the sanitized image was unreadable.
 *
 * 1. TIGHT BOXES. scanVisibleTextNodes used to walk up to the nearest block
 *    ancestor and black out its whole rect, so one email inside a <pre>
 *    obliterated the entire code block — and a per-ancestor dedupe meant an
 *    eight-line address block produced exactly ONE box. Boxes now cover the
 *    matched characters, via Range.getClientRects() so wrapped text gets one
 *    rect per line instead of a union rectangle swallowing the lines between.
 *
 * 2. LABELLED BOXES. The blackout painted flat #000, so the model (and the
 *    user) saw anonymous rectangles. Boxes now carry their category token.
 *    This is only safe because the zero-leakage guard runs BEFORE the
 *    annotation pass — see the ordering test at the bottom, which is the one
 *    that actually protects the security property.
 *
 * Run: node scripts/test-tight-boxes-and-labels.mjs
 */
import fs from 'node:fs';

const ROOT = 'C:/BrowserExt/browserxtension-2-working/pii-agent-extension';
const readSrc = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const contentSrc = readSrc(`${ROOT}/content.js`);
const offscreenSrc = readSrc(`${ROOT}/offscreen.js`);

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  PASS  ' : '  FAIL  ') + name); };

// Lift the pure pieces out (both files are browser-only modules).
const slice = (src, start, endAfter) =>
  src.slice(src.indexOf(start), src.indexOf('\n}\n', src.indexOf(endAfter)) + 3);

const patternsBlock = contentSrc.slice(
  contentSrc.indexOf('const CREDENTIAL_LABELS'),
  contentSrc.indexOf('const OVERLAY_ID'));
const globalBlock = contentSrc.slice(
  contentSrc.indexOf('const INLINE_PII_PATTERNS_GLOBAL'),
  contentSrc.indexOf('/**', contentSrc.indexOf('const INLINE_PII_PATTERNS_GLOBAL')));

const { INLINE_PII_PATTERNS, INLINE_PII_PATTERNS_GLOBAL, isOnScreen } = new Function(`
${patternsBlock}
${globalBlock}
${slice(contentSrc, 'function isOnScreen', 'function isOnScreen')}
return { INLINE_PII_PATTERNS, INLINE_PII_PATTERNS_GLOBAL, isOnScreen };
`)();

console.log('tight boxes: every occurrence is found, not just the first');
{
  // The reported failure: an address block where 8 lines of PII collapsed into
  // one whole-block rectangle.
  const block = [
    'Email: a@example.com',
    'Email: b@example.com',
    'Email: c@example.com',
  ].join('\n');

  const hits = [...block.matchAll(INLINE_PII_PATTERNS_GLOBAL.EMAIL)];
  check('all three emails are matched, not one', hits.length === 3);
  check('each match carries its own offset',
    hits[0].index < hits[1].index && hits[1].index < hits[2].index);
  check('offsets point at the value, not the "Email:" label',
    block.slice(hits[0].index, hits[0].index + hits[0][0].length) === 'a@example.com');
}

console.log('\ntight boxes: the global regexes are stateless across calls');
{
  // A shared /g regex carries lastIndex, so a second scan of the same page
  // would silently start mid-string and miss earlier PII. matchAll() is
  // specified to operate on a clone, but the patterns are module-level and
  // reused for every node, so this is worth pinning.
  const text = 'contact a@example.com or b@example.com';
  const first = [...text.matchAll(INLINE_PII_PATTERNS_GLOBAL.EMAIL)].length;
  const second = [...text.matchAll(INLINE_PII_PATTERNS_GLOBAL.EMAIL)].length;
  const third = [...text.matchAll(INLINE_PII_PATTERNS_GLOBAL.EMAIL)].length;
  check('repeated scans return identical counts', first === 2 && second === 2 && third === 2);
  check('lastIndex is not left dirty', INLINE_PII_PATTERNS_GLOBAL.EMAIL.lastIndex === 0);
}

console.log('\ntight boxes: every pattern got a global twin');
{
  const names = Object.keys(INLINE_PII_PATTERNS);
  check('one global twin per pattern',
    Object.keys(INLINE_PII_PATTERNS_GLOBAL).length === names.length);
  check('every twin has the /g flag',
    names.every((n) => INLINE_PII_PATTERNS_GLOBAL[n].flags.includes('g')));
  check('every twin keeps its source unchanged',
    names.every((n) => INLINE_PII_PATTERNS_GLOBAL[n].source === INLINE_PII_PATTERNS[n].source));
  check('case-insensitive patterns stay case-insensitive',
    INLINE_PII_PATTERNS.CREDENTIAL.flags.includes('i') ===
    INLINE_PII_PATTERNS_GLOBAL.CREDENTIAL.flags.includes('i'));
}

console.log('\ntight boxes: on-screen test');
{
  const r = (left, top, width, height) =>
    ({ left, top, width, height, right: left + width, bottom: top + height });
  global.window = { innerWidth: 1280, innerHeight: 800 };

  check('a visible rect is on screen', isOnScreen(r(100, 100, 200, 20)));
  check('a rect scrolled above the fold is not', !isOnScreen(r(100, -50, 200, 20)));
  check('a rect below the fold is not', !isOnScreen(r(100, 900, 200, 20)));
  check('a rect off to the right is not', !isOnScreen(r(1400, 100, 200, 20)));
  check('a zero-height rect is rejected', !isOnScreen(r(100, 100, 200, 0)));
  check('a rect straddling the top edge IS kept', isOnScreen(r(100, -5, 200, 20)));
}

console.log('\ntight boxes: the ancestor fallback still exists');
{
  // The fallback is the whole point of being able to tighten safely: an
  // unmeasurable range must over-redact, never drop the match.
  check('rectsForMatch returns [] rather than throwing',
    /catch \{\s*return \[\];\s*\}/.test(contentSrc.slice(
      contentSrc.indexOf('function rectsForMatch'),
      contentSrc.indexOf('function isOnScreen'))));
  check('an unmeasurable range falls back to the block ancestor',
    /unmeasurable range — block fallback/.test(contentSrc));
  check('the fallback path still walks up to a block element',
    /isBlockElement\(ancestor\) && depth >= 1/.test(contentSrc));
  check('per-page box count is capped', /results\.length >= MAX_TEXT_BOXES/.test(contentSrc));
  check('per-node match count is capped', /matchCount > MAX_MATCHES_PER_NODE/.test(contentSrc));
}

// ── labels ──────────────────────────────────────────────────────────────────
const { redactionToken, fitLabelSize, annotateRedaction } = new Function(`
${offscreenSrc.slice(offscreenSrc.indexOf('const REDACTION_TOKEN_BY_CATEGORY'), offscreenSrc.indexOf('function verifyRedactionOpacity'))}
return { redactionToken, fitLabelSize, annotateRedaction };
`)();

console.log('\nlabels: the token names the category, never the value');
{
  check('an email box reads EMAIL', redactionToken({ label: 'Email Address' }) === 'EMAIL');
  check('a phone box reads PHONE', redactionToken({ label: 'Phone Number' }) === 'PHONE');
  check('a credential box reads PASSWORD', redactionToken({ label: 'Credential' }) === 'PASSWORD');
  check('an API key box reads SECRET', redactionToken({ label: 'API Key / Token' }) === 'SECRET');
  check('a UPI box reads FINANCIAL', redactionToken({ label: 'UPI ID' }) === 'FINANCIAL');
  check('a card box reads CARD', redactionToken({ label: 'Credit Card Number' }) === 'CARD');
  check('an aadhaar box reads GOV_ID', redactionToken({ label: 'Aadhaar Number' }) === 'GOV_ID');

  // Faces have no detector label at all — only a category.
  check('a face box falls back to its category', redactionToken({ category: 'faces' }) === 'FACE');
  check('an unknown box degrades to PII', redactionToken({ category: 'nonesuch' }) === 'PII');
  check('an empty box does not throw', redactionToken({}) === 'PII');

  // The label must never be able to carry a value.
  const token = redactionToken({ label: 'Email Address', text: 'alice@example.com', value: 'alice@example.com' });
  check('a value attached to the box cannot reach the token', !token.includes('alice'));
}

console.log('\nlabels: the size ladder, so a label never overflows its box');
{
  // Stub 2D context: monospace-ish, 0.6em per character.
  const ctx = {
    font: '', _size: 10,
    set _f(v) {},
    measureText(t) {
      const size = parseInt(this.font.match(/(\d+)px/)?.[1] || '10', 10);
      return { width: t.length * size * 0.6 };
    },
  };

  const big = fitLabelSize(ctx, '[PASSWORD]', 300, 40);
  check('a roomy box gets the maximum font size', big === 14);

  const snug = fitLabelSize(ctx, '[PASSWORD]', 80, 20);
  check('a narrow box gets a smaller font that still fits', snug > 0 && snug < 14);
  ctx.font = `600 ${snug}px x`;
  check('the chosen size actually fits inside the box',
    ctx.measureText('[PASSWORD]').width <= 80 - 8);

  check('a box too short for any legible text is refused',
    fitLabelSize(ctx, '[PASSWORD]', 300, 6) === 0);
  check('a box too narrow for any legible text is refused',
    fitLabelSize(ctx, '[PASSWORD]', 20, 40) === 0);
}

console.log('\nlabels: annotate draws, and degrades rather than overflowing');
{
  const mkCtx = () => {
    const calls = [];
    return {
      calls, font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
      textAlign: '', textBaseline: '',
      save() { calls.push(['save']); },
      restore() { calls.push(['restore']); },
      strokeRect(...a) { calls.push(['strokeRect', ...a]); },
      fillText(...a) { calls.push(['fillText', ...a]); },
      measureText(t) {
        const size = parseInt(this.font.match(/(\d+)px/)?.[1] || '10', 10);
        return { width: t.length * size * 0.6 };
      },
    };
  };

  const roomy = mkCtx();
  check('a roomy box is labelled',
    annotateRedaction(roomy, { x: 10, y: 20, w: 300, h: 40, label: 'Email Address' }) === true);
  const drawn = roomy.calls.find((c) => c[0] === 'fillText');
  check('the full bracketed token is drawn', drawn && drawn[1] === '[EMAIL]');
  check('the label is centred in the box', drawn && drawn[2] === 160 && drawn[3] === 40);
  check('a border is still drawn', roomy.calls.some((c) => c[0] === 'strokeRect'));
  check('context state is saved and restored',
    roomy.calls[0][0] === 'save' && roomy.calls[roomy.calls.length - 1][0] === 'restore');

  // The ladder: full token -> no brackets -> abbreviation -> nothing.
  const tight = mkCtx();
  annotateRedaction(tight, { x: 0, y: 0, w: 46, h: 16, category: 'passwords' });
  const tightText = tight.calls.find((c) => c[0] === 'fillText');
  check('a tight box steps down to a shorter form',
    tightText && tightText[1] !== '[PASSWORD]' && tightText[1].length < '[PASSWORD]'.length);

  const tiny = mkCtx();
  const labelled = annotateRedaction(tiny, { x: 0, y: 0, w: 12, h: 5, category: 'passwords' });
  check('a box too small for any label draws none', labelled === false);
  check('a too-small box is still bordered', tiny.calls.some((c) => c[0] === 'strokeRect'));
  check('a too-small box still restores context',
    tiny.calls[tiny.calls.length - 1][0] === 'restore');

  const degenerate = mkCtx();
  check('a zero-size box is skipped entirely',
    annotateRedaction(degenerate, { x: 0, y: 0, w: 0, h: 0 }) === false);
  check('a zero-size box draws nothing at all', degenerate.calls.length === 0);
}

console.log('\nSECURITY: the guard must run BEFORE anything is drawn into a box');
{
  // This is the test that matters. The guard fails any box whose peak sampled
  // luma exceeds 40; a legible label is ~200 and the old #ef4444 border was
  // 119. Drawing either before verification made every box "fail", triggering
  // an emergency repaint that erased the mark and reported a bogus
  // zero-leakage failure on every single capture.
  const fillIdx     = offscreenSrc.indexOf('const tStartPaint');
  const guardIdx    = offscreenSrc.indexOf('const verdict = verifyRedactionOpacity');
  const annotateIdx = offscreenSrc.indexOf('const tStartAnnotate');

  check('all three phases exist', fillIdx > 0 && guardIdx > 0 && annotateIdx > 0);
  check('fill happens before the guard runs', fillIdx < guardIdx);
  check('the guard runs before the annotation pass', guardIdx < annotateIdx);

  const fillBlock = offscreenSrc.slice(fillIdx, offscreenSrc.indexOf('const tEndPaint'));
  check('the blackout fills flat black', /fillStyle = "#000000"/.test(fillBlock));
  check('the blackout draws NO border', !/strokeRect/.test(fillBlock));
  check('the blackout draws NO text', !/fillText/.test(fillBlock));

  const annotateBlock = offscreenSrc.slice(
    offscreenSrc.indexOf('function annotateRedaction'),
    offscreenSrc.indexOf('function verifyRedactionOpacity'));
  check('the annotation pass is what draws the border', /strokeRect/.test(annotateBlock));
  check('the annotation pass is what draws the label', /fillText/.test(annotateBlock));

  // The emergency repaint must also stay a pure fill.
  const emergency = offscreenSrc.slice(
    offscreenSrc.indexOf('Emergency blackout'),
    offscreenSrc.indexOf('guardReport.emergencyBlackout = true'));
  check('the emergency repaint is a pure fill too', !/fillText|strokeRect/.test(emergency));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
