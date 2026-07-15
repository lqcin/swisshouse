// Swiss House — Service Worker
// Sayfa dosyalarını önbelleğe alır, internet olmadan da açılabilmesini sağlar.
// Veri (Firebase/Firestore) zaten IndexedDB ile offline çalışıyor,
// bu SW sadece sayfa dosyalarını (HTML, fontlar) önbelleğe alır.

const CACHE_ADI = 'swisshouse-v5'; // sürüm artırıldı — cihazlardaki eski/yarım önbellek otomatik temizlenir
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
  // ÖNEMLİ DÜZELTME: Cache API sadece GET isteklerini destekler. Firestore'un arka planda
  // attığı POST/streaming istekleri (firestore.googleapis.com, identitytoolkit.googleapis.com vb.)
  // buraya kadar geliyordu ve cache.put() bunlarla çağrılınca "Request method 'POST' is
  // unsupported" hatası fırlatıyordu. Artık GET olmayan hiçbir istek işlenmiyor.
  if(e.request.method !== 'GET') return;

  // Firebase/Google API isteklerini SW'ye hiç dahil etme (ne önbellekle ne yedekle).
  // 'firebase' substring kontrolü firestore.googleapis.com gibi adresleri YAKALAMIYORDU —
  // bu yüzden googleapis.com genel kontrolü eklendi.
  if(e.request.url.includes('firebase') ||
     e.request.url.includes('googleapis.com') ||
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
      .catch(async () => {
        // İnternet yok / şebeke kesintisi — önbellekten sun.
        // Önce istenen sayfayı (arama parametrelerini göz ardı ederek) önbellekte aramaya
        // çalışıyoruz; sadece hiçbir eşleşme yoksa son çare olarak resepsiyon.html'e düşüyoruz.
        const tamEslesme = await caches.match(e.request);
        if(tamEslesme) return tamEslesme;

        if(e.request.destination === 'document') {
          const yol = new URL(e.request.url).pathname;
          const ayniSayfa = await caches.match(yol, { ignoreSearch: true });
          if(ayniSayfa) return ayniSayfa;
          return caches.match('/swisshouse/resepsiyon.html');
        }
      })
  );
});
