"use client";

import { useEffect } from "react";

/**
 * Registers the service worker and nudges it to flush the offline add-queue
 * when the network comes back.
 *
 * Two replay triggers, belt-and-suspenders:
 *   1. Background Sync (`sync` event in sw.js) — fires automatically on
 *      reconnect in Chrome/Android. NOT supported on iOS Safari.
 *   2. `online` event here → postMessage('flush-queue') to the controller —
 *      the iOS-safe fallback, since iPhone is the primary target.
 *
 * Renders nothing.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Hygiene: the home-screen icon launches at `/?k=<token>` to auto-unlock
    // (see src/proxy.ts). The proxy has already set the session cookie by now,
    // so drop the token from the visible URL to keep it out of client-side
    // referrers/logs. The icon still relaunches with it — this is per-session.
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("k")) {
        url.searchParams.delete("k");
        window.history.replaceState(
          window.history.state,
          "",
          url.pathname + url.search + url.hash,
        );
      }
    } catch {
      /* no-op */
    }

    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* Registration can fail in private mode or when SW is disabled.
           The app still works online; only offline queueing is lost. */
      });
    };

    // Register after load so it doesn't compete with first paint.
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    const flush = () => {
      navigator.serviceWorker.controller?.postMessage({ type: "flush-queue" });
    };
    window.addEventListener("online", flush);

    return () => {
      window.removeEventListener("online", flush);
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
