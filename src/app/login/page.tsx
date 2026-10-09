"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

/* Password fallback for the single-user lock. The primary way in is the
 * home-screen icon's `?k` token (see src/proxy.ts), which unlocks with zero
 * typing. This screen is the safety net: laptop access, or if the cookie is
 * ever lost with no token present, so the app never dead-ends. */

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Full navigation so the proxy re-runs WITH the new cookie and the
        // force-dynamic home page renders server-side.
        window.location.assign("/");
        return;
      }
      setError("That's not the password, sir.");
    } catch {
      setError("Something went wrong. Try again.");
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto w-full max-w-sm px-4 pt-safe-top pb-safe-bottom">
      <div className="pt-16">
        <div className="brand-label mb-1">Grocery Run</div>
        <h1 className="font-serif font-bold text-[28px] leading-tight mb-6">
          Welcome back.
        </h1>
        <Card>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label htmlFor="pw" className="text-[13px] text-ink-soft">
              Password
            </label>
            <input
              id="pw"
              type="password"
              name="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-11 px-3 rounded-lg border border-hairline bg-paper text-ink placeholder:text-gray-soft"
            />
            {error && <p className="text-[13px] text-cherry">{error}</p>}
            <Button
              type="submit"
              disabled={busy || !password}
              className="justify-center h-11 disabled:opacity-40"
            >
              {busy ? "Checking…" : "Enter"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
