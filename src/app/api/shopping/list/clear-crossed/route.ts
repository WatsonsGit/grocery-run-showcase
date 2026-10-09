// Clear every crossed-out row from the active list.
//
// POST /api/shopping/list/clear-crossed
//   → sets cleared_at = now() on every row where crossed = true AND
//     cleared_at IS NULL. Returns the affected ids so the client can plumb
//     them through to /undo-clear if Watson taps Undo.
//
// We do NOT hard-delete. The rows linger in the table with cleared_at set,
// which gives us free "Undo" + a future "history" view if Watson ever wants
// one (out of scope for v1).
import { isDemo } from "@/lib/data";
import { and, eq, isNull, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST() {
  if (isDemo()) {
    return Response.json({ ok: true, demo: true, ids: [] });
  }

  const { db } = await import("@/lib/db");
  const { shoppingList } = await import("@/lib/schema");

  const rows = await db
    .update(shoppingList)
    .set({ clearedAt: sql`now()` })
    .where(
      and(eq(shoppingList.crossed, true), isNull(shoppingList.clearedAt)),
    )
    .returning({ id: shoppingList.id });

  return Response.json({ ok: true, ids: rows.map((r) => r.id) });
}
