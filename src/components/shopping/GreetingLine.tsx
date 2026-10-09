"use client";

import { useSyncExternalStore } from "react";

/* The masthead eyebrow: a time-aware greeting + today's date, in the brand's
 * butler voice. Rendered on the client on purpose — the deploy runs on UTC
 * servers, so a server-rendered "good morning" / date would be wrong for the
 * owner's timezone. We render a reserved-height placeholder until mounted to
 * avoid a hydration mismatch and layout shift. */

const DAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function greetingFor(hour: number): string {
  if (hour < 12) return "Good morning, sir";
  if (hour < 17) return "Good afternoon, sir";
  if (hour < 21) return "Good evening, sir";
  return "Burning the midnight oil, sir";
}

/* The clock, modelled as an external store. `getSnapshot` must return a stable
 * reference across calls or React re-renders forever, so the Date is cached and
 * only replaced when the subscribed tick fires. The server snapshot is null,
 * which is what renders the reserved-height placeholder during SSR. */
let cachedNow: Date | null = null;

function subscribe(onChange: () => void): () => void {
  const id = setInterval(() => {
    cachedNow = new Date();
    onChange();
  }, 60_000);
  return () => clearInterval(id);
}

function getSnapshot(): Date {
  if (cachedNow === null) cachedNow = new Date();
  return cachedNow;
}

function getServerSnapshot(): null {
  return null;
}

export function GreetingLine() {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-h-[18px]">
      {now && (
        <>
          <span className="brand-label">{greetingFor(now.getHours())}</span>
          <span className="text-[12px] text-gray-soft" suppressHydrationWarning>
            {DAYS[now.getDay()]}, {MONTHS[now.getMonth()]} {now.getDate()}
          </span>
        </>
      )}
    </p>
  );
}
