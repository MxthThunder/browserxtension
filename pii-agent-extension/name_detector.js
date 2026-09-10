/**
 * Person-name detection (Layer G).
 *
 * Names were the one PII class the pipeline had no detector for at all: they are
 * absent from content.js's INLINE_PII_PATTERNS, absent from offscreen.js's
 * OCR_PII_PATTERNS, and invisible to OWL-ViT, which sees objects rather than
 * semantics. semantic_redactor mapped a category *label* containing "name" onto
 * PERSON, but nothing ever produced that label. A name on screen was therefore
 * never masked.
 *
 * Detection is deliberately deterministic and lives in ONE module, so the DOM
 * scanner, the OCR pass and the text redactor cannot drift apart the way the
 * three copies of the server prompt did.
 *
 * Two independent signals, because a bare "capitalised word" rule would redact
 * half of every navigation bar:
 *
 *   1. CUE-ANCHORED — a capitalised run introduced by a cue ("Name:", "Dear",
 *      "Mr", "Deliver to", "Ordered by"). High precision; this is how names
 *      appear on checkout, profile, invoice and ticket pages.
 *   2. GAZETTEER     — the run's first token is a known given name. Catches
 *      names with no nearby cue, at the cost of some false positives on brands
 *      and place names that share a given name.
 *
 * Neither depends on a model being available. Ollama's role (Layer G3) is to ADD
 * detections these rules miss, never to remove one they made.
 */

/** Words that introduce a person's name on the very same line. */
const NAME_CUES = [
  "name", "full name", "first name", "last name", "surname", "given name",
  "dear", "hi", "hello", "regards", "sincerely",
  "deliver to", "delivery to", "delivering to", "shipping to", "ship to",
  "ordered by", "billed to", "bill to", "sold to", "buyer", "seller",
  "customer", "client", "patient", "employee", "student", "candidate",
  "passenger", "traveller", "traveler", "guest", "member", "holder",
  "account holder", "cardholder", "beneficiary", "nominee", "applicant",
  "signed", "signature", "attn", "contact person", "reporting to",
];

/** Honorifics, which are themselves a cue and part of the name run. */
const HONORIFICS = [
  "mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam",
  "shri", "smt", "kum", "sri", "thiru", "selvi",
];

/**
 * Capitalised words that are almost never a person in a browser UI. Without
 * this, cue matching still trips on things like "Deliver to Home" and the
 * gazetteer branch redacts menu items.
 */
const NAME_STOPWORDS = new Set([
  // Navigation and commerce chrome
  "home", "search", "login", "logout", "signin", "sign", "signup", "register",
  "cart", "checkout", "buy", "add", "order", "orders", "menu", "filter",
  "filters", "sort", "price", "prices", "offer", "offers", "deal", "deals",
  "delivery", "delivered", "shipping", "free", "new", "best", "top", "more",
  "all", "view", "show", "hide", "back", "next", "previous", "continue",
  "submit", "cancel", "close", "help", "support", "settings", "account",
  "profile", "wishlist", "compare", "rating", "ratings", "review", "reviews",
  "product", "products", "brand", "brands", "category", "categories",
  "electronics", "fashion", "mobiles", "grocery", "returns", "exchange",
  "warranty", "assured", "express", "prime", "plus", "gold", "premium",
  "available", "unavailable", "stock", "sold", "out", "in", "on", "off",
  "yes", "no", "ok", "done", "edit", "delete", "remove", "save", "share",
  "address", "addresses", "payment", "payments", "wallet", "card", "upi",
  // Field labels. These sit directly beside the value they describe, so without
  // them a run happily swallows "Daniel Whitfield Email" as a three-token name.
  "name", "names", "person", "persons", "email", "mail", "phone", "mobile", "tel",
  "contact", "customer", "customers", "patient", "patients", "employee", "employees",
  "passenger", "passengers", "guest", "guests", "member", "members",
  "holder", "holders", "cardholder", "beneficiary", "nominee", "applicant", "applicants",
  "recipient", "recipients", "buyer", "buyers", "seller", "sellers", "client", "clients",
  "student", "students", "candidate", "candidates", "dear", "regards",
  "invoice", "receipt", "date", "total", "amount", "qty", "quantity", "status",
  // Time words
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "today", "tomorrow",
  "yesterday", "am", "pm",
  // Places that would otherwise read as names
  "india", "delhi", "mumbai", "chennai", "kolkata", "bangalore", "bengaluru",
  "hyderabad", "pune", "state", "city", "country", "pincode", "street",
]);

/**
 * Seed gazetteer of given names (Indian + international), lowercase.
 *
 * Deliberately a SEED, not a complete list: it covers high-frequency names so
 * the branch is useful immediately, and is meant to be extended. Recall for
 * names therefore rests mainly on the cue-anchored branch, which does not
 * depend on this list at all — see NAME_DETECTION_LIMITS below.
 */
const GIVEN_NAMES = new Set(`
aarav aditya advait akash akhil amit anand aniket anil anita anjali ankit ankur
anu anuj anupam arjun arun arvind ashish ashok asha aditi akshay alok amita
amol ananya aparna arti asmita avinash ayush
bharat bhavana bhavesh bhupendra bina
chetan chitra chandan chandra
darshan deepa deepak deepika dev devendra dhruv dinesh divya
farhan fatima firoz
gaurav gayatri geeta girish gopal gita govind gurpreet
harish harsh harsha hemant hina
indra isha ishaan
jaya jayant jitendra jyoti juhi
kabir kailash kamal kamala karan kartik kavita keshav kiran krishna kumar kunal
lakshmi lalit latha leela
madhu madhav mahesh mamta manish manoj maya meena meera mohan mohit mukesh
nandini naresh navin neha nikhil nilesh nisha nitin nithya
om omkar
pallavi pankaj parth pavan payal poonam prabhu pradeep prakash pramod pranav
prasad praveen preeti prem priya priyanka pooja purnima
radha raghav rahul raj rajat rajesh rakesh ram raman ramesh rani ranjan ravi
reena rekha renu rishi ritu rohan rohit roshan rupa
sachin sagar sameer sandeep sanjay sanjeev sarita satish saurabh seema shalini
shankar shanti sharda sharmila shashi shilpa shiv shivani shobha shreya shruti
shyam siddharth simran smita sneha sonal sonia subhash sudha sudhir sujata
sumit sunil sunita suresh surya sushma swati
tanvi tara tarun tejas trupti tushar
uday ujjwal uma usha utkarsh
varun vandana vasant vedant venkat vijay vikas vikram vimal vinay vinod vishal
vishnu vivek
yash yogesh yogita
zara zoya
adam adrian alan albert alex alexander alice amanda amy andrew angela ann anna
anne anthony arthur ashley barbara benjamin betty brandon brian bruce carl
carol caroline catherine charles charlotte cheryl chris christina christopher
claire daniel david deborah debra dennis diana diane donald donna dorothy
douglas edward elizabeth emily emma eric eugene evelyn frances francis frank
gary george gerald gloria grace gregory hannah harold harry heather helen henry
irene isabella jack jacob james jane janet jason jean jeffrey jennifer jeremy
jerry jesse jessica joan joe john jonathan jordan jose joseph joshua joyce juan
judith judy julia julie justin karen katherine kathleen kayla keith kelly
kenneth kevin kimberly larry laura lauren lawrence linda lisa logan lori louis
lucas madison marie margaret maria marilyn mark martha martin mary matthew
megan melissa michael michelle nancy natalie nathan nicholas nicole noah olivia
oliver pamela patricia patrick paul peter philip rachel ralph raymond rebecca
richard robert roger ronald rose roy russell ruth ryan samantha samuel sandra
sara sarah scott sean sharon shirley sophia stephanie stephen steven susan
teresa terry theresa thomas timothy tyler victoria vincent virginia walter
wayne william zachary
`.trim().split(/\s+/));

/**
 * Honest statement of what this layer does NOT catch, so callers do not
 * overstate coverage. Referenced by the docs and the dashboard.
 */
export const NAME_DETECTION_LIMITS = [
  "Names with no cue whose given name is outside the seed gazetteer",
  "Names written in non-Latin scripts (the OCR worker is English-only)",
  "Surname-only references ('Dr. Whitfield' is caught; a bare 'Whitfield' is not)",
  "Names rendered inside canvas/WebGL, handwriting, or heavily stylised type",
];

/**
 * Makes a cue match in any casing WITHOUT using the `i` flag.
 *
 * The flag cannot be used here: it would also apply to the capture group, whose
 * whole job is to require a leading capital, and a case-insensitive capture
 * matches ordinary lowercase prose. Expanding each letter to [Xx] keeps the two
 * halves of the pattern under different rules.
 */
function caseInsensitiveCue(cue) {
  return cue
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Letters are expanded BEFORE whitespace becomes \s+. Doing it the other way
    // round rewrites the `s` inside `\s+` into `\[sS]+` — a literal backslash
    // followed by a character class — which silently breaks every multi-word cue
    // ("deliver to", "ordered by", "account holder") while single-word cues
    // keep working, so the failure looks like patchy recall rather than a bug.
    .replace(/[a-z]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`)
    .replace(/\s+/g, "\\s+");
}

const CUE_ALTERNATION = [...NAME_CUES, ...HONORIFICS]
  .sort((a, b) => b.length - a.length)
  .map(caseInsensitiveCue)
  .join("|");

/**
 * A cue, then optional punctuation, then 1-3 capitalised tokens.
 * Unicode-aware so accented and transliterated names are not silently skipped.
 */
const CUED_NAME_RE = new RegExp(
  `\\b(?:${CUE_ALTERNATION})\\b[\\s:,.\\-]{0,4}` +
  `((?:[A-Z\\u00C0-\\u024F][a-z\\u00C0-\\u024F'’\\-]{1,20})(?:\\s+[A-Z\\u00C0-\\u024F][a-z\\u00C0-\\u024F'’\\-]{1,20}){0,2})`,
  "g"
);

/** A single capitalised token. Runs are assembled from these, not matched whole. */
const CAPITALISED_TOKEN_RE = /[A-ZÀ-ɏ][a-zÀ-ɏ'’\-]{1,20}/g;

/** Form fields whose value IS a person's name (Layer G1). */
export const NAME_FIELD_RE =
  /\b(full[\s_-]?name|first[\s_-]?name|last[\s_-]?name|given[\s_-]?name|family[\s_-]?name|sur[\s_-]?name|your[\s_-]?name|customer[\s_-]?name|recipient|deliver(?:y)?[\s_-]?to|ordered[\s_-]?by|card[\s_-]?holder|account[\s_-]?holder|beneficiary|nominee|contact[\s_-]?person|passenger[\s_-]?name|patient[\s_-]?name)\b/i;

/** autocomplete tokens that declare a name field outright. */
export const NAME_AUTOCOMPLETE = new Set([
  "name", "given-name", "family-name", "additional-name",
  "honorific-prefix", "honorific-suffix", "nickname",
]);

/**
 * Lowercase, diacritics stripped. "José" and "Jose" are the same given name;
 * without folding, every accented spelling would miss the gazetteer.
 */
function foldToken(token) {
  return token
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function isStopword(token) {
  return NAME_STOPWORDS.has(foldToken(token));
}

/**
 * True when a capitalised run is plausibly a person rather than UI chrome.
 * Every token must be a non-stopword; the run must not be entirely uppercase
 * (which is styling, not a name).
 */
function runLooksLikeName(run) {
  const tokens = run.trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every((t) => t.length >= 2 && !isStopword(t));
}

/**
 * Finds person names in a block of text.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {boolean} [options.useGazetteer=true] Enable the gazetteer branch.
 * @returns {Array<{text: string, index: number, length: number, via: "cue"|"gazetteer"}>}
 *   Non-overlapping matches, in order of appearance.
 */
export function findNames(text, options = {}) {
  if (!text || typeof text !== "string") return [];
  const useGazetteer = options.useGazetteer !== false;
  // Capitalised tokens with their positions. Names are assembled from these
  // rather than matched as one greedy run: "Person Daniel Whitfield" matched
  // whole, found that "person" was not a given name, and discarded the entire
  // span — losing the real name sitting two tokens to its right.
  const tokens = [];
  CAPITALISED_TOKEN_RE.lastIndex = 0;
  let t;
  while ((t = CAPITALISED_TOKEN_RE.exec(text)) !== null) {
    tokens.push({ text: t[0], index: t.index, end: t.index + t[0].length });
  }
  if (tokens.length === 0) return [];

  const hits = [];
  const claimed = [];
  const overlaps = (start, end) => claimed.some(([s, e]) => start < e && end > s);

  /**
   * Claims the LONGEST acceptable run (3 -> 2 -> 1 tokens) starting at `i`.
   *
   * Shrinking is what makes labels harmless: "Daniel Whitfield Email" is
   * rejected because "Email" is a label word, and without the retry the real
   * "Daniel Whitfield" inside it would be lost as well.
   */
  const claimRun = (i, via) => {
    for (let span = Math.min(3, tokens.length - i); span >= 1; span--) {
      const run = tokens.slice(i, i + span);

      // Tokens must be separated by whitespace only, or a "name" could leap a
      // sentence boundary or two table cells.
      let contiguous = true;
      for (let k = 1; k < run.length; k++) {
        if (!/^\s+$/.test(text.slice(run[k - 1].end, run[k].index))) { contiguous = false; break; }
      }
      if (!contiguous) continue;

      if (!runLooksLikeName(run.map((r) => r.text).join(" "))) continue;

      const start = run[0].index;
      const end = run[run.length - 1].end;
      if (overlaps(start, end)) return true;

      claimed.push([start, end]);
      hits.push({ text: text.slice(start, end), index: start, length: end - start, via });
      return true;
    }
    return false;
  };

  // 1. Cue-anchored. Runs first so a cued name claims its span before the
  //    gazetteer branch can produce a narrower, worse-placed match for it.
  CUED_NAME_RE.lastIndex = 0;
  let m;
  while ((m = CUED_NAME_RE.exec(text)) !== null) {
    const captureStart = m.index + m[0].length - m[1].length;
    const startToken = tokens.findIndex((tok) => tok.index === captureStart);
    if (startToken !== -1) claimRun(startToken, "cue");
  }

  // 2. Gazetteer: any token that is a known given name may start a run.
  if (useGazetteer) {
    for (let i = 0; i < tokens.length; i++) {
      if (!GIVEN_NAMES.has(foldToken(tokens[i].text))) continue;
      claimRun(i, "gazetteer");
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

/**
 * Layer G3 candidate extraction: capitalised runs that LOOK name-shaped
 * (proper case, not UI-chrome, 1-3 tokens) but that `findNames` could not
 * confirm — no adjacent cue, and the leading token is not in the seed
 * gazetteer. This is deliberately the SAME structural filter as `claimRun`
 * (stopwords, run length, contiguity) minus the two deterministic signals,
 * so the candidate set is exactly "plausible name, undecided" rather than
 * "any capitalised word" — sending nav labels and brand names to the model
 * in bulk would swamp the latency budget for no benefit.
 *
 * Deliberately returns candidates only; it never redacts anything itself.
 * The caller (Ollama, Layer G3) decides redact/safe, and a caller that
 * never asks is simply left at the G1+G2 deterministic baseline.
 *
 * @param {string} text
 * @returns {Array<{text: string, index: number, length: number}>}
 */
export function findNameCandidates(text) {
  if (!text || typeof text !== "string") return [];
  const tokens = [];
  CAPITALISED_TOKEN_RE.lastIndex = 0;
  let t;
  while ((t = CAPITALISED_TOKEN_RE.exec(text)) !== null) {
    tokens.push({ text: t[0], index: t.index, end: t.index + t[0].length });
  }
  if (tokens.length === 0) return [];

  // Skip spans findNames already confirmed, so a cued/gazetteer name is
  // never ALSO sent to the model as an "undecided" candidate.
  const confirmed = findNames(text).map((h) => [h.index, h.index + h.length]);
  const overlapsConfirmed = (start, end) => confirmed.some(([s, e]) => start < e && end > s);

  const candidates = [];
  for (let i = 0; i < tokens.length; i++) {
    let claimedSpan = 0;
    for (let span = Math.min(3, tokens.length - i); span >= 1; span--) {
      const run = tokens.slice(i, i + span);
      let contiguous = true;
      for (let k = 1; k < run.length; k++) {
        if (!/^\s+$/.test(text.slice(run[k - 1].end, run[k].index))) { contiguous = false; break; }
      }
      if (!contiguous) continue;
      if (!runLooksLikeName(run.map((r) => r.text).join(" "))) continue;

      const start = run[0].index;
      const end = run[run.length - 1].end;
      if (overlapsConfirmed(start, end)) { claimedSpan = span; break; }
      // Gazetteer hits are already found by findNames above; re-asking the
      // model about them would just waste a batch slot.
      if (GIVEN_NAMES.has(foldToken(run[0].text))) { claimedSpan = span; break; }

      candidates.push({ text: text.slice(start, end), index: start, length: end - start });
      claimedSpan = span;
      break;
    }
    if (claimedSpan > 1) i += claimedSpan - 1;
  }
  return candidates;
}

/**
 * True when a field's descriptors mark it as holding a person's name.
 *
 * @param {Object} descriptors {autocomplete, name, id, placeholder, ariaLabel, label, itemprop}
 */
export function isNameField(descriptors = {}) {
  const auto = String(descriptors.autocomplete || "").toLowerCase();
  for (const token of auto.split(/\s+/)) {
    // autocomplete may be scoped, e.g. "shipping given-name".
    if (NAME_AUTOCOMPLETE.has(token)) return true;
  }
  if (String(descriptors.itemprop || "").toLowerCase() === "name") return true;

  const haystack = [
    descriptors.name, descriptors.id, descriptors.placeholder,
    descriptors.ariaLabel, descriptors.label,
  ].filter(Boolean).join(" ");
  return NAME_FIELD_RE.test(haystack);
}

export const __testing = { GIVEN_NAMES, NAME_STOPWORDS, runLooksLikeName };
