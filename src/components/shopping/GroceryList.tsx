"use client";

/**
 * GroceryList — the whole app. It IS the page.
 *
 * Modeled on the iPhone "Grocery" app Watson uses. Plain text lines, tap to
 * cross out (red strikethrough), tap again to uncross. The "Clear crossed"
 * affordance only appears when at least one item is crossed; right after a
 * clear, it swaps to "Undo clear" for ten seconds so a stray sweep is
 * recoverable.
 *
 * Three input modes:
 *  - Type into the item input + press Enter (or tap Add) — parsed
 *  - Tap a suggestion in the inline autocomplete (catalog rank) — NOT parsed,
 *    a tapped catalog row is already the exact stored name
 *  - Speak into the mic (Web Speech API) — parsed
 *
 * Parsing lives in @/lib/voice-parse and NOWHERE else. This file used to own
 * splitTranscript() + stripLeadingFraming(), which split on /\band\b/ BEFORE
 * cleaning and carried a verb list that had "want" but not "wanna". That is
 * what turned "I wanna get paper towels and water" into one row named "I
 * wanna get paper towels water" and then wrote it into shopping_items
 * permanently. Both functions are gone. parseUtterance() matches the catalog
 * first and splits only what the catalog declined, so it reuses existing rows
 * instead of minting sentence-shaped ones.
 *
 * The parser's vocabulary is `parseCatalog`: the server-rendered catalog prop
 * merged with every item added in this session, minus anything forgotten in
 * this session, so speaking the same new item twice reuses it the second time
 * and speaking a forgotten one does not resurrect it.
 *
 * ---------------------------------------------------------------------------
 * TWO DELETES, AND THEY ARE NOT THE SAME DELETE
 *
 * This is the single most important thing to keep straight in this file,
 * because both controls are one tap and only one of them is reversible.
 *
 *   X on a list row      "Remove from this list"  -> DELETE /api/shopping/list/:id
 *                        Clears it from today's run. The saved item survives,
 *                        keeps its use count, keeps being suggested. Add it
 *                        again and it is back.
 *
 *   Forget               "Forget permanently"     -> DELETE /api/shopping/catalog/:id
 *                        Destroys the saved item and every list row pointing at
 *                        it. Out of suggestions, out of the mic's vocabulary,
 *                        off past lists. No undo table, no recovery.
 *
 * Watson asked for the second one outright, because the first one is why rows
 * like "I wanna get water" kept coming back as suggestions after he had
 * already deleted them from the list. Forget is offered in exactly two places:
 * the Saved items sheet (the deliberate cleanout) and the autocomplete
 * suggestion row (nuke a bad row the moment it is seen). Both carry a confirm
 * step and both say the word "forever" before doing it; the list-row X says
 * "from this list" and never says "forever". If those labels ever blur, this
 * comment has failed and so has the UI.
 *
 * Optimism + reconciliation:
 *  - All mutations update local state first, then fire the network call.
 *  - On 4xx/5xx we surface a small inline error and roll the row back.
 *  - router.refresh() runs after a successful add so the server-rendered
 *    initial payload stays current on the next navigation.
 *  - The add path can now be REFUSED by the server: POST rejects a
 *    sentence-shaped name with a 400 and a message written for Watson to
 *    read, which the existing rollback surfaces verbatim.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import type { ShoppingListEntry } from "@/lib/data";
import { parseUtterance, type CatalogEntry } from "@/lib/voice-parse";
import { MobileSheet } from "@/components/ui/MobileSheet";

type ListItem = {
  id: number;
  itemId: number;
  name: string;
  count: number | null;
  crossed: boolean;
  createdAt: string; // ISO so it survives client round-trips
};

type CatalogItem = { id: number; name: string; useCount: number };

type ApiAddResponse = {
  ok: boolean;
  item?: {
    id: number;
    itemId: number;
    name: string;
    count: number | null;
    crossed: boolean;
    createdAt: string;
  };
  error?: string;
  /** Set by POST when the name was refused for SHAPE (not for a missing name,
   *  not for a bad count). The only 400 Watson is allowed to overrule, so it is
   *  the only one that gets the "Save it anyway" affordance. Read as a flag,
   *  never as a message match — the copy is copy, this is the contract. */
  sentenceShaped?: boolean;
};

function toListItem(e: ShoppingListEntry): ListItem {
  return {
    id: e.id,
    itemId: e.itemId,
    name: e.name,
    count: e.count,
    crossed: e.crossed,
    createdAt:
      e.createdAt instanceof Date
        ? e.createdAt.toISOString()
        : String(e.createdAt),
  };
}

/* ---- Web Speech API typing (narrow shim, library-free) ---- */
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Client-only flag for "does the browser expose Web Speech?". Read via
 *  useSyncExternalStore so the answer is true on first client paint without
 *  tripping the React 19 "no setState in effect" rule. The subscribe arg is
 *  a no-op because the capability never toggles inside a page session. */
function subscribeNever(): () => void {
  return () => {};
}
function getVoiceSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}
function getVoiceSupportedServer(): boolean {
  return false;
}

export function GroceryList({
  initialItems,
  initialCatalog,
}: {
  initialItems: ShoppingListEntry[];
  /** Every catalog row, id + name, server-rendered. This is the parser's
   *  entire vocabulary — see getShoppingCatalogAll() in @/lib/data. */
  initialCatalog: CatalogEntry[];
}) {
  const router = useRouter();
  const [items, setItems] = useState<ListItem[]>(() =>
    initialItems.map(toListItem),
  );
  const [name, setName] = useState("");
  const [count, setCount] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Autocomplete state. Separate from the parser's catalog on purpose: this
  // is a ranked top-8 slice for the current prefix, that is the full
  // vocabulary. Different jobs, different reads.
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const catalogReqId = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rows the catalog gained during THIS session. Every successful POST comes
  // back with the item's real id + stored name (the upsert either created the
  // row or reused an existing one), so we fold it in here. Without this,
  // saying "arborio rice" twice in one session would parse as novel twice.
  const [sessionCatalog, setSessionCatalog] = useState<CatalogEntry[]>([]);

  // ...and the mirror of it: catalog ids forgotten during THIS session. The
  // server prop `initialCatalog` cannot be mutated and router.refresh() only
  // catches up on the next render pass, so without this a just-forgotten item
  // stays in the parser's vocabulary and the mic quietly re-adds it. Ids, not
  // names, because a forget is keyed on the row.
  const [forgottenIds, setForgottenIds] = useState<number[]>([]);

  // "Saved items" manager sheet. savedItems is null while loading — distinct
  // from [], which means the catalog really is empty.
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedItems, setSavedItems] = useState<CatalogItem[] | null>(null);
  // Which row is mid-confirm. Two states, not one, because the sheet and the
  // suggestion list can both be on screen and a confirm must never jump
  // between them. Forget is irreversible; a stray tap must not be enough.
  const [confirmSavedId, setConfirmSavedId] = useState<number | null>(null);

  // The suggestion-row confirm carries the QUERY it was opened under, and is
  // read back through a derivation rather than reset by an effect.
  //
  // The suggestion list is rebuilt on every keystroke, so a confirm left
  // pending would land on whichever row inherited that slot — a stray tap
  // forgetting the wrong item, which is unrecoverable. Storing the query makes
  // "still the same list" a property of the value instead of a race between a
  // reset effect and the next render. It also satisfies React 19's
  // set-state-in-effect rule for free: there is no effect to write.
  const [confirmSuggestion, setConfirmSuggestion] = useState<{
    id: number;
    q: string;
  } | null>(null);

  // Clear / Undo state. lastCleared is the set of ids the last Clear sweep
  // removed; the Undo button is visible until clearedExpiresAt elapses or a
  // new mutation lands.
  const [lastCleared, setLastCleared] = useState<number[]>([]);
  const [clearedExpiresAt, setClearedExpiresAt] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Voice state.
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const voiceSupported = useSyncExternalStore(
    subscribeNever,
    getVoiceSupported,
    getVoiceSupportedServer,
  );
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Tick once a second while the Undo banner is live so it can self-expire.
  useEffect(() => {
    if (clearedExpiresAt === 0) return;
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [clearedExpiresAt]);

  const undoVisible =
    lastCleared.length > 0 && nowTick < clearedExpiresAt;

  const crossedCount = useMemo(
    () => items.filter((i) => i.crossed).length,
    [items],
  );
  const activeNames = useMemo(
    () => new Set(items.map((i) => i.name.toLowerCase())),
    [items],
  );

  /* --------------------------- parser vocabulary -------------------------
   * The server prop is authoritative and refreshes on every router.refresh()
   * (so rows Watson adds on another device arrive here too); sessionCatalog
   * covers the gap between an add landing and that refresh completing;
   * forgottenIds covers the same gap in the other direction, subtracting rows
   * this session destroyed but that the prop still carries. Union by id, prop
   * first, minus the forgotten.
   *
   * The subtraction is not cosmetic. Forget an item and the row is gone from
   * the database, but `initialCatalog` still holds it until the refresh lands.
   * A parser still holding it would MATCH it on the next utterance and emit
   * its stored name, POST would upsert it straight back, and Watson's forget
   * would have been undone by his own microphone.
   *
   * This is a useMemo, not an effect-synced state, so a new prop needs no
   * setState-in-effect to take hold. The identity is stable between renders,
   * which matters: parseUtterance memoizes its index per catalog array
   * identity — and with nothing added or forgotten yet, this returns the prop
   * array itself, so the common case keeps that cache warm. */
  const parseCatalog = useMemo<CatalogEntry[]>(() => {
    const forgotten = new Set(forgottenIds);
    const base =
      forgotten.size === 0
        ? initialCatalog
        : initialCatalog.filter((c) => !forgotten.has(c.id));
    if (sessionCatalog.length === 0) return base;
    const known = new Set(base.map((c) => c.id));
    const extra = sessionCatalog.filter(
      (c) => !known.has(c.id) && !forgotten.has(c.id),
    );
    return extra.length === 0 ? base : [...base, ...extra];
  }, [initialCatalog, sessionCatalog, forgottenIds]);

  /* The speech recognizer's onresult closure is captured once at start(), so
   * reading parseCatalog directly there would freeze the vocabulary at the
   * moment the mic opened. A ref keeps a long dictation session current. */
  const parseCatalogRef = useRef(parseCatalog);
  useEffect(() => {
    parseCatalogRef.current = parseCatalog;
  }, [parseCatalog]);

  /* ----------------------------- autocomplete ----------------------------
   * The fetch fires after a 120ms debounce so we're not hitting the catalog
   * route on every keystroke. The empty-input case is handled at render
   * time: the suggestions ul only shows when name.trim() is non-empty, so a
   * stale catalog state doesn't leak through. The reqId guard drops late
   * responses if the user kept typing past the in-flight call. */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = name.trim();
    if (!q) return;
    debounceRef.current = setTimeout(() => {
      const reqId = ++catalogReqId.current;
      fetch(`/api/shopping/catalog?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data: { items?: CatalogItem[] }) => {
          if (reqId !== catalogReqId.current) return;
          setCatalog(data.items ?? []);
        })
        .catch(() => {
          if (reqId !== catalogReqId.current) return;
          setCatalog([]);
        });
    }, 120);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [name]);

  /* ---------------------------- saved items load -------------------------
   * Fetched lazily, only when the sheet opens, and re-fetched on every open so
   * a cleanout done on another device shows up. Deliberately NOT derived from
   * `initialCatalog`: that prop is id + name only, and the manager's whole job
   * is to show the use count Watson judges a row by.
   *
   * The effect only FETCHES and only sets state from the async callback — the
   * loading reset lives in openSaved() below, because a synchronous setState
   * in an effect body is a cascading render (and React 19's
   * set-state-in-effect rule rightly refuses it). Opening the sheet is an
   * event, so the event handler is where that state belongs.
   *
   * The `cancelled` flag drops a response that lands after the sheet closed,
   * so a slow fetch cannot repopulate a list that is no longer on screen. */
  useEffect(() => {
    if (!savedOpen) return;
    let cancelled = false;
    fetch("/api/shopping/catalog?saved=1")
      .then((r) => r.json())
      .then((data: { items?: CatalogItem[] }) => {
        if (!cancelled) setSavedItems(data.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setSavedItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [savedOpen]);

  /* Opening the sheet clears the last visit's rows FIRST, so a reopen shows
     "Fetching the pantry, sir." rather than a stale list that a forget on
     another device may already have emptied. */
  function openSaved() {
    setSavedItems(null);
    setConfirmSavedId(null);
    setSavedOpen(true);
  }

  /* -------------------------------- actions ------------------------------ */
  /* The raw add primitive: one name, one row, no interpretation. Every
     caller has already decided what the name is — parsed (voice, typed) or
     picked verbatim (a tapped suggestion). Cleaning text in here is exactly
     the mistake that produced rows 48 and 50; the parser owns that now. */
  /* A name the server refused for SHAPE, parked until Watson says otherwise.
     Null means there is nothing to confirm — which is the state after every
     other kind of failure, so the override can never be offered for a missing
     name or a bad count. */
  const [pendingForce, setPendingForce] = useState<{
    name: string;
    count: number | null;
  } | null>(null);

  const addItem = useCallback(
    async (rawName: string, rawCount?: number | null, force = false) => {
      const trimmed = rawName.trim();
      if (!trimmed) return;
      setError(null);
      setPendingForce(null);
      setLastCleared([]);
      setClearedExpiresAt(0);

      // Optimistic insert with a placeholder negative id we'll replace on
      // the server response.
      const tempId = -Math.floor(Math.random() * 1_000_000_000);
      const optimistic: ListItem = {
        id: tempId,
        itemId: -1,
        name: trimmed,
        count: rawCount ?? null,
        crossed: false,
        createdAt: new Date().toISOString(),
      };
      setItems((prev) => [...prev, optimistic]);

      try {
        const res = await fetch("/api/shopping/list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmed,
            count: rawCount ?? null,
            // Only ever true on the confirm tap below. The parser, the mic and
            // the suggestion path all call addItem without it, so a misparse
            // still bounces off the guard exactly as it did before.
            ...(force ? { force: true } : {}),
          }),
        });
        const data = (await res.json()) as ApiAddResponse;
        if (!res.ok || !data.ok || !data.item) {
          // A shape refusal is the one failure Watson can overrule, so park the
          // name for the confirm. Everything else is a plain error with no
          // affordance — there is nothing to reconsider about a missing name.
          if (data.sentenceShaped) {
            setPendingForce({ name: trimmed, count: rawCount ?? null });
          }
          throw new Error(data.error ?? `add failed (HTTP ${res.status})`);
        }
        const real = data.item;
        setItems((prev) =>
          prev.map((row) =>
            row.id === tempId
              ? {
                  id: real.id,
                  itemId: real.itemId,
                  name: real.name,
                  count: real.count,
                  crossed: real.crossed,
                  createdAt: real.createdAt,
                }
              : row,
          ),
        );
        /* Teach the parser the row we just landed on. real.itemId +
           real.name are the SERVER's truth — whether the upsert created a
           new item or reused an existing one, this is the name the next
           utterance has to match against. Returning `prev` untouched on a
           known id keeps the array identity stable, which keeps the
           parser's index cache warm. */
        setSessionCatalog((prev) =>
          prev.some((c) => c.id === real.itemId)
            ? prev
            : [...prev, { id: real.itemId, name: real.name }],
        );
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "add failed");
        setItems((prev) => prev.filter((row) => row.id !== tempId));
      }
    },
    [router],
  );

  /* The single parse seam. Voice and typed both land here; a tapped
     suggestion deliberately does not.

     `explicitCount` is the qty box, which only the typed path has. When it's
     set it overrides the FIRST parsed item's count and leaves the rest alone
     — the box sits beside the name box and reads as "3 × <that item>", so
     binding it to anything past the first item would be a guess.

     `emptyMessage` is how the two paths differ on failure. Typed input is
     deliberate, so a parse that yields nothing has to say so out loud.
     Dictation is a stream — a chunk of "umm" SHOULD yield nothing, silently,
     so voice passes null.

     THAT SAME FLAG IS WHAT GATES THE OVERRIDE, and the reason is the same.
     The parser refuses to emit a sentence-shaped name, so a real product that
     is shaped like one ("I Can't Believe It's Not Butter") dies HERE, client
     side, before any POST — which is why the server's `force` escape hatch was
     unreachable from the box Watson actually types into until this offered it.
     A typed string is a deliberate act by the one person entitled to overrule
     the guess, so when his input yields nothing we say so AND offer to take him
     at his word. Dictation gets no such offer: `emptyMessage` is null on the
     voice path, so a mic that captured a chat message parks nothing and asks
     nothing. The hatch stays a human act, never an accident. */
  const addFromText = useCallback(
    (text: string, explicitCount: number | null, emptyMessage: string | null) => {
      const parsed = parseUtterance(text, parseCatalogRef.current);
      if (parsed.length === 0) {
        if (emptyMessage) {
          setError(emptyMessage);
          const raw = text.trim();
          if (raw) setPendingForce({ name: raw, count: explicitCount });
        }
        return;
      }
      parsed.forEach((p, i) => {
        void addItem(p.name, i === 0 ? (explicitCount ?? p.count) : p.count);
      });
    },
    [addItem],
  );

  async function toggleCrossed(row: ListItem) {
    const nextCrossed = !row.crossed;
    setItems((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, crossed: nextCrossed } : r)),
    );
    setError(null);
    setLastCleared([]);
    setClearedExpiresAt(0);

    try {
      const res = await fetch(`/api/shopping/list/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crossed: nextCrossed }),
      });
      if (!res.ok) throw new Error(`toggle failed (HTTP ${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "toggle failed");
      setItems((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, crossed: row.crossed } : r)),
      );
    }
  }

  /* Hard-delete one row. Optimistic remove with rollback on failure. */
  async function removeItem(row: ListItem) {
    const snapshot = items;
    setItems((prev) => prev.filter((r) => r.id !== row.id));
    setError(null);
    setLastCleared([]);
    setClearedExpiresAt(0);
    try {
      const res = await fetch(`/api/shopping/list/${row.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`remove failed (HTTP ${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove failed");
      setItems(snapshot);
    }
  }

  /* PERMANENT delete of a saved item. The other one-way door in this file, and
     the only control that destroys a catalog row.
   *
   * Every surface that could hand the item back has to drop it in the same
   * breath, or it returns from whichever one was missed:
   *   items          — list rows pointing at it; the server deletes them too,
   *                    so leaving them here would show rows that no longer
   *                    exist. Matched on itemId, not id: `id` is the
   *                    shopping_list row, `itemId` is the catalog row.
   *   savedItems     — the sheet it was just forgotten from.
   *   catalog        — the live autocomplete slice, or it stays tappable.
   *   sessionCatalog — or the parser re-adds it and POST upserts it back.
   *   forgottenIds   — subtracts it from the server prop until refresh lands.
   *
   * Snapshot-and-restore on failure, matching removeItem's convention. */
  async function forgetItem(item: { id: number; name: string }) {
    const snapshotItems = items;
    const snapshotSaved = savedItems;
    const snapshotCatalog = catalog;
    const snapshotSession = sessionCatalog;

    setError(null);
    setConfirmSavedId(null);
    setConfirmSuggestion(null);
    setLastCleared([]);
    setClearedExpiresAt(0);

    setForgottenIds((prev) =>
      prev.includes(item.id) ? prev : [...prev, item.id],
    );
    setItems((prev) => prev.filter((r) => r.itemId !== item.id));
    setSavedItems((prev) => (prev ? prev.filter((s) => s.id !== item.id) : prev));
    setCatalog((prev) => prev.filter((s) => s.id !== item.id));
    setSessionCatalog((prev) => prev.filter((c) => c.id !== item.id));

    try {
      const res = await fetch(`/api/shopping/catalog/${item.id}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `forget failed (HTTP ${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not forget ${item.name}, sir. ${e.message}`
          : `Could not forget ${item.name}, sir.`,
      );
      setForgottenIds((prev) => prev.filter((x) => x !== item.id));
      setItems(snapshotItems);
      setSavedItems(snapshotSaved);
      setCatalog(snapshotCatalog);
      setSessionCatalog(snapshotSession);
    }
  }

  async function clearCrossed() {
    if (crossedCount === 0) return;
    setError(null);
    const snapshot = items;
    const survivors = items.filter((i) => !i.crossed);
    setItems(survivors);

    try {
      const res = await fetch("/api/shopping/list/clear-crossed", {
        method: "POST",
      });
      const data = (await res.json()) as { ok: boolean; ids?: number[] };
      if (!res.ok || !data.ok) throw new Error("clear failed");
      const ids = data.ids ?? [];
      setLastCleared(ids);
      setClearedExpiresAt(Date.now() + 10_000);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "clear failed");
      setItems(snapshot);
    }
  }

  async function undoClear() {
    if (lastCleared.length === 0) return;
    const ids = lastCleared;
    setError(null);
    try {
      const res = await fetch("/api/shopping/list/undo-clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error(`undo failed (HTTP ${res.status})`);
      setLastCleared([]);
      setClearedExpiresAt(0);
      // After undo, we need the server truth for the restored rows (their
      // createdAt + names). router.refresh() rebuilds the page; the parent
      // server component re-fetches getShoppingList() and feeds us fresh
      // initialItems on next navigation. For the current view, refetch the
      // list directly so the rows reappear immediately.
      const listRes = await fetch("/api/shopping/list");
      const listData = (await listRes.json()) as { items?: ListItem[] };
      if (listData.items) setItems(listData.items);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "undo failed");
    }
  }

  /* --------------------------------- form -------------------------------- */
  /* Typing "milk" + Enter still adds milk — it just resolves to the catalog's
     stored "Milk" (id 1) on the way, which is what the server's lower(name)
     upsert was always going to do anyway. A deliberate novel item is
     untouched: "arborio rice" matches nothing, so it lands as itself with
     framing stripped. The win is that phone-keyboard dictation into this box
     gets the same cleanup the mic gets. */
  const submitTyped = useCallback(() => {
    const c = count.trim() === "" ? null : Number(count);
    addFromText(name, c, "Nothing to add from that, sir.");
    setName("");
    setCount("");
  }, [addFromText, name, count]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submitTyped();
  }

  function onItemKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitTyped();
    }
  }

  /* --------------------------------- voice ------------------------------- */
  const stopListening = useCallback(() => {
    const r = recognitionRef.current;
    if (r) {
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    }
    recognitionRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  function startListening() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const t = result[0].transcript;
        if (result.isFinal) finalText += t + " ";
        else interimText += t;
      }
      if (finalText) {
        /* One parse per FINALIZED chunk. The parser handles the splitting
           itself — catalog matches first, conjunctions only where the
           catalog declined — so "paper towels and water" comes back as two
           items and "lavender and mint smell good" comes back as one. */
        addFromText(finalText, null, null);
        setInterim("");
      } else {
        setInterim(interimText);
      }
    };
    r.onerror = () => {
      stopListening();
    };
    r.onend = () => {
      // Auto-stop if the browser drops the session.
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };
    recognitionRef.current = r;
    setListening(true);
    setError(null);
    try {
      r.start();
    } catch (e) {
      stopListening();
      setError(e instanceof Error ? e.message : "voice failed to start");
    }
  }

  function toggleVoice() {
    if (listening) stopListening();
    else startListening();
  }

  // Stop listening on unmount so a navigated-away mic stays off.
  useEffect(() => () => stopListening(), [stopListening]);

  /* ------------------------------- render -------------------------------- */
  // Gate the suggestion list on a non-empty input so a stale catalog from a
  // previous query doesn't linger after Watson clears the field.
  const suggestions = name.trim() ? catalog.slice(0, 8) : [];

  /* A pending forget-confirm survives only as long as the query it was opened
     under. One keystroke and it is gone — see setConfirmSuggestion above. */
  const confirmSuggestionId =
    confirmSuggestion && confirmSuggestion.q === name.trim()
      ? confirmSuggestion.id
      : null;

  return (
    <section className="mt-8 gr-rise-delay">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-serif font-bold text-[26px] leading-tight">
          Grocery list
        </h2>
        <div className="flex items-center gap-3 text-[12.5px]">
          {undoVisible ? (
            <button
              type="button"
              onClick={undoClear}
              className="text-ember font-semibold hover:underline"
            >
              Undo clear
            </button>
          ) : crossedCount > 0 ? (
            <button
              type="button"
              onClick={clearCrossed}
              className="font-semibold px-3 py-1.5 rounded-lg text-ember border border-ember/40 hover:bg-ember/5 transition-colors"
            >
              Clear {crossedCount} crossed
            </button>
          ) : items.length > 0 ? (
            <span className="font-mono text-[12px] text-gray-soft tabular-nums">
              {items.length} to get
            </span>
          ) : null}
          {/* The way in to the cleanout. Always present — the junk rows are
              most annoying exactly when the list is empty and autocomplete is
              all Watson sees. */}
          <button
            type="button"
            onClick={openSaved}
            className="font-semibold text-ink-soft hover:text-ember transition-colors"
          >
            Saved items
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 text-[13px] text-cherry font-semibold">
          {error}
          {/* The override, offered ONLY on a shape refusal. This is the seam
              that lets the guard stay strict: a predicate cannot know that "I
              Can't Believe It's Not Butter" is a real product, and Watson can.
              It is a second deliberate tap on a row that was already refused
              and rolled back, so nothing a misparse does can reach it. */}
          {pendingForce && (
            <button
              type="button"
              onClick={() => {
                const { name, count } = pendingForce;
                setPendingForce(null);
                void addItem(name, count, true);
              }}
              className="ml-2 underline font-semibold text-ink-soft hover:text-ember transition-colors"
            >
              Save {'"'}{pendingForce.name}{'"'} anyway
            </button>
          )}
        </div>
      )}

      <form onSubmit={onSubmit} className="flex items-center gap-2">
        {voiceSupported && (
          <button
            type="button"
            onClick={toggleVoice}
            aria-label={listening ? "Stop listening" : "Start voice input"}
            aria-pressed={listening}
            /* Idle reads as an outline affordance; listening reads as a
               pressed toggle — filled ember, paper glyph. The FILL and the
               GLYPH carry the state, not the animation: a pulsing mic is
               still a mic, and "tap the mic again" is not a thing anyone
               guesses. A stop square is. */
            className={`relative w-10 h-10 flex-none rounded-lg border flex items-center justify-center transition-colors ${
              listening
                ? "border-ember bg-ember text-paper"
                : "border-ember text-ember hover:bg-ember/5"
            }`}
          >
            {listening && (
              /* Soft radar pulse. Purely decorative, so it's hidden outright
                 under prefers-reduced-motion — the fill and the square still
                 say "live" without it. */
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-lg border border-ember opacity-70 animate-ping motion-reduce:hidden"
              />
            )}
            {listening ? (
              /* Stop: solid rounded square. */
              <svg viewBox="0 0 24 24" fill="currentColor" className="relative w-5 h-5">
                <rect x="7" y="7" width="10" height="10" rx="2.5" />
              </svg>
            ) : (
              /* Mic. */
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="relative w-5 h-5">
                <rect x="9" y="3" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <path d="M12 18v3" />
              </svg>
            )}
          </button>
        )}
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={count}
          onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="qty"
          aria-label="Count"
          className="w-[52px] h-10 px-2 rounded-lg border border-hairline bg-paper text-ink text-[13px] font-mono placeholder:text-gray-soft text-center"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onItemKey}
          placeholder="Type the item, or speak it"
          aria-label="Item name"
          autoComplete="off"
          className="flex-1 min-w-0 h-10 px-3 rounded-lg border border-hairline bg-paper text-ink text-[14px] placeholder:text-gray-soft"
        />
        <button
          type="submit"
          aria-label="Add item"
          disabled={!name.trim()}
          className="h-10 px-4 flex-none rounded-lg bg-ember text-paper font-semibold text-[14px] tracking-wide hover:bg-ember-soft active:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Add
        </button>
      </form>

      {/* Live caption. The instruction is the point — it names the exit, so
          the ember square above is legible as a toggle rather than a mystery.
          Interim words trail in ink-soft as proof the mic is hearing. */}
      {listening && (
        <p className="mt-2 text-[12.5px] font-serif italic text-ember">
          Listening. Tap to stop.
          {interim && <span className="text-ink-soft"> {interim}</span>}
        </p>
      )}

      {suggestions.length > 0 && (
        <ul className="mt-3 border border-hairline rounded-lg overflow-hidden bg-paper-deep/60">
          {suggestions.map((sug) => {
            const dupe = activeNames.has(sug.name.toLowerCase());
            const confirming = confirmSuggestionId === sug.id;
            return (
              <li
                key={sug.id}
                className="flex items-center border-b border-hairline last:border-0"
              >
                <button
                  type="button"
                  disabled={dupe}
                  onClick={() => {
                    void addItem(sug.name);
                    setName("");
                    setCount("");
                  }}
                  className={`flex-1 min-w-0 text-left px-3 py-2 text-[14px] ${
                    dupe
                      ? "text-gray-soft cursor-not-allowed"
                      : "text-ink hover:bg-ember/5"
                  }`}
                >
                  {sug.name}
                  {dupe && (
                    <span className="ml-2 text-[11px] tracking-[0.06em] uppercase text-gray-soft">
                      already on list
                    </span>
                  )}
                </button>
                {/* Forget, right where the bad row is seen. This is the
                    control that would have saved Watson from "I wanna get
                    water": the moment a junk suggestion appears, it can be
                    destroyed instead of merely ignored — ignoring it is what
                    let it climb the ranking in the first place. Two taps, and
                    the second one says "forever". */}
                {confirming ? (
                  <span className="flex-none flex items-center gap-1 pr-1.5">
                    <button
                      type="button"
                      onClick={() => void forgetItem(sug)}
                      aria-label={`Confirm: permanently forget ${sug.name}`}
                      className="px-2 py-1 rounded-md bg-cherry text-paper text-[10.5px] font-semibold uppercase tracking-[0.06em]"
                    >
                      Forever
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmSuggestion(null)}
                      aria-label="Cancel"
                      className="px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-soft"
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmSuggestion({ id: sug.id, q: name.trim() })}
                    aria-label={`Forget ${sug.name} permanently — deletes it from saved items, not just this list`}
                    className="flex-none mr-1.5 px-2 py-1 rounded-md text-[10.5px] font-semibold uppercase tracking-[0.06em] text-gray-soft hover:text-cherry transition-colors"
                  >
                    Forget
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6">
        {items.length === 0 ? (
          <p className="font-serif italic text-[15px] text-ink-soft">
            Empty list. Speak it or type it, sir.
          </p>
        ) : (
          <ul className="divide-y divide-hairline border-y border-hairline">
            {items.map((row) => (
              <li key={row.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => toggleCrossed(row)}
                  aria-pressed={row.crossed}
                  className="group flex-1 min-w-0 text-left flex items-center gap-3 px-1 py-3 text-[15px]"
                >
                  {/* Tap target for crossing off — fills ember with a cream
                      check when done, which makes the sweep feel satisfying. */}
                  <span
                    aria-hidden="true"
                    className={`grid place-items-center w-[22px] h-[22px] shrink-0 rounded-full border-2 transition-colors ${
                      row.crossed
                        ? "bg-ember border-ember text-paper"
                        : "border-hairline text-transparent group-hover:border-ember"
                    }`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="13"
                      height="13"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                  {row.count != null && row.count > 1 && (
                    <span className="font-mono text-[12.5px] text-ink-soft w-8 shrink-0">
                      {row.count} ×
                    </span>
                  )}
                  <span
                    className={`min-w-0 flex-1 transition-colors ${
                      row.crossed
                        ? "text-ink-soft line-through decoration-cherry decoration-2"
                        : "text-ink group-hover:text-ember"
                    }`}
                  >
                    {row.name}
                  </span>
                </button>
                {/* Removes the row from THIS list only. The saved item lives
                    on and stays suggestible — that is the difference from
                    Forget, and the label has to carry it, because the two
                    controls look alike and only one is a one-way door. */}
                <button
                  type="button"
                  onClick={() => removeItem(row)}
                  aria-label={`Remove ${row.name} from this list — the saved item is kept`}
                  title={`Remove ${row.name} from this list`}
                  className="flex-none p-2.5 -mr-1.5 text-gray-soft hover:text-cherry active:opacity-60 transition-colors"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --------------------------- Saved items ---------------------------
          The cleanout. Vaul via MobileSheet rather than a bespoke modal, and
          `allWidths` because this app has no desktop layout to fall back to.

          Ordered exactly like autocomplete (use count desc), which is the
          point rather than a convenience: the rows that have been climbing
          Watson's suggestions are the rows sitting at the top of the list he
          can forget. */}
      <MobileSheet
        open={savedOpen}
        onOpenChange={setSavedOpen}
        title="Saved items"
        allWidths
      >
        {/* max-w-2xl mx-auto mirrors the page's own column, so the sheet reads
            as the same document at every width instead of a full-bleed slab of
            text on a desktop monitor. */}
        <div className="flex-none w-full max-w-2xl mx-auto px-4 pb-3">
          <h3 className="font-serif font-bold text-[24px] leading-tight">
            Saved items
          </h3>
          {/* Every gap around an inline <span> is an explicit {" "}: JSX's
              whitespace trimming ate the one after "Forget" and shipped
              "Forgetdeletes it for good" to the DOM. */}
          <p className="mt-1.5 text-[12.5px] text-ink-soft leading-relaxed">
            Everything Grocery Run remembers, sir, and what it suggests from.
            The <span className="font-semibold text-ink">×</span> on your list
            only clears an item from this run.{" "}
            <span className="font-semibold text-cherry">Forget</span>{" "}
            deletes it for good: off this list, out of suggestions, out of the
            mic&apos;s vocabulary. There is no undo.
          </p>
        </div>
        <div className="flex-1 min-h-0 w-full max-w-2xl mx-auto overflow-y-auto px-4 pb-safe-bottom">
          {savedItems === null ? (
            <p className="py-6 font-serif italic text-[15px] text-ink-soft">
              Fetching the pantry, sir.
            </p>
          ) : savedItems.length === 0 ? (
            <p className="py-6 font-serif italic text-[15px] text-ink-soft">
              Nothing saved yet, sir.
            </p>
          ) : (
            <ul className="border-t border-hairline">
              {savedItems.map((s) => {
                const confirming = confirmSavedId === s.id;
                return (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 py-2.5 border-b border-hairline"
                  >
                    <span className="flex-1 min-w-0 truncate text-[15px] text-ink">
                      {s.name}
                    </span>
                    {confirming ? (
                      <span className="flex-none flex items-center gap-1.5">
                        <span className="text-[11px] font-serif italic text-cherry">
                          Forever?
                        </span>
                        <button
                          type="button"
                          onClick={() => void forgetItem(s)}
                          aria-label={`Confirm: permanently forget ${s.name}`}
                          className="px-2.5 py-1 rounded-md bg-cherry text-paper text-[10.5px] font-semibold uppercase tracking-[0.06em] active:opacity-80"
                        >
                          Forget
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmSavedId(null)}
                          className="px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-soft"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <>
                        <span
                          className="flex-none font-mono text-[11.5px] text-gray-soft tabular-nums"
                          title={`Added ${s.useCount} time${s.useCount === 1 ? "" : "s"}`}
                        >
                          {s.useCount}×
                        </span>
                        <button
                          type="button"
                          onClick={() => setConfirmSavedId(s.id)}
                          aria-label={`Forget ${s.name} permanently`}
                          className="flex-none px-2 py-1 rounded-md border border-hairline text-[10.5px] font-semibold uppercase tracking-[0.06em] text-gray-soft hover:text-cherry hover:border-cherry/40 transition-colors"
                        >
                          Forget
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </MobileSheet>
    </section>
  );
}
