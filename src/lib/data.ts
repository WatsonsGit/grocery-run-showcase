/**
 * Data layer — the shopping reads, adapted from Happy Hour Finance's data.ts.
 *
 * This standalone app has NO demo mode and NO AI. It always talks to the
 * shared Neon database. `isDemo()` is kept (always false) purely so the ported
 * API routes stay byte-for-byte identical to Happy Hour's, imports aside.
 *
 * ---------------------------------------------------------------------------
 * WHY THE READS FILTER, NOT JUST THE WRITES
 *
 * The POST route now refuses to CREATE a sentence-shaped shopping_items row,
 * which stops the bleeding but does not clean the wound: rows 13, 48, 50 and
 * 52-55 already exist, and they are permanent until someone deletes them.
 * Unfiltered, they were not merely inert — they were self-reinforcing. Typing
 * "water" surfaced "I wanna get water" as a TAPPABLE suggestion; the tap
 * called POST with that name; the upsert bumped its use_count; and
 * autocomplete ranks by use_count desc. Pollution CLIMBED. Row 50 reached
 * use_count 2 down exactly that path.
 *
 * So the same predicate that guards the write guards the read. Serving a row
 * is what makes it reachable, and an unreachable row cannot climb.
 *
 * WITH ONE DELIBERATE EXCEPTION: getSavedItems. "Reachable" is the property
 * worth denying a SUGGESTION, not the property worth denying Watson. The
 * manager is the cleanout surface, so it lists every row, polluted or not —
 * see its own comment. The rule is not "filter every read", it is "never OFFER
 * a polluted row", and the manager offers nothing; it confesses.
 */
import { asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { isSentenceShaped } from "@/lib/voice-parse";

/** Always false here — grocery-run has no demo/mock mode. Kept so the ported
 *  API route handlers don't have to be edited. */
export function isDemo(): boolean {
  return false;
}

/* ---------------- Shopping (grocery list + catalog) ----------------
 * The active list view: every shopping_list row with cleared_at IS NULL,
 * joined with shopping_items so the UI has the display name on hand.
 */
export type ShoppingListEntry = {
  id: number;
  itemId: number;
  name: string;
  count: number | null;
  crossed: boolean;
  createdAt: Date;
};

export async function getShoppingList(): Promise<ShoppingListEntry[]> {
  const { db } = await import("@/lib/db");
  const { shoppingList, shoppingItems } = await import("@/lib/schema");
  const rows = await db
    .select({
      id: shoppingList.id,
      itemId: shoppingList.itemId,
      name: shoppingItems.name,
      count: shoppingList.count,
      crossed: shoppingList.crossed,
      createdAt: shoppingList.createdAt,
    })
    .from(shoppingList)
    .innerJoin(shoppingItems, eq(shoppingList.itemId, shoppingItems.id))
    .where(isNull(shoppingList.clearedAt))
    .orderBy(asc(shoppingList.createdAt));
  return rows;
}

export type ShoppingCatalogEntry = {
  id: number;
  name: string;
  useCount: number;
};

/** Structurally the parser's `CatalogEntry`, and still declared here rather
 *  than re-exported, so the row SHAPE this layer serves stays its own
 *  decision.
 *
 *  This type once carried a comment claiming the data layer keeps "zero
 *  dependency on @/lib/voice-parse". That is no longer true and should not be:
 *  the reads below import isSentenceShaped, because a filter that must agree
 *  with the write guard has to BE the write guard. Two hand-kept copies of
 *  "what a sentence looks like" is how they drift, and drift here means
 *  pollution reappears in autocomplete. The dependency is one pure,
 *  import-free predicate — cheap, and the coupling is the feature. */
export type ShoppingCatalogName = {
  id: number;
  name: string;
};

/** Every ELIGIBLE catalog row, id + name only, for the voice parser.
 *
 *  The parser is catalog-first: it can only match against names it has been
 *  handed, so it needs every row it could legitimately match, not a prefix
 *  slice. That is why this is a separate read rather than getShoppingCatalog("")
 *  — the autocomplete's ranked top-8 and the parser's exhaustive vocabulary are
 *  different jobs.
 *
 *  The sentence filter here is belt-and-braces, and deliberately so: the
 *  parser's own buildIndex already skips sentence-shaped rows, so dropping
 *  them here changes no parse. It earns its place by shrinking the payload
 *  and, more importantly, by making the prop honest — `initialCatalog` claims
 *  to be the parser's vocabulary, and a row the parser will always discard was
 *  never part of it.
 *
 *  Cost is the reason this is safe to ship whole: 36 rows today, a few
 *  hundred at worst, id + name only. Single-digit KB on the wire, and it
 *  rides down with the server-rendered page so the mic works on first paint
 *  with no round-trip.
 *
 *  Ordered useCount desc / lastUsedAt desc to mirror getShoppingCatalog, with
 *  id asc as a total tie-break so the payload is byte-stable between renders.
 *  Rank carries no meaning for the parser (it resolves ties on id itself), but
 *  a deterministic order keeps the RSC payload from churning. */
export async function getShoppingCatalogAll(): Promise<ShoppingCatalogName[]> {
  const { db } = await import("@/lib/db");
  const { shoppingItems } = await import("@/lib/schema");
  const rows = await db
    .select({ id: shoppingItems.id, name: shoppingItems.name })
    .from(shoppingItems)
    .orderBy(
      desc(shoppingItems.useCount),
      desc(shoppingItems.lastUsedAt),
      asc(shoppingItems.id),
    );
  return rows.filter((r) => !isSentenceShaped(r.name));
}

/** EVERY catalog row WITH its use count — the "Saved items" manager's read,
 *  and the only place the permanent-delete UI gets its list.
 *
 *  A third read rather than an overload of the two above, because it answers a
 *  third question. The autocomplete asks "what matches this prefix"; the
 *  parser asks "what may I match at all"; the manager asks "what is saved, and
 *  how much do I actually use it". The use count is the whole reason it is
 *  separate: it is the evidence Watson needs to decide whether a row is worth
 *  keeping, and shipping it down with the parser vocabulary on every page load
 *  would be paying for it on every render to use it on almost none.
 *
 *  THIS READ DOES NOT FILTER, AND THAT IS THE POINT.
 *
 *  It used to end `.filter((r) => !isSentenceShaped(r.name))`, copied from the
 *  two reads above, and that one line quietly cancelled the entire feature.
 *  This is the ONLY surface that lists catalog rows, so a row it hides has no
 *  delete path at all: rows 13, 48, 50, 52, 53 and 55 — the six polluted rows
 *  this whole round exists to remove — rendered on Watson's list, sent him to
 *  "Saved items" to forget them, and were not there. Only row 54 appeared, and
 *  only because it SLIPPED the guard. The filter hid exactly the rows it was
 *  meant to help him kill, and left SQL as the only recourse, which is the
 *  original complaint verbatim.
 *
 *  The inversion is a category error about what the predicate is FOR. On the
 *  other two reads it answers "may this row be OFFERED?" — suggestion surfaces,
 *  where a polluted row is the bug. Here the question is "what does Grocery Run
 *  remember?", and a polluted row is not the bug, it is the INVENTORY. The
 *  cleanout surface must show the mess; that is what makes it a cleanout.
 *
 *  Serving these rows cannot resurrect them, either — the property the filter
 *  was reaching for is already held elsewhere. getShoppingCatalog and
 *  getShoppingCatalogAll still filter, so a polluted row can never be suggested
 *  or matched, and can never climb use_count. It can only be listed here, and
 *  deleted.
 *
 *  Same ordering as the autocomplete on purpose: the manager lists rows in the
 *  order autocomplete would offer them, so the junk that has been climbing the
 *  ranking is the junk sitting at the top of the list to be forgotten. */
export async function getSavedItems(): Promise<ShoppingCatalogEntry[]> {
  const { db } = await import("@/lib/db");
  const { shoppingItems } = await import("@/lib/schema");
  const rows = await db
    .select({
      id: shoppingItems.id,
      name: shoppingItems.name,
      useCount: shoppingItems.useCount,
    })
    .from(shoppingItems)
    .orderBy(
      desc(shoppingItems.useCount),
      desc(shoppingItems.lastUsedAt),
      asc(shoppingItems.id),
    );
  return rows;
}

/** How many rows to ask the database for per row we intend to return.
 *
 *  The filter runs in JS, not SQL, so a LIMIT applied before it would return
 *  fewer than `limit` clean rows whenever a polluted row matched the prefix —
 *  which is exactly the case that matters, since polluted rows are the ones
 *  climbing the ranking. Over-fetching a bounded window and slicing after the
 *  filter fixes that without an unbounded query.
 *
 *  The bound is honest about its own failure mode: if more than
 *  (OVERFETCH - 1) x limit matching rows are sentence-shaped, the suggestion
 *  list comes back SHORT. It never comes back polluted. A short list is a
 *  cosmetic loss on a pathological catalog; the ranking and response shape are
 *  untouched either way. With the write guard closing the source and the
 *  manager UI draining the existing rows, that window only ever gets emptier. */
const CATALOG_OVERFETCH = 4;

/** Top matches for the autocomplete. Prefix-aware: matches the start of the
 *  name OR the start of any internal word ("green pep" -> Green Pepper).
 *  Ranked by useCount desc, then most recently used.
 *
 *  CONTRACT: unchanged. Same {id, name, useCount} rows, same ranking, same []
 *  on an empty term, same `limit` ceiling. The only difference visible to a
 *  caller is that sentence-shaped rows are gone — and those were never
 *  suggestions, they were the bug. */
export async function getShoppingCatalog(
  q: string,
  limit = 8,
): Promise<ShoppingCatalogEntry[]> {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const { db } = await import("@/lib/db");
  const { shoppingItems } = await import("@/lib/schema");
  const startPattern = `${term}%`;
  const wordPattern = `% ${term}%`;
  const rows = await db
    .select({
      id: shoppingItems.id,
      name: shoppingItems.name,
      useCount: shoppingItems.useCount,
    })
    .from(shoppingItems)
    .where(
      or(
        sql`LOWER(${shoppingItems.name}) LIKE ${startPattern}`,
        sql`LOWER(${shoppingItems.name}) LIKE ${wordPattern}`,
      )!,
    )
    .orderBy(desc(shoppingItems.useCount), desc(shoppingItems.lastUsedAt))
    .limit(limit * CATALOG_OVERFETCH);
  return rows.filter((r) => !isSentenceShaped(r.name)).slice(0, limit);
}

/* ---------------- Permanent delete ----------------
 * The affordance the list-row X never was, and the user-facing half of this
 * whole round.
 *
 * The X on a list row deletes a shopping_list row. The shopping_items row it
 * points at survives, keeps its use_count, and keeps being offered by
 * autocomplete forever. From Watson's side that IS the pollution problem: he
 * deleted "I wanna get water" from his list and watched it come back as a
 * suggestion the next time he typed "water", with no way to refuse it short of
 * SQL. This is the way to actually get rid of an item.
 */
export type DeletedCatalogItem = {
  id: number;
  name: string;
  /** shopping_list rows removed along with it, active or already cleared. */
  listRowsDeleted: number;
};

/**
 * Permanently delete one shopping_items row and every shopping_list row that
 * references it. Returns null when no such item exists, so the route can 404.
 *
 * CHILDREN FIRST, AND WHY IT HAS TO BE EXPLICIT. There are no foreign keys
 * between these tables (Happy Hour Finance owns the schema and this app never
 * runs DDL), so nothing cascades and nothing stops an orphan. Delete the item
 * alone and the list rows survive pointing at an id that no longer exists —
 * getShoppingList() inner-joins shoppingItems, so those rows would not vanish
 * from the list, they would vanish from the QUERY: invisible in the app,
 * present in the table, and reachable again the instant an unrelated insert
 * reused the id. Hence both deletes, in one call, children first.
 *
 * db.batch() IS the transaction here, not a shortcut around one. The neon-http
 * driver has no interactive transactions at all — drizzle's db.transaction()
 * throws "No transactions support in neon-http driver" on this client — but
 * db.batch() sends the statements to Neon's transaction endpoint as a single
 * atomic unit. Either both deletes land or neither does, which is the property
 * that matters: a half-applied delete is precisely the orphan case above.
 *
 * The 404 is derived from the ITEM delete, not from a prior existence check.
 * A read-then-delete would be two round trips and a race; this is one. The
 * cost is that deleting an unknown id still sweeps any shopping_list rows
 * referencing it before returning null. That is a no-op in every real case
 * (an unknown item has no children) and a repair in the only case it is not
 * (pre-existing orphans), so it is worth the round trip saved.
 */
export async function deleteShoppingCatalogItem(
  id: number,
): Promise<DeletedCatalogItem | null> {
  const { db } = await import("@/lib/db");
  const { shoppingItems, shoppingList } = await import("@/lib/schema");

  const [listRows, itemRows] = await db.batch([
    db
      .delete(shoppingList)
      .where(eq(shoppingList.itemId, id))
      .returning({ id: shoppingList.id }),
    db
      .delete(shoppingItems)
      .where(eq(shoppingItems.id, id))
      .returning({ id: shoppingItems.id, name: shoppingItems.name }),
  ]);

  const item = itemRows[0];
  if (!item) return null;
  return { id: item.id, name: item.name, listRowsDeleted: listRows.length };
}
