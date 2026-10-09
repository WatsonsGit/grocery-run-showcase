/* eslint-disable */
/*
 * Grocery Run service worker.
 *
 * Three jobs:
 *  1. Precache the app shell so the page opens with no signal.
 *  2. Network-first for /api/* (always try the live DB; fall back when offline).
 *  3. Queue a failed "add item" POST in IndexedDB and replay it when the phone
 *     reconnects — so adding milk in a dead-zone aisle never loses the item.
 *
 * Replay fires two ways: the Background Sync `sync` event (Chrome/Android) and
 * a `flush-queue` message the page posts on the `online` event (iOS-safe).
 */

const SHELL_CACHE = "grocery-run-shell-v1";
const SHELL_URLS = ["/", "/manifest.webmanifest", "/icon.svg"];
const ADD_ENDPOINT = "/api/shopping/list";
const SYNC_TAG = "grocery-run-queue";

/* ----------------------------- tiny IndexedDB ---------------------------- */
const DB_NAME = "grocery-run";
const STORE = "queued-requests";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbAdd(value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------ install/activate ------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/* -------------------------------- fetch ---------------------------------- */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle our own origin.
  if (url.origin !== self.location.origin) return;

  // Offline-resilient add: queue the POST if the network is down.
  if (request.method === "POST" && url.pathname === ADD_ENDPOINT) {
    event.respondWith(addWithQueue(request));
    return;
  }

  // Only GETs are cacheable below; let other mutations pass straight through.
  if (request.method !== "GET") return;

  // Network-first for API reads.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Navigations: network-first, fall back to the cached shell so the app
  // opens offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/", { ignoreSearch: true }).then(
          (r) => r || new Response("Offline", { status: 503 }),
        ),
      ),
    );
    return;
  }

  // Static assets (fonts, _next/static, icon): stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});

function networkFirst(request) {
  return fetch(request)
    .then((res) => {
      const copy = res.clone();
      caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      return res;
    })
    .catch(() => caches.match(request).then((r) => r || Response.json({ items: [] })));
}

function staleWhileRevalidate(request) {
  return caches.open(SHELL_CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          cache.put(request, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
}

/* ---------------------------- offline add-queue -------------------------- */
async function addWithQueue(request) {
  // Read the body once, up front, so we can both forward it and (on failure)
  // stash it for replay.
  const bodyText = await request.clone().text();

  try {
    return await fetch(
      new Request(request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyText,
      }),
    );
  } catch {
    // Offline: stash for replay and hand the client a synthetic success so the
    // optimistic row stays on screen. A negative id keeps it distinct from
    // real rows; the next successful sync + refresh replaces it with DB truth.
    await idbAdd({ url: request.url, body: bodyText }).catch(() => {});
    if ("sync" in self.registration) {
      self.registration.sync.register(SYNC_TAG).catch(() => {});
    }

    let name = "item";
    let count = null;
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed.name === "string") name = parsed.name;
      if (parsed && parsed.count != null) count = parsed.count;
    } catch {}

    return Response.json({
      ok: true,
      queued: true,
      item: {
        id: -Date.now(),
        itemId: -1,
        name,
        count,
        crossed: false,
        createdAt: new Date().toISOString(),
      },
    });
  }
}

async function flushQueue() {
  const queued = await idbGetAll().catch(() => []);
  for (const entry of queued) {
    try {
      const res = await fetch(
        new Request(entry.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: entry.body,
        }),
      );
      if (res.ok) {
        await idbDelete(entry.id).catch(() => {});
      } else {
        // Server rejected it (not a network problem); drop it so it can't
        // wedge the queue forever.
        await idbDelete(entry.id).catch(() => {});
      }
    } catch {
      // Still offline. Stop; a later trigger retries the rest.
      break;
    }
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) event.waitUntil(flushQueue());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "flush-queue") {
    event.waitUntil(flushQueue());
  }
});
