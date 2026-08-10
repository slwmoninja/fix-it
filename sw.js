// Precaches the app shell and serves it stale-while-revalidate — same
// pattern as HealthScore/sw.js (see that file's header comment for the full
// rationale). Every fetch while online refreshes the cached copy in the
// background for next time, so the cache stays reasonably current on its
// own without needing a manual version bump here whenever a precached file
// changes.
//
// This does NOT fight index.html's own checkForUpdate() (a separate check
// that does a HEAD request with cache:'no-store' + a cache-busting query
// string, comparing etag/last-modified, and force-reloading on a mismatch)
// — that request is excluded below (method!=='GET' is never true for a HEAD
// request's *response handling*, but the same-origin GET branch below still
// always goes straight to the network for the actual navigation reload it
// triggers) so staleness still gets caught and reloaded exactly as before.
//
// manifest.json and the icon files are the one exception: they're served
// network-first instead (fall back to cache only if offline). Android/
// Chrome's installed-PWA (WebAPK) icon-update check reads the manifest
// client-side and only re-fetches an icon when its URL changes (it diffs
// the icons array, not pixel bytes) -- and uninstalling a WebAPK on Android
// does NOT clear this service worker/cache (that data lives in the browser
// profile, not the WebAPK package). So a stale cached manifest here could
// make even a freshly reinstalled icon look stale. See
// scripts/sync_icon_version.py, which stamps manifest.json's (and
// index.html's apple-touch-icon) icon src URLs with a content hash whenever
// the icon files change, so a real icon update always gets a new URL for
// this check to notice.
//
// Every other image FixIt uses (house background, onboarding logo, nav
// icons) is embedded as base64 directly inside index.html, not fetched as a
// separate file, so there's nothing else to precache here.
const CACHE_NAME = 'fixit-shell-v1';
const PRECACHE_URLS = [
  './index.html', './manifest.json',
  './icon-192.png', './icon-512.png'
];

self.addEventListener('install', (e)=>{
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(PRECACHE_URLS)).catch(()=>{}));
});
self.addEventListener('activate', (e)=>{
  e.waitUntil((async ()=>{
    const names = await caches.keys();
    await Promise.all(names.filter(n=>n!==CACHE_NAME).map(n=>caches.delete(n)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e)=>{
  const req = e.request;
  const url = new URL(req.url);
  // Anything that isn't a same-origin GET (checkForUpdate's HEAD ping, the
  // Cloudflare Worker AI call, any other cross-origin request) passes
  // straight through untouched.
  if(req.method!=='GET' || url.origin!==location.origin){
    e.respondWith(fetch(req));
    return;
  }
  if(/\/(manifest\.json|icon-(192|512)\.png)$/.test(url.pathname)){
    // Network-first -- see the top-of-file comment.
    e.respondWith((async ()=>{
      try{
        const res = await fetch(req);
        if(res && res.ok){ const cache = await caches.open(CACHE_NAME); cache.put(req, res.clone()); }
        return res;
      }catch(err){
        const cached = await caches.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async ()=>{
    const cache = await caches.open(CACHE_NAME);
    // A navigation (opening the app fresh, or the reload checkForUpdate
    // triggers) should resolve to the cached shell regardless of the exact
    // URL requested (bare site root vs. an explicit .../index.html).
    const cacheKey = req.mode==='navigate' ? './index.html' : req;
    const cached = await cache.match(cacheKey);
    const networkFetch = fetch(req).then(res=>{
      if(res && res.ok) cache.put(cacheKey, res.clone());
      return res;
    }).catch(()=>null);
    if(cached){ e.waitUntil(networkFetch); return cached; }
    return (await networkFetch) || Response.error();
  })());
});
