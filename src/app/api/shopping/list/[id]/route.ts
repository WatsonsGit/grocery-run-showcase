// Per-row shopping_list operations.
//
// PATCH  /api/shopping/list/:id body { crossed: boolean }  — toggle strikethrough
// DELETE /api/shopping/list/:id                            — hard delete one row
//
// PATCH is idempotent (same value twice is a no-op). DELETE is the "remove
// this item entirely" affordance; Clear-Crossed handles bulk sweep, this
// handles single-row removal when the item was added by mistake.
import { isDemo } from "@/lib/data";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

type Body = { crossed?: boolean };

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await params;
  const id = parseId(idParam);
  if (id == null) {
    return Response.json({ ok: false, error: "bad id" }, { status: 400 });
  }
  const body = (await request.json().catch(() => ({}))) as Body;
  if (typeof body.crossed !== "boolean") {
    return Response.json(
      { ok: false, error: "crossed must be a boolean" },
      { status: 400 },
    );
  }

  if (isDemo()) {
    return Response.json({ ok: true, demo: true });
  }

  const { db } = await import("@/lib/db");
  const { shoppingList } = await import("@/lib/schema");

  const [row] = await db
    .update(shoppingList)
    .set({ crossed: body.crossed })
    .where(eq(shoppingList.id, id))
    .returning();

  if (!row) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return Response.json({ ok: true, row });
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

  const { db } = await import("@/lib/db");
  const { shoppingList } = await import("@/lib/schema");

  const [row] = await db
    .delete(shoppingList)
    .where(eq(shoppingList.id, id))
    .returning();

  if (!row) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return Response.json({ ok: true, row });
}
