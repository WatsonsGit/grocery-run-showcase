import type { MetadataRoute } from "next";

/* PWA manifest for Add-to-Home-Screen installs. Android Chrome reads this for
 * a true PWA install; on iOS 16.4+ Safari DOES read it too (the old "iOS
 * ignores this file" belief is out of date).
 *
 * Deliberately NO `start_url`: the single-user lock bakes a secret token into
 * the home-screen icon's launch URL (`/?k=<APP_TOKEN>`) so a tap auto-unlocks
 * (see src/proxy.ts). On iOS a declared `start_url` OVERRIDES the install-time
 * URL and would strip that `?k` token — so we omit it and let iOS/Chrome fall
 * back to the exact URL the app was added from, token intact.
 *
 * Theme + background = cream paper (#F5EFE6) so the launch screen matches the
 * brand. display: standalone removes the browser chrome when launched from the
 * Home Screen. */

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Grocery Run",
    short_name: "Grocery",
    description:
      "A dead-simple, iPhone-first grocery list. Speak it, type it, cross it off.",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F5EFE6",
    theme_color: "#F5EFE6",
    categories: ["shopping", "productivity", "food"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
