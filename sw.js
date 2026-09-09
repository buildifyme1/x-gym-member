// ============================================================
// X GYM Member Portal — Service Worker
// بيخزّن شكل التطبيق (HTML/CSS/JS/الأيقونات) عشان الصفحة تفتح
// فورًا حتى من غير نت. البيانات الفعلية (تسجيل الدخول، الاشتراك،
// الحضور) بتفضل محتاجة اتصال بالإنترنت لأنها بتيجي من Supabase
// لحظيًا — الكاش هنا بس لواجهة التطبيق نفسها.
// ============================================================
const CACHE_NAME = 'xgym-member-v1';

// ملفات نفس الدومين (أساسية — لازم تتخزن)
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// مصادر خارجية (أفضل مجهود — لو فشل تحميل واحد منها مش بيوقف التثبيت)
const EXTERNAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&family=Orbitron:wght@700;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_ASSETS);
      await Promise.all(EXTERNAL_ASSETS.map(async (url) => {
        try {
          const res = await fetch(url, { mode: 'no-cors' });
          await cache.put(url, res);
        } catch (e) { /* تجاهل — مش أساسي */ }
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

// استراتيجية: كاش أولاً لشكل التطبيق، والشبكة أولاً لأي حاجة تانية
// (زي طلبات Supabase) — عشان البيانات تفضل دايمًا لحظية لما فيه نت
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSupabase = url.hostname.includes('supabase.co');
  if (isSupabase) return; // سيبها تروح للشبكة عادي، من غير تدخل من الكاش

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      }).catch(() => {
        // من غير نت ومفيش كاش — لو طلب صفحة، رجّع الصفحة الرئيسية كبديل
        if (req.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});