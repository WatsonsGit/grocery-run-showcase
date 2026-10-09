// Permanent delete of one saved item (a shopping_items row).
//
// DELETE /api/shopping/catalog/:id → deletes the catalog row AND every
//   shopping_list row referencing it. Returns the deleted name plus the row
//   counts so the client can say what it did. 404 on an unknown id.
//
// THIS IS NOT /api/shopping/list/:id, AND THE DIFFERENCE IS THE WHOLE POINT.
//
//   DELETE /api/shopping/list/:id     → removes one row from THIS list.
//                                       The saved item survives. Autocomplete
//                                       keeps offering it. Reversible by
//                                       adding it again.
//   DELETE /api/shopping/catalog/:id  → the item is GONE. Off this list, out
//                                       of autocomplete, out of the parser's
//                                       vocabulary, off every past list.
//                                       Irreversible; there is no undo table.
//
// Watson asked for the second one by name ("I want the ability to delete and
// remove items permanently"), because the first one is what let rows like
// "I wanna get water" haunt his autocomplete after he had already deleted them
// from the list. The two ids are not interchangeable either — a shopping_list
// id and a shopping_items id are different numbers from different sequences —
// so the routes are separate rather than one endpoint with a mode flag. A
// wrong flag on a one-way door is not a mistake worth making possible.
//
// Params are a Promise and must be awaited: the Next 16 convention documented
// in node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// route.md ("`params`: a promise that resolves to an object containing the
// dynamic route parameters"), changed in 15.0.0-RC and matching the sibling
// handler at /api/shopping/list/[id]/route.ts.
import { isDemo, deleteShoppingCatalogItem } from "@/lib/data";

export const dynamic = "force-dynamic";

/** Same shape as the sibling list route's parseId, deliberately. */
function parseId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id == null) {
    return Response.json({ ok: false, error: "bad id" }, { status: 400 });
  }

  if (isDemo()) {
    return Response.json({ ok: true, demo: true });
  }

  const deleted = await deleteShoppingCatalogItem(id);
  if (!deleted) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }

  return Response.json({
    ok: true,
    itemId: deleted.id,
    name: deleted.name,
    listRowsDeleted: deleted.listRowsDeleted,
  });
}
