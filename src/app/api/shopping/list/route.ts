// Shopping list: list + add.
//
// GET  → active list rows joined with item names, oldest first.
// POST → REJECTS sentence-shaped names, then upserts shopping_items by
//        normalized_name (lowercased trim), bumps useCount + lastUsedAt, and
//        appends a new shopping_list row with optional count. Returns the new
//        row in the same shape the GET endpoint serves.
//
// Demo mode: list is always empty; POST is a no-op that returns 200 so the
// client optimistic flow doesn't blow up if the demo is ever opened.
//
// ---------------------------------------------------------------------------
// THE WRITE GUARD IS THE POINT OF THIS FILE.
//
// This route is the ONLY way a row enters shopping_items, and shopping_items
// rows are permanent: they outlive the list row that created them, they feed
// autocomplete forever, and deleting the list row does not touch them. So a
// single misparse writing a dictated sentence here ("I wanna get paper towels
// water", ids 48/50) is not a transient bug, it is a permanent one.
//
// Guarding the PARSER is necessary but never sufficient, because the parser is
// not the only writer. A tapped suggestion, a curl, a future feature — each is
// its own path to this upsert, and each would need its own guard. Guarding the
// WRITE covers all of them at once, including the ones not written yet. That
// is the difference between the bug class being unlikely and it being
// impossible, and it is why the predicate lives in @/lib/voice-parse (pure,
// import-free, runs identically in the client bundle and in this handler)
// rather than in the component that happens to call it.
import { isDemo, getShoppingList } from "@/lib/data";
import { isSentenceShaped } from "@/lib/voice-parse";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const items = await getShoppingList();
  return Response.json({ items });
}

type PostBody = { name?: string; count?: number | null; force?: boolean };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  const rawName = (body.name ?? "").trim();
  if (!rawName) {
    return Response.json(
      { ok: false, error: "name is required" },
      { status: 400 },
    );
  }

  // THE GUARD. Runs BEFORE the upsert and before any DB import, so a rejected
  // name never reaches the database at all.
  //
  // isSentenceShaped, NOT isFramingShaped — and the difference is deliberate.
  // The parser gates its own novel emissions on framing ALONE, because it must
  // never silently drop a real product over word count; a 7-token "boneless
  // skinless organic free range chicken breast" is a thing Watson buys. This
  // route can afford the stricter predicate precisely because it fails LOUDLY:
  // the client rolls the optimistic row back and says so out loud, which is a
  // recoverable annoyance. Silently writing a dictated sentence is not.
  //
  // The message is what the client renders verbatim, so it is written to be
  // read by Watson, not by a log.
  //
  // `force` IS THE ESCAPE HATCH, AND IT IS WHY THE GUARD CAN STAY STRICT.
  //
  // The predicate judges SHAPE, and some real products are shaped like
  // sentences: "I Can't Believe It's Not Butter" trips the first-person
  // stopword and, without this, was unaddable through every path — typed,
  // tapped or curl'd. The tempting fix is to soften the predicate, and it is a
  // trap: the "i" stopword is what stops "i think water" from becoming a
  // permanent row (measured — see the STOP comment in @/lib/voice-parse), so
  // softening it trades a loud recoverable failure for a silent permanent one.
  //
  // The right question is not "is this a sentence?" but "did a HUMAN mean it?",
  // and no predicate can answer that. So the guard answers the first question
  // and Watson answers the second. `force` is only ever set by an explicit
  // confirmation tap on the rejection notice; the parser never sets it, the mic
  // path never sets it, and a misparse therefore still bounces exactly as
  // before. That is the whole distinction between this and weakening the guard:
  // the shape is still refused BY DEFAULT, and the only thing that overrides it
  // is a deliberate act by the one person entitled to make it.
  //
  // It also generalizes past the row that motivated it. Any legitimate
  // sentence-shaped product — a brand not yet invented — is addable now,
  // without anyone editing a lexicon.
  if (isSentenceShaped(rawName) && body.force !== true) {
    return Response.json(
      {
        ok: false,
        error:
          "That reads as a sentence, sir, not a grocery. Nothing was saved.",
        // The client uses this to tell a shape rejection (offer the override)
        // from every other 400 (never offer it). Without it the client would
        // have to match on the message text, which is copy, not contract.
        sentenceShaped: true,
      },
      { status: 400 },
    );
  }

  const normalized = rawName.toLowerCase();

  // count is optional. NULL means "1". Reject negatives / zero.
  let count: number | null = null;
  if (body.count != null) {
    const n = Number(body.count);
    if (!Number.isFinite(n) || n <= 0) {
      return Response.json(
        { ok: false, error: "count must be a positive number" },
        { status: 400 },
      );
    }
    count = Math.floor(n);
  }

  if (isDemo()) {
    return Response.json({ ok: true, demo: true });
  }

  const { db } = await import("@/lib/db");
  const { shoppingItems, shoppingList } = await import("@/lib/schema");

  // Upsert item by normalized_name. On conflict, bump useCount and refresh
  // lastUsedAt so the autocomplete ranks "what you reach for" first.
  const [item] = await db
    .insert(shoppingItems)
    .values({
      name: rawName,
      normalizedName: normalized,
      useCount: 1,
    })
    .onConflictDoUpdate({
      target: shoppingItems.normalizedName,
      set: {
        useCount: sql`${shoppingItems.useCount} + 1`,
        lastUsedAt: sql`now()`,
      },
    })
    .returning();

  const [entry] = await db
    .insert(shoppingList)
    .values({
      itemId: item.id,
      count,
    })
    .returning();

  return Response.json({
    ok: true,
    item: {
      id: entry.id,
      itemId: item.id,
      name: item.name,
      count: entry.count,
      crossed: entry.crossed,
      createdAt: entry.createdAt,
    },
  });
}
