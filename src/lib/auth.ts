/*
 * Session auth for the single-user lock.
 *
 * A stateless, signed session token (HMAC-SHA256) — no DB session table, since
 * this app never runs DDL. The token is `base64url(payload).base64url(sig)`
 * where payload carries only an expiry. It is stored in a first-party,
 * httpOnly cookie so it survives across iOS home-screen PWA launches (unlike
 * the old stateless Basic Auth, which re-prompted every open).
 *
 * Everything here uses only Web Crypto (`crypto.subtle`), `TextEncoder`, and
 * `atob`/`btoa` — all global in BOTH the Node.js runtime (proxy + route
 * handlers) and the Edge runtime — so the same helpers run everywhere.
 */

export const SESSION_COOKIE = "gr_session";

/* ~400 days, the practical maximum: Chrome and Safari both clamp cookie
   lifetime to ~400 days. Keep the token's `exp` and the cookie `maxAge` in
   sync so they expire together. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 400;

export const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  // Allow plain http on localhost so `npm run dev` works; require https in prod.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE,
};

type Payload = { exp: number }; // unix seconds

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 ? 4 - (norm.length % 4) : 0;
  const bin = atob(norm + "=".repeat(pad));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Mint a fresh signed session token that expires in SESSION_MAX_AGE seconds. */
export async function createSessionToken(secret: string): Promise<string> {
  const payload: Payload = {
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
  const data = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(data)),
  );
  return `${data}.${b64urlEncode(sig)}`;
}

/** Verify signature (constant-time via subtle.verify) and expiry. */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      enc.encode(data),
    );
    if (!ok) return false;
    const payload = JSON.parse(dec.decode(b64urlDecode(data))) as Payload;
    return (
      typeof payload.exp === "number" &&
      payload.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

/** Constant-time string compare — used for the `?k` icon token so a match
 *  can't be teased out by response timing. Length check first is fine; the
 *  token length isn't the secret. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
