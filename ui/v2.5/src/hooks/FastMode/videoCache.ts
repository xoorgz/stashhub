// Talks to the feed video cache in sw.js. Whole scenes are pulled ahead there
// and Range requests answered from disk, which is what makes seeking inside a
// cached scene cost nothing.
//
// Only ever an optimisation: if registration fails the feed streams exactly as
// before. Browsers without service workers use pageCache.ts instead.

import {
  pageCacheSupported,
  pageCachedSrc,
  pagePrecache,
  pagePurge,
} from "./pageCache";

let registration: ServiceWorkerRegistration | null = null;
let registering: Promise<ServiceWorkerRegistration | null> | null = null;

function supported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    // Service workers need a secure context; plain http installs would fail
    // noisily on every load.
    (window.isSecureContext ?? false)
  );
}

export function registerVideoCache(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return Promise.resolve(null);
  if (registration) return Promise.resolve(registration);
  if (registering) return registering;

  registering = navigator.serviceWorker
    .register("sw.js")
    .then((reg) => {
      registration = reg;
      return reg;
    })
    .catch(() => null);

  return registering;
}

async function controller(): Promise<ServiceWorker | null> {
  if (!supported()) return null;
  await registerVideoCache();
  try {
    await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
  return navigator.serviceWorker.controller;
}

/** Pull these scenes down in full, and abandon anything else still running.
 *  Passing the list rather than one URL is deliberate: a scene scrolled past
 *  should stop downloading the moment it is no longer wanted. */
export async function precacheVideos(urls: string[]) {
  if (!supported()) {
    if (pageCacheSupported()) pagePrecache(urls);
    return;
  }
  const sw = await controller();
  if (!sw) return;
  sw.postMessage({ type: "precache", urls });
}

/** Local blob URL for src when the page cache holds it. The service worker
 *  serves its copies transparently, so this is null there. */
export function cachedVideoSrc(src: string): string | null {
  return supported() ? null : pageCachedSrc(src);
}

/** Kill switch: empties the cache and stops the worker intercepting. */
export async function purgeVideoCache() {
  await pagePurge();
  const sw = await controller();
  if (sw) sw.postMessage({ type: "purge" });
  if (registration) {
    try {
      await registration.unregister();
    } catch {
      /* ignore */
    }
    registration = null;
    registering = null;
  }
}
