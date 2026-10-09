/**
 * Drizzle schema — the two shopping tables, re-declared for TYPE SAFETY ONLY.
 *
 * These tables already exist in the shared Neon database (created by Happy
 * Hour Finance). This app never migrates them; it only queries them. The
 * shapes below mirror Happy Hour's schema.ts exactly so the query builder
 * stays honest.
 *
 * Notes:
 * - NUMERIC columns infer as `string` in Drizzle (precision-safe). Not used
 *   by either shopping table today, but the convention holds.
 * - `normalizedName` is UNIQUE so the add-item upsert path stays clean.
 *
 * shopping_items: one row per unique grocery (normalized lowercase). On every
 * add we bump useCount + lastUsedAt so autocomplete ranks "what you reach for
 * most" first.
 *
 * shopping_list: one row per entry on the active list. crossed=true means it
 * was tapped (red strikethrough). clearedAt=NULL means "still on the visible
 * list"; setting clearedAt to now() hides the row without deleting it, which
 * powers the 10-second Undo.
 */
import {
  pgTable,
  bigserial,
  bigint,
  text,
  boolean,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import type { InferSelectModel } from "drizzle-orm";

export const shoppingItems = pgTable("shopping_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().unique(),
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const shoppingList = pgTable("shopping_list", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  itemId: bigint("item_id", { mode: "number" }).notNull(),
  count: integer("count"), // NULL = 1
  crossed: boolean("crossed").notNull().default(false),
  clearedAt: timestamp("cleared_at", { withTimezone: true }), // NULL = active
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ShoppingItemRow = InferSelectModel<typeof shoppingItems>;
export type ShoppingListRow = InferSelectModel<typeof shoppingList>;
