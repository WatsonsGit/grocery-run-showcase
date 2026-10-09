/**
 * Drizzle database client (Neon serverless).
 *
 * Reads DATABASE_URL from the environment (.env.local locally). Never logs
 * the connection string. Pages/API import { db } and query the tables in
 * schema.ts.
 *
 * NOTE: This app SHARES the same Neon database as Happy Hour Finance. It
 * only ever reads/writes the two shopping tables. It NEVER runs migrations
 * or DDL against this database — the tables already exist and hold real data.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/lib/schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.local.example to .env.local and fill it in.",
  );
}

const sql = neon(url);
export const db = drizzle(sql, { schema });
