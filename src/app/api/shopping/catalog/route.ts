// The catalog, in three modes.
//
// GET /api/shopping/catalog?q=<prefix>   → AUTOCOMPLETE
//   → {id, name, useCount}[], ranks by useCount desc, then lastUsedAt desc.
//     Matches the start of the name OR the start of any internal word (so
//     "pep" surfaces "Black pepper", "Cayenne pepper", "Green Pepper").
//
// GET /api/shopping/catalog?all=1        → PARSER VOCABULARY
//   → {id, name}[], every eligible row, no prefix filter, no limit. The voice
//     parser is catalog-first: it matches the transcript against the names it
//     holds, so a ranked top-8 is useless to it and a prefix filter is
//     meaningless (it has no prefix, it has an utterance). Small by
//     construction: id + name over 36 rows.
//
// GET /api/shopping/catalog?saved=1      → "SAVED ITEMS" MANAGER
//   → {id, name, useCount}[], EVERY row, ranked like autocomplete. Backs the
//     manager sheet, where each row can be permanently deleted via
//     DELETE /api/shopping/catalog/:id. Carries useCount (which ?all=1 omits)
//     because the count is the evidence Watson needs to judge a row, and omits
//     nothing at all: the manager must show him everything he can forget.
//
// THE FIRST TWO MODES FILTER. THE THIRD MUST NOT.
//
// ?q= and ?all=1 serve only rows that pass the sentence guard — see @/lib/data.
// A polluted row is not a suggestion and not vocabulary; it is something to be
// deleted, which is what the DELETE route is for.
//
// ?saved=1 is that delete route's only doorway, so it serves rows the other two
// refuse. This comment used to claim the manager "omits nothing else" while
// getSavedItems filtered on the same predicate, which made the claim false and
// the feature inert: six of the seven polluted rows were invisible to the only
// UI that could remove them. A row shown here is not being offered, it is being
// offered UP.
//
// The modes are deliberately separate rather than one q-less overload.
// `?q=` with an empty term still returns [] exactly as before — the
// autocomplete depends on that and nothing here changes it.
//
// The client passes q through after the first keystroke; the input has some
// lightweight client-side debounce so we're not hammering the DB on every
// letter. The all-mode is the standalone surface — the page itself gets its
// parser vocabulary as an RSC prop from the server component, so first paint
// costs no round-trip at all. The saved-mode is fetched lazily, only when the
// manager sheet actually opens.
import {
  getShoppingCatalog,
  getShoppingCatalogAll,
  getSavedItems,
} from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);

  const all = url.searchParams.get("all");
  if (all === "1" || all === "true") {
    const items = await getShoppingCatalogAll();
    return Response.json({ items });
  }

  const saved = url.searchParams.get("saved");
  if (saved === "1" || saved === "true") {
    const items = await getSavedItems();
    return Response.json({ items });
  }

  const q = url.searchParams.get("q") ?? "";
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam ?? "8", 10) || 8, 1),
    25,
  );
  const items = await getShoppingCatalog(q, limit);
  return Response.json({ items });
}
