/* Feed video cache.
 *
 * Whole fast-mode copies are stored here and Range requests are answered from
 * disk, so seeking inside a cached scene needs no network at all. The page
 * decides what to pull ahead; this worker only stores, serves and evicts.
 *
 * Nothing outside /scene/<id>/stream.fast is intercepted, so a failure here
 * can never take out the rest of the app. Setting the kill switch below and
 * reloading disables it entirely.
 */

const CACHE = "stashhub-feed-v2";

// A rolling window, not an archive. Watching a thousand scenes a week is tens
// of gigabytes; keeping them would fill a phone and wear its flash for no
// gain, since an endless shuffle rarely returns to the same scene. Only what
// is in play needs to be here: what you are watching, what you just left, and
// what is next. The page raises this to fit its lookahead setting.
const MIN_ENTRIES = 14;
let maxEntries = MIN_ENTRIES;

// Scenes the page still wants. Eviction never drops these.
let wanted = new Set();

// Ceiling, lowered further at runtime to a slice of whatever the device
// actually has free.
const MAX_TOTAL_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024;

// A single very long scene should not swallow the whole budget.
const MAX_ENTRY_BYTES = 250 * 1024 * 1024;

/** Never take more than a fifth of what the browser offers, and stay under the
 *  ceiling. Storage pressure gets a page evicted wholesale on iOS, so it is
 *  worth being well clear of the limit. */
async function budget() {
  try {
    const est = await navigator.storage.estimate();
    const free = (est.quota || 0) - (est.usage || 0);
    if (free > 0) {
      return Math.max(0, Math.min(MAX_TOTAL_BYTES_DEFAULT, Math.floor(free * 0.2)));
    }
  } catch (e) {
    /* estimate unsupported, fall through */
  }
  return MAX_TOTAL_BYTES_DEFAULT;
}

const VIDEO_RE = /\/scene\/\d+\/stream\.fast(?:$|[?#])/;

// Prefetches currently running, so a scene scrolled past can be abandoned
// instead of competing with whatever is playing now.
const inflight = new Map();

let disabled = false;

self.addEventListener("install", () => self.skipWaiting());
// Claim clients, and drop caches from earlier versions. Without this a version
// bump strands the old cache, holding up to its full budget of the user's
// storage quota forever.
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("stashhub-feed-") && n !== CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  )
);

/** Cache key without the apikey query, so the same file is not stored twice
 *  under two URLs when the token is refreshed. */
function cacheKey(rawUrl) {
  const u = new URL(rawUrl);
  u.search = "";
  u.hash = "";
  return u.toString();
}

function isVideo(url) {
  return VIDEO_RE.test(url);
}

async function cachedSize(res) {
  const len = res.headers.get("content-length");
  if (len) return parseInt(len, 10) || 0;
  const b = await res.blob();
  return b.size;
}

/** Drop oldest entries until both the count and the byte budget are met.
 *  Cache.keys() preserves insertion order, so the front is the oldest. */
async function evictIfNeeded(cache) {
  const keys = await cache.keys();
  let total = 0;
  const sizes = [];
  for (const req of keys) {
    const res = await cache.match(req);
    if (!res) continue;
    const size = await cachedSize(res);
    sizes.push({ req, size });
    total += size;
  }

  const cap = await budget();
  let count = sizes.length;
  for (const { req, size } of sizes) {
    if (total <= cap && count <= maxEntries) break;
    if (wanted.has(req.url)) continue;
    await cache.delete(req);
    total -= size;
    count--;
  }
  return total <= cap;
}

/** Resolves false once the budget is full, which stops the queue. A scene
 *  already downloading is awaited, not started a second time. */
function precache(url) {
  if (disabled) return Promise.resolve(false);
  const key = cacheKey(url);
  const running = inflight.get(key);
  if (running) return running.done;

  const controller = new AbortController();
  const done = download(url, key, controller).finally(() => {
    if (inflight.get(key)?.controller === controller) inflight.delete(key);
  });
  inflight.set(key, { controller, done });
  return done;
}

async function download(url, key, controller) {
  const cache = await caches.open(CACHE);
  if (await cache.match(key)) return true;
  try {
    // Full file, no Range: one sequential read is what makes later seeks free.
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "same-origin",
    });
    if (!res.ok) return true;

    // Scenes without a fast copy fall back to their original, which can be
    // hundreds of megabytes. Abort rather than just returning, so the body
    // stops arriving instead of streaming out in the background.
    const len = parseInt(res.headers.get("content-length") || "0", 10);
    if (len > MAX_ENTRY_BYTES) {
      controller.abort();
      return true;
    }

    await cache.put(key, res.clone());
    return await evictIfNeeded(cache);
  } catch (e) {
    /* aborted or offline, nothing to do */
    return true;
  }
}

// One download at a time, in queue order, so the scene playing now and the
// next one are never sharing the link with scenes further down.
let queueGen = 0;

async function runQueue(urls) {
  const gen = ++queueGen;
  for (const u of urls) {
    if (gen !== queueGen) return;
    if (!(await precache(u))) return;
  }
}

function cancel(urls) {
  const keep = new Set((urls || []).map(cacheKey));
  for (const [key, { controller }] of inflight) {
    if (!keep.has(key)) {
      controller.abort();
      inflight.delete(key);
    }
  }
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "precache") {
    // Only the ones still wanted keep downloading.
    const urls = data.urls || [];
    wanted = new Set(urls.map(cacheKey));
    maxEntries = Math.max(MIN_ENTRIES, urls.length + 4);
    cancel(urls);
    event.waitUntil(runQueue(urls));
  } else if (data.type === "purge") {
    disabled = true;
    cancel([]);
    event.waitUntil(caches.delete(CACHE));
  }
});

/** Serve a cached file, slicing it for Range requests. Blob.slice is lazy, so
 *  a seek reads only the bytes asked for rather than loading the whole file. */
async function serveFromCache(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey(request.url));
  if (!cached) return fetch(request);

  const blob = await cached.blob();
  const total = blob.size;
  const range = request.headers.get("range");

  if (!range) {
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": cached.headers.get("content-type") || "video/mp4",
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
      },
    });
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return fetch(request);

  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : total - 1;
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= total) end = total - 1;
  if (start > end) return fetch(request);

  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": cached.headers.get("content-type") || "video/mp4",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (event) => {
  if (disabled) return;
  const req = event.request;
  if (req.method !== "GET" || !isVideo(req.url)) return;
  event.respondWith(serveFromCache(req).catch(() => fetch(req)));
});
