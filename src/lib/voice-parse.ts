/**
 * voice-parse — catalog-first, deterministic utterance parser.
 *
 * NO AI. NO NETWORK. NO API KEY. Pure, synchronous, zero-dependency. This
 * module imports nothing (not @/lib/data, not @/lib/db), which is what lets
 * it live in the client bundle AND run under bare `node --test`.
 *
 * Per node_modules/next/dist/docs/01-app/03-api-reference/01-directives/
 * use-client.md, the "use client" directive marks an ENTRY POINT, not every
 * file: GroceryList.tsx is already a client entry, so importing this module
 * pulls it into the client bundle with no directive of its own. The catalog
 * rides in as a `CatalogEntry[]` prop — plain {number, string} objects, which
 * satisfies the same doc's rule that props crossing the boundary must be
 * serializable.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS REPLACES
 *
 * The old splitTranscript() SPLIT on /\band\b/ FIRST and cleaned SECOND, and
 * its verb list had "want" but not "wanna". So "I wanna get paper towels and
 * water" survived as the single item "I wanna get paper towels water", which
 * the POST upsert then wrote into shopping_items FOREVER (row 48; row 50 is
 * the same story). Split-then-clean also destroys any catalog name that
 * legitimately contains "and" (row 27, "Lavender and mint smell good").
 *
 * THE FIX IS THE ORDER. We never split blind. We match the catalog FIRST with
 * a greedy longest-match scan, and "and" becomes a boundary ONLY when no
 * catalog entry consumed it. Conjunction splitting is emergent, not a rule.
 *
 * WHY FIXING THE PARSE FIXES THE REUSE. A matched item emits the catalog's
 * STORED name verbatim ("Paper towels", not "paper towels"). POST does
 * `normalized = rawName.toLowerCase()` and upserts onConflictDoUpdate on the
 * UNIQUE normalized_name without overwriting `name` — so the stored name
 * round-trips onto its own row, bumps use_count, and reuses id 44. Emitting
 * the SPOKEN text instead is exactly how rows 48 and 50 were born.
 *
 * ---------------------------------------------------------------------------
 * PIPELINE
 *
 *   preClean -> strip framing BOTH ENDS (fixed point, catalog-clamped)
 *     -> hard-split on separators that CANNOT occur inside a catalog name
 *     -> greedy longest catalog match over the whole chunk   <- the trick
 *     -> segment at SOFT separators ("and") left UNMATCHED in the gaps
 *     -> per-segment quantity extraction
 *     -> resolve leftovers (echo guard -> absorption -> novel)
 *     -> dedupe
 *
 * Framing is stripped at BOTH ends because that is where English puts it.
 * A prefix-only stripper leaves "add bread to the list" as the novel item
 * "bread to the list" — row 48's shape exactly, created by the very code
 * meant to prevent it.
 *
 * TIER ORDER, never allowed to outrank each other:
 *   1. exact    literal normalized name
 *   2. plural   stem key or spaceless-squash key (morphological variants)
 *   3. fuzzy    bounded edit distance, LEFTOVERS ONLY, never inline in the scan
 *   4. novel    a genuinely new item
 */

/* =========================================================================
 * PUBLIC CONTRACT
 * ========================================================================= */

export type CatalogEntry = { id: number; name: string };

export type ParsedItem = {
  /** Display name to add. When matched, this is the CATALOG's stored name
   *  verbatim, so the server's lower(name) upsert reuses the existing row. */
  name: string;
  /** Extracted quantity. null means 1 (matches shopping_list.count's
   *  "NULL = 1" convention and the UI's `count > 1` render gate). */
  count: number | null;
  /** Catalog id when resolved to an existing item, else null. */
  matchedId: number | null;
  source: "exact" | "plural" | "fuzzy" | "novel";
};

/* =========================================================================
 * 1. NORMALIZATION PRIMITIVES
 * ========================================================================= */

/** Expand compounds BEFORE tokenizing so every surface token normalizes to
 *  exactly ONE normalized token. Without this, "half-and-half" would be 1
 *  surface token but 3 normalized ones and every span -> surface
 *  reconstruction would silently misalign. */
function preClean(raw: string): string {
  return raw
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/['`]/g, "") // DELETE apostrophes, never split on them
    .replace(/&/g, " and ")
    .replace(/[-–—/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase, strip diacritics, drop everything that is not [a-z0-9].
 *  toLowerCase, NEVER toLocaleLowerCase: under tr-TR the latter maps "I" to
 *  dotless "ı" and every framing rule starting with "i" silently dies. */
function normWord(w: string): string {
  return w
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const IRREGULAR: Record<string, string> = {
  leaves: "leaf",
  loaves: "loaf",
  knives: "knife",
  halves: "half",
  potatoes: "potato",
  tomatoes: "tomato",
  children: "child",
};

/**
 * Canonicalization, NOT linguistics.
 *
 * SYMMETRY THEOREM: this same function runs over catalog names at index-build
 * time AND over the transcript at parse time. A linguistically absurd stem
 * ("annies" -> "anny", "grits" -> "grit") is therefore HARMLESS, because it
 * can only ever collide with itself. Correctness requires determinism, not
 * linguistic truth, so no exception list is needed. The only failure mode
 * that matters is two DISTINCT catalog rows colliding on one key, which is
 * broken deterministically by id.
 */
function stem(t: string): string {
  const irr = IRREGULAR[t];
  if (irr) return irr;
  if (t.length <= 3) return t; // protects "gas", "oil", "was"
  if (/(ss|us|is)$/.test(t)) return t; // glass, hummus, citrus
  if (/ies$/.test(t) && t.length > 4) return t.slice(0, -3) + "y";
  if (/ves$/.test(t) && t.length > 4) return t.slice(0, -3) + "f";
  if (/(sses|shes|ches|xes|zes)$/.test(t)) return t.slice(0, -2);
  if (/oes$/.test(t) && t.length > 4) return t.slice(0, -2);
  if (/s$/.test(t)) return t.slice(0, -1);
  return t;
}

type Tokens = {
  /** Original word, edge punctuation trimmed. Used ONLY for novel display. */
  surface: string[];
  /** Normalized form. Used for the exact tier. */
  norm: string[];
  /** Stemmed form. Used for the plural/squash/fuzzy tiers. */
  stems: string[];
};

/** INVARIANT: surface.length === norm.length === stems.length. */
function tokenize(raw: string): Tokens {
  const surface: string[] = [];
  const norm: string[] = [];
  const stems: string[] = [];
  for (const w of preClean(raw).split(" ")) {
    const n = normWord(w);
    if (!n) continue; // punctuation-only token: drop from ALL three arrays
    surface.push(w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || w);
    norm.push(n);
    stems.push(stem(n));
  }
  return { surface, norm, stems };
}

/** Optimal String Alignment (Damerau variant). Transposition-aware because
 *  both speech recognition and typing transpose: "yogrut" -> "yogurt" is 1
 *  edit under OSA and 2 under plain Levenshtein. */
function osa(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev2: number[] = [];
  let prev: number[] = [];
  let cur: number[] = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/* =========================================================================
 * 2. LEXICON — built as a GRAMMAR, not a flat alternation.
 *
 * "wanna" being absent from the old regex is the literal cause of rows 48
 * and 50. The answer is not to bolt "wanna" on; it is to model the slots
 * (POLITE / SUBJECT / MODAL / VERB / OBJECT) so the colloquial contractions
 * Watson actually says compose systematically, and to iterate to a FIXED
 * POINT instead of the old hardcoded 2 passes.
 * ========================================================================= */

/**
 * The lexicon is matched against STEMS, so it must be STORED as stems. These
 * helpers push every entry through the identical normWord+stem pipeline the
 * transcript takes, which is the symmetry rule the whole parser rests on.
 *
 * This is not a detail. Writing "lets" by hand and comparing it against a
 * stemmed transcript silently never matches, because stem("lets") is "let" —
 * a missing-verb bug of exactly the same shape as the "wanna" one being
 * fixed here. Deriving the lexicon removes the class rather than the
 * instance: "wants"/"needs"/"gets" now fold into their stems for free, and
 * no one has to remember to hand-write the stemmed spelling.
 */
const stemSet = (xs: string[]): Set<string> =>
  new Set(xs.map((w) => stem(normWord(w))));
const stemPhrases = (xs: string[][]): string[][] =>
  xs.map((p) => p.map((w) => stem(normWord(w))));
const stemNums = (r: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) out[stem(normWord(k))] = v;
  return out;
};

const POLITE = stemSet([
  "please", "ok", "okay", "k", "so", "um", "umm", "uh", "uhh", "uhm", "er",
  "hey", "yo", "alright", "yeah", "yea", "yep", "oh", "now", "just",
  "actually", "well", "and", "then", "also", "plus",
]);

const SUBJ = stemSet([
  "i", "im", "ive", "id", "ill", "we", "were", "weve", "youre", "youve",
  "you", "lets",
]);

/** Multi-token phrases are token arrays. Longest phrases are tried first. */
const MODAL: string[][] = stemPhrases([
  ["would", "like", "to"], ["stock", "up", "on"],
  ["want", "to"], ["wants", "to"], ["wanted", "to"], ["need", "to"],
  ["needs", "to"], ["needed", "to"], ["going", "to"], ["got", "to"],
  ["have", "to"], ["has", "to"], ["had", "to"], ["like", "to"],
  ["let", "me"], ["let", "us"], ["out", "of"], ["ought", "to"],
  ["wanna"], ["wana"], ["wanne"], ["gonna"], ["gunna"], ["gon"], ["gotta"],
  ["needa"], ["hafta"], ["imma"], ["ima"], ["lemme"], ["gimme"], ["finna"],
  ["want"], ["wants"], ["wanted"], ["need"], ["needs"], ["needed"],
  ["should"], ["could"], ["would"], ["can"], ["will"], ["must"], ["gotem"],
  ["lets"],
]);

const VERB: string[][] = stemPhrases([
  ["write", "down"], ["throw", "on"], ["throw", "in"], ["toss", "on"],
  ["toss", "in"], ["put", "down"], ["put", "on"], ["jot", "down"],
  ["drop", "in"], ["pick", "up"],
  ["add"], ["get"], ["gets"], ["getting"], ["gettin"], ["grab"],
  ["grabbing"], ["grabbin"], ["buy"], ["buying"], ["order"], ["purchase"],
  ["pickup"], ["put"], ["jot"], ["note"], ["write"], ["throw"], ["toss"],
  ["drop"], ["include"], ["remember"], ["snag"], ["fetch"], ["bring"],
  ["take"], ["restock"],
]);

const OBJ: string[][] = stemPhrases([
  ["to", "the", "list"], ["to", "my", "list"], ["on", "the", "list"],
  ["the", "list"], ["me"], ["us"], ["my"], ["our"], ["down"],
]);

/**
 * TRAILING destination objects: "add bread TO THE LIST".
 *
 * consumeFramingAt only ever consumes OBJ in PREFIX position (immediately
 * after a VERB), which is why "add to the list bread" always worked and "add
 * bread to the list" — the way English actually orders it — did not. The
 * lexicon above already had the phrases; the tail was simply unreachable.
 *
 * This is not a cosmetic miss. "bread to the list" clears every guard below
 * (no leading framing, no stopword, under the token cap), so POST wrote it to
 * shopping_items forever. That is row 48's exact shape: the bug this module
 * exists to eliminate, re-entering through the back door. Prefix stripping
 * alone was never enough, because framing wraps the item on BOTH sides.
 *
 * Anchored on the head noun ("list" / "cart" / "basket"), NEVER on a bare
 * preposition: a phrase like ["to","the"] would happily eat the tail of a real
 * name. Matched longest-first, and demoted wholesale at index build if the
 * catalog itself claims the head noun — the same "the catalog decides its own
 * grammar" rule that governs hardWordSeps.
 */
const TAIL_OBJ: string[][] = stemPhrases([
  ["to", "the", "grocery", "list"], ["to", "the", "shopping", "list"],
  ["on", "the", "grocery", "list"], ["on", "the", "shopping", "list"],
  ["to", "the", "list"], ["to", "my", "list"], ["to", "our", "list"],
  ["on", "the", "list"], ["on", "my", "list"], ["on", "our", "list"],
  ["in", "the", "list"], ["in", "my", "list"],
  ["to", "the", "cart"], ["to", "my", "cart"], ["in", "the", "cart"],
  ["to", "the", "basket"], ["in", "the", "basket"],
  ["to", "list"], ["on", "list"], ["the", "list"], ["my", "list"],
]).sort((a, b) => b.length - a.length);

/** Droppable inside a segment's residue. */
const FILLER = stemSet([
  "some", "a", "an", "the", "of", "my", "our", "more", "any", "one",
  "please", "thing", "things", "stuff", "item", "items", "and", "then",
  "also", "plus", "too", "well", "uh", "um", "umm", "like", "just", "ok",
  "okay", "oh", "for", "from",
]);

const NUMW: Record<string, number> = stemNums({
  zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
});

const MULT: Record<string, number> = stemNums({ dozen: 12, couple: 2, pair: 2, few: 3 });

/** Units are DISCARDED, never part of the name. That is mandatory for reuse,
 *  not cosmetic: "gallon of milk" could never match row 1. Compared on the
 *  STEM, so plurals fold in. */
const UNITS = stemSet([
  "gallon", "gal", "quart", "qt", "pint", "liter", "litre", "bottle", "jug",
  "carton", "box", "bag", "can", "jar", "pack", "package", "loaf", "bunch",
  "head", "pound", "lb", "ounce", "oz", "container", "stick", "roll", "tub",
  "block", "case", "sleeve", "tray", "tube", "sack", "piece", "count", "bar",
]);

/**
 * Tokens that betray a dictated sentence rather than a grocery item.
 *
 * Every entry earns its place by being a word that CANNOT appear in a grocery
 * name: first-person pronouns and the verbs of intent. That is the whole
 * membership rule, and it is why no product word may be added here.
 *
 * "test" is the cautionary example. It was once a stopword, ostensibly to keep
 * a "smoke-test-item" row unmatchable, and all it actually did was make every
 * real product containing the word permanently unaddable through EVERY input
 * path — "Test strips", "pregnancy test", "COVID test kit" all bounced with
 * "Nothing to add from that, sir." and no way around it, since the suggestion
 * path can only surface rows already in the catalog. A stopword is a bet that
 * no grocery will ever contain the word; "test" lost that bet, and so would
 * "smoke", "water", "note" or any other word borrowed from the product space.
 *
 * "i" STAYS, AND THE REASON IS WORTH RECORDING, because the obvious reading of
 * the paragraph above is that it should go.
 *
 * It does cost a real product: "I Can't Believe It's Not Butter" is sold in
 * real stores and this set makes it bounce, which looks like the "test" mistake
 * exactly. The difference is what removing it costs. "test" was removable
 * because nothing else was holding that line; "i" is load-bearing in a way G1
 * cannot cover. G1 treats a bare subject as framing only when a modal or verb
 * follows ("i wanna"), so with "i" gone, every "i <non-verb>" shape walks into
 * a permanent row: "i think water", "i love water", "i milk" and "i water" all
 * return false from this predicate and get WRITTEN. Measured, not assumed —
 * they were run against this function with the entry deleted.
 *
 * That trade is backwards by this codebase's own rule. A false REJECT is loud
 * and recoverable: the route says so out loud and Watson renames the row. A
 * false ACCEPT is silent and permanent, which is the entire bug class this
 * module exists to close. So the stopword stays, and the product it blocks is
 * handled where a human can vouch for it — the explicit override on POST
 * /api/shopping/list, which lets Watson confirm a sentence-shaped name he
 * actually wants instead of asking this predicate to guess. The guard's job is
 * to stop accidents, not to overrule him.
 */
const STOP = stemSet([
  "i", "im", "ive", "id", "ill", "you", "youre", "we", "were", "weve", "me",
  "my", "us", "our", "wanna", "wana", "gonna", "gunna", "gotta", "lemme",
  "gimme", "imma", "ima", "needa", "hafta", "finna", "need", "needs",
  "needed", "want", "wants", "wanted", "please", "lets", "add", "buy",
  "grab", "purchase", "remember",
]);

/**
 * G5 vocabulary: object pronouns, and the prepositions that follow them.
 *
 * THIS IS THE RULE THAT CLOSES ROW 54 ("merge it to the main"), and the reason
 * it can exist is that the old guard was looking for the wrong evidence.
 *
 * This module previously asserted, in a test named "THE GUARD'S LIMIT", that
 * row 54 was structurally indistinguishable from "Redmond Season salt" and that
 * "every rule that would reject it would reject those". That is false, and the
 * counter-example is the word "it". A grocery name is a NOUN PHRASE. "it" and
 * "them" are pronouns that REPLACE a noun phrase, so they cannot appear inside
 * one — and when a pronoun object is followed by a preposition ("it to", "it
 * up", "them in"), the string is an imperative clause with a destination, which
 * is a sentence and never a product.
 *
 * That is a shape, not a name, so it generalizes past the row that motivated
 * it: "merge it to the main", "push it to the branch", "ship it to prod",
 * "commit it to the repo", "send it to the printer" and "pick it up" all die on
 * the same rule, including the ones nobody has dictated yet. It needs no verb
 * list, which is the whole point — "merge" is not a grocery verb and never will
 * be, and a guard that had to enumerate every English verb would be the
 * DENY_NORMALIZED patch wearing a different hat.
 *
 * It is NOT the "test" mistake repeated. "test" was a product word conscripted
 * into grammar duty; "it" is a pronoun, and the rule fires only on the
 * two-token pronoun-plus-preposition shape, never on a bare word. "I Can't
 * Believe It's Not Butter" survives it untouched: preClean deletes the
 * apostrophe, so "It's" normalizes to the stem "its", which is not "it" — and
 * even were it, "not" is no preposition.
 */
const PRONOUN_OBJ = stemSet(["it", "them"]);

const DEST_PREP = stemSet([
  "to", "into", "onto", "in", "on", "over", "under", "from", "with", "for",
  "at", "back", "out", "off", "up", "down", "around", "through",
]);

/* =========================================================================
 * 3. FRAMING STRIPPER (token-level, fixed point, catalog-clamped)
 * ========================================================================= */

function matchPhrase(list: string[][], stems: string[], at: number): number {
  for (const phrase of list) {
    if (at + phrase.length > stems.length) continue;
    let ok = true;
    for (let k = 0; k < phrase.length; k++) {
      if (stems[at + k] !== phrase[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return phrase.length;
  }
  return 0;
}

/** One framing consumption at `at`. Returns the new position, or -1. */
function consumeFramingAt(stems: string[], at: number): number {
  if (at >= stems.length) return -1;

  if (POLITE.has(stems[at])) return at + 1;

  // A bare subject is only framing when a modal or verb follows it. "I" alone
  // is not a framing prefix; "i wanna" is.
  if (SUBJ.has(stems[at])) {
    const q = at + 1;
    if (matchPhrase(MODAL, stems, q) > 0 || matchPhrase(VERB, stems, q) > 0) {
      return at + 1;
    }
  }

  const m = matchPhrase(MODAL, stems, at);
  if (m > 0) return at + m;

  // A verb also swallows its trailing objects ("get me", "put it down").
  const v = matchPhrase(VERB, stems, at);
  if (v > 0) {
    let q = at + v;
    for (;;) {
      const o = matchPhrase(OBJ, stems, q);
      if (o === 0) break;
      q += o;
    }
    return q;
  }
  return -1;
}

/**
 * Strip framing to a FIXED POINT. The old code capped at 2 passes, which is
 * the quiet second half of the bug: "ok so I'm gonna need to go ahead and
 * grab..." needs more than two.
 *
 * `index` enables the CATALOG-AWARE CLAMP: we never consume a token that
 * begins a viable catalog candidate, which protects a present or future item
 * legitimately named "Grab bag" or "Note cards". Callers that must NOT clamp
 * (the sentence guard, which runs while building the index and therefore
 * cannot consult it) pass undefined.
 */
function stripFramingIdx(stems: string[], index?: CatalogIndex): number {
  let pos = 0;
  for (let guard = 0; guard < 12; guard++) {
    if (pos >= stems.length) break;
    if (index && ngramStartsAt(stems, pos, index)) break; // clamp
    const next = consumeFramingAt(stems, pos);
    if (next < 0 || next === pos) break;
    pos = next;
  }
  return pos;
}

/**
 * The mirror of stripFramingIdx, for the TAIL. Returns the new `end` (an
 * exclusive bound), iterating to a fixed point so "add milk to the list
 * please" peels the polite tail and the destination object both.
 *
 * `tail` is passed rather than read from an index because the row guard runs
 * DURING index build and cannot consult the index it is building — the same
 * reason stripFramingIdx takes its index optionally. Parse-time callers pass
 * index.tailObj (catalog-demoted); the guard passes the raw TAIL_OBJ.
 */
function stripTrailingFramingIdx(
  stems: string[],
  start: number,
  end: number,
  tail: string[][],
): number {
  let pos = end;
  for (let guard = 0; guard < 4; guard++) {
    let consumed = 0;
    for (const phrase of tail) {
      const at = pos - phrase.length;
      if (at < start) continue; // never strip past the item itself
      let ok = true;
      for (let k = 0; k < phrase.length; k++) {
        if (stems[at + k] !== phrase[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      consumed = phrase.length;
      break; // longest-first: TAIL_OBJ is length-sorted
    }
    if (!consumed) break;
    pos -= consumed;
  }
  return pos;
}

/* =========================================================================
 * 4. THE SENTENCE-SHAPE GUARD
 *
 * Runs at index build so rows 13, 48 and 50 can never be MATCHED, on every
 * novel name so a parse failure yields zero rows instead of permanent
 * pollution, in @/lib/data so polluted rows are never SERVED as autocomplete
 * suggestions, and — the one that closes the class — in the POST
 * /api/shopping/list route so no caller can WRITE the shape in the first
 * place. Four callers, one predicate, no path around it.
 *
 * G1 is the load-bearing rule and it is not a coincidence: a sentence-shaped
 * row can ONLY exist because framing survived the stripper. So the exact
 * vocabulary that strips the query is the vocabulary that disqualifies the
 * row. One source of truth, and it covers pollution not yet created.
 *
 * Keyed on the NORMALIZED NAME, never on id — ids are not stable across
 * environments, and a guard that names a row is not a guard, it is a patch.
 * This module used to carry exactly that patch: a DENY_NORMALIZED set holding
 * "smoke test item" plus a regex for the same string, hardcoding ONE real
 * catalog row into the parser. It is gone. That row was deleted from the
 * database, which is the only honest way to retire a row — the rules below
 * describe SHAPES, and "smoke test item" is not a shape, it is a name.
 * ========================================================================= */
export function isFramingShaped(name: string): boolean {
  const t = tokenize(name);
  if (t.norm.length === 0) return true;

  // G1 framing: the row must be a FIXED POINT of the framing stripper, at
  // BOTH ends. Framing wraps the item on both sides, so a prefix-only guard
  // waves "bread to the list" straight through to the catalog.
  if (stripFramingIdx(t.stems) !== 0) return true;
  if (
    stripTrailingFramingIdx(t.stems, 0, t.stems.length, TAIL_OBJ) !==
    t.stems.length
  ) {
    return true;
  }

  // G2 stopwords: first-person pronouns and intent verbs.
  for (const s of t.stems) if (STOP.has(s)) return true;

  // G4 stutter: adjacent duplicate stems ("olive oil oil").
  for (let i = 1; i < t.stems.length; i++) {
    if (t.stems[i] === t.stems[i - 1]) return true;
  }

  // G5 pronoun object + preposition: "merge IT TO the main", "pick IT UP".
  // A noun phrase cannot contain the pronoun that replaces one, so this is an
  // imperative clause, not a product. Row 54's shape, and its whole class.
  for (let i = 0; i < t.stems.length - 1; i++) {
    if (PRONOUN_OBJ.has(t.stems[i]) && DEST_PREP.has(t.stems[i + 1])) {
      return true;
    }
  }
  return false;
}

/**
 * The full guard: framing PLUS the length cap (G3).
 *
 * WHY THE CAP LIVES HERE AND NOT IN isFramingShaped. These two predicates
 * answer different questions, and conflating them made emitSegment do the one
 * thing this module forbids. "Is this dictated framing?" is evidence about
 * MEANING, and when the answer is yes it is safe to drop the words and keep
 * the matches. "Is this too long?" is a blunt bound on garbage, and it is NOT
 * evidence of anything: "boneless skinless organic free range chicken breast"
 * is 7 tokens and a real product. Letting the cap reach the keep-the-matches
 * fall-through meant a 7-token specific product silently collapsed to bare
 * "Chicken breast" — the wrong item on the list, with no error, which is
 * exactly what the modifier comment in emitSegment swears never to do.
 *
 * So: the cap gates what may be MATCHED (index build), never what a span
 * MEANS (emitSegment).
 */
export function isSentenceShaped(name: string): boolean {
  if (isFramingShaped(name)) return true;
  // G3 token cap. Longest legitimate real row is 5 tokens (ids 16, 27). The
  // bound is a garbage stop, not a style rule, so it is set well clear of real
  // product names — 7-token specifics like "boneless skinless organic free
  // range chicken breast" are things Watson genuinely buys, and a cap that
  // cuts them makes its own emissions unmatchable on the next page load.
  return tokenize(name).stems.length > 10;
}

/* =========================================================================
 * 5. INDEX
 * ========================================================================= */

type IndexEntry = {
  id: number;
  name: string;
  norm: string;
  stems: string[];
};

type CatalogIndex = {
  /** literal normalized name -> entry */
  exact: Map<string, IndexEntry>;
  /** stem key -> entry */
  plural: Map<string, IndexEntry>;
  /** spaceless stem squash -> entry (catches "sunscreen" vs "Sun screen") */
  squashed: Map<string, IndexEntry>;
  entries: IndexEntry[];
  maxN: number;
  /** Word separators that no eligible catalog name contains. */
  hardWordSeps: string[];
  softSeps: Set<string>;
  /** TAIL_OBJ minus any phrase whose head noun the catalog itself claims. */
  tailObj: string[][];
};

/** Deterministic total order for key collisions. The public CatalogEntry
 *  carries no useCount, so id ascending (oldest, stable) is the tie-break. */
function better(a: IndexEntry, b: IndexEntry): IndexEntry {
  return a.id <= b.id ? a : b;
}

function put(map: Map<string, IndexEntry>, key: string, e: IndexEntry): void {
  const cur = map.get(key);
  map.set(key, cur ? better(cur, e) : e);
}

/** Candidate word separators. "and" is NOT here: it is permanently SOFT,
 *  resolved by the scan, because row 27 contains it. The rest DEMOTE
 *  themselves to soft if any eligible catalog name contains them — the
 *  catalog decides its own grammar rather than us hardcoding it. */
const WORD_SEP_CANDIDATES = ["then", "also", "plus"];

function buildIndex(catalog: CatalogEntry[]): CatalogIndex {
  const exact = new Map<string, IndexEntry>();
  const plural = new Map<string, IndexEntry>();
  const squashAll = new Map<string, IndexEntry[]>();
  const entries: IndexEntry[] = [];
  let maxN = 1;

  for (const row of catalog) {
    if (!row || typeof row.name !== "string") continue;
    if (isSentenceShaped(row.name)) continue; // rows 13, 48, 50 die here
    const t = tokenize(row.name);
    if (t.stems.length === 0) continue;
    const e: IndexEntry = {
      id: row.id,
      name: row.name,
      norm: t.norm.join(" "),
      stems: t.stems,
    };
    entries.push(e);
    maxN = Math.max(maxN, t.stems.length);
    put(exact, e.norm, e);
    put(plural, t.stems.join(" "), e);
    const sq = t.stems.join("");
    const bucket = squashAll.get(sq);
    if (bucket) bucket.push(e);
    else squashAll.set(sq, [e]);
  }

  // A squash key is only usable when it is UNAMBIGUOUS. Two distinct items
  // squashing to the same string means no match, never a guess.
  const squashed = new Map<string, IndexEntry>();
  for (const [key, bucket] of squashAll) {
    const ids = new Set(bucket.map((e) => e.id));
    if (ids.size === 1) squashed.set(key, bucket[0]);
  }

  const inNames = new Set<string>();
  for (const e of entries) for (const s of e.stems) inNames.add(s);
  const hardWordSeps = WORD_SEP_CANDIDATES.filter((w) => !inNames.has(w));
  const softSeps = new Set<string>(["and"]);
  for (const w of WORD_SEP_CANDIDATES) if (inNames.has(w)) softSeps.add(w);

  // The catalog outranks the tail lexicon. If Watson ever adds a real item
  // whose name ends in "list" ("Shopping list" pads), every "…the list"
  // phrase demotes rather than eating half of his item.
  const tailObj = TAIL_OBJ.filter((p) => !inNames.has(p[p.length - 1]));

  return {
    exact, plural, squashed, entries, maxN, hardWordSeps, softSeps, tailObj,
  };
}

/** Memoize per catalog array identity. Rebuilding 36 rows is microseconds,
 *  but parseUtterance is called on every speech final-result chunk. */
const indexCache = new WeakMap<CatalogEntry[], CatalogIndex>();
function getIndex(catalog: CatalogEntry[]): CatalogIndex {
  const hit = indexCache.get(catalog);
  if (hit) return hit;
  const built = buildIndex(catalog);
  indexCache.set(catalog, built);
  return built;
}

/* =========================================================================
 * 6. LOOKUP TIERS
 * ========================================================================= */

type Hit = { entry: IndexEntry; source: ParsedItem["source"] };

/** Tiers 1 and 2 only: deterministic key lookups, no distance. This is what
 *  the scan uses. Fuzzy is deliberately kept OUT of the scan — inline fuzzy
 *  could let a short fuzzy match beat a longer exact one. */
function lookupKeyed(
  norm: string[],
  stems: string[],
  index: CatalogIndex,
): Hit | null {
  const e1 = index.exact.get(norm.join(" "));
  if (e1) return { entry: e1, source: "exact" };
  const e2 = index.plural.get(stems.join(" "));
  if (e2) return { entry: e2, source: "plural" };
  const e3 = index.squashed.get(stems.join(""));
  if (e3) return { entry: e3, source: "plural" };
  return null;
}

function ngramStartsAt(
  stems: string[],
  pos: number,
  index: CatalogIndex,
): boolean {
  const max = Math.min(index.maxN, stems.length - pos);
  for (let n = max; n >= 1; n--) {
    const span = stems.slice(pos, pos + n);
    if (index.plural.has(span.join(" "))) return true;
    if (index.squashed.has(span.join(""))) return true;
  }
  return false;
}

/**
 * TIER 3 — FUZZY. Conservative by construction, and it only ever sees text
 * the keyed tiers already DECLINED. False positives are worse than misses:
 * a missed match costs a recoverable new row, a wrong match silently puts
 * the wrong product on the list.
 *
 * F1 same token count
 * F2 exactly ONE differing token (0 would have hit tier 1/2 already)
 * F3 identical FIRST CHARACTER on the differing pair  <- load-bearing
 * F4 |length delta| <= 2
 * F5 OSA distance <= budget(DIFFERING TOKEN length) + discriminative bonus
 * F6 unique winner; ties across different ids abort to novel
 *
 * THE BUDGET LADDER IS FITTED TO THE REAL DATA, not chosen for elegance:
 * every misspelling in Watson's catalog is LONG ("Bananna" 7, "Saurkraut" 9)
 * and every dangerous near-collision is SHORT (water/wafer, bread/break,
 * milk/mild, tuna/tune). Budget 0 at length <= 5 separates the two classes
 * with zero loss.
 *
 * F5 IS SCOPED TO THE DIFFERING TOKEN, NOT THE JOINED SPAN. Sizing the budget
 * off the joined span handed a short differing token budget 2 the moment any
 * exactly-matching token sat next to it — the precise permissiveness the
 * ladder was built to deny. It inverted monotonicity: "soy" alone was
 * correctly refused at budget 0, while "soy yogurt" resolved to Skyr Yogurt
 * (dairy, when soy yogurt is dairy-FREE) at budget 2. Appending a matching
 * token must never LOOSEN the test on the token that differs.
 */
function budgetFor(len: number): number {
  return len <= 5 ? 0 : len <= 7 ? 1 : 2;
}

/**
 * Does the exactly-matching context single out `e`? Worth exactly +1 budget,
 * and only when BOTH halves hold.
 *
 * The old comment claimed "the surrounding exactly-matching tokens are real
 * evidence". Sometimes. "yogurt" sits on rows 8, 22 and 40 — it is evidence of
 * the CATEGORY, and the token that differs is the one naming the product. One
 * shared token is never enough, which is why the first half demands two.
 *
 * The second half is what separates the case worth keeping from the case that
 * hurt: "vital farms pasture raised eggs" pins FOUR exact tokens that no other
 * row carries, so pasture/pastor (OSA 2 against a token budget of 1) is
 * genuinely row 16 and nothing else. "black paper" pins one, so it stays novel
 * rather than silently becoming Black pepper.
 */
function contextIsDiscriminative(
  stems: string[],
  e: IndexEntry,
  diff: number,
  index: CatalogIndex,
): boolean {
  if (stems.length - 1 < 2) return false; // one shared token is a category
  for (const o of index.entries) {
    if (o.id === e.id) continue;
    if (o.stems.length !== stems.length) continue;
    let agrees = true;
    for (let i = 0; i < stems.length; i++) {
      if (i === diff) continue;
      if (o.stems[i] !== stems[i]) {
        agrees = false;
        break;
      }
    }
    if (agrees) return false; // context fits another row too: no evidence
  }
  return true;
}

function lookupFuzzy(
  stems: string[],
  index: CatalogIndex,
): Hit | null {
  if (stems.length === 0) return null;
  let best: { entry: IndexEntry; d: number } | null = null;
  let tied = false;

  for (const e of index.entries) {
    if (e.stems.length !== stems.length) continue; // F1

    let diff = -1;
    let diffCount = 0;
    for (let i = 0; i < stems.length; i++) {
      if (stems[i] !== e.stems[i]) {
        diff = i;
        if (++diffCount > 1) break;
      }
    }
    if (diffCount !== 1) continue; // F2

    const a = stems[diff];
    const b = e.stems[diff];
    if (a[0] !== b[0]) continue; // F3
    if (Math.abs(a.length - b.length) > 2) continue; // F4

    const d = osa(a, b);
    const budget =
      budgetFor(Math.max(a.length, b.length)) +
      (contextIsDiscriminative(stems, e, diff, index) ? 1 : 0);
    if (d > budget) continue; // F5

    if (!best || d < best.d) {
      best = { entry: e, d };
      tied = false;
    } else if (d === best.d && e.id !== best.entry.id) {
      tied = true; // F6
    }
  }
  if (!best || tied) return null;
  return { entry: best.entry, source: "fuzzy" };
}

function resolveSpan(
  idxs: number[],
  t: Tokens,
  index: CatalogIndex,
): Hit | null {
  if (idxs.length === 0) return null;
  const norm = idxs.map((i) => t.norm[i]);
  const stems = idxs.map((i) => t.stems[i]);
  return lookupKeyed(norm, stems, index) ?? lookupFuzzy(stems, index);
}

/* =========================================================================
 * 7. THE SCAN — greedy maximal munch
 * ========================================================================= */

type Cell =
  | { kind: "match"; entry: IndexEntry; source: ParsedItem["source"]; from: number; to: number }
  | { kind: "tok"; at: number };

/**
 * Sweep left to right, trying the LONGEST catalog n-gram at each position.
 * The first hit at the largest n wins: longest match is structural, not a
 * scored preference, so a longer name cannot lose to a shorter one.
 *
 * THIS IS WHY "and" SURVIVES INSIDE ROW 27. For "lavender and mint smell
 * good" the scan tries n=5 at position 0 FIRST, hits row 27, and consumes
 * all five tokens including the conjunction. It never reaches the
 * "and"-as-boundary branch. "and" is CONSUMABLE inside a catalog n-gram and
 * a boundary only when left UNCONSUMED. That asymmetry is the whole theorem,
 * and it is available only because matching precedes splitting.
 */
function scan(t: Tokens, from: number, to: number, index: CatalogIndex): Cell[] {
  const cells: Cell[] = [];
  let i = from;
  while (i < to) {
    let hit: Hit | null = null;
    let hitLen = 0;
    const max = Math.min(index.maxN, to - i);
    for (let n = max; n >= 1; n--) {
      const h = lookupKeyed(
        t.norm.slice(i, i + n),
        t.stems.slice(i, i + n),
        index,
      );
      if (h) {
        hit = h;
        hitLen = n;
        break; // FIRST hit at the LARGEST n wins
      }
    }
    if (hit) {
      cells.push({ kind: "match", entry: hit.entry, source: hit.source, from: i, to: i + hitLen });
      i += hitLen;
    } else {
      cells.push({ kind: "tok", at: i });
      i++;
    }
  }
  return cells;
}

/* =========================================================================
 * 8. QUANTITY
 * ========================================================================= */

/** Returns [count, tokensConsumed]. Runs on a SEGMENT's leading uncovered
 *  tokens, which is what scopes a number to the right item: an unmatched
 *  conjunction opens a new segment with a fresh count, so "two gallons of
 *  milk and eggs" gives Milk x2 and Eggs x1, never Eggs x2.
 *
 *  `hasFollowing` is true when a catalog match follows these tokens. It is
 *  what lets "two gallons of milk" consume ALL THREE leading tokens (the
 *  item is the match, not the leftovers) while a bare "dozen" with nothing
 *  after it stays an item rather than evaporating into a count. */
function extractQuantity(
  stems: string[],
  hasFollowing: boolean,
): [number | null, number] {
  let i = 0;
  let base: number | null = null;
  let mult: number | null = null;

  if (i < stems.length && /^\d{1,3}$/.test(stems[i])) {
    base = parseInt(stems[i], 10);
    i++;
  } else if (i < stems.length && NUMW[stems[i]] != null) {
    base = NUMW[stems[i]];
    i++;
  }
  if (i < stems.length && MULT[stems[i]] != null) {
    mult = MULT[stems[i]];
    i++;
  }
  if (base == null && mult == null) return [null, 0];

  if (i < stems.length && UNITS.has(stems[i])) i++;
  if (i < stems.length && stems[i] === "of") i++;

  // Never consume the whole SEGMENT: a bare "dozen" or "two" with nothing
  // to attach to is an item, not a count.
  if (i >= stems.length && !hasFollowing) return [null, 0];

  const c = (base ?? 1) * (mult ?? 1);
  // Prefer null over a wrong count. POST rejects <= 0; the UI only renders
  // the badge when count > 1, so 1 is stored as NULL.
  const count = c >= 2 && c <= 99 ? c : null;
  return [count, i];
}

/* =========================================================================
 * 9. ENTRY POINT
 * ========================================================================= */

export function parseUtterance(
  transcript: string,
  catalog: CatalogEntry[],
): ParsedItem[] {
  if (typeof transcript !== "string" || !transcript.trim()) return [];
  const index = getIndex(Array.isArray(catalog) ? catalog : []);
  const out: ParsedItem[] = [];

  // HARD split. These separators cannot occur inside a catalog name:
  // punctuation is deleted by normalization, and the word candidates were
  // demoted at index build if any eligible name contained them. This stage
  // exists to SCOPE the framing stripper, so "milk, I also need eggs" can
  // strip "I also need" off the second clause.
  const wordSep = index.hardWordSeps.length
    ? new RegExp(`\\b(?:${index.hardWordSeps.join("|")})\\b`, "i")
    : null;
  let chunks = transcript.split(/[,;\n]+/);
  if (wordSep) {
    chunks = chunks.flatMap((c) =>
      c.split(new RegExp(wordSep.source, "gi")),
    );
  }

  for (const chunk of chunks) {
    const t = tokenize(chunk);
    if (t.stems.length === 0) continue;

    const start = stripFramingIdx(t.stems, index);
    if (start >= t.stems.length) continue; // pure framing: emit nothing

    // Framing wraps the item on BOTH sides. Strip the tail too, or "add bread
    // to the list" emits the novel item "bread to the list" — row 48 reborn.
    const end = stripTrailingFramingIdx(t.stems, start, t.stems.length, index.tailObj);
    if (end <= start) continue; // pure framing: emit nothing

    const cells = scan(t, start, end, index);

    // Segment at SOFT separators left UNMATCHED in the gaps. Matched spans
    // are ATOMIC: their internal tokens are never inspected, which is
    // precisely why row 27's "and" is invisible here. A soft separator is
    // only ever applied to text the catalog already DECLINED.
    const segments: Cell[][] = [];
    let cur: Cell[] = [];
    for (const c of cells) {
      if (c.kind === "tok" && index.softSeps.has(t.stems[c.at])) {
        segments.push(cur);
        cur = [];
      } else {
        cur.push(c);
      }
    }
    segments.push(cur);

    for (const seg of segments) emitSegment(seg, t, index, out);
  }

  return dedupe(out);
}

function emitSegment(
  seg: Cell[],
  t: Tokens,
  index: CatalogIndex,
  out: ParsedItem[],
): void {
  if (seg.length === 0) return;
  const matches = seg.filter((c) => c.kind === "match") as Extract<Cell, { kind: "match" }>[];

  // Quantity binds to this segment only, read off its LEADING uncovered
  // tokens (or the whole segment when nothing matched).
  const firstMatchAt = seg.findIndex((c) => c.kind === "match");
  const leadCells = (firstMatchAt < 0 ? seg : seg.slice(0, firstMatchAt)).filter(
    (c) => c.kind === "tok",
  ) as Extract<Cell, { kind: "tok" }>[];
  const [count, consumed] = extractQuantity(
    leadCells.map((c) => t.stems[c.at]),
    firstMatchAt >= 0,
  );
  const eaten = new Set(leadCells.slice(0, consumed).map((c) => c.at));

  const tokIdx = (seg.filter((c) => c.kind === "tok") as Extract<Cell, { kind: "tok" }>[])
    .map((c) => c.at)
    .filter((i) => !eaten.has(i));

  const spanIdx: number[] = [];
  for (const c of seg) {
    if (c.kind === "match") for (let i = c.from; i < c.to; i++) spanIdx.push(i);
    else if (!eaten.has(c.at)) spanIdx.push(c.at);
  }
  spanIdx.sort((a, b) => a - b);

  const text = (idxs: number[]) => idxs.map((i) => t.surface[i]).join(" ");
  const pushMatches = () => {
    let first = true;
    for (const m of matches) {
      out.push({
        name: m.entry.name,
        count: first ? count : null,
        matchedId: m.entry.id,
        source: m.source,
      });
      first = false;
    }
  };

  if (matches.length > 0) {
    // ECHO GUARD. Speech stutter and self-correction leave a tail that would
    // otherwise become a NEW single-token row: "I need olive oil oil" matches
    // "Olive oil" and strands "oil". That is the exact pathology that created
    // row 13. Token EQUALITY, not substring, so "water and watermelon" is
    // untouched.
    const matchedStems = new Set<string>();
    for (const m of matches) for (const s of m.entry.stems) matchedStems.add(s);
    let residue = tokIdx.filter((i) => !matchedStems.has(t.stems[i]));
    if (residue.length === 0) return pushMatches();

    // ABSORPTION. The scan is greedy per position and cannot see that the
    // whole span is one product with a stored typo: "vital farms pasture
    // raised eggs" only matches "Eggs" and strands four tokens. Re-resolving
    // the full span reaches row 16 instead of emitting garbage.
    const whole = resolveSpan(spanIdx, t, index);
    if (whole) {
      out.push({
        name: whole.entry.name,
        count,
        matchedId: whole.entry.id,
        source: whole.source,
      });
      return;
    }

    residue = residue.filter((i) => !FILLER.has(t.stems[i]));
    if (residue.length === 0) return pushMatches();

    // An unresolved modifier directly attached to a match CHANGES the
    // product: "almond milk" is not Milk, and "cold milk" is not two items.
    // So the whole span becomes ONE novel item. We deliberately do NOT
    // discard the modifier (that silently puts dairy milk on the list) and
    // do NOT emit it as its own row (that puts "almond" on the list).
    // isFramingShaped, NOT isSentenceShaped: the question here is whether the
    // residue MEANS anything, and length is not an answer to it. Gating this
    // on the token cap made "organic free range grass fed chicken breast"
    // (7 tokens) fall through to pushMatches() and land bare "Chicken breast"
    // on the list — the exact silent product swap the comment above forbids,
    // triggered by nothing but word count.
    const spanText = text(spanIdx);
    if (!isFramingShaped(spanText)) {
      out.push({ name: spanText, count, matchedId: null, source: "novel" });
      return;
    }

    // The span reads as a dictated sentence, so the residue is framing the
    // stripper did not recognize ("umm I think I need water"). Keep the
    // matches, drop the words. A missed verb costs a missed word, never a
    // permanent catalog row — that containment, not the lexicon's coverage,
    // is the property worth regression-testing.
    return pushMatches();
  }

  const cand = tokIdx.filter((i) => !FILLER.has(t.stems[i]));
  if (cand.length === 0) return;
  const candText = text(cand);
  // Framing, not length: refusing a long novel name here would silently drop a
  // real product Watson deliberately typed ("boneless skinless organic free
  // range turkey thigh") and leave him with nothing on the list.
  if (isFramingShaped(candText)) return; // refuse to write, never pollute

  const hit = resolveSpan(cand, t, index);
  if (hit) {
    out.push({
      name: hit.entry.name,
      count,
      matchedId: hit.entry.id,
      source: hit.source,
    });
    return;
  }
  out.push({ name: candText, count, matchedId: null, source: "novel" });
}

/** Fold duplicates within ONE utterance. Counts merge only when at least one
 *  side is EXPLICIT: "milk and milk" is far more often a stutter than an
 *  order for two, and the brief is explicit that an ambiguous count should
 *  prefer null over a wrong number. */
function dedupe(items: ParsedItem[]): ParsedItem[] {
  const order: string[] = [];
  const byKey = new Map<string, ParsedItem>();
  for (const it of items) {
    const key =
      it.matchedId != null ? `c${it.matchedId}` : `n${normWord(it.name.replace(/\s+/g, ""))}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...it });
      order.push(key);
      continue;
    }
    if (prev.count == null && it.count == null) continue;
    const merged = (prev.count ?? 1) + (it.count ?? 1);
    prev.count = Math.min(merged, 99);
  }
  return order.map((k) => byKey.get(k)!);
}
