import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "Grocery Run — speak it or type it",
  description:
    "A dead-simple, iPhone-first grocery list. Speak it, type it, cross it off. Works in the dead zones of the store.",
  applicationName: "Grocery Run",
  appleWebApp: {
    capable: true,
    title: "Grocery Run",
    /* "default" matches cream paper — iOS renders the status bar text
       dark on the cream background. */
    statusBarStyle: "default",
  },
  formatDetection: {
    /* Stop iOS from auto-linkifying numbers/dates in list items. */
    telephone: false,
    date: false,
    address: false,
    email: false,
  },
  /* iOS home-screen icons must be PNG — Safari ignores SVG icons and falls back
     to a flat gray letter tile. apple-touch-icon.png (opaque 180x180) is what
     iOS actually renders; the SVG + PNGs cover browser tabs and Android. */
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F5EFE6",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-paper text-ink">
        <a href="#gr-main" className="skip-link">
          Skip to content
        </a>
        {/* No sidebar, no tabs, no chat. The list IS the app. */}
        <main id="gr-main" className="min-h-dvh">
          {children}
        </main>
        {/* Registers the service worker + flushes the offline add-queue on
            reconnect. Renders nothing. */}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
