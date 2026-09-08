/* The service worker. Its whole job is installability and an honest offline
   state, and its most important property is what it does NOT cache.

   THE RULE: this dashboard must never show a stale number as though it were
   current. Every figure on it comes from /api/, so /api/ is network-only, full
   stop -- no cache read, no cache write, no stale-while-revalidate. A cached
   inbox count or a cached follower total is exactly the failure this codebase
   keeps having to fix, and a service worker is a very effective way to cause
   it permanently.

   What is cached is the shell: the document, the icons, the manifest, the
   fonts. Things whose content is the app rather than the data.

   The document is NETWORK-FIRST rather than cache-first, and that matters for
   two reasons beyond freshness. The auto-updater restarts the server into new
   code and the page notices via a boot stamp injected into index.html; a cached
   document would carry the old stamp and the page would either never notice or
   notice forever. And the injected auth-mode flag would go stale the same way. */

const VERSION = 'cc-v1';
const SHELL = VERSION + '-shell';

/* Fetched on install so the offline page exists before it is needed. The
   document is deliberately not in here -- it is cached on first visit by the
   fetch handler, with whatever flags the server injected for this session. */
const PRECACHE = [
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icons/icon-64.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png'
];

/* Never touched. Not "cached briefly", not "revalidated" -- absent from the
   cache entirely, so there is no version of this worker that can serve a
   number the server did not just say.

   /connect and /oauth are here for a different reason: they are redirects into
   a provider's consent screen, and a service worker that intercepts them
   breaks the grant in ways that are miserable to debug. */
const NEVER = [/^\/api\//, /^\/connect\//, /^\/oauth\//, /^\/login/, /^\/logout/];

const isNever = url => NEVER.some(re => re.test(url.pathname));

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    /* Individually, not addAll: addAll rejects the whole install if one file
       404s, and an install that fails because of a missing icon leaves the app
       with no worker at all. */
    await Promise.all(PRECACHE.map(u =>
      c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    /* Active immediately. The alternative is a worker that only takes over on
       the second visit, which makes "is it installed yet" unanswerable. */
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    /* Everything from an older VERSION goes. The auto-updater ships new code
       without asking, so old shells must not accumulate. */
    for (const k of await caches.keys()) {
      if (k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

/* A message from the page, so an update can drop the shell without waiting for
   a version bump here. */
self.addEventListener('message', e => {
  if (e.data === 'cc-drop-shell') {
    e.waitUntil(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))));
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  /* Someone else's origin -- fonts, an avatar. Left entirely alone: caching a
     cross-origin opaque response is a way to fill a quota with things that
     cannot be inspected. */
  if (url.origin !== self.location.origin) return;
  if (isNever(url)) return;

  /* The document. Network first; the cache is the offline fallback only. */
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        /* Only a real page. A 302 to /login must not become the cached shell,
           or signing out would leave the login page installed as the app. */
        if (fresh.ok && fresh.type !== 'opaqueredirect') {
          const c = await caches.open(SHELL);
          c.put('/', fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        const cached = await caches.match('/');
        if (cached) return cached;
        return new Response(OFFLINE_HTML, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    })());
    return;
  }

  /* Everything else on this origin: icons, the manifest. Stale-while-
     revalidate, because these change on a deploy and never inside a session,
     and a hairline-fast icon is worth more than a fresh one. */
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(req);
    const spin = fetch(req).then(r => {
      if (r && r.ok) c.put(req, r.clone()).catch(() => {});
      return r;
    }).catch(() => null);
    if (hit) { e.waitUntil(spin); return hit; }
    const fresh = await spin;
    return fresh || new Response('', { status: 504 });
  })());
});

/* Shown only when the document is wanted and there is neither network nor a
   cached shell -- a first visit while offline. Deliberately plain: it must not
   look like the dashboard with nothing in it, because that is the one thing a
   reader could mistake for real. */
const OFFLINE_HTML = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Command Center — offline</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0E1120;
    color:#c9cede;font:15px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;
    padding:24px;text-align:center}
  b{display:block;font-size:19px;color:#eceef3;margin-bottom:8px;font-weight:600}
  p{margin:0 auto;max-width:38ch;color:#7b8296;font-size:13.5px}
  code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#a2a9b8}
</style>
<div>
  <b>Command Center is not reachable</b>
  <p>No cached copy of the dashboard and no connection to the server.
  If you run it locally, it may not be started &mdash; launch it and reload.</p>
  <p style="margin-top:14px"><code id="u"></code></p>
</div>
<script>document.getElementById('u').textContent = location.origin;<\/script>`;
