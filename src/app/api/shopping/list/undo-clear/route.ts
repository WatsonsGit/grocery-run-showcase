// Undo a previous Clear-Crossed sweep.
//
// POST /api/shopping/list/undo-clear body { ids: number[] }
//   → sets cleared_at = NULL on the given rows so they reappear on the
//     active list. The crossed flag stays as it was (true), which matches
//     the Grocery iOS app's behavior: Undo restores both the row AND its
//     strikethrough state, so Watson can re-clear or un-cross without
//     re-entering the items.
import { isDemo } from "@/lib/data";
import { inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

type Body = { ids?: unknown };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  if (!Array.isArray(body.ids)) {
    return Response.json(
      { ok: false, error: "ids must be an array" },
      { status: 400 },
    );
  }
  const ids = body.ids
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) {
    return Response.json({ ok: true, restored: 0 });
  }

  if (isDemo()) {
    return Response.json({ ok: true, demo: true, restored: ids.length });
  }

  const { db } = await import("@/lib/db");
  const { shoppingList } = await import("@/lib/schema");

  const rows = await db
    .update(shoppingList)
    .set({ clearedAt: null })
    .where(inArray(shoppingList.id, ids))
    .returning({ id: shoppingList.id });

  return Response.json({ ok: true, restored: rows.length, ids: rows.map((r) => r.id) });
}
