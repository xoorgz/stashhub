// Feed video cache for browsers without service workers, such as every
// third-party browser on iOS. Same rolling window as sw.js, but stored in
// IndexedDB and played through blob URLs the feed asks for by scene URL.

const DB_NAME = "stashhub-feed";
const STORE = "videos";
const MIN_ENTRIES = 14;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 250 * 1024 * 1024;

interface IEntry {
  key: string;
  blob: Blob;
  size: number;
  ts: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
const cachedKeys = new Set<string>();
const objectUrls = new Map<string, string>();
const inflight = new Map<
  string,
  { controller: AbortController; done: Promise<boolean> }
>();
let wanted = new Set<string>();
let maxEntries = MIN_ENTRIES;
let queueGen = 0;
let disabled = false;

export function pageCacheSupported(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

function cacheKey(rawUrl: string): string {
  const u = new URL(rawUrl, window.location.href);
  u.search = "";
  u.hash = "";
  return u.toString();
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE, { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  }).then(async (db) => {
    const keys = await req(
      db.transaction(STORE).objectStore(STORE).getAllKeys()
    );
    keys.forEach((k) => cachedKeys.add(String(k)));
    return db;
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function budget(): Promise<number> {
  try {
    const est = await navigator.storage.estimate();
    const free = (est.quota || 0) - (est.usage || 0);
    if (free > 0) return Math.min(MAX_TOTAL_BYTES, Math.floor(free * 0.2));
  } catch {
    /* estimate unsupported */
  }
  return MAX_TOTAL_BYTES;
}

function revoke(key: string) {
  const url = objectUrls.get(key);
  if (!url) return;
  URL.revokeObjectURL(url);
  objectUrls.delete(key);
}

/** Oldest first, never a scene still wanted. False when the budget is full. */
async function evictIfNeeded(db: IDBDatabase): Promise<boolean> {
  const all = (await req(
    db.transaction(STORE).objectStore(STORE).getAll()
  )) as IEntry[];
  all.sort((a, b) => a.ts - b.ts);
  let total = all.reduce((sum, e) => sum + e.size, 0);
  let count = all.length;
  const cap = await budget();
  for (const e of all) {
    if (total <= cap && count <= maxEntries) break;
    if (wanted.has(e.key)) continue;
    await req(
      db.transaction(STORE, "readwrite").objectStore(STORE).delete(e.key)
    );
    cachedKeys.delete(e.key);
    revoke(e.key);
    total -= e.size;
    count--;
  }
  return total <= cap;
}

/** Blob URL for a stored scene, read back from IndexedDB so it is backed by
 *  disk rather than held in memory. */
async function prepareUrl(db: IDBDatabase, key: string) {
  if (objectUrls.has(key)) return;
  const e = (await req(db.transaction(STORE).objectStore(STORE).get(key))) as
    | IEntry
    | undefined;
  if (!e || objectUrls.has(key)) return;
  objectUrls.set(key, URL.createObjectURL(e.blob));
}

async function download(
  url: string,
  key: string,
  controller: AbortController
): Promise<boolean> {
  const db = await openDb();
  if (!cachedKeys.has(key)) {
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!res.ok) return true;
      const len = parseInt(res.headers.get("content-length") || "0", 10);
      if (len > MAX_ENTRY_BYTES) {
        controller.abort();
        return true;
      }
      const blob = await res.blob();
      const entry: IEntry = { key, blob, size: blob.size, ts: Date.now() };
      await req(
        db.transaction(STORE, "readwrite").objectStore(STORE).put(entry)
      );
      cachedKeys.add(key);
    } catch {
      return true;
    }
  }
  if (wanted.has(key)) await prepareUrl(db, key);
  return evictIfNeeded(db);
}

function precache(url: string): Promise<boolean> {
  if (disabled) return Promise.resolve(false);
  const key = cacheKey(url);
  const running = inflight.get(key);
  if (running) return running.done;

  const controller = new AbortController();
  const done = download(url, key, controller)
    .catch(() => true)
    .finally(() => {
      if (inflight.get(key)?.controller === controller) inflight.delete(key);
    });
  inflight.set(key, { controller, done });
  return done;
}

/** Keep exactly these scenes, downloading one at a time in order. */
export async function pagePrecache(urls: string[]) {
  if (disabled || !pageCacheSupported()) return;
  const keys = urls.map(cacheKey);
  wanted = new Set(keys);
  maxEntries = Math.max(MIN_ENTRIES, urls.length + 4);

  for (const [key, { controller }] of inflight) {
    if (!wanted.has(key)) {
      controller.abort();
      inflight.delete(key);
    }
  }
  // Blob URLs of scenes no longer in play are released; stored data stays
  // until eviction so scrolling back costs a lookup, not a download.
  for (const key of Array.from(objectUrls.keys())) {
    if (!wanted.has(key)) revoke(key);
  }

  const gen = ++queueGen;
  for (const u of urls) {
    if (gen !== queueGen) return;
    if (!(await precache(u))) return;
  }
}

/** Blob URL for a scene already on the device, or null to use the network. */
export function pageCachedSrc(src: string): string | null {
  if (disabled) return null;
  try {
    return objectUrls.get(cacheKey(src)) ?? null;
  } catch {
    return null;
  }
}

export async function pagePurge() {
  disabled = true;
  queueGen++;
  inflight.forEach(({ controller }) => controller.abort());
  inflight.clear();
  Array.from(objectUrls.keys()).forEach(revoke);
  cachedKeys.clear();
  if (!pageCacheSupported()) return;
  try {
    const db = await openDb();
    await req(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
  } catch {
    /* nothing stored */
  }
}
