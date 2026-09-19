// ============================================================
// X GYM Member Portal — Service Worker
// بيخلّي التطبيق يفتح ويشتغل من غير نت:
//  • ملفات التطبيق (HTML/CSS/JS) + الخطوط والأيقونات + مكتبات الـCDN
//    بتتخزن على الموبايل.
//  • صورة العضو بتتخزن أول ما تظهر.
//  • بيانات العضو نفسها (الاشتراك/الحضور/الباركود) بيحفظها script.js
//    على الموبايل بعد كل دخول ناجح.
//
// التحديثات: ملفات الموقع بتتجاب من الإنترنت أولاً، فأي تعديل ترفعه
// بيظهر على طول. الكاش بيتستخدم بس لو مفيش نت أو النت بطيء جدًا.
// ============================================================
const CACHE_NAME = 'xgym-member-v8';
const NETWORK_TIMEOUT = 4000;   // لو النت أبطأ من كده نفتح من الكاش

// ملفات نفس الدومين (لو ملف منهم مش موجود مش هيوقف التثبيت)
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './training-data.js',
  './manifest.json',
  './img1.jpeg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

// مكتبات JS خارجية
const EXTERNAL_SCRIPTS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// أوراق أنماط خارجية — بنخزّن معاها ملفات الخطوط اللي جواها
// (Font Awesome + Cairo + Orbitron) عشان الأيقونات والخط العربي يظهروا أوفلاين
const EXTERNAL_STYLESHEETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&family=Orbitron:wght@700;900&display=swap'
];

async function precacheStylesheet(cache, cssUrl) {
  const res = await fetch(cssUrl);                 // CORS عادي
  if (!res.ok) return;
  const css = await res.clone().text();
  await cache.put(cssUrl, res);

  const fonts = new Set();
  const re = /url\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(css))) {
    const u = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (u.startsWith('data:')) continue;
    try {
      const abs = new URL(u, cssUrl).href;
      if (/\.woff2(\?|#|$)/i.test(abs)) fonts.add(abs);
    } catch (e) { /* تجاهل */ }
  }
  await Promise.all([...fonts].map(async (f) => {
    try {
      const r = await fetch(f);
      if (r.ok) await cache.put(f, r);
    } catch (e) { /* تجاهل */ }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // ملفات التطبيق: نجيبها فعلاً من السيرفر (بدون كاش المتصفح القديم)
      await Promise.all(CORE_ASSETS.map(async (url) => {
        try {
          const res = await fetch(new Request(url, { cache: 'reload' }));
          if (res.ok) await cache.put(url, res);
        } catch (e) { /* ملف مش أساسي للتثبيت */ }
      }));
      await Promise.all([
        ...EXTERNAL_SCRIPTS.map(async (url) => {
          try {
            const res = await fetch(url, { mode: 'no-cors' });
            await cache.put(url, res);
          } catch (e) { /* تجاهل */ }
        }),
        ...EXTERNAL_STYLESHEETS.map((url) => precacheStylesheet(cache, url).catch(() => {}))
      ]);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function fetchWithTimeout(req, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  // no-cache = اسأل السيرفر لو الملف اتغيّر (بيتخطى كاش المتصفح القديم)
  return fetch(req, { cache: 'no-cache', signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// الشبكة أولاً، والكاش لو مفيش نت (ملفات التطبيق)
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetchWithTimeout(req, NETWORK_TIMEOUT);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const home = await cache.match('./index.html');
      if (home) return home;
    }
    return Response.error();
  }
}

// الكاش أولاً (مكتبات/خطوط خارجية وصور العضو)
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreVary: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Supabase: البيانات والدخول تروح للشبكة مباشرة (script.js بيحفظ نسخة منها)،
  // ماعدا صور العضو العامة فبنخزّنها عشان تظهر أوفلاين
  if (url.hostname.endsWith('supabase.co')) {
    if (url.pathname.startsWith('/storage/v1/object/public/')) {
      event.respondWith(cacheFirst(req));
    }
    return;
  }

  // الفيديوهات ويوتيوب/فيميو: مالهاش كاش (كبيرة ومحتاجة نت)
  const isMedia = req.destination === 'video' || req.destination === 'audio' || req.headers.has('range') ||
                  /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i.test(url.pathname) ||
                  /(youtube|youtube-nocookie|ytimg|googlevideo|vimeo|vimeocdn)\./.test(url.hostname);
  if (isMedia) return;

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));   // ملفات التطبيق: دايمًا أحدث نسخة
  } else {
    event.respondWith(cacheFirst(req));     // مكتبات وخطوط خارجية: من الكاش
  }
});