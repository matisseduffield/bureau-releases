// Lets the website open with no signal. The page and pwa.js come from the network
// first, so a release shows straight away; the copies here are for when that
// fails, or takes over WAIT_MS on a weak signal: then the saved copy opens, and
// the network's answer still updates it for next time. A ?v= file never changes,
// so its saved copy answers at once: a saved page always runs the lib.js it was
// saved with, and a new page waits for its own. Anything not named below passes
// straight through, so rates never land here. Registered by pwa.js, never in the
// Android app. Keep lib.js?v= in step with index.html.
const CACHE = 'bureau-2';
const WAIT_MS = 3000;
const at = file => new URL(file, location).href;
const INDEX = at('index.html');
const FILES = ['index.html', 'lib.js?v=5', 'pwa.js', 'fonts/hanken-grotesk-latin.woff2', 'fonts/hanken-grotesk-latin-ext.woff2'].map(at);
// Past the browser's own cache, which could hold a copy older than the network's.
const fresh = key => (key.endsWith('.woff2') ? 'default' : 'reload');

addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(FILES.map(key => new Request(key, { cache: fresh(key) }))))
    .then(() => skipWaiting()));
});

// Only the files named now are kept: an older release's lib.js goes.
addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => caches.open(CACHE))
    .then(cache => cache.keys().then(reqs => Promise.all(reqs.filter(r => !FILES.includes(r.url)).map(r => cache.delete(r)))))
    .then(() => clients.claim()));
});

addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.pathname === '/' ? INDEX : url.href;
  if (!FILES.includes(key)) return;
  const saved = () => caches.match(key).catch(() => undefined);
  const load = () => {
    const network = fetch(key, { cache: fresh(key) });
    // Kept whichever answer the page gets; cloned at once, before the page reads it.
    e.waitUntil(network.then(res => {
      if (!res.ok) return;
      const copy = res.clone();
      return caches.open(CACHE).then(cache => cache.put(key, copy));
    }).catch(() => {}));
    return network;
  };
  // The page asking for a fresh copy (its lib.js didn't match) goes past the saved one.
  if (url.search && request.cache !== 'reload') {
    e.respondWith(saved().then(hit => hit || load()));
    return;
  }
  const network = load();
  e.respondWith(new Promise(resolve => {
    let done = false;
    const answer = res => { if (res && !done) { done = true; resolve(res); } };
    // An error page from the server (GitHub down behind the Worker) is no better than no answer.
    const orSaved = res => saved().then(hit => answer(hit || res));
    network.then(res => (res.ok ? answer(res) : orSaved(res)), () => orSaved(Response.error()));
    // With no saved copy the network gets as long as it needs.
    setTimeout(() => saved().then(answer), WAIT_MS);
  }));
});
