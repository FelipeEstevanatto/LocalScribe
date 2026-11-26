/*
 * One service worker for three jobs:
 *
 * 1. Add COOP/COEP to same-origin responses so GitHub Pages can run
 *    multi-threaded WASM (the original purpose of this file).
 * 2. Cache the app shell and same-origin assets so the page opens offline
 *    after the first visit. Model weights live in the app's own Cache Storage
 *    bucket, not here.
 * 3. Report request destinations to the page for the privacy receipt. Only the
 *    URL, method, status, and response size are reported. Request bodies are
 *    never read.
 */

const BUILD = new URL(self.location.href).searchParams.get('v') || 'v1';
const APP_CACHE = `localscribe-app-${BUILD}`;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 32 * 1024 * 1024;
const RUNTIME_ASSET = /\.(?:js|mjs|css|wasm|json|woff2?|svg|png|webp|wav|mp3)$/i;
const CACHEABLE_DESTINATIONS = new Set([
  'document',
  'script',
  'style',
  'font',
  'image',
  'manifest',
  'worker',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(['./', './index.html']))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('localscribe-app-') && key !== APP_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isolate(response) {
  if (!response || response.status === 0) return response;

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  // fetch() has already decoded the body; leaving these makes the browser
  // decode it a second time.
  headers.delete('content-encoding');
  headers.delete('content-length');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function describe(request, response) {
  let host = '';
  let sameOrigin = false;
  try {
    const url = new URL(request.url);
    host = url.host;
    sameOrigin = url.origin === self.location.origin;
  } catch {
    return null;
  }

  const length = response?.headers.get('content-length');
  const bytes = length && /^\d+$/.test(length) ? Number(length) : null;

  return {
    type: 'localscribe:request',
    url: request.url,
    host,
    sameOrigin,
    method: request.method,
    status: response?.status ?? 0,
    bytes,
  };
}

function report(request, response) {
  const message = describe(request, response);
  if (!message) return;

  void self.clients
    .matchAll({ includeUncontrolled: true, type: 'window' })
    .then((clients) => {
      for (const client of clients) client.postMessage(message);
    })
    .catch(() => undefined);
}

function shouldCache(request, response) {
  if (!response || !response.ok || response.status === 206) return false;
  if (isHtmlForRuntime(request, response)) return false;
  if (request.headers.has('range')) return false;

  const length = Number(response.headers.get('content-length') ?? 0);
  let path = '';
  try {
    path = new URL(request.url).pathname;
  } catch {
    return false;
  }

  const runtimeAsset = RUNTIME_ASSET.test(path);
  if (length > (runtimeAsset ? MAX_RUNTIME_BYTES : MAX_CACHE_BYTES)) return false;

  return (
    CACHEABLE_DESTINATIONS.has(request.destination) ||
    runtimeAsset ||
    request.destination === ''
  );
}

function isHtmlForRuntime(request, response) {
  const pathname = new URL(request.url).pathname;
  return /\.(?:js|mjs|wasm)$/i.test(pathname) &&
    /text\/html/i.test(response.headers.get('content-type') ?? '');
}

async function cacheResponse(request, responseForCache) {
  try {
    const cache = await caches.open(APP_CACHE);
    await cache.put(request, responseForCache);
  } catch {
    // Quota or an opaque response: offline caching is best effort.
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'localscribe:receipt-ping') {
    event.source?.postMessage({ type: 'localscribe:receipt-ready' });
  }
});

async function cachedNavigation(request) {
  return (
    (await caches.match(request)) ??
    (await caches.match(new URL('index.html', self.registration.scope).href)) ??
    (await caches.match(new URL('./', self.registration.scope).href))
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Cross-origin model downloads use CORS. Pass the response through
  // untouched, but report where it went so the receipt can name the host.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          report(request, response);
          return response;
        })
        .catch(() => {
          report(request, null);
          return Response.error();
        }),
    );
    return;
  }

  if (request.method !== 'GET') {
    report(request, null);
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          report(request, response);

          // A dead host or a proxy error is still a resolved Response. Serve
          // the cached shell instead of a blank 502 page.
          if (!response.ok) {
            const cached = await cachedNavigation(request);
            if (cached) return cached;
            return response;
          }

          if (shouldCache(request, response)) {
            event.waitUntil(cacheResponse(request, isolate(response.clone())));
          }
          return isolate(response);
        })
        .catch(async () => {
          report(request, null);
          const cached = await cachedNavigation(request);
          return cached ?? Response.error();
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached && !isHtmlForRuntime(request, cached)) {
        report(request, cached);
        return cached;
      }

      return fetch(request)
        .then((response) => {
          report(request, response);
          if (isHtmlForRuntime(request, response)) return Response.error();
          if (shouldCache(request, response)) {
            event.waitUntil(cacheResponse(request, isolate(response.clone())));
          }
          return isolate(response);
        })
        .catch(() => Response.error());
    }),
  );
});
