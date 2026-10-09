"use client";

import { Drawer } from "vaul";
import type { ReactNode } from "react";

/* Mobile bottom sheet primitive. Wraps Vaul so a future swap to a maintained
   fork is one-file. Renders lg:hidden by DEFAULT; desktop callers that have
   their own chrome (slide-over, etc.) simply never reach this primitive.

   Behavior:
   - Drag the top handle down to dismiss.
   - Tap the backdrop to dismiss.
   - Tap the optional close X to dismiss.
   - pt-safe-top via Vaul auto-padding; pb-safe-bottom on body container.
   - Body scroll lock + Escape close + focus trap are Vaul-managed.
   - Background page scales down ~2% while sheet is open (native iOS feel). */

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /* When true (default) shows the X close button in the header strip. */
  showClose?: boolean;
  /* Max height as dvh fraction. Default 0.92 (covers most of viewport,
     leaves a 8% peek of the page behind). */
  maxHeight?: number;
  /* Escape hatch from the lg:hidden clamp, for apps with NO desktop chrome to
     fall back to.

     The clamp assumes a responsive app that swaps this sheet for a slide-over
     past lg. Grocery Run is not that app: it is one phone-shaped max-w-2xl
     column at every breakpoint, and it has no wide layout to swap to. Left
     clamped, opening the sheet on a desktop browser would render nothing
     visible while Vaul still locked body scroll — the app would read as
     frozen. So the caller that has no desktop chrome opts out and the sheet IS
     its chrome at every width.

     Default false, so the documented lg:hidden contract holds for anyone who
     does not ask otherwise. */
  allWidths?: boolean;
};

export function MobileSheet({
  open,
  onOpenChange,
  title,
  children,
  showClose = true,
  maxHeight = 0.92,
  allWidths = false,
}: Props) {
  const hide = allWidths ? "" : "lg:hidden";
  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      shouldScaleBackground
    >
      <Drawer.Portal>
        <Drawer.Overlay className={`${hide} fixed inset-0 z-40 bg-ink/40`} />
        <Drawer.Content
          aria-describedby={undefined}
          className={`${hide} fixed inset-x-0 bottom-0 z-50 flex flex-col bg-paper rounded-t-2xl shadow-2xl outline-none focus:outline-none`}
          style={{ maxHeight: `${maxHeight * 100}dvh`, height: `${maxHeight * 100}dvh` }}
        >
          <div className="flex-none relative">
            <Drawer.Handle className="!w-10 !h-1 !bg-hairline !my-2.5" />
            <Drawer.Title className="sr-only">{title}</Drawer.Title>
            {showClose && (
              <Drawer.Close
                aria-label="Close"
                className="absolute right-2 top-1.5 p-1.5 text-ink-soft active:opacity-60"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </Drawer.Close>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
