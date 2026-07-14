// Swiss House — Service Worker
// Sayfa dosyalarını önbelleğe alır, internet olmadan da açılabilmesini sağlar.
// Veri (Firebase/Firestore) zaten IndexedDB ile offline çalışıyor,
// bu SW sadece sayfa dosyalarını (HTML, fontlar) önbelleğe alır.

const CACHE_ADI = 'swisshouse-v3';
const ONBELLEKLENECEKLER = [
  '/swisshouse/resepsiyon.html',
  '/swisshouse/komisyoncu.html',
  '/swisshouse/index.html',
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Jost:wght@400;500;600;700&family=Big+Shoulders+Display:wght@600&display=swap',
];

// Kurulum: dosyaları önbelleğe al
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_ADI).then(cache => {
      return Promise.allSettled(
        ONBELLEKLENECEKLER.map(url => cache.add(url).catch(() => {}))
      );
    })
  );
  self.skipWaiting();
});

// Aktivasyon: eski önbellekleri temizle
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_ADI).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: önce ağdan dene, başarısız olursa önbellekten sun
self.addEventListener('fetch', e => {
  // Firebase ve harici API isteklerini SW'ye dahil etme
  if(e.request.url.includes('firebase') ||
     e.request.url.includes('google.com/recaptcha') ||
     e.request.url.includes('gstatic.com/firebasejs')) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Başarılı cevabı önbelleğe de kaydet (güncelleme için)
        if(response && response.status === 200 && response.type !== 'opaque') {
          const klon = response.clone();
          caches.open(CACHE_ADI).then(cache => cache.put(e.request, klon));
        }
        return response;
      })
      .catch(() => {
        // İnternet yok — önbellekten sun
        return caches.match(e.request).then(cached => {
          if(cached) return cached;
          // Önbellekte de yoksa resepsiyon.html'i sun (SPA fallback)
          if(e.request.destination === 'document') {
            return caches.match('/swisshouse/resepsiyon.html');
          }
        });
      })
  );
});
