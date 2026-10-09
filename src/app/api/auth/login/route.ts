import { NextResponse } from "next/server";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTS,
} from "@/lib/auth";

/* POST /api/auth/login — validate the single-user password and set the durable
   session cookie. The client (src/app/login/page.tsx) does the redirect. */

export async function POST(request: Request) {
  const secret = process.env.SESSION_SECRET;
  const expected = process.env.APP_PASSWORD;
  if (!secret || !expected) {
    return NextResponse.json({ error: "auth not configured" }, { status: 500 });
  }

  const { password } = (await request.json().catch(() => ({}))) as {
    password?: string;
  };
  if (!password || password !== expected) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    SESSION_COOKIE,
    await createSessionToken(secret),
    SESSION_COOKIE_OPTS,
  );
  return res;
}
