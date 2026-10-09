import { GroceryList } from "@/components/shopping/GroceryList";
import { GreetingLine } from "@/components/shopping/GreetingLine";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { getShoppingList, getShoppingCatalogAll } from "@/lib/data";

// Server-side fetch on every visit so a navigation away and back (or a fresh
// load on another device) picks up the current shared list.
export const dynamic = "force-dynamic";

export default async function Home() {
  // Both reads in parallel — they're independent, so the page waits on the
  // slower one, not the sum. The catalog rides down as a plain {id, name}[]
  // prop (serializable, per the Server/Client Components rules), which is
  // what lets the voice parser match on the FIRST tap of the mic with no
  // fetch. router.refresh() after every add re-runs this, so the parser's
  // vocabulary picks up rows added on Watson's other devices too.
  const [initialItems, initialCatalog] = await Promise.all([
    getShoppingList(),
    getShoppingCatalogAll(),
  ]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-safe-top pb-safe-bottom">
      <header className="pt-8 gr-rise">
        <GreetingLine />
        <h1 className="mt-1.5 font-serif font-bold text-[34px] leading-[1.05]">
          Your Grocery Run.
        </h1>
        <p className="mt-2 text-[13.5px] text-ink-soft">
          Speak it or type it. Tap to cross off. It syncs everywhere.
        </p>
        {/* LPM signature accent rule — ember dash + a gold tick. */}
        <div className="mt-4 flex items-center gap-1.5" aria-hidden="true">
          <span className="h-[3px] w-10 rounded-full bg-ember" />
          <span className="h-[3px] w-1.5 rounded-full bg-gold" />
        </div>
      </header>

      <GroceryList initialItems={initialItems} initialCatalog={initialCatalog} />

      <InstallPrompt />
    </div>
  );
}
