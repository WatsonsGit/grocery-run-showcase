/**
 * voice-parse tests — the union of all three design corpora plus every
 * "what must be true when done" case, seeded with the REAL 36-row catalog.
 *
 * Run:  node --test src/lib/voice-parse.test.ts
 * (Node >= 22.18 strips types natively; --experimental-strip-types is a
 *  no-op on this version but still accepted.)
 *
 * The parser imports nothing, so this runs with no DB, no browser, no mocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Two resolvers, one import, no config change.
 *
 * Node's native type stripping REQUIRES the explicit "./voice-parse.ts"
 * specifier; tsc REJECTS that extension unless `allowImportingTsExtensions`
 * is enabled (TS5097). So:
 *   - the TYPE side imports extensionless — tsc's bundler resolution finds
 *     the .ts, and Node never sees the line because type-only imports are
 *     erased before execution;
 *   - the VALUE side builds the specifier at runtime, which tsc cannot
 *     statically resolve (so no TS5097) and Node resolves normally. The cast
 *     puts the real types back, so these tests are still fully type-checked.
 *
 * Cleaner alternative, if the owner of tsconfig.json wants it: add
 * "allowImportingTsExtensions": true (already legal — noEmit is set) and
 * collapse this back to a plain static import.
 */
import type { CatalogEntry } from "./voice-parse";

const { parseUtterance, isSentenceShaped } = (await import(
  "./voice-parse" + ".ts"
)) as typeof import("./voice-parse");

/** The real shopping_items rows, verbatim — misspellings, casing, pollution
 *  and all. Ids 13, 48 and 50 are the rows the old splitter created; they must
 *  never be matchable.
 *
 *  Row 7 ("smoke-test-item") is deliberately ABSENT, and its absence is the
 *  test. It was never a grocery, it was leftover test data, and the parser
 *  used to carry a DENY_NORMALIZED set plus a regex hardcoding that one row's
 *  text. Both are gone, and the row is deleted from the database. Listing it
 *  here would assert that the parser still special-cases a row that does not
 *  exist — which is exactly the thing that was wrong. Test data belongs in
 *  neither the database nor the fixture. */
const CATALOG: CatalogEntry[] = [
  { id: 6, name: "annies organic ketchup" },
  { id: 16, name: "Vital farm pastor raised eggs" },
  { id: 1, name: "Milk" },
  { id: 8, name: "greek yogurt" },
  { id: 12, name: "Bananna" },
  { id: 15, name: "Water" },
  { id: 21, name: "Tuna" },
  { id: 23, name: "Bread" },
  { id: 27, name: "Lavender and mint smell good" },
  { id: 28, name: "Organic white distilled vinegar" },
  { id: 30, name: "Toothpaste" },
  { id: 2, name: "Eggs" },
  { id: 3, name: "Black pepper" },
  { id: 4, name: "Green Pepper" },
  { id: 9, name: "Saurkraut" },
  { id: 11, name: "Mustard" },
  { id: 13, name: "I need olive oil oil" },
  { id: 14, name: "Olive oil" },
  { id: 17, name: "red onions" },
  { id: 18, name: "green peppers" },
  { id: 19, name: "red peppers" },
  { id: 22, name: "Yogurt" },
  { id: 25, name: "paper bowls" },
  { id: 29, name: "Sun screen" },
  { id: 34, name: "Umbrella" },
  { id: 36, name: "Redmond Season salt" },
  { id: 38, name: "Organic preworkout" },
  { id: 39, name: "Nativity Lotion" },
  { id: 40, name: "Skyr Yogurt" },
  { id: 42, name: "Chicken breast" },
  { id: 43, name: "Pure Elizabeth granola" },
  { id: 44, name: "Paper towels" },
  { id: 47, name: "Avocado" },
  { id: 48, name: "I wanna get paper towels water" },
  { id: 50, name: "I wanna get chicken breast" },
];

const names = (u: string) => parseUtterance(u, CATALOG).map((i) => i.name);
const ids = (u: string) => parseUtterance(u, CATALOG).map((i) => i.matchedId);

/** Assert the emitted display names, and that every match reuses a row. */
function expect(u: string, expected: string[], expectedIds?: (number | null)[]) {
  assert.deepEqual(names(u), expected, `names for: ${JSON.stringify(u)}`);
  if (expectedIds) {
    assert.deepEqual(ids(u), expectedIds, `ids for: ${JSON.stringify(u)}`);
  }
}

/* =======================================================================
 * WHAT MUST BE TRUE WHEN DONE — the locked acceptance criteria.
 * ======================================================================= */

test("THE BUG: 'I wanna get paper towels and water' -> 2 reused rows", () => {
  // "wanna" now strips systematically; the scan takes "paper towels",
  // declines "and", takes "water". Emits the STORED names so the upsert
  // reuses ids 44 and 15 instead of minting row 51.
  expect("I wanna get paper towels and water", ["Paper towels", "Water"], [44, 15]);
});

test("THE BUG: 'I wanna get chicken breast' -> 1 reused row", () => {
  expect("I wanna get chicken breast", ["Chicken breast"], [42]);
});

test("'lavender and mint smell good' is NOT split on 'and'", () => {
  // The 5-gram is tried at position 0 before any boundary logic runs.
  expect("lavender and mint smell good", ["Lavender and mint smell good"], [27]);
});

test("'get me some bananas' reuses the misspelled 'Bananna' (id 12)", () => {
  expect("get me some bananas", ["Bananna"], [12]);
});

test("'two gallons of milk and eggs' -> Milk x2 + Eggs", () => {
  const r = parseUtterance("two gallons of milk and eggs", CATALOG);
  assert.deepEqual(r.map((i) => i.name), ["Milk", "Eggs"]);
  assert.deepEqual(r.map((i) => i.matchedId), [1, 2]);
  assert.equal(r[0].count, 2, "count binds to Milk");
  assert.equal(r[1].count, null, "count must NOT leak across the 'and'");
});

test("a genuinely novel item still adds cleanly, framing stripped", () => {
  const r = parseUtterance("arborio rice", CATALOG);
  assert.deepEqual(r.map((i) => i.name), ["arborio rice"]);
  assert.equal(r[0].matchedId, null);
  assert.equal(r[0].source, "novel");
  expect("I wanna get arborio rice", ["arborio rice"], [null]);
});

test("no sentence-shaped catalog row (13, 48, 50) is ever matchable", () => {
  for (const bad of [
    "I need olive oil oil",
    "I wanna get paper towels water",
    "I wanna get chicken breast",
  ]) {
    assert.equal(isSentenceShaped(bad), true, `must reject: ${bad}`);
  }
  // The rows that are literally Watson's chat messages (52-55), captured
  // because the mic never stopped. Never in the fixture — they are being
  // deleted, not special-cased — but the SHAPE has to bounce on its own
  // merits: first-person stopwords, framing verbs, the length cap.
  for (const bad of [
    "OK do whatever you need to do to fix everything that needs to get fixed so that we can commit it",
    "let me know when you're done",
    "I wanna get water",
  ]) {
    assert.equal(isSentenceShaped(bad), true, `must reject: ${bad}`);
  }
  // ...and every legitimate row survives the guard.
  for (const row of CATALOG) {
    const polluted = [13, 48, 50].includes(row.id);
    assert.equal(
      isSentenceShaped(row.name),
      polluted,
      `${row.id} "${row.name}" eligibility`,
    );
  }
  // Row 27 keeps its "and"; row 16 keeps its 5 tokens.
  assert.equal(isSentenceShaped("Lavender and mint smell good"), false);
  assert.equal(isSentenceShaped("Vital farm pastor raised eggs"), false);
  // The polluted ids can never be RETURNED, even though they sit in the table.
  for (const r of parseUtterance("i need olive oil oil", CATALOG)) {
    assert.ok(![13, 48, 50].includes(r.matchedId ?? -1));
  }
  // The literal string of row 48 parses into its two real items, not row 48.
  expect("I wanna get paper towels water", ["Paper towels", "Water"], [44, 15]);
});

test("G5: row 54's shape ('merge it to the main') IS sentence-shaped", () => {
  // This test used to be called "THE GUARD'S LIMIT" and asserted the exact
  // OPPOSITE — that row 54 slipped the guard, that it was "not a bug to fix",
  // and that it was "structurally indistinguishable" from "Redmond Season
  // salt", because "every rule that would reject it would reject those".
  //
  // That claim was false, and the disclosure kept the suite green while POST
  // /api/shopping/list happily minted permanent rows: a novel chat sentence
  // ("push it to the branch") returned 200 and created a catalog row that
  // polluted autocomplete forever. Honest disclosure of a hole is not a closed
  // hole.
  //
  // The distinguishing evidence is the word "it". A grocery name is a NOUN
  // PHRASE; "it" and "them" are pronouns that REPLACE a noun phrase, so they
  // cannot occur inside one. Followed by a preposition, they mark an imperative
  // clause with a destination. That is a SHAPE, so it closes the class and not
  // just the row.
  for (const bad of [
    "merge it to the main", // row 54, verbatim
    "push it to the branch",
    "ship it to prod",
    "commit it to the repo",
    "send it to the printer",
    "pick it up",
    "add it to the list",
    "put them in the cart",
  ]) {
    assert.equal(isSentenceShaped(bad), true, `must reject: ${bad}`);
  }

  // ...and the rows the old comment swore G5 would take down with it. These are
  // the whole reason the rule keys on a pronoun rather than on a verb list or a
  // word count: none of them contains a pronoun object, so none of them moves.
  assert.equal(isSentenceShaped("Redmond Season salt"), false);
  assert.equal(isSentenceShaped("Organic white distilled vinegar"), false);
  assert.equal(isSentenceShaped("Chicken breast"), false);

  // G5 fires on the pronoun-plus-preposition SHAPE, never on a bare word, so a
  // name that merely contains "it"-like text survives. "It's" loses its
  // apostrophe in preClean and stems to "its", which is not "it"; and in
  // "It's-It", the real bare "it" is followed by "ice", which is no
  // preposition. This is the "test"-stopword mistake NOT being repeated.
  assert.equal(isSentenceShaped("It's-It ice cream sandwich"), false);
});

test("the 'i' stopword is load-bearing: dropping it leaks permanent rows", () => {
  // A real cost is charged here, and it is recorded rather than hidden: "I
  // Can't Believe It's Not Butter" is a real product and this predicate refuses
  // it. Removing only the leading "I" flips the verdict, which isolates the
  // cause to the G2 stopword rather than the length cap.
  assert.equal(isSentenceShaped("I Can't Believe It's Not Butter"), true);
  assert.equal(isSentenceShaped("Can't Believe It's Not Butter"), false);

  // THE REASON IT STAYS. G1 treats a bare subject as framing only when a modal
  // or verb follows it, so "i" is the ONLY thing standing between these shapes
  // and a permanent catalog row. Each of these returns false with the stopword
  // removed — measured, not assumed — and each would then be WRITTEN by POST.
  // A false reject is loud and recoverable; a false accept is silent and
  // forever. That asymmetry is what decides this trade.
  for (const bad of ["i think water", "i love water", "i milk", "i water"]) {
    assert.equal(isSentenceShaped(bad), true, `must reject: ${bad}`);
  }

  // ...and the ordinary dictated openers, which are caught either way.
  for (const bad of [
    "I need milk",
    "I wanna get water",
    "I need olive oil oil",
    "I wanna get paper towels water",
    "I want to buy eggs",
    "I gotta grab bread",
    "i",
  ]) {
    assert.equal(isSentenceShaped(bad), true, `must reject: ${bad}`);
  }

  // So the shape guard does NOT get to be the last word on a real product. The
  // predicate stays strict and the escape hatch lives on the write path, where
  // a human can vouch: POST /api/shopping/list accepts {force: true} from an
  // explicit confirmation tap. Asserted for real in the route's own suite —
  // route.test.ts, "the override is the escape hatch for a real product".
  assert.equal(isSentenceShaped("Not Butter"), false);
});

test("empty / garbage transcript returns []", () => {
  assert.deepEqual(parseUtterance("", CATALOG), []);
  assert.deepEqual(parseUtterance("   ", CATALOG), []);
  assert.deepEqual(parseUtterance("...", CATALOG), []);
  assert.deepEqual(parseUtterance("uh", CATALOG), []);
  assert.deepEqual(parseUtterance("and", CATALOG), []);
  assert.deepEqual(parseUtterance("um", CATALOG), []);
  // A whole dictated sentence with nothing groceryish: refuse to write.
  assert.deepEqual(
    parseUtterance(
      "so I was thinking maybe we should probably grab something for dinner tonight",
      CATALOG,
    ),
    [],
  );
  // The rows the mic captured off Watson's chat. These bounce on SHAPE — "OK"
  // + "do" framing, first-person stopwords, the length cap — not because
  // anyone listed them.
  assert.deepEqual(parseUtterance("let me know when you're done", CATALOG), []);
  assert.deepEqual(
    parseUtterance(
      "OK do whatever you need to do to fix everything that needs to get fixed so that we can commit it",
      CATALOG,
    ),
    [],
  );
});

/* =======================================================================
 * FRAMING — the systematic colloquial range.
 * ======================================================================= */

test("framing: the full colloquial contraction range", () => {
  expect("wanna get milk", ["Milk"], [1]);
  expect("gonna need milk", ["Milk"], [1]);
  expect("i'm gonna need bread and I want tuna", ["Bread", "Tuna"], [23, 21]);
  expect("gotta grab milk", ["Milk"], [1]);
  expect("lemme grab water", ["Water"], [15]);
  expect("i'ma get milk", ["Milk"], [1]);
  expect("imma grab bread", ["Bread"], [23]);
  expect("needa get eggs", ["Eggs"], [2]);
  expect("gimme milk", ["Milk"], [1]);
  expect("finna grab tuna", ["Tuna"], [21]);
  expect("I need olive oil", ["Olive oil"], [14]);
  expect("please add milk", ["Milk"], [1]);
  expect("can you add toothpaste and sun screen", ["Toothpaste", "Sun screen"], [30, 29]);
  expect("let me get water", ["Water"], [15]);
  expect("lets get bread", ["Bread"], [23]);
  expect("we're out of milk", ["Milk"], [1]);
  expect("pick up bread", ["Bread"], [23]);
  expect("jot down tuna", ["Tuna"], [21]);
  expect("throw on some avocado", ["Avocado"], [47]);
  expect("add greek yogurt", ["greek yogurt"], [8]);
  expect("um get me uh water", ["Water"], [15]);
});

test("framing strips to a FIXED POINT, not the old 2 passes", () => {
  // "ok" + "so" + "im" + "gonna" + "need" is five layers deep.
  expect("ok so I'm gonna need bread and tuna", ["Bread", "Tuna"], [23, 21]);
  expect("please could you add a dozen eggs", ["Eggs"], [2]);
});

test("framing re-runs per segment, not just at the utterance head", () => {
  // The second clause carries its own "I want".
  expect("I'm gonna need bread and I want tuna", ["Bread", "Tuna"], [23, 21]);
  // continuous=true delivers dictation as multiple final chunks, so a bare
  // leading conjunction must strip.
  expect("and water", ["Water"], [15]);
  expect("milk, I also need eggs", ["Milk", "Eggs"], [1, 2]);
});

test("an unrecognized framing verb costs a MISSED WORD, never a new row", () => {
  // This is the containment property that matters more than lexicon coverage:
  // "think" is not in the grammar, but the residue reads as a sentence, so
  // the words are dropped and Water still lands. No pollution either way.
  expect("umm I think I need water", ["Water"], [15]);
  expect("milk i think", ["Milk"], [1]);
});

/* =======================================================================
 * LONGEST MATCH over overlapping catalog names.
 * ======================================================================= */

test("longest match beats shorter overlapping names", () => {
  expect("greek yogurt", ["greek yogurt"], [8]);
  expect("skyr yogurt", ["Skyr Yogurt"], [40]);
  expect("yogurt", ["Yogurt"], [22]); // bare word does NOT get vacuumed to 8/40
  expect("please add some greek yogurt", ["greek yogurt"], [8]);
  expect("skyr yogurt and greek yogurt", ["Skyr Yogurt", "greek yogurt"], [40, 8]);
  expect("vital farm pastor raised eggs", ["Vital farm pastor raised eggs"], [16]);
  expect("eggs", ["Eggs"], [2]); // the 5-gram row does not swallow the 1-gram
  expect("organic white distilled vinegar", ["Organic white distilled vinegar"], [28]);
  expect("olive oil and black pepper", ["Olive oil", "Black pepper"], [14, 3]);
  expect("pure elizabeth granola", ["Pure Elizabeth granola"], [43]);
  expect("redmond season salt", ["Redmond Season salt"], [36]);
  expect("nativity lotion and organic preworkout", ["Nativity Lotion", "Organic preworkout"], [39, 38]);
  expect("red onions", ["red onions"], [17]);
  expect("chicken breast", ["Chicken breast"], [42]);
  expect("toothpaste", ["Toothpaste"], [30]);
});

test("plural/singular unify; exact literal spelling wins the collision", () => {
  // Ids 4 "Green Pepper" and 18 "green peppers" both stem to "green pepper".
  // The exact tier resolves it with no tie-break at all: each literal
  // spelling lands on its own row, and either way the upsert reuses rather
  // than creating. (Designs 0/1 predicted id 4 here via a useCount tie-break;
  // the public CatalogEntry carries no useCount, and exact-literal is the
  // stronger, more obvious rule.)
  expect("green peppers", ["green peppers"], [18]);
  expect("green pepper", ["Green Pepper"], [4]);
  expect("red peppers and green peppers", ["red peppers", "green peppers"], [19, 18]);
  expect("add green peppers and red peppers", ["green peppers", "red peppers"], [18, 19]);
  expect("red onions and green peppers", ["red onions", "green peppers"], [17, 18]);
  // Plural speech reaching a singular-stored row:
  expect("three avocados", ["Avocado"], [47]);
  expect("umbrellas", ["Umbrella"], [34]);
});

test("conjunction splitting still works normally on ordinary items", () => {
  expect("I want olive oil and greek yogurt and bread", ["Olive oil", "greek yogurt", "Bread"], [14, 8, 23]);
  expect("I wanna get some milk and greek yogurt and bread", ["Milk", "greek yogurt", "Bread"], [1, 8, 23]);
  expect("please add milk, bread, and tuna", ["Milk", "Bread", "Tuna"], [1, 23, 21]);
  expect("milk, eggs, bread", ["Milk", "Eggs", "Bread"], [1, 2, 23]);
  expect("milk, bread, and tuna", ["Milk", "Bread", "Tuna"], [1, 23, 21]);
  expect("paper bowls and paper towels", ["paper bowls", "Paper towels"], [25, 44]);
  expect("toothpaste and sunscreen", ["Toothpaste", "Sun screen"], [30, 29]);
});

test("run-on with NO conjunction still splits (the old splitter could not)", () => {
  expect("I wanna get paper towels water", ["Paper towels", "Water"], [44, 15]);
});

/* =======================================================================
 * NORMALIZATION VARIANTS.
 * ======================================================================= */

test("apostrophes are deleted, never split on", () => {
  // Row 6 is stored WITHOUT an apostrophe; splitting would yield [annie, s].
  expect("annie's organic ketchup", ["annies organic ketchup"], [6]);
  expect("annies organic ketchup", ["annies organic ketchup"], [6]);
});

test("compound-boundary drift is caught in both directions", () => {
  expect("sunscreen", ["Sun screen"], [29]); // join -> split
  expect("sun screen", ["Sun screen"], [29]);
  expect("tooth paste", ["Toothpaste"], [30]); // split -> join
});

test("hyphens, ampersands and trailing punctuation", () => {
  expect("milk & eggs", ["Milk", "Eggs"], [1, 2]);
  expect("lavender and mint smell good.", ["Lavender and mint smell good"], [27]);
  expect("Milk!", ["Milk"], [1]);
});

/* =======================================================================
 * FUZZY TIER — must catch the real typos, must NOT vacuum novel items.
 * ======================================================================= */

test("fuzzy reuses the permanently misspelled rows", () => {
  const r = parseUtterance("bananas", CATALOG);
  assert.deepEqual(r.map((i) => i.name), ["Bananna"]);
  assert.equal(r[0].matchedId, 12);
  assert.equal(r[0].source, "fuzzy");
  expect("banana", ["Bananna"], [12]);
  expect("sauerkraut", ["Saurkraut"], [9]); // stored typo, distance 1
  expect("avacado", ["Avocado"], [47]);
  expect("yoghurt", ["Yogurt"], [22]);
  expect("greek yoghurt", ["greek yogurt"], [8]);
  expect("umbrela", ["Umbrella"], [34]);
});

test("fuzzy REJECTS the dangerous near-collisions in this catalog", () => {
  // Each of these is edit distance 1 or 2 from a real row. A wrong reuse is
  // silent and permanent; a new row is recoverable. So all must stay novel.
  const mustStayNovel: [string, string][] = [
    ["wafer", "Water id 15 — distance 1, same first char; only the length-5 budget of 0 saves it"],
    ["wafers", "plural form of the same trap"],
    ["break", "Bread id 23 — distance 1"],
    ["bred", "Bread id 23"],
    ["tune", "Tuna id 21 — distance 1"],
    ["mild", "Milk id 1 — distance 1"],
    ["milt", "Milk id 1"],
    ["custard", "Mustard id 11 — distance 1; ONLY the first-char anchor rejects it"],
    ["butter", "Water id 15"],
    ["salsa", "salt inside Redmond Season salt"],
    ["ripe", "rice/Tuna neighbourhood"],
  ];
  for (const [word, why] of mustStayNovel) {
    const r = parseUtterance(word, CATALOG);
    assert.equal(r.length, 1, `${word}: ${why}`);
    assert.equal(r[0].matchedId, null, `${word} must NOT reuse a row — ${why}`);
    assert.equal(r[0].source, "novel", `${word}: ${why}`);
  }
});

test("fuzzy never crosses the paper bowls / paper towels pair", () => {
  // Both hit the exact tier, so fuzzy never runs; and even if it did, the
  // per-token first-char anchor (b vs t) rejects.
  expect("paper bowls", ["paper bowls"], [25]);
  expect("paper towels", ["Paper towels"], [44]);
  expect("paper bowl", ["paper bowls"], [25]);
});

test("exact ALWAYS outranks fuzzy", () => {
  const r = parseUtterance("mustard", CATALOG);
  assert.equal(r[0].source, "exact");
  assert.equal(r[0].matchedId, 11);
});

test("fuzzy absorbs a stored typo inside a multi-word name", () => {
  // Row 16 stores "pastor" for "pasture". The scan alone only reaches "Eggs"
  // and strands four tokens; span-level re-resolution reaches row 16.
  const r = parseUtterance("vital farms pasture raised eggs", CATALOG);
  assert.deepEqual(r.map((i) => i.name), ["Vital farm pastor raised eggs"]);
  assert.equal(r[0].matchedId, 16);
});

test("ambiguous or unsupported words stay novel rather than guess", () => {
  // "pepper" is inside Black pepper, Green Pepper AND red peppers. Guessing
  // green when he meant red is worse than an honest new row.
  for (const u of ["pepper", "peppers", "mint", "good", "farm", "vinegar", "granola", "oil", "salt", "onions"]) {
    const r = parseUtterance(u, CATALOG);
    assert.equal(r.length, 1, u);
    assert.equal(r[0].matchedId, null, `${u} must not be vacuumed onto a row`);
  }
});

/* =======================================================================
 * LEFTOVERS, MODIFIERS, STUTTER.
 * ======================================================================= */

test("echo guard kills the stutter that created row 13", () => {
  expect("i need olive oil oil", ["Olive oil"], [14]);
  expect("olive oil oil", ["Olive oil"], [14]);
});

test("echo guard is token EQUALITY, not substring", () => {
  expect("water and watermelon", ["Water", "watermelon"], [15, null]);
});

test("an unresolved modifier makes ONE novel item, never a silent wrong row", () => {
  // The single most important safety case in the whole parser: discarding
  // "almond" would put DAIRY milk on Watson's list with no trace.
  expect("almond milk", ["almond milk"], [null]);
  expect("oat milk", ["oat milk"], [null]);
  expect("organic milk", ["organic milk"], [null]);
  expect("cold milk", ["cold milk"], [null]);
  expect("coconut water", ["coconut water"], [null]);
  // ...and it must not swallow a real second item across a conjunction.
  expect("milk and arborio rice", ["Milk", "arborio rice"], [1, null]);
});

test("catalog match followed by a novel item across 'and'", () => {
  expect("bread and butter", ["Bread", "butter"], [23, null]);
});

test("pure-filler and pure-framing clauses drop silently", () => {
  expect("um, yeah, let's get, uh, some paper bowls", ["paper bowls"], [25]);
  assert.deepEqual(parseUtterance("i need", CATALOG), []);
  assert.deepEqual(parseUtterance("please add", CATALOG), []);
});

/* =======================================================================
 * QUANTITY.
 * ======================================================================= */

test("quantity: number words, digits, units and multipliers", () => {
  const q = (u: string) => parseUtterance(u, CATALOG).map((i) => [i.name, i.count]);
  assert.deepEqual(q("two gallons of milk"), [["Milk", 2]]);
  assert.deepEqual(q("a dozen eggs"), [["Eggs", 12]]);
  assert.deepEqual(q("please add a dozen eggs"), [["Eggs", 12]]);
  assert.deepEqual(q("two dozen eggs"), [["Eggs", 24]]);
  assert.deepEqual(q("three avocados"), [["Avocado", 3]]);
  assert.deepEqual(q("3 bananas"), [["Bananna", 3]]);
  assert.deepEqual(q("get me a couple gallons of water"), [["Water", 2]]);
  assert.deepEqual(q("twelve eggs"), [["Eggs", 12]]);
  assert.deepEqual(q("get me two boxes of granola"), [["granola", 2]]);
  assert.deepEqual(q("three bags of ice"), [["ice", 3]]);
});

test("quantity: prefer null over a wrong count", () => {
  const q = (u: string) => parseUtterance(u, CATALOG).map((i) => [i.name, i.count]);
  // count 1 stores as NULL (schema convention; UI only renders count > 1).
  assert.deepEqual(q("a gallon of milk"), [["Milk", null]]);
  assert.deepEqual(q("one milk"), [["Milk", null]]);
  assert.deepEqual(q("milk"), [["Milk", null]]);
  assert.deepEqual(q("some milk"), [["Milk", null]]);
  assert.deepEqual(q("zero milk"), [["Milk", null]]);
  // A bare quantity word must never consume its whole segment.
  assert.deepEqual(q("dozen"), [["dozen", null]]);
});

test("quantity is scoped PER SEGMENT, and cannot leak or strand", () => {
  const q = (u: string) => parseUtterance(u, CATALOG).map((i) => [i.name, i.count]);
  // The count must not leak forward onto Eggs...
  assert.deepEqual(q("two gallons of milk and eggs"), [["Milk", 2], ["Eggs", null]]);
  // ...and a count in the SECOND segment must be found there, not ignored and
  // then written out as a permanent "two gallons" catalog row.
  assert.deepEqual(q("milk and two gallons of water"), [["Milk", null], ["Water", 2]]);
  assert.deepEqual(q("two milks and three breads"), [["Milk", 2], ["Bread", 3]]);
});

/* =======================================================================
 * DEDUPE.
 * ======================================================================= */

test("dedupe within one utterance", () => {
  expect("milk and milk", ["Milk"], [1]);
  expect("milk milk", ["Milk"], [1]);
  expect("water water water", ["Water"], [15]);
  expect("tuna tuna and bread", ["Tuna", "Bread"], [21, 23]);
  // A stutter is ambiguous, so it must NOT invent a count of 2.
  assert.equal(parseUtterance("milk and milk", CATALOG)[0].count, null);
  // An EXPLICIT count still merges.
  assert.equal(parseUtterance("two milks and milk", CATALOG)[0].count, 3);
});

/* =======================================================================
 * DETERMINISM / ROBUSTNESS.
 * ======================================================================= */

test("parse is a pure function of (catalog, transcript)", () => {
  const u = "I wanna get paper towels and water";
  const a = JSON.stringify(parseUtterance(u, CATALOG));
  const b = JSON.stringify(parseUtterance(u, [...CATALOG].reverse()));
  assert.equal(a, b, "row order must not change the result");
  assert.equal(a, JSON.stringify(parseUtterance(u, CATALOG)), "repeatable");
});

test("degenerate catalogs do not throw", () => {
  assert.deepEqual(parseUtterance("milk", []), [
    { name: "milk", count: null, matchedId: null, source: "novel" },
  ]);
  assert.deepEqual(parseUtterance("milk", [{ id: 1, name: "" }]).length, 1);
});

test("INVARIANT: every eligible row, spoken back, resolves to itself", () => {
  // The strongest single check in the file. Says nothing about phrasing and
  // everything about the index: no row may be shadowed by another (longest
  // match holds), swallowed by fuzzy, or split by a conjunction. Row 27
  // ("Lavender and mint smell good") and row 16 (5 tokens) are the ones this
  // would catch first if the scan order ever regressed. It re-derives its
  // expectations from CATALOG, so it keeps working as the catalog grows.
  for (const row of CATALOG) {
    if (isSentenceShaped(row.name)) continue; // 13, 48, 50
    const r = parseUtterance(row.name, CATALOG);
    assert.equal(r.length, 1, `${row.id} "${row.name}" must yield ONE item`);
    assert.equal(r[0].matchedId, row.id, `${row.id} "${row.name}" must reuse itself`);
    assert.equal(r[0].name, row.name, `${row.id} must echo its stored name`);
  }
});

test("matched names are the catalog's stored casing, verbatim", () => {
  // This is the entire reuse mechanism: POST lowercases what we send and
  // upserts on normalized_name, so the stored string round-trips onto its
  // own row. Sending the SPOKEN text is how rows 48 and 50 were born.
  for (const [u, stored] of [
    ["paper towels", "Paper towels"],
    ["milk", "Milk"],
    ["greek yogurt", "greek yogurt"],
    ["annies organic ketchup", "annies organic ketchup"],
    ["redmond season salt", "Redmond Season salt"],
    ["skyr yogurt", "Skyr Yogurt"],
  ] as const) {
    const r = parseUtterance(u, CATALOG);
    assert.equal(r[0].name, stored, u);
    const row = CATALOG.find((c) => c.id === r[0].matchedId)!;
    assert.equal(r[0].name, row.name, `${u}: must equal the stored name`);
    assert.equal(
      r[0].name.toLowerCase(),
      row.name.toLowerCase(),
      `${u}: normalized upsert must land on the existing row`,
    );
  }
});

/* =======================================================================
 * REGRESSIONS — four defects found by adversarial review, none of which
 * any test above would have caught.
 * ======================================================================= */

test("REGRESSION: trailing 'to the list' is framing, not part of the name", () => {
  // The prefix stripper only ever consumed OBJ right after a VERB, so "add to
  // the list bread" worked and "add bread to the list" — the way English
  // actually orders it — emitted the novel item "bread to the list". That is
  // row 48's shape, minted by the code written to prevent row 48.
  expect("add bread to the list", ["Bread"], [23]);
  expect("add milk to the list", ["Milk"], [1]);
  expect("put milk on the list", ["Milk"], [1]);
  expect("throw tuna on the list", ["Tuna"], [21]);
  expect("write down eggs on the list", ["Eggs"], [2]);
  expect("get chicken breast on the list", ["Chicken breast"], [42]);
  expect("add paper towels and water to the list", ["Paper towels", "Water"], [44, 15]);
  // A novel item keeps its own name and loses only the destination.
  expect("add arborio rice to the list", ["arborio rice"], [null]);
  // Prefix position still works — it never broke.
  expect("add to the list bread", ["Bread"], [23]);
  // "my" vs "the" must not change the outcome. It used to: "my" is a STOP
  // token, which tripped the guard and produced the right answer BY ACCIDENT.
  expect("add bread to my list", ["Bread"], [23]);
  // Defense in depth: the PREDICATE rejects the shape even if a tail is ever
  // missed at parse time.
  //
  // This comment used to say "the write guard rejects the shape". It did not.
  // Nothing imported this predicate on the write path — the guard was a
  // comment, and these two lines proved only that a pure function returns
  // true. The route now imports it for real, and route.test.ts asserts on the
  // real Response, which is the claim this comment was making all along.
  assert.equal(isSentenceShaped("bread to the list"), true);
  assert.equal(isSentenceShaped("milk on the list"), true);
  // Pure framing with no item still emits nothing rather than throwing.
  assert.deepEqual(parseUtterance("add to the list", CATALOG), []);
});

test("REGRESSION: fuzzy budget is scoped to the DIFFERING token", () => {
  // Sizing the budget off the joined span handed a short differing token
  // budget 2 the moment any exactly-matching token sat beside it. Appending a
  // matching token must never LOOSEN the test on the token that differs.
  const novel = (u: string) => {
    const r = parseUtterance(u, CATALOG);
    assert.equal(r.length, 1, `${u} must yield one item`);
    assert.equal(r[0].matchedId, null, `${u} must NOT resolve to a catalog row`);
    assert.equal(r[0].source, "novel");
  };
  novel("soy yogurt");   // was Skyr Yogurt (40) — soy yogurt is dairy-FREE
  novel("soya yogurt");  // was Skyr Yogurt (40)
  novel("raw onions");   // was red onions (17)
  novel("raw peppers");  // was red peppers (19)
  novel("paper boxes");  // was paper bowls (25)
  novel("black paper");  // was Black pepper (3)
  novel("red paper");    // was red peppers (19)
  novel("olive oats");   // was Olive oil (14)
  novel("chicken bread");// was Chicken breast (42)

  // MONOTONICITY: a token refused alone stays refused in a span.
  assert.equal(parseUtterance("soy", CATALOG)[0].matchedId, null);
  assert.equal(parseUtterance("soy yogurt", CATALOG)[0].matchedId, null);

  // ...and every intended fuzzy match survives the tightening. The last one is
  // the reason the budget cannot simply be scoped and left there:
  // pasture/pastor is OSA 2 against a token budget of 1, and is reachable only
  // because four other tokens pin row 16 and nothing else.
  expect("bananas", ["Bananna"], [12]);
  expect("sauerkraut", ["Saurkraut"], [9]);
  expect("yoghurt", ["Yogurt"], [22]);
  expect("vital farms pasture raised eggs", ["Vital farm pastor raised eggs"], [16]);
});

test("REGRESSION: a real product containing 'test' is addable", () => {
  // "test" in STOP made every such product unaddable through EVERY path: the
  // parser emitted nothing and the typed box just said "Nothing to add from
  // that, sir." The suggestion path could not help either — it only surfaces
  // rows already in the catalog, so the item could never get in.
  expect("Test strips", ["Test strips"], [null]);
  expect("pregnancy test", ["pregnancy test"], [null]);
  expect("COVID test kit", ["COVID test kit"], [null]);
  expect("test tube brush", ["test tube brush"], [null]);
});

test("REGRESSION: no catalog row is hardcoded into the parser", () => {
  // The parser used to carry `DENY_NORMALIZED = new Set(["smoke test item"])`
  // plus a `/\b(smoke\s?test|test item)\b/` regex — two spellings of the same
  // hack, both naming ONE real row (id 7) so the guard would reject it.
  //
  // Both are gone, and this test is what stops them coming back. It asserts
  // the honest consequence rather than hiding it: with the hack removed,
  // "smoke-test-item" is nothing special. It is a three-token phrase with no
  // framing, no stopword and no stutter, so it reads as an ordinary novel
  // item — exactly like "Test strips" above, and for the same reason.
  //
  // That is CORRECT, because the row was deleted from the database. A guard
  // hardcoding a row is a guard that cannot be reasoned about: it says the
  // parser rejects a shape when really it rejects a string, and it rots the
  // moment the row is gone. The row's absence is what retires it. The
  // predicate only ever describes shapes.
  assert.equal(isSentenceShaped("smoke-test-item"), false);
  assert.equal(isSentenceShaped("smoke test item"), false);
  // Emitted as "smoke test": preClean turns the hyphens into spaces and "item"
  // is FILLER, dropped from every name the same way "some" and "the" are. No
  // rule here knows what a smoke test is, which is the entire point.
  expect("smoke-test-item", ["smoke test"], [null]);
  // ...and nothing in the fixture is named for it either: the row is not in
  // CATALOG, so there is no id 7 to match against in the first place.
  assert.equal(CATALOG.some((c) => c.id === 7), false);
  assert.equal(
    CATALOG.some((c) => /smoke/i.test(c.name)),
    false,
  );
});

test("REGRESSION: a long specific product is never silently swapped", () => {
  // Past the token cap, emitSegment fell through to "keep the matches, drop
  // the words" and put bare "Chicken breast" on the list — the exact silent
  // product swap its own comment forbids, triggered by nothing but word count.
  // Same grammatical shape either side of the old cliff, so only the count
  // ever mattered:
  expect("organic free range chicken breast", ["organic free range chicken breast"], [null]);
  expect(
    "organic free range grass fed chicken breast",
    ["organic free range grass fed chicken breast"],
    [null],
  );
  expect(
    "boneless skinless organic free range chicken breast",
    ["boneless skinless organic free range chicken breast"],
    [null],
  );
  expect(
    "extra large pasture raised organic brown eggs",
    ["extra large pasture raised organic brown eggs"],
    [null],
  );
  // Long emissions must be MATCHABLE on the next page load, or the parser
  // spends forever re-adding rows it cannot see.
  assert.equal(isSentenceShaped("boneless skinless organic free range chicken breast"), false);

  // The distinction that replaced the cap still holds in the other direction:
  // real framing around a match still drops the words and keeps the item.
  expect("umm I think I need water", ["Water"], [15]);
});
