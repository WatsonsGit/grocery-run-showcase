"use client";

import { useEffect, useState } from "react";

/* iOS Add-to-Home-Screen hint card. Renders once per device (mobile only),
 * dismissable. iOS Safari does NOT show a native install prompt the way
 * Android Chrome does — the user has to tap Share then "Add to Home Screen"
 * themselves, so this card walks them through it.
 *
 * Heuristics for showing:
 *   - On iOS Safari (not Chrome iOS, not in-app browsers)
 *   - NOT already running in standalone (already installed)
 *   - NOT previously dismissed (localStorage flag)
 *   - Below lg (this is a mobile feature only) */

const DISMISS_KEY = "grocery-run:install-hint-dismissed";

function isIOSSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  if (!isIOS) return false;
  /* Chrome on iOS contains "CriOS"; Firefox iOS contains "FxiOS"; in-app
     webviews (Twitter, Instagram, Slack) contain their own UA marker.
     Real Safari is Safari/* WITHOUT CriOS or FxiOS. */
  const isChromeIOS = /CriOS/.test(ua);
  const isFirefoxIOS = /FxiOS/.test(ua);
  const isSafari = /Safari/.test(ua);
  return isSafari && !isChromeIOS && !isFirefoxIOS;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  /* iOS-specific standalone flag + the standard display-mode media query. */
  const iosStandalone =
    "standalone" in navigator &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const matchesStandalone =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || matchesStandalone;
}

export function InstallPrompt() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isIOSSafari()) return;
    if (isStandalone()) return;
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* localStorage blocked (private mode); show anyway. */
    }
    /* Slight delay so it doesn't fight the first paint. */
    const t = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(t);
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* best effort */
    }
  };

  if (!visible) return null;

  return (
    <div className="mx-1 my-6 rounded-2xl border border-hairline bg-paper-deep px-4 py-4 shadow-sm relative">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install hint"
        className="absolute top-2 right-2 p-1.5 text-ink-soft hover:text-ink active:opacity-60"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <div className="brand-label mb-1.5">Install Grocery Run</div>
      <h3 className="font-serif font-bold text-[18px] leading-tight mb-1.5 pr-6">
        Add to your Home Screen for a one-tap launch, sir.
      </h3>
      <p className="text-[13.5px] text-ink-soft leading-relaxed">
        Tap{" "}
        <span className="inline-flex items-center align-middle mx-0.5">
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-ember"
          >
            <path d="M12 3v12M7 8l5-5 5 5" />
            <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
          </svg>
        </span>{" "}
        Share in Safari, scroll, then choose{" "}
        <span className="font-semibold text-ink">Add to Home Screen</span>.
      </p>
    </div>
  );
}
