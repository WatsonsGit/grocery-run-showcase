/**
 * Resolve hook so `node --test` can import a route handler directly.
 *
 * WHY THIS EXISTS. The write guard's whole claim is that the ROUTE rejects a
 * sentence-shaped name — not that a predicate returns true. Proving that means
 * importing src/app/api/shopping/list/route.ts and calling POST for real. The
 * only thing standing in the way is the `@/*` path alias: it is a tsconfig
 * "paths" entry, which Node knows nothing about, so route.ts's
 * `import { isDemo } from "@/lib/data"` fails resolution under bare Node.
 *
 * Node's own subpath imports (package.json "imports") cannot express it — those
 * keys must start with "#" — so a resolve hook is the mechanism. It maps `@/x`
 * to `<repo>/src/x.ts`, mirroring tsconfig.json's { "@/*": ["./src/*"] }, and
 * defers everything else to the default resolver.
 *
 * This is test infrastructure ONLY. Next resolves the alias itself at build
 * time; nothing in the shipped app loads this file. Kept in sync with
 * tsconfig.json by hand — it is one line, and it fails loudly (a resolution
 * error, not a silent wrong answer) if it ever drifts.
 */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const SRC = pathToFileURL(new URL("../src/", import.meta.url).pathname).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      // ".ts" is explicit because Node's resolver does no extension guessing;
      // every aliased module in this repo is TypeScript.
      return nextResolve(`${SRC}${specifier.slice(2)}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
