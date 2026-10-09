/**
 * POST /api/shopping/list — the WRITE GUARD, tested at the route.
 *
 * Run:  node --import ./scripts/node-test-alias-hook.mjs --test \
 *         src/app/api/shopping/list/route.test.ts
 * (or `npm test`, which runs this and the parser suite together)
 *
 * WHY THIS FILE EXISTS, AND WHY THE PARSER SUITE COULD NOT COVER IT.
 *
 * voice-parse.test.ts asserted `isSentenceShaped("bread to the list") === true`
 * under a comment that read "the write guard rejects the shape". It did not.
 * Nothing imported the predicate on the write path at all — the guard was a
 * comment, and the test proved only that a pure function returns true. A
 * predicate returning true and a route refusing to write are different claims,
 * and only the second one protects shopping_items.
 *
 * So these tests call the real exported POST with a real Request and assert on
 * the real Response. If the import in route.ts is ever deleted, the predicate
 * stays green and THIS goes red.
 *
 * NO DATABASE IS INVOLVED, AND THAT IS ITSELF THE ASSERTION.
 * route.ts reaches the database through `await import("@/lib/db")` INSIDE the
 * handler, below the guard, and @/lib/db throws on import when DATABASE_URL is
 * unset. So a clean 400 is proof the guard short-circuits before the upsert:
 * had it fallen through, the import would have thrown and the status would not
 * be 400.
 *
 * WHY THE `delete` BELOW IS LOAD-BEARING, NOT BELT-AND-BRACES.
 *
 * This suite used to rest that entire property on the AMBIENT environment —
 * "these tests run with it unset (node --test does not read .env.local)" — and
 * then POST four clean names through the real handler. Clean names pass the
 * guard by construction, so the only thing standing between this file and
 * Watson's production catalog was a variable nobody had set yet. Exported
 * DATABASE_URL in a shell, or injected in CI, and the suite wrote permanent
 * rows: proved by running exactly this fixture loop with .env.local loaded,
 * which minted catalog rows for "arborio rice" and "Test strips" and appended
 * shopping_list rows for each. It also bumped use_count on "Milk" and "Paper
 * towels" — Watson's real rows — skewing the very autocomplete ranking this
 * work exists to protect. A test that can mint the bug it guards is not a test,
 * it is the bug with a green checkmark.
 *
 * So the condition is now ENFORCED here rather than assumed: the variable is
 * deleted before route.ts is imported (it imports @/lib/db lazily, inside the
 * handler, so the delete lands first no matter what). The db import therefore
 * throws for every caller, in every environment, and this suite CANNOT reach
 * Neon. The fall-through assertions below turn that into evidence instead of
 * swallowing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* Hermetic by construction — see the header. Must precede the route import. */
delete process.env.DATABASE_URL;

/* Same two-resolver dance as voice-parse.test.ts: the TYPE side imports
   extensionless so tsc's bundler resolution finds the .ts (a literal "./route.ts"
   would trip TS5097), and the VALUE side builds the specifier at runtime so
   Node's native type stripping gets the explicit extension it requires. The
   `@/*` imports INSIDE route.ts are handled by the resolve hook above. */
const { POST } = (await import("./route" + ".ts")) as typeof import("./route");

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3001/api/shopping/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function json(res: Response): Promise<{ ok?: boolean; error?: string }> {
  return (await res.json()) as { ok?: boolean; error?: string };
}

/** Every shape the guard must refuse, and why each one is in this list. */
const MUST_REJECT: [string, string][] = [
  ["I wanna get paper towels water", "row 48, verbatim — the row this closes"],
  ["I wanna get chicken breast", "row 50, verbatim"],
  ["I wanna get water", "row 52, verbatim"],
  ["I need olive oil oil", "row 13, verbatim — the stutter"],
  [
    "OK do whatever you need to do to fix everything that needs to get fixed so that we can commit it",
    "row 53 — a chat message the mic captured",
  ],
  ["let me know when you're done", "row 55, verbatim — apostrophe and all"],
  ["merge it to the main", "row 54, verbatim — the one that used to slip (G5)"],
  ["push it to the branch", "row 54's CLASS: a novel chat sentence, no row yet"],
  ["ship it to prod", "same class, different verb — no verb list involved"],
  ["bread to the list", "the trailing-framing shape the old comment claimed"],
  ["milk on the list", "same, other preposition"],
  ["please add milk", "leading framing"],
  ["I need milk", "first-person stopword"],
  ["can you add toothpaste", "framing with a pronoun"],
  [
    "one two three four five six seven eight nine ten eleven twelve",
    "past the token cap (G3)",
  ],
];

test("the ROUTE rejects every sentence-shaped name with a 400", async () => {
  for (const [name, why] of MUST_REJECT) {
    const res = await post({ name });
    assert.equal(res.status, 400, `${JSON.stringify(name)} must 400 — ${why}`);
    const body = await json(res);
    assert.equal(body.ok, false, `${name}: ok must be false`);
    assert.equal(
      typeof body.error,
      "string",
      `${name}: must carry an error message`,
    );
    assert.match(
      body.error ?? "",
      /sentence/i,
      `${name}: the message must say WHY, not just fail`,
    );
  }
});

test("the route's rejection is the parser's predicate, not a second copy", async () => {
  // The guard must BE isSentenceShaped, or the two drift and the drift is the
  // bug. Anything the predicate calls sentence-shaped, the route must 400 —
  // asserted against the predicate itself rather than a hand-copied list.
  const { isSentenceShaped } = await import("@/lib/voice-parse");
  for (const [name] of MUST_REJECT) {
    assert.equal(
      isSentenceShaped(name),
      true,
      `${name}: fixture must actually be sentence-shaped`,
    );
  }
  // ...and the converse: a name the predicate ACCEPTS must not be 400'd by the
  // guard.
  //
  // Asserted as a REJECTION, not as a non-400. With DATABASE_URL deleted (see
  // the header), a name that clears the guard must fall through to
  // `await import("@/lib/db")` and throw there — so a throw naming DATABASE_URL
  // is positive proof of exactly the thing being claimed: the guard let it past
  // and the handler got as far as the upsert it can no longer perform.
  //
  // This replaces a `.catch(() => null)` + `if (res)` that swallowed the throw
  // and asserted nothing whenever it fired. That shape was strictly weaker in
  // both directions: it passed silently when the handler exploded for an
  // unrelated reason, and — with DATABASE_URL set — it passed on a real 200
  // that had just written a permanent row to Watson's catalog. assert.rejects
  // cannot pass on a 200.
  for (const good of ["Milk", "Paper towels", "arborio rice", "Test strips"]) {
    assert.equal(isSentenceShaped(good), false, `${good}: fixture sanity`);
    await assert.rejects(
      post({ name: good }),
      /DATABASE_URL/,
      `${good}: a real grocery must clear the guard and reach the db import`,
    );
  }
});

test("a shape rejection is FLAGGED, so the client can tell it apart", async () => {
  // The override may only ever be offered for a SHAPE refusal. The client must
  // not have to regex the prose to know that, so the route says it in a field.
  const shape = await post({ name: "I wanna get water" });
  assert.equal(shape.status, 400);
  assert.equal(
    ((await shape.json()) as { sentenceShaped?: boolean }).sentenceShaped,
    true,
    "a shape refusal must be flagged as one",
  );

  // ...and no other 400 carries the flag, or the client would offer to force a
  // name that was never refused for its shape.
  for (const body of [{}, { name: "" }, { name: "Milk", count: 0 }]) {
    const res = await post(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)}: still a 400`);
    assert.notEqual(
      ((await res.json()) as { sentenceShaped?: boolean }).sentenceShaped,
      true,
      `${JSON.stringify(body)}: must NOT offer the override`,
    );
  }
});

test("the override is the escape hatch for a real product", async () => {
  // "I Can't Believe It's Not Butter" is a real grocery that is shaped like a
  // sentence. The predicate cannot know that and must not try — softening it to
  // let this through is what would let "i think water" become a permanent row.
  // So the guard refuses by default...
  const { isSentenceShaped } = await import("@/lib/voice-parse");
  const BUTTER = "I Can't Believe It's Not Butter";
  assert.equal(isSentenceShaped(BUTTER), true, "shaped like a sentence");
  const refused = await post({ name: BUTTER });
  assert.equal(refused.status, 400, "refused by default");

  // ...and force overrules it, because a human vouched. This must reach the DB
  // import to prove the guard actually yielded: with DATABASE_URL deleted, a
  // throw naming it is proof the handler ran ON PAST the guard to the upsert.
  // A 400 here would mean the escape hatch does not exist.
  await assert.rejects(
    post({ name: BUTTER, force: true }),
    /DATABASE_URL/,
    "force must carry a sentence-shaped name past the guard",
  );
});

test("force is EXPLICIT: nothing falsy or absent may open the guard", async () => {
  // The override's whole safety rests on it being unreachable by accident. A
  // misparse posts no `force` at all; a sloppy client might post a falsy one.
  // Neither may write, or the guard is decorative and the bug class is back.
  for (const force of [undefined, false, null, 0, "", "false", "true", 1]) {
    const body: Record<string, unknown> = { name: "I wanna get water" };
    if (force !== undefined) body.force = force;
    const res = await post(body);
    assert.equal(
      res.status,
      400,
      `force=${JSON.stringify(force)} must NOT override the guard`,
    );
  }
  // Only the literal boolean true, which is what the confirm tap sends.
  await assert.rejects(
    post({ name: "I wanna get water", force: true }),
    /DATABASE_URL/,
    "an explicit true is the one thing that overrides",
  );
});

test("the guard runs before the database, not after", async () => {
  // DATABASE_URL is deleted at the top of this file, so @/lib/db throws on
  // import. A 400 therefore proves the guard returned BEFORE the upsert was
  // reached — the property that makes the bad row impossible rather than
  // merely unlikely.
  assert.equal(
    process.env.DATABASE_URL,
    undefined,
    "the suite's hermetic invariant: nothing here may reach Neon",
  );
  const res = await post({ name: "I wanna get paper towels water" });
  assert.equal(res.status, 400);
});

test("the existing name/count contract is untouched", async () => {
  // The guard must not have moved the goalposts on validation that already
  // worked. An empty name is still a 400, and still says so in its own words.
  for (const body of [{}, { name: "" }, { name: "   " }]) {
    const res = await post(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)}: empty name`);
    const parsed = await json(res);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? "", /name is required/);
  }
  // A bad count on a CLEAN name is still the count error — proving the guard
  // sits alongside the old checks rather than swallowing them.
  const res = await post({ name: "Milk", count: 0 });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error ?? "", /count must be a positive number/);
});
