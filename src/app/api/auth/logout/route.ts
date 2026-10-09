import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/* POST /api/auth/logout — clear the session cookie. Ready for a future "log
   out" control; no UI is wired to it yet. Note: on the iPhone, the icon still
   carries the `?k` token, so a fresh tap will re-unlock. To fully revoke,
   rotate SESSION_SECRET (invalidates all cookies) and/or APP_TOKEN. */

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
