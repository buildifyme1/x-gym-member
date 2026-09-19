// ============================================================
// X GYM Member Portal — Service Worker
// بيخزّن شكل التطبيق (HTML/CSS/JS/الأيقونات) عشان الصفحة تفتح
// حتى من غير نت. البيانات الفعلية (تسجيل الدخول، الاشتراك،
// الحضور) بتفضل محتاجة اتصال بالإنترنت لأنها بتيجي من Supabase.
//
// التحديثات: ملفات الموقع نفسه (index.html / style.css / script.js /
// training-data.js ...) بتتجاب من الإنترنت أولاً، فأي تعديل ترفعه
// بيظهر على طول. الكاش بيتستخدم بس لو مفيش نت.
// ============================================================
const CACHE_NAME = 'xgym-member-v7';

// ملفات نفس الدومين (لو ملف منهم مش موجود مش هيوقف التثبيت)
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './training-data.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// مصادر خارجية (أفضل مجهود)
const EXTERNAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&family=Orbitron:wght@700;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // نجيب النسخة الجديدة فعلاً من السيرفر (بدون كاش المتصفح)
      await Promise.all(CORE_ASSETS.map(async (url) => {
        try {
          const res = await fetch(new Request(url, { cache: 'reload' }));
          if (res.ok) await cache.put(url, res);
        } catch (e) { /* تجاهل — الملف ده مش أساسي للتثبيت */ }
      }));
      await Promise.all(EXTERNAL_ASSETS.map(async (url) => {
        try {
          const res = await fetch(url, { mode: 'no-cors' });
          await cache.put(url, res);
        } catch (e) { /* تجاهل */ }
      }));
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
  // no-cache = اسأل السيرفر الأول لو الملف اتغيّر (بيتخطى كاش المتصفح القديم)
  return fetch(req, { cache: 'no-cache', signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// الشبكة أولاً، والكاش لو مفيش نت
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetchWithTimeout(req, 6000);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const home = await cache.match('./index.html');
      if (home) return home;
    }
    return Response.error();
  }
}

// الكاش أولاً (للمكتبات والخطوط الخارجية)
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    cache.put(req, res.clone());
    return res;
  } catch (e) {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.hostname.includes('supabase.co')) return;   // البيانات تروح للشبكة مباشرة

  // الفيديوهات ويوتيوب/فيميو: مالهاش كاش
  const isMedia = req.destination === 'video' || req.destination === 'audio' || req.headers.has('range') ||
                  /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i.test(url.pathname) ||
                  /(youtube|youtube-nocookie|ytimg|googlevideo|vimeo|vimeocdn)\./.test(url.hostname);
  if (isMedia) return;

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));   // ملفات التطبيق: دايمًا أحدث نسخة
  } else {
    event.respondWith(cacheFirst(req));     // مكتبات خارجية: من الكاش
  }
});