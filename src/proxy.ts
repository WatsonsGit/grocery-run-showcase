import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  createSessionToken,
  verifySessionToken,
  timingSafeEqual,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTS,
} from "@/lib/auth";

/* Single-user session gate (Next 16 renamed `middleware` -> `proxy`; runs on
   the Node.js runtime). Three ways in, in priority order:
     1. A valid `gr_session` cookie (the normal case after first unlock).
     2. The `?k=<APP_TOKEN>` icon key baked into the iPhone home-screen launch
        URL — validates, mints the cookie, serves 200 (NO redirect, so iOS and
        the service worker pass the Set-Cookie through cleanly). This is the
        "tap the icon and you're in" path.
     3. Otherwise: 401 for /api/*, redirect to /login (password fallback) for
        page navigations.
   When SESSION_SECRET is unset (local dev), the gate is a no-op and the app is
   open — same "blank = open" contract as the old Basic Auth gate. */

export const config = {
  // Exclude framework + PWA assets so an unauthenticated request for the
  // service worker / manifest / icon is NOT redirected to /login (that would
  // break install + offline caching). /login's own JS/CSS lives under
  // _next/static, already excluded here.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|manifest.webmanifest|icon.svg|icon-192.png|icon-512.png|apple-touch-icon.png|sw.js).*)",
  ],
};

export async function proxy(req: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return NextResponse.next(); // unconfigured => open (local dev)

  const { pathname, searchParams } = req.nextUrl;

  // Always let the login page and auth endpoints through, else you could never
  // get in.
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  // 1) Valid session cookie already present?
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookie && (await verifySessionToken(cookie, secret))) {
    return NextResponse.next();
  }

  // 2) Icon key present? (?k=APP_TOKEN) -> mint cookie, serve 200.
  const appToken = process.env.APP_TOKEN;
  const k = searchParams.get("k");
  if (appToken && k && timingSafeEqual(k, appToken)) {
    const res = NextResponse.next();
    res.cookies.set(
      SESSION_COOKIE,
      await createSessionToken(secret),
      SESSION_COOKIE_OPTS,
    );
    return res;
  }

  // 3) Unauthenticated.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", req.nextUrl);
  return NextResponse.redirect(loginUrl);
}
