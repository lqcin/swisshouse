
// Modal özet şeritlerinde "16 Haziran 2026" gibi okunaklı tarih göstermek için
function formatTarihGoster(iso) {
  if(!iso) return '—';
  const [y,m,d] = iso.split('-').map(Number);
  if(!y||!m||!d) return iso;
  const aylar = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
  return `${d} ${aylar[m-1]} ${y}`;
}
// Mockup'taki "Pazartesi" gibi gün adı gösterimi için
function gunAdiGoster(iso) {
  if(!iso) return '';
  const [y,m,d] = iso.split('-').map(Number);
  if(!y||!m||!d) return '';
  const gunler = ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];
  return gunler[new Date(y,m-1,d).getDay()];
}

const HOTEL_ODALAR = [101,102,103,201,202,203,301,302,303,401,402,403];

// ── MERKEZİ İŞ KURALLARI ──
// Odayı kapatan rezervasyon durumları TEK noktadan yönetilir. Böylece bir ekranın
// "no-show bitti" derken diğerinin hâlâ odayı rezerve göstermesi engellenir.
const REZ_ODA_BLOKLAYAN_DURUMLAR = new Set(['bekliyor','aktif','gecikmis']);
function rezervasyonOdayiBloklar(r) {
  if(!r) return false;
  const durum=String(r.durum || r._durum || 'bekliyor');
  if(!REZ_ODA_BLOKLAYAN_DURUMLAR.has(durum)) return false;

  // Gerçek check-in yapılmış kayıtlar normal biçimde oda/konaklama tarafından korunur.
  if(durum==='aktif' || rezervasyonCheckinOlmus(r)) return true;

  // YENİ KURAL: giriş günü gelmiş fakat check-in yapılmamış rezervasyon artık odayı
  // teknik olarak kilitlemez. Resepsiyon yeni check-in başlatırsa önce bu kaydı
  // "check-in yap / iptal-no-show işle" kararıyla sonuçlandırmak zorundadır.
  if(r.giris && r.giris <= today()) return false;

  // Gelecekteki rezervasyon planlama/çakışma kontrolünde odayı bloklamaya devam eder.
  return true;
}

function kararBekleyenRezervasyonlar(odaNo) {
  return (window._R||[]).filter(r => {
    const durum=String(r.durum||'bekliyor');
    if(Number(r.odaNo)!==Number(odaNo)) return false;
    if(['iptal','noshow','tamamlandi'].includes(durum)) return false;
    if(rezervasyonCheckinOlmus(r)) return false;
    return !!r.giris && r.giris <= today();
  }).sort((a,b)=>String(a.giris||'').localeCompare(String(b.giris||'')) || String(a.kayitTarih||'').localeCompare(String(b.kayitTarih||'')));
}

window.rezKararModalAc = function(odaNo) {
  const r=kararBekleyenRezervasyonlar(odaNo)[0];
  if(!r) return false;
  document.getElementById('rk_rez_id').value=r.id;
  document.getElementById('rk_oda').value=odaNo;
  const tahsil=rezervasyonTahsilEdilenTutar(r);
  document.getElementById('rk_ozet').innerHTML =
    `<b>${shEsc(r.misafir||'Misafir')}</b> · Oda ${shEsc(r.odaNo)}<br>`+
    `${shEsc(r.giris||'—')} → ${shEsc(r.cikis||'—')} · ${Math.max(0,geceSayisi(r.giris,r.cikis))} gece`+
    `${tahsil>0?`<br><span style="color:var(--green);font-weight:700">Alınmış ödeme: ${fmt(tahsil)}</span>`:''}`;
  openModal('rezKararModal');
  return true;
};

window.rezKararCheckinYap = function() {
  const id=document.getElementById('rk_rez_id').value;
  const r=(window._R||[]).find(x=>x.id===id);
  closeModal('rezKararModal');
  if(!r){toast('Rezervasyon bulunamadı','error');return;}
  checkindenRezervasyon(r);
};

window.rezKararIptalEtVeDevam = async function() {
  const id=document.getElementById('rk_rez_id').value;
  const odaNo=Number(document.getElementById('rk_oda').value);
  const r=(window._R||[]).find(x=>x.id===id);
  closeModal('rezKararModal');
  if(!r){toast('Rezervasyon bulunamadı','error');return;}

  // Ödeme varsa finansal karar verilmeden sessiz iptal yapılmaz.
  const tahsil=rezervasyonTahsilEdilenTutar(r);
  if(tahsil>0.009) {
    window._noShowSonrasiCheckinOda=odaNo;
    noShowModal(r.id,r.misafir||'',Number(r.fiyat)||0,String(r.odaNo));
    toast('Ödeme alınmış. İptal/no-show finans kararını seçin; ardından yeni check-in açılacak.','warning');
    return;
  }

  const now=nowISO();
  await updateDoc(doc(db,'rezervasyonlar',r.id), {
    durum:'iptal',iptalTarih:now,iptalNedeni:'Giriş günü geldi; check-in yapılmadı ve oda yeni giriş için serbest bırakıldı',guncelleme:now
  });
  await talepIptalGuncelle(r,'iptal','Giriş günü geldi; check-in yapılmadı');
  await logAktivite('rezervasyon_iptal',`${r.misafir||'?'} · Oda ${odaNo} · giriş günü check-in yapılmadı`,odaNo);
  toast('Eski rezervasyon iptal edildi. Yeni check-in açılıyor.','success');
  setTimeout(()=>openCheckin(odaNo),150);
};

// meta/odalar tek Firestore belgesi olsa da artık tüm belgeyi eski tarayıcı verisiyle
// geri yazmıyoruz. Yalnız değişen oda alanını merge ederek kaydetmek, farklı odalarda
// aynı anda çalışan iki resepsiyon cihazının birbirinin değişikliğini ezmesini önler.
async function odaMetaKaydet(no, odaData) {
  const key = 'oda' + no;
  window._O[key] = odaData;
  await setDoc(doc(db,'meta','odalar'), { [key]: odaData }, { merge:true });
}

function bosOdaKaydi(durum='bos', ek={}) {
  return {
    durum, misafir:'', tc:'', pasaport:'', tel:'', email:'', plaka:'', kaynak:'',
    fiyatTip:1, fiyat:0, sozlesmeFiyat:null, odemeTuru:'nakit', odemeDurum:'odenmedi',
    kismiTutar:null, kismiKalan:null, odemeToplam:0, tahsilEdilen:0, kalanTutar:0,
    giris:'', cikis:'', girisSaati:'', yetiskin:1, cocuk:0, not:'', refakatciler:[],
    rezervasyonId:null, gelirDocId:null, konaklamaKey:null, guncelleme:nowISO(), ...ek
  };
}

// ── KOMİSYONCU LİSTESİ ──
// Artık koddan değil Firestore'dan (meta/komisyoncular) okunuyor — Rapor sekmesindeki
// "Komisyoncu Yönetimi" panelinden ekle/düzenle/sil yapılabiliyor, kod değiştirmeye gerek yok.
window.KOMISYONCULAR = {};

async function loadKomisyoncular() {
  try {
    const snap = await getDoc(doc(db,'meta','komisyoncular'));
    if(snap.exists() && Object.keys(snap.data()||{}).length > 0) {
      window.KOMISYONCULAR = snap.data();
    } else {
      // İlk çalıştırma — eski koddaki 3 komisyoncuyu Firestore'a taşı (veri kaybı olmasın)
      window.KOMISYONCULAR = {
        'ahmet':  { ad: 'Ahmet Aracı',   sifre: 'ahmet2024',  komisyonTip:'manuel', komisyonDeger:0 },
        'mehmet': { ad: 'Mehmet Turizm', sifre: 'mehmet2024', komisyonTip:'manuel', komisyonDeger:0 },
        'pune':   { ad: 'pune iran',     sifre: 'pune2026',   komisyonTip:'manuel', komisyonDeger:0 },
      };
      await setDoc(doc(db,'meta','komisyoncular'), window.KOMISYONCULAR);
    }
  } catch(e) {
    console.warn('Komisyoncu listesi yüklenemedi:', e);
  }
  renderKomisyoncuYonetimi();
  rezervasyonKomisyoncuSecenekleriniGuncelle('rev_komisyoncu');
  rezervasyonKomisyoncuSecenekleriniGuncelle('rd_komisyoncu');
  // Komisyon Ayarları dropdown'ı da bu listeye bağlı, yeniden doldur
  const kisiSel = document.getElementById('kom_ayar_kisi');
  if(kisiSel) {
    kisiSel.innerHTML = Object.entries(window.KOMISYONCULAR||{}).map(([key,k]) => `<option value="${key}">${k.ad}</option>`).join('');
    komisyonAyarKisiDegisti();
  }
}
window.loadKomisyoncular = loadKomisyoncular;

// Komisyoncu Yönetimi panelini çizer — Rapor sekmesinde
window.renderKomisyoncuYonetimi = function() {
  const govde = document.getElementById('komisyoncuYonetimBody');
  if(!govde) return;
  const girdiler = Object.entries(window.KOMISYONCULAR||{});
  if(girdiler.length === 0) {
    govde.innerHTML = '<tr class="empty-row"><td colspan="5">Henüz komisyoncu tanımlanmamış</td></tr>';
    return;
  }
  govde.innerHTML = girdiler.map(([key, k]) => `<tr>
    <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-weight:600">${k.ad||key}</td>
    <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted)">${key}</td>
    <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px;font-family:monospace">${k.sifre||'—'}</td>
    <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px">${k.komisyonTip==='sabit'?('Sabit '+fmt(k.komisyonDeger||0)+'/gece'):k.komisyonTip==='oran'?('%'+(k.komisyonDeger||0)):'Manuel'}</td>
    <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center;white-space:nowrap">
      <button class="btn btn-ghost btn-sm" onclick="komisyoncuDuzenleAc('${key}')">✏ Düzenle</button>
      <button class="btn btn-danger btn-sm" onclick="komisyoncuSil('${key}')">Sil</button>
    </td>
  </tr>`).join('');
};

window.komisyoncuEkleAc = function() {
  document.getElementById('kyModalBaslik').textContent = 'Yeni Komisyoncu Ekle';
  document.getElementById('ky_eski_key').value = '';
  document.getElementById('ky_key').value = '';
  document.getElementById('ky_key').disabled = false;
  document.getElementById('ky_ad').value = '';
  document.getElementById('ky_sifre').value = '';
  document.getElementById('ky_tip').value = 'manuel';
  document.getElementById('ky_deger').value = '';
  document.getElementById('ky_deger_wrap').style.display = 'none';
  document.getElementById('ky_link').style.display = 'none';
  openModal('komisyoncuYonetimModal');
};

window.komisyoncuDuzenleAc = function(key) {
  const k = window.KOMISYONCULAR[key];
  if(!k) return;
  document.getElementById('kyModalBaslik').textContent = 'Komisyoncu Düzenle';
  document.getElementById('ky_eski_key').value = key;
  document.getElementById('ky_key').value = key;
  document.getElementById('ky_key').disabled = true; // link'i bozmamak için giriş adı sonradan değiştirilemez
  document.getElementById('ky_ad').value = k.ad || '';
  document.getElementById('ky_sifre').value = k.sifre || '';
  document.getElementById('ky_tip').value = k.komisyonTip || 'manuel';
  document.getElementById('ky_deger').value = k.komisyonDeger || '';
  document.getElementById('ky_deger_wrap').style.display = (k.komisyonTip && k.komisyonTip !== 'manuel') ? 'block' : 'none';
  document.getElementById('ky_link').style.display = 'block';
  document.getElementById('ky_link_url').textContent = `komisyoncu.html?k=${key}`;
  openModal('komisyoncuYonetimModal');
};

window.komisyoncuKaydet = async function() {
  const eskiKey = document.getElementById('ky_eski_key').value;
  const yeniKey = document.getElementById('ky_key').value.trim().toLowerCase().replace(/[^a-z0-9]/g,'');
  const ad = document.getElementById('ky_ad').value.trim();
  const sifre = document.getElementById('ky_sifre').value.trim();
  const tip = document.getElementById('ky_tip').value;
  const deger = tip === 'manuel' ? 0 : Math.max(0, Number(document.getElementById('ky_deger').value)||0);
  if(!yeniKey || !ad || !sifre) { toast('Giriş adı, görünen ad ve şifre zorunlu','error'); return; }
  if(!eskiKey && window.KOMISYONCULAR[yeniKey]) { toast('Bu giriş adı zaten kullanılıyor','error'); return; }
  const guncel = {...(window.KOMISYONCULAR||{})};
  guncel[yeniKey] = { ad, sifre, komisyonTip:tip, komisyonDeger:deger };
  try {
    await setDoc(doc(db,'meta','komisyoncular'), guncel);
    window.KOMISYONCULAR = guncel;
    renderKomisyoncuYonetimi();
    renderRaporKomisyonRez();
    closeModal('komisyoncuYonetimModal');
    toast(`${ad} kaydedildi ✓ — link: komisyoncu.html?k=${yeniKey}`, 'success');
  } catch(e) {
    toast('Kaydedilemedi: '+(e?.message||'Bilinmeyen hata'), 'error');
  }
};

window.komisyoncuSil = async function(key) {
  const k = window.KOMISYONCULAR[key];
  if(!k) return;
  if(!confirm(`"${k.ad}" silinsin mi? Bu komisyoncunun giriş bilgileri kaldırılacak — geçmiş komisyon/ödeme kayıtları etkilenmez.`)) return;
  const guncel = {...(window.KOMISYONCULAR||{})};
  delete guncel[key];
  try {
    await setDoc(doc(db,'meta','komisyoncular'), guncel);
    window.KOMISYONCULAR = guncel;
    renderKomisyoncuYonetimi();
    renderRaporKomisyonRez();
    toast('Komisyoncu silindi', 'success');
  } catch(e) {
    toast('Silinemedi: '+(e?.message||'Bilinmeyen hata'), 'error');
  }
};

// Takvimde ardışık farklı misafirlerin görsel olarak ayrışması için
// her misafir/rezervasyon kaydına (isim+giriş tarihine göre) sabit ama
// birbirinden ayırt edilebilir bir ton ataması yapar. Palet (mor/yeşil) sabit kalır.
function takvimRenkTonu(anahtar, taban) {
  let h = 0;
  const s = String(anahtar || '');
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) % 360; }
  // taban: 'rezerve' (mor), 'dolu' (yeşil) veya 'gecmis' (açık kırmızı — tamamlanmış/geçmiş konaklama)
  const hue = taban === 'dolu' ? 130 : taban === 'gecmis' ? 355 : 270;
  const light = 78 + (h % 5) * 3; // 78–90 arası, hafif farklı tonlar
  const sat = taban === 'dolu' ? 32 : taban === 'gecmis' ? 45 : 38;
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}
if('serviceWorker' in navigator) { navigator.serviceWorker.register('/swisshouse/sw.js').catch(()=>{}); }

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, addDoc, updateDoc, deleteDoc, doc, query, orderBy, onSnapshot, setDoc, getDoc, where, getDocs, writeBatch, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp({
  apiKey:"AIzaSyDd1m3Az_JKKF__73dLj3mPA9Y5HOJw9mQ",
  authDomain:"swiss-hotel-64451.firebaseapp.com",
  projectId:"swiss-hotel-64451",
  storageBucket:"swiss-hotel-64451.firebasestorage.app",
  messagingSenderId:"1051421740248",
  appId:"1:1051421740248:web:1aba5dbdda28f1b35d1bad"
});
const auth = getAuth(app);

// ── OFFLİNE DESTEK ──
// IndexedDB tabanlı kalıcı önbellek — internet kesilince son bilinen veriyi gösterir,
// yapılan değişiklikler kuyruğa alınır, internet gelince otomatik senkronize olur.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch(e) {
  // Persistence başlatılamazsa (eski tarayıcı, özel sekme vb.) normal moda düş
  db = getFirestore(app);
}

// Bağlantı durumu göstergesi
window.addEventListener('online',  () => {
  const el = document.getElementById('syncLabel');
  if(el) { el.textContent = 'Bağlı'; el.parentElement.style.opacity='1'; }
  const bd = document.getElementById('baglanti-durum'); if(bd){bd.textContent='● Bağlı';bd.style.color='var(--green)';}
  toast('İnternet bağlantısı yeniden kuruldu — veriler senkronize ediliyor', 'success');
});
window.addEventListener('offline', () => {
  const el = document.getElementById('syncLabel');
  if(el) { el.textContent = 'Çevrimdışı'; el.parentElement.style.opacity='.7'; }
  const bd = document.getElementById('baglanti-durum'); if(bd){bd.textContent='● Çevrimdışı';bd.style.color='var(--gold2)';}
  toast('İnternet bağlantısı kesildi — sistem önbellekten çalışmaya devam ediyor', 'info');
});

// Auth kontrolü
onAuthStateChanged(auth, user => {
  if (!user) window.location.href = 'index.html';
});

// Global veri
window._O = {}; window._F = {}; window._R = []; window._M = []; window._G = [];
window._KOM_AYAR = {};
window._OZ = {}; // Oda özellikleri
let currentCheckinOda = null;
let currentCheckoutOda = null;
let takvimTarih = new Date();
let takvimModu = 'ay';

// ── YARDIMCI ──
const fmt = n => Number(n||0).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' ₺';
const today = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const nowISO = () => new Date().toISOString();
const timeStr = iso => iso ? new Date(iso).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
const dateStr = iso => iso ? new Date(iso).toLocaleDateString('tr-TR',{day:'numeric',month:'long',year:'numeric'}) : '—';
const addDays = (dateStr, days) => {
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m-1, d+days);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
};
// Timezone-safe gece sayısı hesabı
const geceSayisi = (g, c) => {
  if(!g || !c) return 0;
  const [gy,gm,gd] = g.split('-').map(Number);
  const [cy,cm,cd] = c.split('-').map(Number);
  const d1 = new Date(gy, gm-1, gd);
  const d2 = new Date(cy, cm-1, cd);
  return Math.max(1, Math.round((d2 - d1) / 864e5));
};

// Ödeme durumuna göre alınan tutar alanını yönetir. Depozito da kısmi ödeme gibi tutar gerektirir.
window.odemeDurumAlanGuncelle = function(prefix) {
  const durum = document.getElementById(prefix + '_odeme_durum')?.value || 'odenmedi';
  const wrap = document.getElementById(prefix + '_kismi_wrap');
  const tutarEl = document.getElementById(prefix + '_kismi_tutar');
  const turEl = document.getElementById(prefix + '_odeme_tip');
  const goster = durum === 'kismi' || durum === 'depozito';
  if(wrap) wrap.style.display = goster ? 'block' : 'none';
  if(tutarEl) tutarEl.placeholder = durum === 'depozito' ? 'Depozito tutarı (₺)' : 'Alınan tutar (₺)';
  // Ödenmedi durumunda ödeme türü finansal hareket değildir. Eski "Ödenmedi + Nakit"
  // kayıtlarının yeniden üretilmesini engelle.
  if(turEl) {
    if(durum === 'odenmedi') { turEl.value = ''; turEl.disabled = true; }
    else { turEl.disabled = false; if(!turEl.value) turEl.value = 'nakit'; }
  }
  if(prefix === 'ci') ciFiyatGuncelle();
  if(prefix === 'rev') revFiyatGuncelle();
  if(prefix === 'rd') rdFiyatGuncelle();
};

function odemeAlinanTutar(durum, toplam, girilenTutar) {
  if(durum === 'odendi') return Math.max(0, Number(toplam)||0);
  if(durum === 'kismi' || durum === 'depozito') return Math.max(0, Number(girilenTutar)||0);
  return 0;
}

function komisyonKuraliHesapla(sozlesmeFiyat, ayar) {
  const fiyat = Math.max(0, Number(sozlesmeFiyat)||0);
  const tip = ayar?.tip || 'manuel';
  const deger = Math.max(0, Number(ayar?.deger)||0);
  let komisyon = 0;
  if(tip === 'oran' && deger > 0) komisyon = fiyat * Math.min(deger,100) / 100;
  if(tip === 'sabit' && deger > 0) komisyon = Math.min(fiyat, deger);
  komisyon = Math.round(komisyon * 100) / 100;
  return { tip, deger, komisyon, otelFiyat: Math.max(0, Math.round((fiyat-komisyon)*100)/100) };
}

// KOMİSYONUN TEK HESAP NOKTASI
// 1) Açık sözleşme fiyatı varsa komisyon = (müşteri fiyatı - otel neti) × gece.
// 2) Fiyat farkı yoksa ve komisyoncuya kayıtlı sabit/oranlı kural varsa o uygulanır.
// 3) Komisyoncu seçilmemişse hiçbir fiyat farkı kendiliğinden bir kişiye yazılmaz.
function komisyonToplamHesapla({otelFiyat=0, sozlesmeFiyat=0, gece=0, araciAd='', komisyoncuKey='', komisyonTipSnapshot='', komisyonDegerSnapshot=null }={}) {
  const nGece = Math.max(0, Number(gece)||0);
  const otel = Math.max(0, Number(otelFiyat)||0);
  const soz = Math.max(0, Number(sozlesmeFiyat)||0);
  const key = komisyoncuKeyBul(araciAd, komisyoncuKey||'');
  const ad = araciKanonikAd(araciAd || window.KOMISYONCULAR?.[key]?.ad || '');
  if(nGece <= 0 || (!ad && !key)) return {gecelik:0, toplam:0, kaynak:'yok', araciAd:ad||null, komisyoncu:key||null};

  let gecelik = 0;
  let kaynak = 'yok';
  if(soz > 0 && otel > 0 && soz > otel) {
    gecelik = soz - otel;
    kaynak = 'fiyat_farki';
  } else {
    // Önce rezervasyon anında saklanan komisyon kuralını kullan. Geçmiş kaydı bugünkü
    // komisyon ayarıyla yeniden hesaplamak muhasebe hatasıdır.
    const snapTip = String(komisyonTipSnapshot||'');
    const snapDeger = Math.max(0, Number(komisyonDegerSnapshot)||0);
    const ayar = (snapTip==='sabit' || snapTip==='oran') && snapDeger>0
      ? {tip:snapTip,deger:snapDeger}
      : komisyonAyariBul(ad);
    if(ayar && (ayar.tip === 'sabit' || ayar.tip === 'oran') && Number(ayar.deger) > 0) {
      const baz = soz || otel;
      const hesap = komisyonKuraliHesapla(baz, ayar);
      gecelik = Number(hesap.komisyon)||0;
      kaynak = snapTip ? 'snapshot_ayar' : 'ayar';
    }
  }
  gecelik = Math.round(Math.max(0,gecelik)*100)/100;
  const toplam = Math.round(gecelik*nGece*100)/100;
  return {gecelik, toplam, kaynak, araciAd:ad||null, komisyoncu:key||null};
}


// Komisyoncu/acentaya bağlı kayıtta müşteri fiyatı otel netinin altında olamaz.
// Bu kontrol eski sürümlerde oluşan 2.300 müşteri / 2.700 otel net gibi ters kayıtların
// yeni veriye tekrar girmesini engeller. Doğrudan (komisyonsuz) özel fiyatlarda uygulanmaz.
function komisyonFiyatDogrula(otelFiyat, sozlesmeFiyat, araciAd='', komisyoncuKey='') {
  const otel = Math.max(0, Number(otelFiyat)||0);
  const musteri = Math.max(0, Number(sozlesmeFiyat)||0);
  const key = komisyoncuKeyBul(araciAd, komisyoncuKey||'');
  const ad = araciKanonikAd(araciAd || window.KOMISYONCULAR?.[key]?.ad || '');
  if((ad || key) && otel > 0 && musteri > 0 && musteri + 0.009 < otel) {
    return {ok:false, otel, musteri, mesaj:`Komisyoncu kaydında müşteri fiyatı (${fmt(musteri)}) otel net fiyatından (${fmt(otel)}) düşük olamaz. Otel netini veya sözleşme fiyatını düzeltin.`};
  }
  return {ok:true, otel, musteri};
}

// Rezervasyon anındaki komisyon kuralını snapshot olarak sakla. Sonradan ayar değişse bile
// geçmiş hakedişin matematiği değişmez.
function komisyonSnapshotAl(komisyoncuKey='', araciAd='', kaynakKayit=null) {
  const key = komisyoncuKeyBul(araciAd, komisyoncuKey||'') || komisyoncuKey || '';
  if(kaynakKayit?.komisyonTipSnapshot || kaynakKayit?.komisyonTip) {
    return {
      tip: kaynakKayit.komisyonTipSnapshot || kaynakKayit.komisyonTip || 'manuel',
      deger: Math.max(0,Number(kaynakKayit.komisyonDegerSnapshot ?? kaynakKayit.komisyonDeger)||0),
      kaynak:'kaynak_kayit'
    };
  }
  const ayar = window._KOM_AYAR?.[key] || komisyonAyariBul(araciAd || window.KOMISYONCULAR?.[key]?.ad || '') || {tip:'manuel',deger:0};
  return {tip:ayar.tip||'manuel', deger:Math.max(0,Number(ayar.deger)||0), kaynak:'rezervasyon_ani'};
}

function rezervasyonKomisyoncuSecenekleriniGuncelle(selectId, seciliKey='', legacyAd='') {
  const el = document.getElementById(selectId);
  if(!el) return;
  const keyNorm = String(seciliKey||'').trim();
  const entries = Object.entries(window.KOMISYONCULAR||{});
  el.innerHTML = '<option value="">Komisyoncu yok / doğrudan rezervasyon</option>' +
    entries.map(([key,k])=>`<option value="${key}">${k.ad||key}</option>`).join('');
  if(keyNorm && window.KOMISYONCULAR?.[keyNorm]) el.value = keyNorm;
  else if(legacyAd) {
    const bulunan = komisyoncuKeyBul(legacyAd);
    if(bulunan) el.value = bulunan;
    else {
      const opt=document.createElement('option');
      opt.value='__legacy__'; opt.textContent='⚠ Eski kayıt — doğrula: '+legacyAd; opt.selected=true;
      el.appendChild(opt);
    }
  }
}

window.revKomisyoncuDegisti = function() {
  const el=document.getElementById('rev_komisyoncu');
  const key=el?.value||'';
  const uyari=document.getElementById('rev_komisyoncu_uyari');
  if(uyari) uyari.textContent = key ? `Seçili: ${window.KOMISYONCULAR?.[key]?.ad||key}. Müşteri fiyatı otel netinin altında olamaz.` : 'Komisyoncu yoksa komisyon hakedişi oluşmaz.';
  sozlesmeToplam('rev');
};
window.rdKomisyoncuDegisti = function() {
  const el=document.getElementById('rd_komisyoncu');
  const uyari=document.getElementById('rd_komisyoncu_uyari');
  if(uyari) uyari.textContent = el?.value==='__legacy__' ? '⚠ Bu eski komisyoncu kimliği doğrulanmadan kayıt kaydedilemez.' : (el?.value ? 'Komisyoncu doğrulandı.' : 'Doğrudan rezervasyon.');
  rdFiyatGuncelle();
};


// Rezervasyonda check-in öncesinde alınmış gerçek ödeme. Eski kayıt alanlarını da okur.
function rezervasyonTahsilEdilenTutar(r) {
  if(!r) return 0;
  const gece = geceSayisi(r.giris,r.cikis);
  const musteriGecelik = Math.max(0, Number(r.sozlesmeFiyat||r.fiyat)||0);
  const toplam = Math.max(0, musteriGecelik*gece);
  if(r.tahsilEdilen != null) return Math.min(toplam || Infinity, Math.max(0,Number(r.tahsilEdilen)||0));
  if(r.odemeDurum === 'odendi') return toplam;
  if(['kismi','depozito'].includes(r.odemeDurum)) return Math.min(toplam || Infinity, Math.max(0,Number(r.kismiTutar)||0));
  return 0;
}

// Check-in olmadan gelirleşen (iade edilmeyen) rezervasyon tutarının komisyon karşılığı.
// Tam sözleşme komisyonunu, otelde kalan müşteri bedeli oranında kesinleştirir.
function gelirlesenRezervasyonKomisyonu(r, gelirlesenTutar) {
  if(!r) return {toplam:0,gecelik:0,oran:0,esdegerGece:0,kaynak:'yok'};
  const gece = geceSayisi(r.giris,r.cikis);
  const musteriGecelik = Math.max(0,Number(r.sozlesmeFiyat||r.fiyat)||0);
  const musteriToplam = Math.max(0,musteriGecelik*gece);
  const tam = komisyonToplamHesapla({
    otelFiyat:r.fiyat, sozlesmeFiyat:r.sozlesmeFiyat, gece,
    araciAd:r.araciAd||r.komisyoncuAd||'', komisyoncuKey:r.komisyoncu||''
  });
  if(tam.toplam<=0 || musteriToplam<=0) return {...tam,toplam:0,oran:0,esdegerGece:0,musteriToplam};
  const kesinTutar = Math.min(musteriToplam, Math.max(0,Number(gelirlesenTutar)||0));
  const oran = Math.min(1, kesinTutar/musteriToplam);
  const toplam = Math.round(tam.toplam*oran*100)/100;
  const esdegerGece = musteriGecelik>0 ? Math.round((kesinTutar/musteriGecelik)*100)/100 : 0;
  return {...tam,toplam,oran,esdegerGece,musteriToplam,gelirlesenTutar:kesinTutar,kaynak:'gelirlesen_'+tam.kaynak};
}

function rezervasyonCheckinOlmus(r) {
  if(!r) return false;
  if(['aktif','tamamlandi'].includes(String(r.durum||''))) return true;
  if((window._KOM||[]).some(k =>
      r.id && k.rezervasyonId === r.id &&
      !String(k.kaynak||'').toLocaleLowerCase('tr-TR').includes('no-show')
    )) return true;
  if((window._G||[]).some(g =>
      (r.id && g.rezervasyonId === r.id) ||
      (String(g.odaNo||'')===String(r.odaNo||'') && String(g.giris||g.tarih||'')===String(r.giris||'') && Boolean(g.araciAd||g.komisyoncu))
    )) return true;
  const oda = window._O?.['oda'+r.odaNo];
  return Boolean(oda?.durum==='dolu' && ((r.id && oda.rezervasyonId===r.id) || oda.giris===r.giris));
}

function rezervasyonEskiAraciKarismasi(r) {
  if(!r || !r.aracirez || !r.araciAd || !r.misafir) return false;
  const ayni = araciAnahtar(r.araciAd) === araciAnahtar(r.misafir);
  // Kayıtlı komisyoncu key/ad varsa kimlik kurtarılabilir; yoksa eski sürümde misafir
  // adının komisyoncu alanına yanlış yazılmış olma ihtimali yüksektir.
  return ayni && !r.komisyoncu && !r.komisyoncuAd;
}
function komisyonMutabakatDurumu(k) {
  if(!k) return {uygun:false,kod:'bos',neden:'Boş kayıt'};
  if(k.cariDahil === false || String(k.mutabakatDurum||'').startsWith('cari_disi')) return {uygun:false,kod:'karantina',neden:'Cari dışı / karantinada'};
  const r=(window._R||[]).find(x=>k.rezervasyonId && x.id===k.rezervasyonId) || null;
  const g=(window._G||[]).find(x=>k.gelirDocId && x.id===k.gelirDocId) || null;
  if(rezervasyonEskiAraciKarismasi(r)) return {uygun:false,kod:'kimlik',neden:'Eski kayıtta misafir/komisyoncu kimliği karışmış'};

  // Aynı gelir için yalnız deterministik komisyon_<gelirDocId> kaydı cari hesaba girebilir.
  if(k.gelirDocId) {
    const aynilar=(window._KOM||[]).filter(x=>String(x.gelirDocId||'')===String(k.gelirDocId));
    if(aynilar.length>1) {
      const kanonik='komisyon_'+k.gelirDocId;
      if(k.id!==kanonik) return {uygun:false,kod:'cift',neden:'Aynı gelir için çift komisyon kaydı'};
    }
  }
  const rDurum=String(r?.durum||'').toLowerCase();
  const noShowGeliri = String(k.kaynak||'').includes('no-show') || String(g?.kaynak||'').includes('no-show') || Number(k.gelirlesenTutar)>0;
  if(['iptal','reddedildi'].includes(rDurum) && !noShowGeliri) return {uygun:false,kod:'iptal',neden:'İptal/reddedilmiş rezervasyon hakediş üretmez'};
  if(!r && !g && !k.gelirDocId) return {uygun:false,kod:'yetim',neden:'Bağlı rezervasyon/gelir kaydı bulunamadı'};

  const gece=Math.max(0,Number(k.gece)||Number(g?.gece)||geceSayisi(r?.giris,r?.cikis)||0);
  const otel=Math.max(0,Number(k.gercekFiyat ?? g?.fiyat ?? r?.fiyat)||0);
  const musteri=Math.max(0,Number(k.sozlesmeFiyat ?? g?.sozlesmeFiyat ?? r?.sozlesmeFiyat)||0);
  const toplamKom=Number(k.toplamKomisyon)||0;
  if(toplamKom < -0.009) return {uygun:false,kod:'negatif',neden:'Negatif toplam komisyon'};
  if(musteri>0 && otel>0 && musteri+0.009<otel) return {uygun:false,kod:'ters_fiyat',neden:`Müşteri fiyatı (${fmt(musteri)}) otel netinden (${fmt(otel)}) düşük`};
  if((musteri<=0 || otel<=0) && toplamKom>0 && !noShowGeliri) {
    // Açık fiyat ilişkisi yoksa yalnız rezervasyon anı snapshot'ı olan kural bazlı kayıt güvenlidir.
    const snapTip=String(k.komisyonTipSnapshot||'');
    const snapDeger=Number(k.komisyonDegerSnapshot)||0;
    if(!(['sabit','oran'].includes(snapTip) && snapDeger>0)) return {uygun:false,kod:'eksik_fiyat',neden:'Otel neti/müşteri fiyatı eksik; eski ayarla tahmin edilemez'};
  }
  if(musteri>0 && otel>0 && musteri>=otel && gece>0 && !noShowGeliri) {
    const beklenen=Math.round((musteri-otel)*gece*100)/100;
    if(String(k.komisyonKaynak||'').includes('fiyat') || musteri>otel) {
      if(Math.abs(toplamKom-beklenen)>0.02) return {uygun:false,kod:'tutar_farki',neden:`Kayıtlı komisyon ${fmt(toplamKom)}, fiyat farkına göre ${fmt(beklenen)}`};
    }
  }
  if(k.mutabakatDurum==='dogrulandi' || k.mutabakatDurum==='yeni_dogrulanmis' || k.mutabakatDurum==='no_show_dogrulanmis') return {uygun:true,kod:'dogrulandi',neden:'Doğrulanmış'};
  return {uygun:true,kod:'otomatik',neden:'Finans ilişkisi tutarlı'};
}
function komisyonKaydiSupheli(k) { return !komisyonMutabakatDurumu(k).uygun; }

function rezervasyonBeklenenKomisyon(r) {
  if(!r || r.durum !== 'bekliyor' || !(r.araciAd||r.komisyoncu||r.komisyoncuAd)) return null;
  if(rezervasyonEskiAraciKarismasi(r)) return null;
  if(rezervasyonCheckinOlmus(r)) return null;
  if(r.sozlesmeFiyat && r.fiyat && Number(r.sozlesmeFiyat)+0.009 < Number(r.fiyat)) return null;
  const gece = geceSayisi(r.giris,r.cikis);
  const h = komisyonToplamHesapla({
    otelFiyat:r.fiyat,
    sozlesmeFiyat:r.sozlesmeFiyat,
    gece,
    araciAd:r.araciAd||r.komisyoncuAd||'',
    komisyoncuKey:r.komisyoncu||'',
    komisyonTipSnapshot:r.komisyonTipSnapshot||r.komisyonTip||'',
    komisyonDegerSnapshot:r.komisyonDegerSnapshot??r.komisyonDeger
  });
  return h.toplam>0 ? {...h, gece} : null;
}

// Bir konaklamanın gece sayısı SONRADAN değiştiğinde (erken çıkış veya süre uzatma/
// kısaltma) komisyoncunun hakediş kaydını da orantılı olarak günceller. Check-in
// anında kaydedilmiş gecelik komisyon oranı (toplamKomisyon / eskiGece) korunarak
// yeni gece sayısına göre yeniden hesaplanır — böylece manuel sözleşme farkı veya
// ayar bazlı (sabit/oranlı) hesaplama fark etmeksizin aynı mantıkla ölçeklenir.
// Komisyon sıfıra inerse (0 gece kaldıysa vb.) kayıt tamamen silinir.
async function komisyonSureGuncelle(gelirDocId, yeniGece) {
  if(!gelirDocId) return null;
  try {
    const komRef = doc(db, 'komisyonlar', 'komisyon_' + gelirDocId);
    const komSnap = await getDoc(komRef);
    if(!komSnap.exists()) return null;
    const kom = komSnap.data();
    const eskiGece = Number(kom.gece) || 0;
    const eskiKomisyon = Number(kom.toplamKomisyon) || 0;
    const geceGuvenli = Math.max(0, Number(yeniGece) || 0);

    // Eski toplam/gece oranını taşımak yerine fiyat ilişkisini BAŞTAN kur.
    // Böylece hem erken çıkış hem fiyat değişikliği aynı matematiği kullanır.
    const hesap = komisyonToplamHesapla({
      otelFiyat:kom.gercekFiyat,
      sozlesmeFiyat:kom.sozlesmeFiyat,
      gece:geceGuvenli,
      araciAd:kom.araciAd||kom.komisyoncuAd||'',
      komisyoncuKey:kom.komisyoncu||''
    });
    let yeniKomisyon = hesap.toplam;
    let gecelikKomisyon = hesap.gecelik;
    let komisyonKaynak = hesap.kaynak;
    // Çok eski kayıtlarda fiyat ilişkisi saklanmamış olabilir. Böyle bir kaydı erken
    // çıkışta sıfırlamak yerine yalnızca süre değişimi için eski gecelik hakedişi koru.
    if(komisyonKaynak==='yok' && eskiGece>0 && eskiKomisyon>0) {
      gecelikKomisyon = Math.round((eskiKomisyon/eskiGece)*100)/100;
      yeniKomisyon = Math.round(gecelikKomisyon*geceGuvenli*100)/100;
      komisyonKaynak = 'legacy_gecelik';
    }
    const duzeltme = Math.round((yeniKomisyon - eskiKomisyon) * 100) / 100;
    const komisyoncudanMahsup = Math.max(0, Math.round((eskiKomisyon - yeniKomisyon) * 100) / 100);
    const hareketler = Array.isArray(kom.komisyonHareketleri) && kom.komisyonHareketleri.length
      ? [...kom.komisyonHareketleri]
      : (eskiKomisyon>0 ? [{tarih:kom.kayitTarih||kom.tarih||nowISO(),tutar:eskiKomisyon,tip:'hakedis',aciklama:`İlk hakediş · Oda ${kom.odaNo||'—'} · ${eskiGece||'—'} gece`}] : []);
    if(Math.abs(duzeltme) > 0.009) hareketler.push({
      tarih:nowISO(), tutar:duzeltme, tip:duzeltme<0?'mahsup':'ek_hakedis',
      aciklama:duzeltme<0?`Süre kısaltma / erken çıkış mahsupu · ${eskiGece}→${geceGuvenli} gece`:`Süre uzatma ek hakedişi · ${eskiGece}→${geceGuvenli} gece`
    });
    await setDoc(komRef, {
      gece:geceGuvenli,
      gecelikKomisyon,
      komisyonKaynak,
      toplamKomisyon:yeniKomisyon,
      komisyonFark:yeniKomisyon,
      oncekiToplamKomisyon:eskiKomisyon,
      sonKomisyonDuzeltme:duzeltme,
      komisyoncudanMahsup,
      sonDuzeltmeTarih:nowISO(),
      komisyonHareketleri:hareketler,
      guncelleme:nowISO()
    }, { merge:true });

    // Aylık raporun eski komisyonFark değerini okumaması için bağlı gelir kaydını da eşitle.
    try {
      await setDoc(doc(db,'gelirler',gelirDocId), {
        gece:geceGuvenli,
        komisyonFark:yeniKomisyon,
        guncelleme:nowISO()
      }, {merge:true});
    } catch(e) { console.warn('Gelir komisyon senkronizasyonu:',e); }

    return { silindi:false, eski:eskiKomisyon, yeni:yeniKomisyon, fark:duzeltme, mahsup:komisyoncudanMahsup, araciAd:kom.araciAd };
  } catch(e) {
    console.warn('Komisyon süre güncelleme hatası:', e);
    return null;
  }
}

// Serbest yazılan "Aracı" adını sistemde KAYITLI komisyoncu adına çevirir.
// Sadece büyük/küçük harf farkını değil, "PUNE" / "Pune" gibi KISALTILMIŞ yazımları da
// tam kayıtlı isme ("pune iran") eşler — biri diğerinin baş kısmıysa (en az 3 harf) eşleşir.
// Sistemde kayıtlı hiçbir isimle eşleşmezse, yazılan ad olduğu gibi (ad-hoc komisyoncu) döner.
function komisyoncuKeyBul(araciAd, explicitKey='') {
  const direkt = String(explicitKey||'').trim().toLocaleLowerCase('tr-TR');
  if(direkt && window.KOMISYONCULAR?.[direkt]) return direkt;
  const yazilan = (araciAd||'').trim();
  if(!yazilan) return '';
  const yAnahtar = araciAnahtar(yazilan);
  const entries = Object.entries(window.KOMISYONCULAR||{});
  const tam = entries.filter(([k,v]) => araciAnahtar(v?.ad||k) === yAnahtar);
  if(tam.length === 1) return tam[0][0];
  const yakin = entries.filter(([k,v]) => {
    const a = araciAnahtar(v?.ad||k);
    return yAnahtar.length>=3 && a.length>=3 && (a.startsWith(yAnahtar)||yAnahtar.startsWith(a));
  });
  return yakin.length === 1 ? yakin[0][0] : '';
}
function araciKanonikAd(araciAd) {
  const yazilan = (araciAd||'').trim();
  if(!yazilan) return yazilan;
  const key = komisyoncuKeyBul(yazilan);
  return key ? (window.KOMISYONCULAR?.[key]?.ad || key) : yazilan;
}

// Serbest yazılan "Aracı" adını (check-in'de girilen) önceden tanımlı komisyoncu
// ayarlarıyla (Rapor > Komisyoncu Ayarları) eşleştirir — yazım farkına ve kısaltmaya duyarsız.
// Böylece resepsiyonist "sözleşme fiyatı" alanını doldurmayı unutsa bile, komisyoncunun
// sabit/oranlı ayarı varsa komisyon YİNE DE otomatik hesaplanır (unutkanlık, hak kaybı değildir).
function komisyonAyariBul(araciAd) {
  if(!araciAd) return null;
  const anahtar = araciAnahtar(araciKanonikAd(araciAd));
  for(const k in (window._KOM_AYAR||{})) {
    const ayar = window._KOM_AYAR[k];
    const kayitliAd = ayar?.ad || window.KOMISYONCULAR?.[k]?.ad || k;
    if(araciAnahtar(kayitliAd) === anahtar) return ayar;
  }
  return null;
}

async function loadKomisyonAyarlar() {
  try {
    const snap = await getDoc(doc(db,'meta','komisyoncuAyarlar'));
    window._KOM_AYAR = snap.exists() ? snap.data() : {};
  } catch(e) {
    console.warn('Komisyoncu ayarları yüklenemedi:', e);
    window._KOM_AYAR = {};
  }
  const kisi = document.getElementById('kom_ayar_kisi');
  if(kisi) {
    kisi.innerHTML = Object.entries(window.KOMISYONCULAR||{}).map(([key,k]) => `<option value="${key}">${k.ad}</option>`).join('');
    komisyonAyarKisiDegisti();
  }
}
window.loadKomisyonAyarlar = loadKomisyonAyarlar;

window.komisyonAyarKisiDegisti = function() {
  const key = document.getElementById('kom_ayar_kisi')?.value;
  if(!key) return;
  const varsayilan = window.KOMISYONCULAR[key] || {};
  const ayar = window._KOM_AYAR[key] || { tip: varsayilan.komisyonTip||'manuel', deger:Number(varsayilan.komisyonDeger)||0 };
  document.getElementById('kom_ayar_tip').value = ayar.tip || 'manuel';
  document.getElementById('kom_ayar_deger').value = Number(ayar.deger)||0;
  komisyonAyarTipDegisti();
};

window.komisyonAyarTipDegisti = function() {
  const tip = document.getElementById('kom_ayar_tip')?.value || 'manuel';
  const label = document.getElementById('kom_ayar_deger_label');
  const input = document.getElementById('kom_ayar_deger');
  if(label) label.textContent = tip === 'oran' ? 'Oran (%)' : tip === 'sabit' ? 'Tutar (₺ / gece)' : 'Değer';
  if(input) input.disabled = tip === 'manuel';
  const deger = Number(input?.value)||0;
  const ornek = document.getElementById('kom_ayar_ornek');
  if(ornek) {
    const h = komisyonKuraliHesapla(1000,{tip,deger});
    ornek.textContent = tip === 'manuel'
      ? 'Manuel modda gerçek fiyat ve sözleşme fiyatı ayrı girilir.'
      : `Örnek: Misafire 1.000 ₺ girildiğinde komisyon ${fmt(h.komisyon)}, otel payı ${fmt(h.otelFiyat)} olur.`;
  }
};

window.komisyonAyarKaydet = async function() {
  const key = document.getElementById('kom_ayar_kisi')?.value;
  const tip = document.getElementById('kom_ayar_tip')?.value || 'manuel';
  const deger = tip === 'manuel' ? 0 : Math.max(0, Number(document.getElementById('kom_ayar_deger')?.value)||0);
  if(!key) return;
  if(tip === 'oran' && deger > 100) { toast('Komisyon oranı %100’den büyük olamaz','error'); return; }
  const mevcut = {...(window._KOM_AYAR||{})};
  mevcut[key] = { tip, deger, ad: window.KOMISYONCULAR[key]?.ad || key, guncelleme: nowISO() };
  try {
    await setDoc(doc(db,'meta','komisyoncuAyarlar'), mevcut);
    window._KOM_AYAR = mevcut;
    const durum = document.getElementById('kom_ayar_durum');
    if(durum) { durum.textContent = '✓ Ayar kaydedildi'; durum.style.color='var(--green)'; }
    komisyonAyarTipDegisti();
    toast('Komisyoncu ayarı kaydedildi ✓','success');
  } catch(e) {
    toast('Komisyon ayarı kaydedilemedi: '+e.message,'error');
  }
};

function temizAnahtar(v) {
  return String(v||'').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40) || 'misafir';
}
function konaklamaGelirId(odaNo, giris, tc, misafir, rezervasyonId='') {
  return rezervasyonId ? `konaklama_${rezervasyonId}` : `konaklama_${odaNo}_${giris}_${temizAnahtar(tc||misafir)}`;
}

// Eski sürümlerde check-in ve check-out aynı konaklamayı iki kez yazabildi.
// Ekran hesaplarında aynı oda/misafir/giriş kaydını tekilleştirir; yeni kayıtlar ayrıca deterministik ID ile yazılır.
function gelirleriTekillestir(liste) {
  const tumu = Array.isArray(liste) ? liste : [];
  const sonuc = [];
  const konaklamaMap = new Map();
  const legacyCheckout = [];

  const kisiAnahtari = g => temizAnahtar(g.tc || g.misafir);
  const konaklamaMi = g => g.kaynak !== 'oda-masrafi' && Boolean(
    g.kayitTip === 'konaklama' || g.giris || g.girisSaati || g.fiyat || g.gece || /gece\s+konaklama|\[OTOMATİK\]/i.test(g.aciklama||'')
  );

  for(const g of tumu) {
    if(!konaklamaMi(g)) { sonuc.push(g); continue; }

    // Eski checkout kayıtlarında giriş tarihi/gece/fiyat bulunmuyordu.
    // Bunları ikinci turda check-in kaydıyla eşleştiriyoruz.
    const eskiCheckoutMu = !g.giris && !g.girisSaati && !g.fiyat && !g.gece && /gece\s+konaklama/i.test(g.aciklama||'');
    if(eskiCheckoutMu) { legacyCheckout.push(g); continue; }

    const anahtar = g.konaklamaKey || `${g.odaNo}|${kisiAnahtari(g)}|${g.giris||g.tarih}`;
    const eski = konaklamaMap.get(anahtar);
    if(!eski) { konaklamaMap.set(anahtar,g); continue; }
    const eskiZaman = String(eski.guncelleme||eski.kayitTarih||'');
    const yeniZaman = String(g.guncelleme||g.kayitTarih||'');
    if(yeniZaman > eskiZaman || Number(g.gece||0) > Number(eski.gece||0) || Number(g.tutar||0) > Number(eski.tutar||0)) {
      konaklamaMap.set(anahtar,{...eski,...g});
    }
  }

  // Eski sürümün check-out sırasında oluşturduğu ikinci konaklama gelirini
  // aynı oda + aynı kişi + aynı tutardaki en yakın check-in kaydıyla birleştir.
  for(const co of legacyCheckout) {
    const coTarih = new Date(`${co.tarih||''}T00:00:00`).getTime();
    let enIyiKey = null;
    let enIyiFark = Infinity;
    for(const [key, ci] of konaklamaMap.entries()) {
      if(String(ci.odaNo) !== String(co.odaNo)) continue;
      if(kisiAnahtari(ci) !== kisiAnahtari(co)) continue;
      if(Math.abs(Number(ci.tutar||0)-Number(co.tutar||0)) > 0.01) continue;
      const ciTarih = new Date(`${ci.giris||ci.tarih||''}T00:00:00`).getTime();
      if(!Number.isFinite(ciTarih) || !Number.isFinite(coTarih)) continue;
      const farkGun = Math.round((coTarih-ciTarih)/864e5);
      if(farkGun < 0 || farkGun > 365) continue;
      if(farkGun < enIyiFark) { enIyiFark=farkGun; enIyiKey=key; }
    }
    if(enIyiKey) {
      const ci = konaklamaMap.get(enIyiKey);
      konaklamaMap.set(enIyiKey,{
        ...ci,
        checkoutTarih: co.tarih || ci.checkoutTarih || null,
        odemeTuru: co.odemeTuru || ci.odemeTuru,
        odemeDurum: co.odemeDurum || ci.odemeDurum,
        guncelleme: co.kayitTarih || ci.guncelleme || ci.kayitTarih
      });
    } else {
      // Eşleşme bulunamazsa gerçek bir kaydı yanlışlıkla gizleme.
      sonuc.push(co);
    }
  }

  return [...sonuc, ...konaklamaMap.values()];
}

function toast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show ' + type;
  setTimeout(() => t.className='', 3200);
}

function syncStatus(ok) {
  const el = document.getElementById('syncEl');
  el.className = 'sync-indicator' + (ok?' ok':'');
  document.getElementById('syncLabel').textContent = ok ? 'Bağlı' : 'Bağlantı Yok';
}

// Saat
function updateTime() {
  const now = new Date();
  document.getElementById('headerTime').textContent = now.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('headerDate').textContent = now.toLocaleDateString('tr-TR',{weekday:'long',day:'numeric',month:'long'});
}
updateTime(); setInterval(updateTime, 1000);

// ── FİYAT ──
const TIP_ADLAR = {1:'Hafta İçi', 2:'Hafta Sonu', 3:'Sezon', 4:'İndirimli'};
function getTipAd(no) { return TIP_ADLAR[no] || `Tip ${no}`; }
function getOdaFiyat(odaNo, tip) { return Number(window._F?.odalar?.['oda'+odaNo]?.[tip]) || 0; }

async function loadFiyatlar() {
  try {
    const snap = await getDoc(doc(db,'meta','fiyatlar2'));
    if (snap.exists()) window._F = snap.data();
    else {
      window._F = {tipAdlar:{1:'Standart',2:'Hafta Sonu',3:'Sezon',4:'İndirimli'},odalar:{}};
      for(const i of HOTEL_ODALAR) window._F.odalar['oda'+i]={1:0,2:0,3:0,4:0};
    }
  } catch(e) {}
}

// ── ODALAR ──
async function initOdalar() {
  const snap = await getDoc(doc(db,'meta','odalar'));
  if (!snap.exists()) {
    const o = {};
    for(const i of HOTEL_ODALAR) o['oda'+i]={durum:'bos',misafir:'',tc:'',tel:'',email:'',plaka:'',kaynak:'',fiyatTip:1,fiyat:0,odemeTuru:'nakit',giris:'',cikis:'',girisSaati:'',yetiskin:1,cocuk:0,not:'',guncelleme:''};
    await setDoc(doc(db,'meta','odalar'),o);
    window._O = o;
  } else window._O = snap.data();

  // Oda ilk yüklemede mevcut durumu gösterir. Vadesi gelmiş gerçek check-in'ler
  // yaşam döngüsü denetiminde otomatik checkout edilir; eski kayıtlar ayrıca uzlaştırılır.
  renderOdalar();

  // Oda durumunu gerçek zamanlı dinle. Başka cihazda yapılan check-in/check-out birkaç
  // saniye içinde bu ekrana gelir; 60 sn/yenileme bekleyen eski davranış kaldırıldı.
  if(!window._odaCanliUnsub) {
    window._odaCanliUnsub = onSnapshot(doc(db,'meta','odalar'), snap => {
      if(!snap.exists()) return;
      window._O = snap.data() || {};
      renderOdalar();
      renderHatirlatma();
      if(document.getElementById('page-rapor')?.classList.contains('active')) renderRaporKomisyonRez();
      syncStatus(true);
    }, () => syncStatus(false));
  }
}

// ── OTOMATİK VADE / YAŞAM DÖNGÜSÜ ──
// Yeni kural:
// 1) Check-in yapılmış oda, güncellenmiş çıkış tarihinde saat 11:00'e geldiğinde uzatma yoksa
//    otomatik tamamlanır. Otomatik işlem para tahsil etmiş/iade etmiş SAYILMAZ; açık alacak veya
//    iade bekleyen tutar mali kayıtta korunur.
// 2) Check-in yapılmamış rezervasyon, giriş günü geldiğinde odayı artık teknik olarak kilitlemez.
//    Kayıt "karar bekliyor" olur. Yeni check-in girişiminde resepsiyon eski rezervasyonu ya
//    check-in eder ya da iptal/no-show finans kararını tamamlar. Sistem kendi kendine gelir yaratmaz.
function vadeGeldiMi(iso, saat=11) {
  if(!iso) return false;
  const simdi=new Date(), gun=today();
  if(gun>iso) return true;
  return gun===iso && simdi.getHours()>=saat;
}

async function otomatikCheckoutKaydet(no) {
  const o=window._O?.['oda'+no];
  if(!o || o.durum!=='dolu' || !o.cikis || !vadeGeldiMi(o.cikis,11)) return false;
  if(o._otomatikCheckoutIsleniyor) return false;
  o._otomatikCheckoutIsleniyor=true;
  try {
    const gece=geceSayisi(o.giris,o.cikis);
    const state=checkoutHesapDurumu(no,gece);
    if(!state) return false;
    const now=nowISO();
    const gelirId=o.gelirDocId || konaklamaGelirId(no,o.giris,o.tc,o.misafir,o.rezervasyonId||'');
    const konaklamaKey=o.konaklamaKey || `${no}|${temizAnahtar(o.tc||o.misafir)}|${o.giris}`;
    const tahsil=Math.max(0,Number(state.oncekiTahsil)||0);
    const konaklamaTahsil=Math.min(state.fiyatModel.misafirToplam,tahsil);
    const kalan=Math.max(0,Math.round((state.fiyatModel.misafirToplam-konaklamaTahsil)*100)/100);
    const iadeBekleyen=Math.max(0,Math.round((tahsil-state.fiyatModel.misafirToplam)*100)/100);
    const odemeDurum=kalan<=0.009?'odendi':(konaklamaTahsil>0?'kismi':'odenmedi');

    // Odaya yansıtılmış masrafları kaybetme: otomatik checkout para tahsil etmez, masraf açık kalır.
    for(const m of state.yansitilan||[]) {
      const tutar=Math.max(0,Number(m.tutar)||0);
      await updateDoc(doc(db,'odaMasraflari',m.id), {odemeDurumu:'checkout_borc',checkoutTarih:now,checkoutTahsilEdilen:0,checkoutKalan:tutar,checkoutOdemeTuru:''});
      await setDoc(doc(db,'gelirler',`oda_masrafi_${m.id}`), {
        masrafId:m.id,tarih:o.cikis,tutar,odaNo:String(no),odemeTuru:'',odemeDurum:'odenmedi',
        tahsilEdilen:0,kalanTahsilat:tutar,misafir:o.misafir,tc:o.tc||'',konaklamaKey,
        gelirDocId:gelirId,rezervasyonId:o.rezervasyonId||null,kaynak:'oda-masrafi',
        aciklama:`Oda ${no} · Otomatik checkout · ${m.aciklama}`,kayitTarih:m.kayitTarih||now,guncelleme:now
      },{merge:true});
    }

    await setDoc(doc(db,'gelirler',gelirId), {
      kayitTip:'konaklama',konaklamaKey,giris:o.giris,cikis:o.cikis,checkoutTarih:o.cikis,
      otomatikCheckout:true,otomatikCheckoutIslemTarih:now,tarih:o.giris||o.cikis,
      tutar:state.fiyatModel.otelNetToplam,otelNetToplam:state.fiyatModel.otelNetToplam,
      komisyonToplam:state.fiyatModel.komisyonToplam,odaNo:String(no),
      odemeTuru:o.odemeTuru||'',odemeDurum,odemeToplam:state.fiyatModel.misafirToplam,
      tahsilEdilen:konaklamaTahsil,kalanTahsilat:kalan,iadeBekleyen,
      misafir:o.misafir,tc:o.tc||'',kaynak:o.kaynak||'walk-in',fiyatTip:o.fiyatTip||1,
      fiyatTipAd:getTipAd(o.fiyatTip||1),gece,fiyat:state.fiyatModel.otelGecelik,
      sozlesmeFiyat:state.fiyatModel.misafirGecelik,aciklama:`Oda ${no} · ${gece} gece · otomatik checkout`,
      kayitTarih:o.kayitTarih||now,guncelleme:now
    },{merge:true});

    const kaynakRev=o.rezervasyonId ? (window._R||[]).find(r=>r.id===o.rezervasyonId) : null;
    if(kaynakRev?.id) {
      await updateDoc(doc(db,'rezervasyonlar',kaynakRev.id), {
        durum:'tamamlandi',cikis:o.cikis,gece,checkoutTarih:o.cikis,otomatikCheckout:true,
        odemeToplam:state.fiyatModel.misafirToplam,otelNetToplam:state.fiyatModel.otelNetToplam,
        komisyonToplam:state.fiyatModel.komisyonToplam,kalanTahsilat:kalan,iadeBekleyen,guncelleme:now
      });
      if(kaynakRev.kaynakTalepId) {
        try { await updateDoc(doc(db,'rezervasyon_talepleri',kaynakRev.kaynakTalepId), {
          durum:'tamamlandi',rezervasyonId:kaynakRev.id,cikis:o.cikis,gece,checkoutTarih:o.cikis,
          otomatikCheckout:true,odemeToplam:state.fiyatModel.misafirToplam,
          otelNetToplam:state.fiyatModel.otelNetToplam,komisyonToplam:state.fiyatModel.komisyonToplam,
          kalanTahsilat:kalan,iadeBekleyen,islemTarih:now
        }); } catch(e) { console.warn('Otomatik checkout talep senkronu:',e); }
      }
    }

    const temizlik=bosOdaKaydi('temizlik', {_otoTemizlik:o.cikis,temizlikBaslangic:now,otomatikCheckout:true,manuelCheckout:false,sonCheckoutTarih:o.cikis,kalanTahsilat:kalan,iadeBekleyen});
    await odaMetaKaydet(no,temizlik);
    await logAktivite('oto_checkout', `${o.misafir||'?'} · Oda ${no} · ${gece} gece · otomatik checkout · açık alacak ${fmt(kalan)}${iadeBekleyen>0?' · iade bekleyen '+fmt(iadeBekleyen):''}`, no);
    return true;
  } catch(e) {
    console.error('Otomatik checkout hatası Oda '+no,e);
    return false;
  }
}


// ── GERİYE DÖNÜK CHECK-OUT UZLAŞTIRMASI ──
// Eski sürümlerde gerçek check-in/konaklama kaydı oluşup checkout alanı yazılmadan kalan
// kayıtları planlanan çıkış tarihinde tamamlar. YENİ tahsilat, iade veya komisyon üretmez;
// yalnız yaşam döngüsündeki eksik "checkout tamamlandı" bilgisini yazar.
async function geriyeDonukCheckoutUzlastir() {
  if(window._geriyeDonukCheckoutCalisiyor) return;
  if(!Array.isArray(window._G) || !Array.isArray(window._R)) return;
  window._geriyeDonukCheckoutCalisiyor=true;
  let duzelen=0, tarihTamamlanan=0;
  try {
    const tumGelir=(window._G||[]).filter(g =>
      g && g.id &&
      g.kaynak!=='oda-masrafi' &&
      g.kaynak!=='no-show' &&
      !g.checkoutTarih
    );

    for(const g of tumGelir) {
      // 1) Önce doğrudan rezervasyonId, sonra legacy oda+misafir eşleşmesi.
      let r=g.rezervasyonId ? (window._R||[]).find(x=>x.id===g.rezervasyonId) : null;
      if(!r) {
        const ga=temizAnahtar(g.misafir||'');
        const aday=(window._R||[]).filter(x =>
          !['iptal','noshow'].includes(String(x.durum||'')) &&
          String(x.odaNo||'')===String(g.odaNo||'') &&
          ga && temizAnahtar(x.misafir||'')===ga
        );
        if(aday.length===1) r=aday[0];
        else if(aday.length>1) {
          const gt=String(g.giris||g.tarih||'');
          r=aday.find(x=>gt && x.giris===gt) ||
            aday.find(x=>gt && x.giris<=gt && x.cikis>gt) ||
            aday.sort((a,b)=>String(b.giris||'').localeCompare(String(a.giris||'')))[0];
        }
      }

      const giris=String(g.giris||r?.giris||g.tarih||'').slice(0,10);
      const cikis=String(g.cikis||r?.cikis||'').slice(0,10);
      if(!giris || !cikis || !vadeGeldiMi(cikis,11)) continue;

      // Bu kayıt gerçekten konaklama/check-in izi taşımalı. Yalnız rezervasyon planı olan
      // kayıtların geriye dönük checkout'a dönüşmesini engelle.
      const checkinIzi =
        g.kayitTip==='konaklama' ||
        !!g.gelirDocId || !!g.konaklamaKey ||
        Number(g.gece)>0 ||
        (r && ['aktif','tamamlandi'].includes(String(r.durum||''))) ||
        (r && g.misafir && temizAnahtar(g.misafir)===temizAnahtar(r.misafir||''));
      if(!checkinIzi) continue;

      // Aktif odada aynı konaklama hâlâ duruyorsa güncel oda çıkışına saygı göster.
      const oda=window._O?.['oda'+g.odaNo];
      if(oda?.durum==='dolu') {
        const ayni=(oda.gelirDocId===g.id) || (r?.id && oda.rezervasyonId===r.id) ||
          (oda.konaklamaKey && g.konaklamaKey && oda.konaklamaKey===g.konaklamaKey) ||
          (temizAnahtar(oda.misafir||'')===temizAnahtar(g.misafir||'') && String(oda.odaNo||g.odaNo)===String(g.odaNo));
        if(ayni) continue; // mevcut oda otomatikCheckoutKaydet ile kapatılır; uzatma burada ezilmez.
      }

      const patch={
        giris:g.giris||giris,
        cikis:g.cikis||cikis,
        checkoutTarih:cikis,
        geriyeDonukCheckout:true,
        geriyeDonukCheckoutIslemTarih:nowISO(),
        guncelleme:nowISO()
      };
      if(!g.giris || !g.cikis) tarihTamamlanan++;
      await setDoc(doc(db,'gelirler',g.id),patch,{merge:true});

      if(r && !['iptal','noshow'].includes(String(r.durum||''))) {
        await updateDoc(doc(db,'rezervasyonlar',r.id), {
          durum:'tamamlandi',
          giris:r.giris||giris,
          cikis:r.cikis||cikis,
          checkoutTarih:cikis,
          geriyeDonukCheckout:true,
          guncelleme:nowISO()
        });
        if(r.kaynakTalepId) {
          try {
            await updateDoc(doc(db,'rezervasyon_talepleri',r.kaynakTalepId), {
              durum:'tamamlandi',
              giris:r.giris||giris,
              cikis:r.cikis||cikis,
              checkoutTarih:cikis,
              geriyeDonukCheckout:true,
              islemTarih:nowISO()
            });
          } catch(e) { console.warn('Geriye dönük checkout talep senkronu:',e); }
        }
      }
      duzelen++;
    }

    if(duzelen>0) {
      await logAktivite('geriye_donuk_checkout',`${duzelen} eski konaklamanın eksik checkout bilgisi tamamlandı${tarihTamamlanan?` · ${tarihTamamlanan} legacy kayıtta giriş/çıkış rezervasyondan tamamlandı`:''}`);
      toast(`${duzelen} geçmiş konaklamanın eksik check-out kaydı uzlaştırıldı.${tarihTamamlanan?` ${tarihTamamlanan} legacy kaydın tarihleri de rezervasyondan tamamlandı.`:''}`,'success');
    }
  } catch(e) {
    console.error('Geriye dönük checkout uzlaştırma hatası:',e);
  } finally {
    window._geriyeDonukCheckoutCalisiyor=false;
  }
}

function geriyeDonukCheckoutKur() {
  if(window._geriyeDonukCheckoutKuruldu) return;
  window._geriyeDonukCheckoutKuruldu=true;
  let deneme=0;
  const t=setInterval(async()=>{
    deneme++;
    if(Array.isArray(window._G) && Array.isArray(window._R) && window._O) {
      clearInterval(t);
      await geriyeDonukCheckoutUzlastir();
    } else if(deneme>=20) clearInterval(t);
  },1000);
}

// Check-in yapılmamış rezervasyon artık otomatik no-show'a çevrilmez.
// Giriş günü geldiğinde "karar bekliyor" durumuna alınır; oda bloklanmaz.
// İlk yeni check-in girişiminde resepsiyon mevcut rezervasyonu ya check-in eder
// ya da iptal/no-show finans kararını tamamlar.
async function rezervasyonKararBekliyorIsaretle(r) {
  if(!r?.id || rezervasyonCheckinOlmus(r) || !r.giris || r.giris>today()) return false;
  if(['iptal','noshow','tamamlandi','aktif','karar_bekliyor'].includes(String(r.durum||''))) return false;
  try {
    await updateDoc(doc(db,'rezervasyonlar',r.id), {
      durum:'karar_bekliyor',
      checkinKararBekliyor:true,
      checkinKararBaslangic:r.giris,
      guncelleme:nowISO()
    });
    return true;
  } catch(e) {
    console.warn('Rezervasyon karar bekliyor işaretlenemedi:',e);
    return false;
  }
}

async function otomatikBosal() {
  if(!window._O) return;

  // Gerçek check-in olmuş aktif odalarda planlanan çıkış tarihi geldiyse otomatik checkout.
  for(const no of HOTEL_ODALAR) await otomatikCheckoutKaydet(no);

  // Check-in yapılmamış rezervasyon odayı kilitlemez ve otomatik finans kararı üretmez.
  // Sadece resepsiyonun karar vermesi için işaretlenir.
  for(const r of (window._R||[])) {
    if(!rezervasyonCheckinOlmus(r) && r.giris && r.giris<=today()) {
      await rezervasyonKararBekliyorIsaretle(r);
    }
  }
}

// Günlük kontrol + periyodik kontrol. Saat 11 sınırı nedeniyle 5 dakikalık kontrol ayrıca aşağıda çalışır.
function gunlukKontrolKur() {
  const simdi = new Date();
  const yarinGeceyarisi = new Date(simdi);
  yarinGeceyarisi.setDate(yarinGeceyarisi.getDate()+1);
  yarinGeceyarisi.setHours(0,1,0,0);
  const kalan = yarinGeceyarisi - simdi;
  setTimeout(async () => {
    await otomatikBosal();
    renderOdalar();
    setInterval(async () => { await otomatikBosal(); renderOdalar(); }, 86400000);
  }, kalan);
}

onSnapshot(query(collection(db,'rezervasyonlar'), orderBy('giris','asc')), s => {
  window._R = s.docs.map(d=>({id:d.id,...d.data()}));
  renderRezervasyonlar(); renderOdalar(); renderHatirlatma(); syncStatus(true);
  if(document.getElementById('page-rapor')?.classList.contains('active')) { renderKomisyonCari(); renderRaporKomisyonRez(); renderRaporTarihDetay(); }
}, () => syncStatus(false));

onSnapshot(query(collection(db,'odaMasraflari'), orderBy('kayitTarih','desc')), s => {
  window._M = s.docs.map(d=>({id:d.id,...d.data()}));
  renderMasraflar();
});

onSnapshot(query(collection(db,'gelirler'), orderBy('tarih','desc')), s => {
  window._G = gelirleriTekillestir(s.docs.map(d=>({id:d.id,...d.data()})));
  if(document.getElementById('page-rapor')?.classList.contains('active')) { renderRaporKomisyonRez(); renderRaporTarihDetay(); }
});

onSnapshot(query(collection(db,'komisyonlar'), orderBy('kayitTarih','desc')), s => {
  window._KOM = s.docs.map(d=>({id:d.id,...d.data()}));
  if(document.getElementById('page-rapor')?.classList.contains('active')) renderKomisyonCari();
});

// Komisyoncuya yapılan ÖDEMELER — müşterinin oda ödemesinden tamamen bağımsız,
// ayrı bir cari hesap (borç: komisyonlar koleksiyonu, ödeme: burası).
window._KOMODEME = [];
onSnapshot(query(collection(db,'komisyonOdemeleri'), orderBy('tarih','desc')), s => {
  window._KOMODEME = s.docs.map(d=>({id:d.id,...d.data()}));
  if(document.getElementById('page-rapor')?.classList.contains('active')) { renderKomisyonCari(); renderOdemeGecmisi(); }
});

// ── INSTAGRAM REZERVASYON TALEPLERİ ──
window._TALEP = [];
let _talepIlkYukleme = true;
onSnapshot(query(collection(db,'rezervasyon_talepleri'), orderBy('kayitTarih','desc')), s => {
  const oncekiBekleyenSayisi = (window._TALEP||[]).filter(t => t.durum==='bekliyor').length;
  window._TALEP = s.docs.map(d=>({id:d.id,...d.data()}));
  const yeniBekleyenSayisi = window._TALEP.filter(t => t.durum==='bekliyor').length;
  renderInstagramTalepleri();
  if(document.getElementById('page-rapor')?.classList.contains('active')) renderRaporKomisyonRez();
  // Sayfa ilk açıldığında ses çalma — sadece sonradan yeni talep gelirse çal
  if(!_talepIlkYukleme && yeniBekleyenSayisi > oncekiBekleyenSayisi) {
    talepSesiCal();
  }
  _talepIlkYukleme = false;
});

function talepSesiCal() {
  try {
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.stop(ctx.currentTime + 0.4);
  } catch(e) {}
}

window.renderInstagramTalepleri = function() {
  const bekleyenler = (window._TALEP||[]).filter(t => t.durum === 'bekliyor');
  const badge = document.getElementById('talep-badge');
  const kart = document.getElementById('instagramTalepKart');
  const sayac = document.getElementById('talep-sayac');

  if(bekleyenler.length === 0) {
    if(badge) badge.style.display = 'none';
    if(kart) kart.style.display = 'none';
    return;
  }

  if(badge) { badge.textContent = bekleyenler.length; badge.style.display = 'inline'; }
  if(kart) kart.style.display = 'block';
  if(sayac) sayac.textContent = bekleyenler.length;

  document.getElementById('instagramTalepBody').innerHTML = bekleyenler.map(t => {
    const odemeIkon = {nakit:'💵',kart:'💳',havale:'🏦',depozito:'🔒'}[t.odemeTercihi||'nakit']||'💵';
    const odemeAd = {nakit:'Nakit',kart:'Kart',havale:'Havale',depozito:'Depozito'}[t.odemeTercihi||'nakit']||'—';
    const dilBayragi = {tr:'🇹🇷',en:'🇬🇧',fa:'🇮🇷'}[t.dil||'tr']||'';
    const kaynakLabel = t.kaynak === 'komisyoncu'
      ? `🤝 ${t.komisyoncuAd||t.komisyoncu||'Komisyoncu'}`
      : `📷 Instagram`;
    return `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px;white-space:nowrap">${kaynakLabel}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-weight:600">${dilBayragi} ${t.misafir||'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border)">${t.tel||'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted)">${t.tc||'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px">${t.giris||'?'} → ${t.cikis||'?'}${t.gece?` (${t.gece}g)`:''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">${(t.yetiskin||1)+(t.cocuk||0)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px">${odemeIkon} ${odemeAd}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(t.not||'').replace(/"/g,'&quot;')}">${t.not||'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;white-space:nowrap">
        <button class="btn btn-primary btn-sm" onclick="talepOnayla('${t.id}')">✓ Onayla</button>
        <button class="btn btn-ghost btn-sm" onclick="talepReddet('${t.id}')">✕ Reddet</button>
      </td>
    </tr>
  `}).join('');
};

window.talepOnayla = function(id) {
  const t = (window._TALEP||[]).find(x => x.id === id);
  if(!t) return;
  // Talebi rezervasyon formuna taşı — kullanıcı kontrol edip onaylasın
  window._onaylananTalepId = id; // ÖNCE set et, openRezervModalForOda sıfırlamasın
  window._onaylananKomisyoncu = t.kaynak === 'komisyoncu' ? (t.komisyoncu||null) : null;
  window._onaylananKomisyoncuAd = t.kaynak === 'komisyoncu' ? (t.komisyoncuAd||t.komisyoncu||null) : null;
  openRezervModalForOda(t.odaNo ? Number(t.odaNo) : null, id);
  setTimeout(() => {
    document.getElementById('rev_giris').value = t.giris || '';
    document.getElementById('rev_ad').value = t.misafir || '';
    document.getElementById('rev_tel').value = t.tel || '';
    document.getElementById('rev_tc').value = t.tc || '';
    document.getElementById('rev_yetiskin').value = t.yetiskin || 1;
    document.getElementById('rev_cocuk').value = t.cocuk || 0;
    const kaynakNot = t.kaynak === 'komisyoncu'
      ? `[Acenta: ${t.komisyoncuAd||t.komisyoncu}]`
      : `[Instagram talebi]`;
    document.getElementById('rev_not').value = (t.not ? t.not + ' ' : '') + kaynakNot;
    document.getElementById('rev_kaynak').value = 'diger';
    if(t.sozlesmeFiyat) {
      const rsf = document.getElementById('rev_sozlesme_fiyat');
      if(rsf) { rsf.value = t.sozlesmeFiyat; sozlesmeToplam('rev'); }
    }
    {
      const kayitliAyar = window._KOM_AYAR?.[t.komisyoncu] || null;
      const talepAyari = t.komisyonTip ? {tip:t.komisyonTip,deger:Number(t.komisyonDeger)||0} : kayitliAyar;
      const hesap = komisyonKuraliHesapla(t.sozlesmeFiyat, talepAyari);
      const gercekFiyat = Number(t.fiyat)||((hesap.tip!=='manuel' && hesap.otelFiyat>0)?hesap.otelFiyat:0);
      if(gercekFiyat > 0) {
        const rf = document.getElementById('rev_fiyat');
        if(rf) { rf.value = gercekFiyat; rf.dataset.manuelDegisim='1'; }
      }
    }
    if(t.komisyoncu) {
      const rk = document.getElementById('rev_komisyoncu');
      if(rk) { rezervasyonKomisyoncuSecenekleriniGuncelle('rev_komisyoncu', t.komisyoncu||'', t.komisyoncuAd||''); rk.value = t.komisyoncu || komisyoncuKeyBul(t.komisyoncuAd||'') || ''; revKomisyoncuDegisti(); }
    }
    const gece = geceSayisi(t.giris, t.cikis) || 1;
    document.getElementById('rev_gece').value = gece;
    if(t.odaNo) {
      const sel = document.getElementById('rev_oda');
      if(sel) { sel.value = t.odaNo; revOdaSecildi(); }
    }
    revHesapla();

    // Ödeme bilgilerini EN SONA set et — revHesapla sıfırlamalarından sonra
    setTimeout(() => {
      if(t.odemeDurum) {
        const rod = document.getElementById('rev_odeme_durum');
        if(rod) {
          rod.value = t.odemeDurum;
          const kismiWrap = document.getElementById('rev_kismi_wrap');
          if(kismiWrap) kismiWrap.style.display = (t.odemeDurum === 'kismi' || t.odemeDurum === 'depozito') ? 'block' : 'none';
        }
      }
      if(t.odemeTuru) {
        const rot = document.getElementById('rev_odeme_tip');
        if(rot) rot.value = t.odemeTuru;
      }
      if(t.kismiTutar && (t.odemeDurum === 'kismi' || t.odemeDurum === 'depozito')) {
        const rkt = document.getElementById('rev_kismi_tutar');
        if(rkt) rkt.value = t.kismiTutar;
      }
    }, 150);
  }, 100);
};

window.talepReddet = async function(id) {
  if(!confirm('Bu talebi reddetmek istediğinize emin misiniz?')) return;
  await updateDoc(doc(db,'rezervasyon_talepleri',id), {durum:'reddedildi', islemTarih: nowISO()});
  toast('Talep reddedildi', 'info');
};

// ── RENDER ODALAR ──
window.renderOdalar = function() {
  const grid = document.getElementById('roomsGrid');
  const todayStr = today();
  let dolu=0, bos=0, temizlik=0, rezerve=0, arizali=0;

  // Katları grupla: 1xx → Kat 1, 2xx → Kat 2 vb.
  const KATLAR = [
    { kat: 1, odalar: [101,102,103] },
    { kat: 2, odalar: [201,202,203] },
    { kat: 3, odalar: [301,302,303] },
    { kat: 4, odalar: [401,402,403] },
  ];

  // Önce stat say
  for(const i of HOTEL_ODALAR) {
    const o = window._O['oda'+i] || {durum:'bos'};
    const aktifRev = window._R.find(r => Number(r.odaNo)===i && r.giris<=todayStr && r.cikis>todayStr && rezervasyonOdayiBloklar(r));
    const bugunRev = window._R.find(r => Number(r.odaNo)===i && r.giris===todayStr && rezervasyonOdayiBloklar(r));
    let durum = o.durum;
    if(durum==='dolu') dolu++;
    else if(durum==='temizlik') temizlik++;
    else if(durum==='arizali') arizali++;
    else if(aktifRev?.durum==='aktif') dolu++;
    else if(bugunRev) rezerve++;
    else bos++;
  }

  document.getElementById('stat-dolu').textContent = dolu;
  document.getElementById('stat-bos').textContent = bos;
  document.getElementById('stat-temizlik').textContent = temizlik;
  document.getElementById('stat-rezerve').textContent = rezerve;
  document.getElementById('stat-arizali').textContent = arizali;

  // Kat bazlı render
  grid.innerHTML = '';
  for(const { kat, odalar } of KATLAR) {
    const blok = document.createElement('div');
    blok.className = 'kat-blok';
    blok.innerHTML = `<div class="kat-baslik"><span>${kat}. KAT</span><small>${odalar.join(' · ')}</small></div>`;

    const odalarDiv = document.createElement('div');
    odalarDiv.className = 'kat-odalar';

    for(const i of odalar) {
      const o  = window._O['oda'+i] || {durum:'bos'};
      const oz = window._OZ?.['oda'+i] || {};
      const aktifRev    = window._R.find(r => Number(r.odaNo)===i && r.giris<=todayStr && r.cikis>todayStr && rezervasyonOdayiBloklar(r));
      const bugunRev    = window._R.find(r => Number(r.odaNo)===i && r.giris===todayStr && rezervasyonOdayiBloklar(r));
      const bekleyenRev = window._R.find(r => Number(r.odaNo)===i && r.giris>todayStr && rezervasyonOdayiBloklar(r));

      let durum = o.durum;
      if(durum!=='dolu' && durum!=='temizlik' && durum!=='arizali' && aktifRev?.durum==='aktif') durum='dolu';

      const div = document.createElement('div');
      // Sadece bugün girişi varsa "rezerve" rengi göster, gelecek rezervasyonlar görünmez
      const kalanBorc = durum === 'dolu' ? window.odaKalanBorc(o) : 0;
      div.className = `room-card ${durum}${bugunRev&&durum==='bos'?' rezerve':''}${kalanBorc>0?' borclu':''}`;

      let icerik = `<div class="room-no">${i}${oz.ad?`<span style="display:block;font-size:10px;color:var(--gold);font-family:'Jost',sans-serif;font-weight:600;letter-spacing:.5px;margin-top:-2px">${oz.ad}</span>`:''}</div>`;
      icerik += `<div class="room-status-text">${durum==='dolu'?'Dolu':durum==='temizlik'?'Temizlik':durum==='arizali'?'Arızalı / Bakımda':bugunRev?'Check-in Bekleniyor':'Boş'}</div>`;
      if(o.misafir&&durum==='dolu') icerik+=`<div class="room-guest">${o.misafir}</div>`;
      if(o.cikis&&durum==='dolu') icerik+=`<div class="room-info">↑ ${o.cikis}</div>`;
      if(o.fiyat&&durum==='dolu') icerik+=`<div class="room-price">${(o.fiyat||0).toLocaleString('tr-TR')}₺/gece</div>`;
      if(kalanBorc>0) icerik+=`<div class="room-borc-rozet">KALAN: ${kalanBorc.toLocaleString('tr-TR')} ₺</div>`;
      else if(durum==='dolu' && o.odemeDurum==='odendi') icerik+=`<div class="room-borc-rozet" style="background:#16a34a;color:#fff">✓ ÖDENDİ</div>`;
      if(bugunRev&&durum!=='dolu') icerik+=`<div class="room-guest">${bugunRev.misafir||'—'}</div><div class="room-info">Check-in bekleniyor</div>`;
      icerik += buildPopup(i, o, oz, durum, aktifRev, bekleyenRev);

      div.innerHTML = icerik;
      div.onclick = () => odaKliklandi(i);
      odalarDiv.appendChild(div);
    }

    blok.appendChild(odalarDiv);
    grid.appendChild(blok);
  }
};

function buildPopup(no, o, oz, durum, aktifRev, bekleyenRev) {
  let html = `<div class="room-popup">`;

  // Başlık
  html += `<div class="popup-title">Oda ${no}${oz.ad ? ` — ${oz.ad}` : ''}</div>`;

  // Dolu ise misafir bilgisi
  if(durum==='dolu' && o.misafir) {
    const gece = o.giris&&o.cikis ? Math.max(1,Math.round((new Date(o.cikis)-new Date(o.giris))/864e5)) : '?';
    const kalanBorc = window.odaKalanBorc(o);
    html += `<div class="popup-misafir-blok">
      <div class="popup-misafir-ad">${o.misafir}</div>
      <div style="font-size:11px;color:rgba(255,180,180,.7)">${o.giris||'?'} → ${o.cikis||'?'} · ${gece} gece</div>
      ${o.tc?`<div style="font-size:10px;color:rgba(255,255,255,.4);margin-top:2px">TC: ${o.tc}</div>`:''}
      ${kalanBorc>0?`<div style="font-size:11px;color:#ffb020;font-weight:700;margin-top:4px">💰 ${kalanBorc.toLocaleString('tr-TR')} ₺ ödenmedi</div>`:(o.odemeDurum==='odendi'?`<div style="font-size:11px;color:#4ade80;font-weight:700;margin-top:4px">✓ Ödendi</div>`:'')}
    </div>`;
  }

  // Rezervasyon varsa
  if(bekleyenRev && durum!=='dolu') {
    html += `<div style="background:rgba(30,61,107,.3);border:1px solid rgba(30,61,107,.4);padding:8px 10px;margin-bottom:10px">
      <div style="font-size:11px;color:#a0c0ff;font-weight:600">Yaklaşan: ${bekleyenRev.misafir||'—'}</div>
      <div style="font-size:10px;color:rgba(255,255,255,.5);margin-top:2px">${bekleyenRev.giris} → ${bekleyenRev.cikis}</div>
    </div>`;
  }

  // Oda özellikleri
  if(oz.kat || oz.cephe || oz.tip || oz.yatak || oz.m2) {
    if(oz.tip) html += `<div class="popup-row"><span class="popup-row-label">Tip</span><span class="popup-row-val">${oz.tip}</span></div>`;
    if(oz.kat) html += `<div class="popup-row"><span class="popup-row-label">Kat</span><span class="popup-row-val">${oz.kat}</span></div>`;
    if(oz.cephe) html += `<div class="popup-row"><span class="popup-row-label">Cephe</span><span class="popup-row-val">${oz.cephe}</span></div>`;
    if(oz.yatak) html += `<div class="popup-row"><span class="popup-row-label">Yatak</span><span class="popup-row-val">${oz.yatak}</span></div>`;
    if(oz.m2) html += `<div class="popup-row"><span class="popup-row-label">Alan</span><span class="popup-row-val">${oz.m2} m²</span></div>`;
    if(oz.maxkisi) html += `<div class="popup-row"><span class="popup-row-label">Kapasite</span><span class="popup-row-val">${oz.maxkisi} kişi</span></div>`;
  } else {
    html += `<div style="font-size:11px;color:rgba(255,255,255,.3);font-style:italic">Oda özellikleri henüz girilmemiş</div>`;
  }

  // Donanım etiketleri
  if((oz.ozellikler||[]).length > 0) {
    html += `<div class="popup-tags">`;
    oz.ozellikler.forEach(tag => { html += `<span class="popup-tag">${tag}</span>`; });
    html += `</div>`;
  }

  // Not
  if(oz.not) html += `<div class="popup-not">${oz.not}</div>`;

  html += `</div>`;
  return html;
}

// Oda tıklandığında ne yapılacağına karar ver
window.odaKliklandi = function(no) {
  openOdaDetay(no);
};

window.openOdaDetay = function(no) {
  window._curOdaDetay = no;
  const oda = window._O['oda'+no]  || {durum:'bos'};
  const oz  = window._OZ?.['oda'+no] || {};
  const td  = today();

  // Aktif rezervasyon var mı?
  const aktifRev = window._R.find(r =>
    Number(r.odaNo)===Number(no) && r.giris<=td && r.cikis>td && rezervasyonOdayiBloklar(r)
  );
  const kararRev = kararBekleyenRezervasyonlar(no)[0] || null;

  // Efektif durum — Firebase dolu ise dolu, değilse gerçek durum
  const d = oda.durum === 'dolu' ? 'dolu' : oda.durum;
  const o = oda;

  // Başlık
  const baslik = 'Oda ' + no + (oz.ad ? ' — ' + oz.ad : '');
  document.getElementById('od_baslik').textContent = baslik;

  // Durum & renk
  const renkMap = {dolu:'var(--red)',bos:'var(--green)',temizlik:'var(--gold)',rezerve:'var(--blue)',arizali:'#9a5221'};
  const lblMap  = {dolu:'🔴 Dolu',bos:'🟢 Boş',temizlik:'🟡 Temizlik',rezerve:'🔵 Rezerveli',arizali:'🔧 Arızalı / Bakımda'};
  document.getElementById('od_header').style.background = renkMap[d] || 'var(--dark)';
  document.getElementById('od_durum').innerHTML =
    `<span style="background:rgba(255,255,255,.2);color:#fff;padding:3px 10px;font-size:11px;font-weight:700;letter-spacing:1px">${lblMap[d]||d}</span>`;

  // Bilgi
  let bilgi = '';
  if(d==='dolu') {
    const misafir = o.misafir || '';
    const giris   = o.giris   || '';
    const cikis   = o.cikis   || '';
    const fiyat   = o.fiyat   || 0;
    const kaynak  = o.kaynak  || '';
    const gece    = geceSayisi(giris, cikis);
    const fm = konaklamaFiyatModeli(o);
    const tahsilEdilen = misafirTahsilEdilenBul(o, fm);
    const kalanBorc = Math.max(0, fm.misafirToplam - tahsilEdilen);
    bilgi = `<div style="background:var(--parchment);border:1px solid var(--border);padding:14px 18px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Misafir</div>
        <div style="font-size:15px;font-weight:600;color:var(--dark)">${misafir||'—'}</div>
        ${o.tc ? `<div style="font-size:11px;color:var(--muted)">TC: ${o.tc}</div>` : ''}
        ${o.tel ? `<div style="font-size:11px;color:var(--muted)">📞 ${o.tel}</div>` : ''}
      </div>
      <div>
        <div style="font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:4px">Konaklama</div>
        <div style="font-size:13px;font-weight:600;color:var(--dark)">${giris||'?'} → ${cikis||'?'}</div>
        <div style="font-size:11px;color:var(--muted)">${gece} gece · Misafir: ${fm.misafirGecelik ? fmt(fm.misafirGecelik) + '/gece' : '—'}</div>
        ${fm.komisyonGecelik>0.009?`<div style="font-size:10px;color:var(--muted)">Otel net: ${fmt(fm.otelGecelik)}/gece · Komisyon: ${fmt(fm.komisyonGecelik)}/gece</div>`:''}
        <div style="font-size:11px;color:var(--muted)">${kaynak||'walk-in'}</div>
      </div>
      <div style="grid-column:1/-1;border-top:1px solid var(--border);padding-top:10px">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
          <div style="font-size:11px;color:var(--muted)">Misafir hesabı: <strong style="color:var(--dark)">${fmt(fm.misafirToplam)}</strong>${fm.komisyonGecelik>0.009?` · Otel net: <strong>${fmt(fm.otelNetToplam)}</strong> · Komisyon: <strong style="color:var(--gold2)">${fmt(fm.komisyonToplam)}</strong>`:''}</div>
          <div style="font-size:13px;font-weight:800;color:${kalanBorc>0?'#d97706':'var(--green)'}">${kalanBorc>0?'Kalan: '+fmt(kalanBorc):'✓ Ödeme Tamam'}</div>
        </div>
        ${tahsilEdilen>0?`<div style="font-size:10px;color:var(--muted);margin-top:4px">Misafir hesabında tahsil/mahsup: ${fmt(tahsilEdilen)}</div>`:''}
      </div>
    </div>`;
  } else if(aktifRev) {
    // Oda boş ama aktif rezervasyon var — check-in bekleniyor
    const gece = geceSayisi(aktifRev.giris, aktifRev.cikis);
    const gecikmis = aktifRev.giris < td && aktifRev.durum !== 'aktif';
    const kutuBg = gecikmis ? '#fff5e8' : '#eef6ff';
    const kutuBorder = gecikmis ? 'rgba(232,147,12,.35)' : 'rgba(29,78,216,.2)';
    const baslikRenk = gecikmis ? 'var(--orange,#e8930c)' : 'var(--blue)';
    const baslikTxt = gecikmis ? `⚠ Gecikmiş Giriş — ${geceSayisi(aktifRev.giris, td)} gündür check-in yapılmadı` : '⏳ Check-in Bekliyor';
    bilgi = `<div style="background:${kutuBg};border:1px solid ${kutuBorder};padding:14px 18px">
      <div style="font-size:11px;font-weight:700;color:${baslikRenk};margin-bottom:8px">${baslikTxt}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Misafir</div>
          <div style="font-size:14px;font-weight:600;color:var(--dark)">${aktifRev.misafir||'—'}</div>
          ${aktifRev.tel ? `<div style="font-size:11px;color:var(--muted)">📞 ${aktifRev.tel}</div>` : ''}
        </div>
        <div>
          <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Rezervasyon</div>
          <div style="font-size:13px;font-weight:600;color:var(--dark)">${aktifRev.giris} → ${aktifRev.cikis}</div>
          <div style="font-size:11px;color:var(--muted)">${gece} gece · ${aktifRev.fiyat ? aktifRev.fiyat.toLocaleString('tr-TR') + ' ₺/gece' : '—'}</div>
        </div>
      </div>
    </div>`;
  } else if(kararRev) {
    const tahsil=rezervasyonTahsilEdilenTutar(kararRev);
    bilgi = `<div style="background:#fff8e8;border:1px solid rgba(217,119,6,.35);padding:12px 16px">
      <div style="font-size:12px;color:#b45309;font-weight:800;margin-bottom:5px">⚠ Check-in Kararı Bekliyor</div>
      <div style="font-size:12px;color:var(--dark)"><b>${shEsc(kararRev.misafir||'Misafir')}</b> · ${shEsc(kararRev.giris||'—')} → ${shEsc(kararRev.cikis||'—')}</div>
      ${tahsil>0?`<div style="font-size:11px;color:var(--green);margin-top:4px">Alınmış ödeme: ${fmt(tahsil)}</div>`:''}
      <div style="font-size:10px;color:var(--muted);margin-top:6px">Oda teknik olarak müsaittir; yeni check-in öncesinde bu kayıt iptal/no-show veya check-in olarak sonuçlandırılmalıdır.</div>
      <button class="btn btn-warning btn-sm" style="margin-top:9px" onclick="rezKararModalAc(${Number(no)})">Karar Ver</button>
    </div>`;
  } else if(d==='temizlik') {
    bilgi = '<div style="background:var(--orange-bg);border:1px solid rgba(200,150,0,.2);padding:12px 16px;font-size:13px;color:var(--orange);font-weight:600">🧹 Oda temizlik bekleniyor</div>';
  } else {
    bilgi = '<div style="background:var(--green-bg);border:1px solid rgba(22,163,74,.2);padding:12px 16px;font-size:13px;color:var(--green);font-weight:600">✓ Oda müsait</div>';
  }
  document.getElementById('od_bilgi').innerHTML = bilgi;

  // 7 günlük takvim
  const gunAdlari = ['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'];
  const gunler = [];
  for(let i=0;i<7;i++) {
    const dd = new Date(); dd.setDate(dd.getDate()+i);
    gunler.push(dd.getFullYear()+'-'+String(dd.getMonth()+1).padStart(2,'0')+'-'+String(dd.getDate()).padStart(2,'0'));
  }

  let thHtml = '<tr><th style="padding:6px 4px;font-size:10px;font-weight:600;color:var(--muted);background:var(--cream);border:1px solid var(--border);min-width:52px">Oda</th>';
  gunler.forEach(gs => {
    const dd2 = new Date(gs+'T00:00:00');
    const gad = gunAdlari[dd2.getDay()===0?6:dd2.getDay()-1];
    const isT = gs===td;
    thHtml += `<th style="padding:6px 4px;font-size:10px;font-weight:600;text-align:center;background:var(--cream);border:1px solid var(--border);min-width:52px;color:${isT?'var(--blue)':'var(--muted)'}">${gad}<br><span style="font-size:11px;font-weight:700">${dd2.getDate()}</span></th>`;
  });
  thHtml += '</tr>';

  let tdHtml = `<tr><td style="padding:6px 10px;font-family:'Cormorant Garamond',serif;font-size:14px;font-weight:700;background:var(--parchment);border:1px solid var(--border);white-space:nowrap">${no}${oz.ad?`<br><span style="font-size:9px;font-weight:400;color:var(--muted)">${oz.ad}</span>`:''}</td>`;
  gunler.forEach(gs => {
    const isT = gs===td;
    const rz = window._R.find(r => Number(r.odaNo)===no && (r.giris||'')<=gs && (r.cikis||'')>gs && rezervasyonOdayiBloklar(r));
    const isTemz = d==='temizlik' && isT;
    const bg = rz ? '#d4c4e8' : isTemz ? '#fde8c0' : '#fff';
    const lbl = rz ? (rz.misafir||'Rez.').split(' ')[0] : isTemz ? 'Temizlik' : '';
    tdHtml += `<td style="padding:0;height:36px;position:relative;border:1px solid rgba(200,200,200,.4);background:${bg}${isT?';box-shadow:inset 0 0 0 2px var(--blue)':''}">${lbl?`<div style="position:absolute;inset:2px;display:flex;align-items:center;padding:0 3px;font-size:9px;font-weight:600;color:#3a3530;overflow:hidden;white-space:nowrap">${lbl}</div>`:''}</td>`;
  });
  tdHtml += '</tr>';

  document.getElementById('od_takvim_head').innerHTML = thHtml;
  document.getElementById('od_takvim_body').innerHTML = tdHtml;

  // Yakın rezervasyonlar (30 gün)
  const limit30 = gunler[0].slice(0,8) + '30'; // yaklaşık
  const d30 = new Date(); d30.setDate(d30.getDate()+30);
  const d30s = d30.getFullYear()+'-'+String(d30.getMonth()+1).padStart(2,'0')+'-'+String(d30.getDate()).padStart(2,'0');
  const yakin = window._R.filter(r => Number(r.odaNo)===no && rezervasyonOdayiBloklar(r) && r.cikis>=td && r.giris<=d30s);
  let rezHtml = '';
  if(yakin.length) {
    rezHtml = '<div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:10px">Yakın Rezervasyonlar</div>';
    rezHtml += '<div style="display:flex;flex-direction:column;gap:6px">';
    yakin.forEach(r => {
      const checkinYapildi = r.durum === 'aktif';
      const gecikmis = !checkinYapildi && r.giris < td;
      const aktif = r.giris<=td && r.cikis>td;
      const renk = checkinYapildi ? 'var(--green)' : gecikmis ? 'var(--orange,#e8930c)' : 'var(--blue)';
      const badgeCls = checkinYapildi ? 'badge-green' : gecikmis ? 'badge-orange' : aktif ? 'badge-green' : 'badge-blue';
      const badgeTxt = checkinYapildi ? 'Aktif' : gecikmis ? '⚠ Gecikmiş Giriş' : aktif ? 'Aktif' : 'Bekliyor';
      rezHtml += `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--parchment);border:1px solid var(--border);border-left:3px solid ${renk}">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--dark)">${r.aracirez?'🤝 ':''}${r.misafir||'—'}${r.aracirez?' <span style="font-size:9px;color:var(--gold2);font-weight:700">ARACI</span>':''}</div>
          <div style="font-size:11px;color:var(--muted)">${r.giris} → ${r.cikis}${r.fiyat?' · '+r.fiyat.toLocaleString('tr-TR')+' ₺/gece':''}</div>
        </div>
        <span class="badge ${badgeCls}">${badgeTxt}</span>
      </div>`;
    });
    rezHtml += '</div>';
  }
  document.getElementById('od_rezerv').innerHTML = rezHtml;

  // Butonlar — duruma göre göster/gizle
  const isDolu = d === 'dolu';
  const isArizali = d === 'arizali';
  document.getElementById('od_btn_checkin').style.display  = (isDolu||isArizali) ? 'none' : '';
  document.getElementById('od_btn_checkout').style.display = (isDolu && !isArizali) ? '' : 'none';
  document.getElementById('od_btn_masraf').style.display   = (isDolu && !isArizali) ? '' : 'none';
  document.getElementById('od_btn_sure').style.display     = (isDolu && !isArizali) ? '' : 'none';
  document.getElementById('od_btn_rezerv').style.display   = (isDolu||isArizali) ? 'none' : '';
  document.getElementById('od_btn_durum').style.display    = '';

  // Check-in butonu — aktif rezervasyon varsa oradan getir, yoksa boş form
  const checkinBtn = document.getElementById('od_btn_checkin');
  if(!isDolu && !isArizali) {
    if(aktifRev) {
      checkinBtn.onclick = () => { closeModal('odaDetayModal'); checkindenRezervasyon(aktifRev); };
    } else {
      checkinBtn.onclick = () => { closeModal('odaDetayModal'); openCheckin(window._curOdaDetay); };
    }
  }

  // Sözleşme butonu — aktif rezervasyon varsa göster
  const sozBtn = document.getElementById('od_btn_sozlesme');
  if(sozBtn) sozBtn.style.display = (!isDolu && !isArizali && aktifRev) ? '' : 'none';

  // Arızalı bilgi notu
  if(isArizali && o.arizaNot) {
    bilgi += `<div style="background:#f5ece0;border:1px solid rgba(154,82,33,.3);padding:12px 16px;margin-top:10px;font-size:13px;color:#9a5221"><strong>🔧 Arıza/Bakım Notu:</strong> ${o.arizaNot}</div>`;
    document.getElementById('od_bilgi').innerHTML = bilgi;
  }

  openModal('odaDetayModal');
};

// ── VARDİYA SİSTEMİ ──
let vardiyaAktif = false;
let vardiyaBaslangic = null;
let vardiyaSayacInterval = null;
let vardiyaId = null;
let vardiyaIstatistik = {checkin:0, checkout:0, rezervasyon:0, tahsilat:0};

window.vardiyaAc = function() {
  if(vardiyaAktif) {
    toast('Zaten aktif bir vardiya var','error');
    return;
  }
  document.getElementById('vardiya_nakit').value = '';
  document.getElementById('vardiya_not').value = '';
  openModal('vardiyaBaslatModal');
};

window.vardiyaBaslat = async function() {
  const nakit = Number(document.getElementById('vardiya_nakit').value) || 0;
  const not_  = document.getElementById('vardiya_not').value.trim();
  const now   = nowISO();
  vardiyaBaslangic = new Date();
  vardiyaIstatistik = {checkin:0, checkout:0, rezervasyon:0, tahsilat:0};

  const ref = await addDoc(collection(db,'vardiyalar'), {
    baslangic: now,
    nakitDevir: nakit,
    not: not_,
    kim: auth.currentUser?.email || 'resepsiyon',
    durum: 'aktif'
  });
  vardiyaId = ref.id;
  vardiyaAktif = true;

  document.getElementById('vardiyaBar').style.display = 'flex';
  document.getElementById('vardiyaBtn').textContent = '⏱ Vardiya Aktif';
  document.getElementById('vardiyaBtn').disabled = true;
  closeModal('vardiyaBaslatModal');
  toast('Vardiya başlatıldı ✓', 'success');

  vardiyaSayacInterval = setInterval(vardiyaSayacGuncelle, 1000);
  await logAktivite('vardiya_baslat', `Nakit devir: ${nakit.toLocaleString('tr-TR')} ₺`, '');
};

function vardiyaSayacGuncelle() {
  if(!vardiyaBaslangic) return;
  const fark = Math.floor((new Date() - vardiyaBaslangic) / 1000);
  const s = Math.floor(fark/3600);
  const d = Math.floor((fark%3600)/60);
  const sn = fark%60;
  const el = document.getElementById('vardiyaSure');
  if(el) el.textContent = `${String(s).padStart(2,'0')}:${String(d).padStart(2,'0')}:${String(sn).padStart(2,'0')}`;
}

// Vardiya istatistiğini güncelle (saveCheckin/saveCheckout çağırır)
function vardiyaIstatistikGuncelle(tip, tutar=0) {
  if(!vardiyaAktif) return;
  if(tip==='checkin') vardiyaIstatistik.checkin++;
  if(tip==='checkout') { vardiyaIstatistik.checkout++; vardiyaIstatistik.tahsilat += tutar; }
  if(tip==='rezervasyon') vardiyaIstatistik.rezervasyon++;
  // UI güncelle
  document.getElementById('vd-checkin').textContent = vardiyaIstatistik.checkin;
  document.getElementById('vd-checkout').textContent = vardiyaIstatistik.checkout;
  document.getElementById('vd-rezerv').textContent = vardiyaIstatistik.rezervasyon;
  document.getElementById('vd-tahsilat').textContent = vardiyaIstatistik.tahsilat.toLocaleString('tr-TR') + ' ₺';
}

window.vardiyaBitir = function() {
  if(!vardiyaAktif) return;
  const fark = Math.floor((new Date() - vardiyaBaslangic) / 1000);
  const sure = `${Math.floor(fark/3600)}s ${Math.floor((fark%3600)/60)}dk`;
  document.getElementById('vardiyaBitirIcerik').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
      ${[
        ['Vardiya Süresi', sure],
        ['Check-in', vardiyaIstatistik.checkin + ' işlem'],
        ['Check-out', vardiyaIstatistik.checkout + ' işlem'],
        ['Rezervasyon', vardiyaIstatistik.rezervasyon + ' işlem'],
        ['Toplam Tahsilat', vardiyaIstatistik.tahsilat.toLocaleString('tr-TR') + ' ₺'],
      ].map(([k,v])=>`<div style="background:var(--parchment);border:1px solid var(--border);padding:10px 14px">
        <div style="font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:3px">${k}</div>
        <div style="font-size:14px;font-weight:700;color:var(--dark)">${v}</div>
      </div>`).join('')}
    </div>`;
  document.getElementById('vardiya_bitis_nakit').value = '';
  openModal('vardiyaBitirModal');
};

window.vardiyaKapat = async function() {
  const nakitSayim = Number(document.getElementById('vardiya_bitis_nakit').value) || 0;
  const now = nowISO();
  if(vardiyaId) {
    await updateDoc(doc(db,'vardiyalar',vardiyaId), {
      bitis: now,
      nakitSayim,
      istatistik: vardiyaIstatistik,
      sure: Math.floor((new Date()-vardiyaBaslangic)/1000),
      durum: 'kapali'
    });
  }
  clearInterval(vardiyaSayacInterval);
  vardiyaAktif = false;
  vardiyaBaslangic = null;
  vardiyaId = null;
  document.getElementById('vardiyaBar').style.display = 'none';
  document.getElementById('vardiyaBtn').textContent = '⏱ Vardiya Başlat';
  document.getElementById('vardiyaBtn').disabled = false;
  closeModal('vardiyaBitirModal');
  await logAktivite('vardiya_kapat', `Nakit sayım: ${nakitSayim.toLocaleString('tr-TR')} ₺ · Tahsilat: ${vardiyaIstatistik.tahsilat.toLocaleString('tr-TR')} ₺`, '');
  toast('Vardiya kapatıldı ✓', 'success');
};

// ── SÖZLEŞME & CHECK-IN ──
// ── ÇAKIŞMA KONTROLÜ (merkezi) ──
// Bir oda için verilen tarih aralığında çakışan rezervasyon veya konaklama var mı?
// excludeRevId: kendisinden check-in yapılan rezervasyonu hariç tut
window.odaCakismaKontrol = function(odaNo, giris, cikis, excludeRevId = null) {
  // 1) Çakışan rezervasyon var mı?
  const carpisanRev = (window._R||[]).find(r =>
    Number(r.odaNo) === Number(odaNo) &&
    rezervasyonOdayiBloklar(r) &&
    r.id !== excludeRevId &&
    (r.giris||'') < cikis && (r.cikis||'') > giris
  );
  if(carpisanRev) {
    return { cakisma: true, tip: 'rezervasyon', detay: `${carpisanRev.misafir||'?'} · ${carpisanRev.giris} → ${carpisanRev.cikis}` };
  }

  // 2) Oda şu an dolu mu ve konaklama tarihleri çakışıyor mu?
  const oda = window._O['oda'+odaNo];
  if(oda?.durum === 'dolu' && oda.giris && oda.cikis) {
    if(oda.giris < cikis && oda.cikis > giris) {
      return { cakisma: true, tip: 'konaklama', detay: `${oda.misafir||'?'} · ${oda.giris} → ${oda.cikis}` };
    }
  }

  return { cakisma: false };
};

window.checkinSozlesmeOnayla = function() {
  const no    = currentCheckinOda;
  const mevcutOda = window._O['oda'+no] || {};
  // Form açık kaldığı sırada başka bir cihaz/personel check-in yaptıysa burada da engelle.
  if(mevcutOda.durum === 'dolu') {
    const kalan = window.odaKalanBorc(mevcutOda);
    toast(`Oda ${no} artık dolu. Önce mevcut konaklamanın check-out işlemini tamamlayın${kalan>0 ? ` · Kalan ödeme: ${fmt(kalan)}` : ''}.`, 'error');
    return;
  }
  const ad    = document.getElementById('ci_ad').value.trim();
  const giris = document.getElementById('ci_giris').value;
  const cikis = document.getElementById('ci_cikis').value;
  const fiyat = Number(document.getElementById('ci_fiyat').value);
  const tc    = document.getElementById('ci_tc').value.trim();
  const pasaport = document.getElementById('ci_pasaport')?.value.trim().toUpperCase() || '';

  if(!ad) { toast('Misafir adı zorunlu','error'); return; }
  if(!giris||!cikis) { toast('Tarih zorunlu','error'); return; }
  if(giris > today()) { toast(`Check-in yapılamaz — giriş tarihi gelecekte (${giris}). Misafir geldiği gün check-in yapın.`,'error'); return; }
  if(tc && tc.length===11 && !tcDogrula(tc)) { toast('TC Kimlik No geçersiz','error'); return; }
  if(!fiyat || fiyat <= 0) { toast('Gecelik fiyat girilmeden devam edilemez','error'); return; }
  {
    const odDurum = document.getElementById('ci_odeme_durum')?.value || 'odenmedi';
    const toplamKontrol = (Number(document.getElementById('ci_sozlesme_fiyat')?.value)||fiyat) * geceSayisi(giris,cikis);
    const alinanKontrol = Number(document.getElementById('ci_kismi_tutar')?.value)||0;
    if(['kismi','depozito'].includes(odDurum) && (alinanKontrol <= 0 || alinanKontrol > toplamKontrol)) {
      toast(`Alınan/depozito tutarı 0'dan büyük ve toplamdan (${fmt(toplamKontrol)}) fazla olmamalı`,'error'); return;
    }
  }

  // Form açık kaldıktan sonra aynı oda için giriş günü gelmiş başka bir rezervasyon oluştuysa
  // sessizce üzerine yazma. Önce rezervasyon kararı zorunlu.
  if(!window._ciKaynakRevId && kararBekleyenRezervasyonlar(no).length) {
    closeModal('checkinModal');
    rezKararModalAc(no);
    return;
  }

  // ÇAKIŞMA KONTROLÜ — kendisinden check-in yapılan rezervasyon hariç
  const kendiRevId = window._ciKaynakRevId || null;
  const kontrol = odaCakismaKontrol(no, giris, cikis, kendiRevId);
  if(kontrol.cakisma) {
    toast(`⚠ Oda ${no} bu tarihlerde dolu! (${kontrol.tip === 'rezervasyon' ? 'Rezervasyon' : 'Konaklama'}: ${kontrol.detay})`, 'error');
    return;
  }

  // Sözleşme önizlemesi artık window._O'yu DEĞİŞTİRMEZ. Eski sürüm form henüz
  // kaydedilmeden odayı yerelde "dolu" yapıyor ve hata/iptal halinde hayalet doluluk
  // oluşturabiliyordu. Önizleme için bağımsız veri nesnesi kullanılır.
  const now = nowISO();
  const odeme = document.getElementById('ci_odeme').value;
  const kaynak = document.getElementById('ci_kaynak').value;
  const gece = geceSayisi(giris, cikis);
  const yetiskin = parseInt(document.getElementById('ci_yetiskin').value)||1;
  const cocuk    = parseInt(document.getElementById('ci_cocuk').value)||0;
  const not_     = document.getElementById('ci_not').value;
  const email    = document.getElementById('ci_email')?.value.trim()||'';
  const plaka    = document.getElementById('ci_plaka')?.value.trim()||'';
  const fiyatTip = Number(document.getElementById('ci_fiyat_tip')?.value)||1;
  const refakatciler = getRefakatciler();
  const odemeDurumOnizleme = document.getElementById('ci_odeme_durum')?.value || 'odenmedi';
  const sozlesmeFiyatOnizleme = document.getElementById('ci_sozlesme_fiyat')?.value ? Number(document.getElementById('ci_sozlesme_fiyat').value) : null;
  const toplamOnizleme = (sozlesmeFiyatOnizleme || fiyat) * gece;
  const kismiOnizleme = ['kismi','depozito'].includes(odemeDurumOnizleme) ? (Number(document.getElementById('ci_kismi_tutar')?.value)||0) : null;
  const tahsilOnizleme = odemeAlinanTutar(odemeDurumOnizleme, toplamOnizleme, kismiOnizleme);
  const sozlesmeOnizleme = {
    durum:'dolu', misafir:ad, tc, pasaport,
    tel: document.getElementById('ci_tel').value.trim(), email, plaka, kaynak,
    fiyatTip, fiyat, sozlesmeFiyat:sozlesmeFiyatOnizleme,
    odemeTuru:odeme, odemeDurum:odemeDurumOnizleme,
    kismiTutar:kismiOnizleme, kismiKalan:Math.max(0, toplamOnizleme-tahsilOnizleme),
    odemeToplam:toplamOnizleme, tahsilEdilen:tahsilOnizleme,
    kalanTutar:Math.max(0, toplamOnizleme-tahsilOnizleme),
    giris, cikis, girisSaati:now, yetiskin, cocuk, not:not_, refakatciler,
    dt:document.getElementById('ci_dt')?.value || '',
    araciAd:window._ciAraciAd || document.getElementById('ci_komisyoncu')?.value.trim() || null
  };
  const ozOnizleme = window._OZ?.['oda'+no] || {};
  const odaAdiOnizleme = ozOnizleme.ad ? `Oda ${no} — ${ozOnizleme.ad}` : `Oda ${no}`;
  const sozNoOnizleme = `SW-${Date.now().toString().slice(-6)}`;
  const resNoOnizleme = `RES-${Date.now().toString().slice(-5)}`;
  const fmtTarihOnizleme = (t) => { if(!t) return '—'; const [y,m,d]=t.split('-'); return `${d}.${m}.${y}`; };
  const odemeDurumMapOnizleme = {odenmedi:'Ödenmedi',odendi:'Ödendi',depozito:'Depozito Alındı',kismi:'Kısmi Ödeme'};
  let odemeDurumMetni = odemeDurumMapOnizleme[odemeDurumOnizleme] || 'Ödenmedi';
  if(kismiOnizleme != null) odemeDurumMetni += ` (${Number(kismiOnizleme).toLocaleString('tr-TR')} ₺ alındı, ${Math.max(0,toplamOnizleme-kismiOnizleme).toLocaleString('tr-TR')} ₺ kalan)`;
  printSozlesmeFromData(sozlesmeOnizleme, odaAdiOnizleme, gece, sozNoOnizleme, resNoOnizleme, sozlesmeFiyatOnizleme||fiyat, toplamOnizleme, odemeDurumMetni, fmtTarihOnizleme);

  // Ödeme özetini hazırla
  const sozlesmeFiyatVal = Number(document.getElementById('ci_sozlesme_fiyat')?.value) || fiyat;
  const toplamTutar = sozlesmeFiyatVal * gece;
  const odemeDurumVal = document.getElementById('ci_odeme_durum')?.value || 'odenmedi';
  const kismiTutarVal = ['kismi','depozito'].includes(odemeDurumVal) ? (Number(document.getElementById('ci_kismi_tutar')?.value)||0) : 0;
  const kalanTutar = ['kismi','depozito'].includes(odemeDurumVal)
    ? Math.max(0, toplamTutar - kismiTutarVal)
    : (odemeDurumVal === 'odendi' ? 0 : toplamTutar);

  const fmt = n => Number(n).toLocaleString('tr-TR') + ' ₺';
  const durumMap = {odenmedi:'❌ Ödenmedi', odendi:'✅ Ödendi', depozito:'🔒 Depozito Alındı', kismi:'⚠ Kısmi Ödeme'};

  document.getElementById('ciOdemToplamTutar').textContent = fmt(toplamTutar);
  document.getElementById('ciOdemDurumGoster').textContent = durumMap[odemeDurumVal] || odemeDurumVal;
  document.getElementById('ciOdemDurumGoster').style.color = kalanTutar > 0 ? 'var(--red)' : 'var(--green)';

  const satir3 = document.getElementById('ciOdemOzetSatir3');
  const satir4 = document.getElementById('ciOdemOzetSatir4');
  const ekWrap = document.getElementById('ciEkOdemeWrap');

  if(['kismi','depozito'].includes(odemeDurumVal)) {
    satir3.style.display = 'flex';
    document.getElementById('ciOdemAlinan').textContent = fmt(kismiTutarVal);
    satir4.style.display = 'flex';
    document.getElementById('ciOdemKalan').textContent = fmt(kalanTutar);
    ekWrap.style.display = 'block';
    document.getElementById('ciEkOdemeTutar').value = '';
    document.getElementById('ciEkOdemeKalanGoster').textContent = `Kalan: ${fmt(kalanTutar)}`;
  } else if(odemeDurumVal === 'odenmedi') {
    satir3.style.display = 'none';
    satir4.style.display = 'flex';
    document.getElementById('ciOdemKalan').textContent = fmt(toplamTutar);
    ekWrap.style.display = 'block';
    document.getElementById('ciEkOdemeTutar').value = '';
    document.getElementById('ciEkOdemeKalanGoster').textContent = `Kalan: ${fmt(toplamTutar)}`;
  } else {
    satir3.style.display = 'none';
    satir4.style.display = 'none';
    ekWrap.style.display = 'none';
  }

  // Sözleşme yazdırıldıktan sonra check-in onay modalı
  setTimeout(() => openModal('sozlesmeOnayModal'), 500);
};

// ── CHECK-IN ──
window.ciEkOdemeHesapla = function() {
  const no = currentCheckinOda;
  const oda = window._O['oda'+no] || {};
  const fiyat = Number(document.getElementById('ci_fiyat').value)||0;
  const sozlesmeFiyat = Number(document.getElementById('ci_sozlesme_fiyat')?.value)||fiyat;
  const gece = geceSayisi(document.getElementById('ci_giris').value, document.getElementById('ci_cikis').value)||1;
  const toplamTutar = sozlesmeFiyat * gece;
  const odemeDurumVal = document.getElementById('ci_odeme_durum')?.value || 'odenmedi';
  const oncekiAlinan = ['kismi','depozito'].includes(odemeDurumVal) ? (Number(document.getElementById('ci_kismi_tutar')?.value)||0) : 0;
  const ekTutar = Number(document.getElementById('ciEkOdemeTutar').value)||0;
  const toplamAlinan = oncekiAlinan + ekTutar;
  const kalan = Math.max(0, toplamTutar - toplamAlinan);
  const fmt = n => Number(n).toLocaleString('tr-TR') + ' ₺';
  document.getElementById('ciEkOdemeKalanGoster').textContent =
    ekTutar > 0
      ? `Alınan: ${fmt(toplamAlinan)} → Kalan: ${fmt(kalan)}`
      : `Kalan: ${fmt(toplamTutar - oncekiAlinan)}`;
};

window.ciOdemeOnaylaVeCheckin = async function() {
  const no = currentCheckinOda;
  const fiyat = Number(document.getElementById('ci_fiyat').value)||0;
  const sozlesmeFiyat = Number(document.getElementById('ci_sozlesme_fiyat')?.value)||fiyat;
  const gece = geceSayisi(document.getElementById('ci_giris').value, document.getElementById('ci_cikis').value)||1;
  const toplamTutar = sozlesmeFiyat * gece;
  const odemeDurumVal = document.getElementById('ci_odeme_durum')?.value || 'odenmedi';
  const kismiTutarVal = ['kismi','depozito'].includes(odemeDurumVal) ? (Number(document.getElementById('ci_kismi_tutar')?.value)||0) : 0;

  // Ek ödeme alındıysa güncelle
  const ekTutar = Number(document.getElementById('ciEkOdemeTutar')?.value)||0;
  const ekTur = document.getElementById('ciEkOdemeTur')?.value || 'nakit';
  if(kismiTutarVal > 0 && !window._ciOncekiOdeme) {
    window._ciOncekiOdeme = {tutar:kismiTutarVal,tur:document.getElementById('ci_odeme')?.value||'nakit',tarih:nowISO(),asama:'checkin_on_odeme'};
  }
  window._ciEkOdeme = ekTutar > 0 ? { tutar:ekTutar, tur:ekTur, tarih:nowISO(), asama:'checkin_ek_odeme' } : null;
  if(ekTutar > 0) {
    const toplamAlinan = kismiTutarVal + ekTutar;
    const kalanSonra = Math.max(0, toplamTutar - toplamAlinan);
    // Ödeme durumunu güncelle
    const odDurumEl = document.getElementById('ci_odeme_durum');
    const kismiEl = document.getElementById('ci_kismi_tutar');
    if(odDurumEl) {
      if(kalanSonra <= 0) {
        odDurumEl.value = 'odendi';
        const kismiWrap = document.getElementById('ci_kismi_wrap');
        if(kismiWrap) kismiWrap.style.display = 'none';
      } else {
        odDurumEl.value = 'kismi';
        if(kismiEl) kismiEl.value = toplamAlinan;
        const kismiWrap = document.getElementById('ci_kismi_wrap');
        if(kismiWrap) kismiWrap.style.display = 'block';
      }
    }
  }

  closeModal('sozlesmeOnayModal');
  await saveCheckin();
};

window.openCheckin = function(no) {
  const mevcutOda = window._O['oda'+no] || {};
  const odaDurum = mevcutOda.durum;
  // Aktif konaklama, planlanan çıkış tarihi geçmiş olsa bile CHECK-OUT yapılmadan
  // kapanmış sayılmaz. Aynı odaya ikinci check-in kesinlikle açılamaz.
  if(odaDurum === 'dolu') {
    const kalan = window.odaKalanBorc(mevcutOda);
    toast(`Oda ${no} için aktif konaklama var (${mevcutOda.misafir||'misafir'}). Önce check-out işlemini tamamlayın${kalan>0 ? ` · Kalan ödeme: ${fmt(kalan)}` : ''}.`, 'error');
    return;
  }
  if(odaDurum === 'arizali') {
    toast(`Oda ${no} arızalı/bakımda — check-in yapılamaz. Önce oda durumunu güncelleyin.`, 'error');
    return;
  }

  // Giriş günü gelmiş ancak check-in edilmemiş eski rezervasyon varsa oda kilitli değildir,
  // fakat kayıt çözülmeden yeni misafir kaydına geçilmez.
  if(rezKararModalAc(no)) return;

  currentCheckinOda = no;
  window._ciKaynakRevId = null; // boş check-in, rezervasyondan gelmiyor
  window._ciOrijinalGiris = null;
  window._ciAraciAd = null;
  window._ciKomisyoncuKey = null;
  window._ciOncekiOdeme = null;
  window._ciEkOdeme = null;
  document.getElementById('checkinTitle').textContent = `Check-in — Oda ${no}`;
  // Temizle
  ['ci_tc','ci_ad','ci_tel','ci_email','ci_plaka','ci_not','ci_dt','ci_komisyoncu'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  ['ci_ozet_giris','ci_ozet_gece','ci_ozet_cikis','ci_ozet_toplam','ci_ozet_giris_gun','ci_ozet_cikis_gun'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='—';});
  const ozOdaEl = document.getElementById('ci_ozet_oda'); if(ozOdaEl) ozOdaEl.textContent = no;
  const ciKomisyoncuAdinaEl = document.getElementById('ci_komisyoncu_adina'); if(ciKomisyoncuAdinaEl) ciKomisyoncuAdinaEl.checked = false;
  clearRefakatciler();;
  document.getElementById('ci_giris').value = today();
  document.getElementById('ci_gece').value = 1;
  document.getElementById('ci_yetiskin').value = 1;
  document.getElementById('ci_cocuk').value = 0;
  document.getElementById('ci_kaynak').value = 'walk-in';
  document.getElementById('ci_odeme').value = 'nakit';
  document.getElementById('ci_odeme_durum').value = ''; // her check-in'de personel bilinçli seçim yapmak zorunda
  document.getElementById('ci_saat').value = new Date().toLocaleTimeString('tr-TR');
  document.getElementById('musteriBulundu').style.display = 'none';
  // Manuel fiyat flag'ini sıfırla
  const cifEl = document.getElementById('ci_fiyat');
  if(cifEl) { cifEl.value=''; cifEl.dataset.manuelDegisim=''; }
  document.getElementById('ci_kismi_wrap').style.display='none';
  document.getElementById('ci_kismi_tutar').value='';

  // Fiyat tipi doldur
  const sel = document.getElementById('ci_fiyat_tip');
  sel.innerHTML = [1,2,3,4].map(t=>`<option value="${t}">${getTipAd(t)} — ${getOdaFiyat(no,t).toLocaleString('tr-TR')} ₺</option>`).join('');
  fiyatTipGuncelle();
  hesaplaKonaklama();
  kisilerGuncelle();

  openModal('checkinModal');
};

window.hesaplaKonaklama = function() {
  const giris = document.getElementById('ci_giris').value;
  const gece  = parseInt(document.getElementById('ci_gece').value) || 1;
  const dogrudanCheckin = !window._ciKaynakRevId; // rezervasyondan değil, doğrudan açılan check-in

  // Geçmiş tarih engeli
  if(giris && giris < today()) {
    toast('Giriş tarihi geçmiş tarih olamaz', 'error');
    document.getElementById('ci_giris').value = today();
    return;
  }

  // Doğrudan (rezervasyonsuz) check-in'de ileri tarih engeli — check-in "şu an doluyum" demektir
  if(dogrudanCheckin && giris && giris > today()) {
    toast('Doğrudan check-in için giriş tarihi bugün olmalı. İleri tarihli giriş için Rezervasyon oluşturun.', 'error');
    document.getElementById('ci_giris').value = today();
    return;
  }

  if(giris) {
    const cikis = addDays(giris, gece);
    document.getElementById('ci_cikis').value = cikis;
    const cikisGosterEl = document.getElementById('ci_cikis_goster'); if(cikisGosterEl) cikisGosterEl.value = cikis + ` (${gece} gece)`;
    const ozGirisEl = document.getElementById('ci_ozet_giris'); if(ozGirisEl) ozGirisEl.textContent = formatTarihGoster(giris);
    const ozGirisGunEl = document.getElementById('ci_ozet_giris_gun'); if(ozGirisGunEl) {
      // Erken giriş: rezervasyondan gelen check-in'de misafir, sistemde kayıtlı planlanan
      // tarihten daha erken giriyorsa personel bunu görsün — komisyon hesaplaması zaten
      // gerçek (girilen) tarihe göre otomatik doğru çalışır, bu sadece bilgilendirme amaçlı.
      const erkenGiris = window._ciOrijinalGiris && giris < window._ciOrijinalGiris;
      ozGirisGunEl.innerHTML = gunAdiGoster(giris) + (erkenGiris ? ` <span class="badge badge-gold" style="font-size:9px">Erken Giriş · Planlanan: ${window._ciOrijinalGiris}</span>` : '');
    }
    const ozGeceEl = document.getElementById('ci_ozet_gece'); if(ozGeceEl) ozGeceEl.textContent = gece;
    const ozCikisEl = document.getElementById('ci_ozet_cikis'); if(ozCikisEl) ozCikisEl.textContent = formatTarihGoster(cikis);
    const ozCikisGunEl = document.getElementById('ci_ozet_cikis_gun'); if(ozCikisGunEl) ozCikisGunEl.textContent = `${gunAdiGoster(cikis)} (${gece} Gece)`;
  }
  fiyatTipGuncelle();
};

window.kisilerGuncelle = function() {
  const y = parseInt(document.getElementById('ci_yetiskin')?.value)||1;
  const c = parseInt(document.getElementById('ci_cocuk')?.value)||0;
  const topEl = document.getElementById('ci_toplam_kisi');
  if(topEl) topEl.value = `${y+c} kişi (${y} yetişkin${c>0?`, ${c} çocuk`:''})`;
};

// Mockup'taki +/- stepper kontrolleri için
window.ciKisiAyarla = function(id, delta) {
  const el = document.getElementById(id);
  if(!el) return;
  const min = id === 'ci_yetiskin' ? 1 : 0;
  const val = Math.max(min, (parseInt(el.value)||min) + delta);
  el.value = val;
  kisilerGuncelle();
};
window.revKisiAyarla = function(id, delta) {
  const el = document.getElementById(id);
  if(!el) return;
  const min = id === 'rev_yetiskin' ? 1 : 0;
  const val = Math.max(min, (parseInt(el.value)||min) + delta);
  el.value = val;
};

document.getElementById('ci_yetiskin')?.addEventListener('input', kisilerGuncelle);
document.getElementById('ci_cocuk')?.addEventListener('input', kisilerGuncelle);

window.fiyatTipGuncelle = function() {
  const no    = currentCheckinOda;
  const tip   = Number(document.getElementById('ci_fiyat_tip')?.value)||1;
  const gece  = parseInt(document.getElementById('ci_gece')?.value)||1;
  const fiyat = getOdaFiyat(no, tip);
  const fiyatEl = document.getElementById('ci_fiyat');
  // Sadece kullanıcı değiştirmediyse otomatik doldur
  if(!fiyatEl.dataset.manuelDegisim) {
    fiyatEl.value = fiyat || '';
  }
  ciFiyatGuncelle();
};

// Kısmi ödeme — toplam üzerinden kalan tutarı göster
function kismiKalanGuncelle(prefix, toplam) {
  const kismiEl  = document.getElementById(prefix + '_kismi_tutar');
  const kalanEl  = document.getElementById(prefix + '_kismi_kalan');
  if(!kismiEl || !kalanEl) return;
  const alinan = Number(kismiEl.value) || 0;
  const kalan = Math.max(0, toplam - alinan);
  kalanEl.textContent = toplam > 0
    ? `Toplam: ${fmt(toplam)} · Alınan: ${fmt(alinan)} · Kalan: ${fmt(kalan)}`
    : '';
}

window.ciFiyatGuncelle = function() {
  const gece  = parseInt(document.getElementById('ci_gece')?.value)||1;
  const fiyat = Number(document.getElementById('ci_fiyat')?.value)||0;
  const toplam = fiyat * gece;
  const subEl = document.getElementById('ci_fiyat_toplam_sub');
  if(subEl) subEl.textContent = toplam > 0 ? fmt(toplam) : '—';
  const ozTutarEl = document.getElementById('ci_ozet_toplam');
  if(ozTutarEl) ozTutarEl.textContent = toplam > 0 ? fmt(toplam) : '—';
  sozlesmeToplam('ci');
};

// TC doğrulama (Türkiye Cumhuriyeti kimlik algoritması)
function tcDogrula(tc) {
  if(!tc || tc.length !== 11 || !/^\d{11}$/.test(tc)) return false;
  if(tc[0] === '0') return false;
  const d = tc.split('').map(Number);
  const s1 = (d[0]+d[2]+d[4]+d[6]+d[8])*7 - (d[1]+d[3]+d[5]+d[7]);
  if((s1%10) !== d[9]) return false;
  const s2 = d.slice(0,10).reduce((a,b)=>a+b,0);
  return (s2%10) === d[10];
}

// TC Arama
window.tcAra = async function(tc) {
  const tcEl = document.getElementById('ci_tc');
  const uyariEl = document.getElementById('tc_uyari');
  if(uyariEl) uyariEl.remove();
  if(tc.length !== 11) {
    document.getElementById('musteriBulundu').style.display='none';
    tcEl.style.borderColor='';
    return;
  }
  if(!tcDogrula(tc)) {
    tcEl.style.borderColor = 'var(--red)';
    document.getElementById('musteriBulundu').style.display='none';
    toast('TC Kimlik No geçersiz','error');
    return;
  }
  tcEl.style.borderColor = 'var(--green)';
  try {
    const q = query(collection(db,'musteriler'), where('tc','==',tc));
    const snap = await getDocs(q);
    if(!snap.empty) {
      const m = snap.docs[0].data();
      document.getElementById('ci_ad').value = m.ad || '';
      document.getElementById('ci_tel').value = m.tel || '';
      document.getElementById('ci_email').value = m.email || '';
      document.getElementById('ci_plaka').value = m.plaka || '';
      document.getElementById('mb-ad').textContent = `${m.ad} — Kayıtlı Müşteri`;
      document.getElementById('mb-meta').textContent = `${m.konaklamaSayisi||0} kez konaklamış · Son: ${m.sonKonaklama||'—'}`;
      document.getElementById('musteriBulundu').style.display = 'flex';
      document.getElementById('ci_ad').dataset.kayitliAd = m.ad || '';
    } else {
      document.getElementById('musteriBulundu').style.display = 'none';
      document.getElementById('ci_ad').dataset.kayitliAd = '';
    }
  } catch(e) {}
};

window.adDegistiKontrol = function() {
  const ad = document.getElementById('ci_ad').value.trim();
  const kayitliAd = document.getElementById('ci_ad').dataset.kayitliAd || '';
  const eski = document.getElementById('tc_uyari');
  if(eski) eski.remove();
  if(!kayitliAd || !ad) return;
  if(ad.toLowerCase() !== kayitliAd.toLowerCase()) {
    const uyari = document.createElement('div');
    uyari.id = 'tc_uyari';
    uyari.style.cssText = 'background:#fff0f2;border:1px solid #f5c6cb;padding:8px 12px;font-size:12px;color:#C8102E;margin-bottom:10px;display:flex;align-items:center;gap:6px;border-radius:3px;';
    uyari.innerHTML = `⚠ <span>Bu TC ile sistemde kayıtlı kişi: <strong>${kayitliAd}</strong> — Girdiğiniz isim farklı, kontrol edin.</span>`;
    document.getElementById('ci_ad').insertAdjacentElement('afterend', uyari);
  }
};

window.tcTemizle = function() {
  document.getElementById('ci_tc').value='';
  document.getElementById('musteriBulundu').style.display='none';
};

window.saveCheckin = async function() {
  const no     = currentCheckinOda;
  if(window._O['oda'+no]?.durum === 'arizali') { toast(`Oda ${no} arızalı/bakımda — check-in yapılamaz.`, 'error'); return; }
  const tc     = document.getElementById('ci_tc').value.trim();
  const pasaport = document.getElementById('ci_pasaport')?.value.trim().toUpperCase() || '';
  const ad     = document.getElementById('ci_ad').value.trim();
  const tel    = document.getElementById('ci_tel').value.trim();
  const email  = document.getElementById('ci_email').value.trim();
  const plaka  = document.getElementById('ci_plaka').value.trim().toUpperCase();
  const giris  = document.getElementById('ci_giris').value;
  const cikis  = document.getElementById('ci_cikis').value;
  const gece   = parseInt(document.getElementById('ci_gece').value)||1;
  const yetiskin = parseInt(document.getElementById('ci_yetiskin').value)||1;
  const cocuk  = parseInt(document.getElementById('ci_cocuk').value)||0;
  const kaynak = document.getElementById('ci_kaynak').value;
  const odeme  = document.getElementById('ci_odeme').value;
  const fiyatTip = Number(document.getElementById('ci_fiyat_tip').value)||1;
  const fiyat  = Number(document.getElementById('ci_fiyat').value)||0;
  const not_   = document.getElementById('ci_not').value;
  const now    = nowISO();
  const ciAraciYazilan = (window._ciAraciAd || document.getElementById('ci_komisyoncu')?.value.trim() || '');
  const ciKomisyoncuKey = window._ciKomisyoncuKey || komisyoncuKeyBul(ciAraciYazilan, window._ciKomisyoncuKey||'') || '';
  const ciAraciAd = araciKanonikAd(ciAraciYazilan || window.KOMISYONCULAR?.[ciKomisyoncuKey]?.ad || '');
  const ciKomisyoncuAdina = document.getElementById('ci_komisyoncu_adina')?.checked || false;

  if(!ad) { toast('Misafir adı zorunlu','error'); return; }
  if(ciKomisyoncuAdina && !ciAraciAd && !ciKomisyoncuKey) { toast('Komisyoncu adına check-in için Komisyoncu / Acente seçimi zorunludur','error'); return; }
  if(!window._ciKaynakRevId && giris && giris > today()) { toast('Doğrudan check-in için giriş tarihi bugün olmalı. İleri tarihli giriş için Rezervasyon kullanın.','error'); return; }
  if(!giris||!cikis) { toast('Tarih zorunlu','error'); return; }
  if(tc && tc.length===11 && !tcDogrula(tc)) { toast('TC Kimlik No geçersiz — lütfen kontrol edin','error'); return; }
  if(!fiyat || fiyat <= 0) { toast('Gecelik fiyat girilmeden check-in yapılamaz — Fiyat Tipi seçin veya fiyatı kontrol edin','error'); return; }
  const ciSozlesmeFiyatKontrol = document.getElementById('ci_sozlesme_fiyat')?.value ? Number(document.getElementById('ci_sozlesme_fiyat').value) : null;
  const ciFiyatKontrol = komisyonFiyatDogrula(fiyat, ciSozlesmeFiyatKontrol, ciAraciAd, ciKomisyoncuKey);
  if(!ciFiyatKontrol.ok) { toast('⚠ '+ciFiyatKontrol.mesaj,'error'); return; }
  // Ödeme durumu ZORUNLU — müşteri nereden gelirse gelsin (walk-in, komisyoncu,
  // online rezervasyon fark etmez) check-in'de ödeme durumu mutlaka sorulup
  // seçilmeli. Boş bırakılıp sessizce "ödenmedi"ye düşmesine izin verilmiyor.
  const odemeDurumSecimi = document.getElementById('ci_odeme_durum')?.value || '';
  if(!odemeDurumSecimi) { toast('⚠ Ödeme durumu seçilmeden check-in yapılamaz — Ödendi / Ödenmedi / Kısmi / Depozito seçin','error'); return; }
  if(['kismi','depozito'].includes(odemeDurumSecimi)) {
    const kismiVal = Number(document.getElementById('ci_kismi_tutar')?.value)||0;
    if(kismiVal <= 0) { toast('⚠ Kısmi ödeme/depozito seçildi ama alınan tutar girilmedi','error'); return; }
  }

  // ÇAKIŞMA KONTROLÜ — son güvenlik: sözleşme önizlemesi artık _O'yu değiştirmediği
  // için yapay "geçici oda boşalt" hilesine ihtiyaç yok.
  {
    const kontrol = odaCakismaKontrol(no, giris, cikis, window._ciKaynakRevId || null);
    if(kontrol.cakisma) {
      toast(`⚠ Oda ${no} bu tarihlerde dolu! Check-in iptal edildi. (${kontrol.detay})`, 'error');
      return;
    }
  }

  if(window._checkinKaydediliyor) { toast('Check-in zaten kaydediliyor…','info'); return; }
  window._checkinKaydediliyor = true;
  try {
  const girisSaati = new Date().toLocaleTimeString('tr-TR');
  const toplam = gece * fiyat;
  const gelirDocId = konaklamaGelirId(no,giris,tc,ad,window._ciKaynakRevId||'');
  const konaklamaKey = `${no}|${temizAnahtar(tc||ad)}|${giris}`;

  // Oda güncelle — ödeme özeti oda kaydında açık biçimde tutulur. Böylece
  // checkout yapılana kadar resepsiyon ekranı her zaman kalan borcu gösterebilir.
  const refakatciler = getRefakatciler();
  const odaOdemeDurum = document.getElementById('ci_odeme_durum')?.value || 'odenmedi';
  const odaKismiTutar = ['kismi','depozito'].includes(odaOdemeDurum) ? (Number(document.getElementById('ci_kismi_tutar')?.value)||0) : null;
  const odaSozlesmeFiyat = document.getElementById('ci_sozlesme_fiyat')?.value ? Number(document.getElementById('ci_sozlesme_fiyat').value) : null;
  const odaOdemeToplam = (odaSozlesmeFiyat || fiyat) * gece;
  const odaTahsilEdilen = odemeAlinanTutar(odaOdemeDurum, odaOdemeToplam, odaKismiTutar);
  const odaKalanTutar = Math.max(0, odaOdemeToplam - odaTahsilEdilen);
  const odemeHareketleri = [];
  if(window._ciOncekiOdeme?.tutar > 0) odemeHareketleri.push(window._ciOncekiOdeme);
  if(window._ciEkOdeme?.tutar > 0) odemeHareketleri.push(window._ciEkOdeme);
  if(!window._ciOncekiOdeme && !window._ciEkOdeme && odaTahsilEdilen > 0) {
    odemeHareketleri.push({tutar:odaTahsilEdilen,tur:odeme,tarih:now,asama:window._ciKaynakRevId?'rezervasyon_on_odeme':'checkin'});
  }
  const yeniOdaKaydi = {durum:'dolu',misafir:ad,tc,pasaport,tel,email,plaka,kaynak,fiyatTip,fiyat,sozlesmeFiyat:odaSozlesmeFiyat,odemeTuru:odeme,odemeDurum:odaOdemeDurum,kismiTutar:odaKismiTutar,kismiKalan:odaKalanTutar,odemeToplam:odaOdemeToplam,tahsilEdilen:odaTahsilEdilen,kalanTutar:odaKalanTutar,odemeHareketleri,giris,cikis,girisSaati,yetiskin,cocuk,not:not_,refakatciler,dt:document.getElementById('ci_dt')?.value||'',araciAd:ciAraciAd||null,komisyoncu:ciKomisyoncuKey||null,komisyoncuAd:ciAraciAd||null,guncelleme:now,gelirKaydedildi:true,gelirDocId,konaklamaKey,rezervasyonId:window._ciKaynakRevId||null};

  // Aynı odaya iki cihazın aynı anda check-in yapmasını transaction ile engelle.
  // Firestore transaction çevrimdışı çalışmadığı için gerçek offline durumda yerel kuyruğa
  // düşen alan-bazlı yazıma geri dönülür; bağlantı varken yarış koşulu engellenir.
  const odaMetaRef = doc(db,'meta','odalar');
  if(navigator.onLine) {
    await runTransaction(db, async tx => {
      const snap = await tx.get(odaMetaRef);
      const canliOda = snap.exists() ? (snap.data()?.['oda'+no] || {}) : {};
      if(canliOda.durum === 'dolu') throw new Error(`ODA_DOLU:${canliOda.misafir||'aktif misafir'}`);
      if(canliOda.durum === 'arizali') throw new Error('ODA_ARIZALI');
      tx.set(odaMetaRef, { ['oda'+no]: yeniOdaKaydi }, {merge:true});
    });
    window._O['oda'+no] = yeniOdaKaydi;
  } else {
    await odaMetaKaydet(no, yeniOdaKaydi);
    toast('Çevrimdışı check-in kaydedildi. Bağlantı gelince senkronize edilecek; aynı odayı başka cihazda kullanmayın.', 'info');
  }

  const sozlesmeFiyatVal = window._O['oda'+no]?.sozlesmeFiyat || null;
  const araciAdVal = window._O['oda'+no]?.araciAd || null;
  const komKaynakRev = window._ciKaynakRevId ? (window._R||[]).find(r=>r.id===window._ciKaynakRevId) : null;
  const komSnapshot = komisyonSnapshotAl(window._O['oda'+no]?.komisyoncu || window._ciKomisyoncuKey||'', araciAdVal||'', komKaynakRev);
  const komisyonHesabi = komisyonToplamHesapla({
    otelFiyat:fiyat,
    sozlesmeFiyat:sozlesmeFiyatVal,
    gece,
    araciAd:araciAdVal||'',
    komisyoncuKey:window._O['oda'+no]?.komisyon||window._ciKomisyoncuKey||'',
    komisyonTipSnapshot:komSnapshot.tip, komisyonDegerSnapshot:komSnapshot.deger
  });
  const komisyonFark = komisyonHesabi.toplam;

  // Gelir kaydı
  if(toplam > 0) {
    const odDurumVal = document.getElementById('ci_odeme_durum')?.value||'odenmedi';
    const kismiTutarVal = ['kismi','depozito'].includes(odDurumVal) ? (Number(document.getElementById('ci_kismi_tutar')?.value)||0) : null;
    const sozlesmeToplam = (sozlesmeFiyatVal||fiyat)*gece;
    const alinanTutar = odemeAlinanTutar(odDurumVal,sozlesmeToplam,kismiTutarVal);
    await setDoc(doc(db,'gelirler',gelirDocId),{
      kayitTip:'konaklama', gelirDocId, rezervasyonId:window._ciKaynakRevId||null, konaklamaKey, giris, cikis,
      tarih:giris, tutar:toplam, odaNo:String(no),
      odemeTuru:odeme, odemeDurum:odDurumVal,
      tahsilEdilen:alinanTutar, kalanTahsilat:Math.max(0,sozlesmeToplam-alinanTutar),
      odemeHareketleri,
      kismiTutar: kismiTutarVal,
      kismiKalan: kismiTutarVal!=null ? Math.max(0, sozlesmeToplam - kismiTutarVal) : (odDurumVal==='odendi'?0:sozlesmeToplam),
      misafir:ad, tc, kaynak,
      fiyatTip, fiyatTipAd:getTipAd(fiyatTip),
      girisSaati, yetiskin, cocuk, gece, fiyat,
      sozlesmeFiyat: sozlesmeFiyatVal || null,
      komisyonFark: komisyonFark || null,
      araciAd: window._O['oda'+no]?.araciAd || null,
      komisyoncu: window._O['oda'+no]?.komisyoncu || komisyoncuKeyBul(window._O['oda'+no]?.araciAd||'', window._ciKomisyoncuKey||'') || null,
      aciklama:`Oda ${no} · ${gece} gece · ${getTipAd(fiyatTip)} · ${kaynak}`,
      kayitTarih:now,guncelleme:now
    },{merge:true});
  }

  // Komisyon kaydı
  if(komisyonFark > 0) {
    await setDoc(doc(db,'komisyonlar','komisyon_'+gelirDocId),{
      gelirDocId, konaklamaKey, tarih:giris, odaNo:String(no), misafir:ad, tc, kaynak,
      gece, gercekFiyat:fiyat, sozlesmeFiyat:sozlesmeFiyatVal,
      gecelikKomisyon:komisyonHesabi.gecelik, komisyonKaynak:komisyonHesabi.kaynak,
      komisyonFark, toplamKomisyon:komisyonFark,
      araciAd: araciKanonikAd(window._O['oda'+no]?.araciAd || '') || null,
      komisyoncu: window._O['oda'+no]?.komisyoncu || komisyoncuKeyBul(window._O['oda'+no]?.araciAd||'', window._ciKomisyoncuKey||'') || null,
      komisyoncuAd: araciKanonikAd(window._O['oda'+no]?.araciAd || '') || null,
      rezervasyonId: window._ciKaynakRevId || null,
      komisyonTipSnapshot:komSnapshot.tip, komisyonDegerSnapshot:komSnapshot.deger, komisyonSnapshotKaynak:komSnapshot.kaynak,
      cariDahil:true, mutabakatDurum:'yeni_dogrulanmis',
      komisyonHareketleri:[{tarih:now,tutar:komisyonFark,tip:'hakedis',aciklama:`Check-in hakedişi · Oda ${no} · ${gece} gece`}],
      kayitTarih:now,guncelleme:now
    },{merge:true});
  } else if(!araciAdVal) {
    // Aynı konaklama daha önce acentaya bağlı kaydedildiyse eski hakediş kalmasın.
    try { await deleteDoc(doc(db,'komisyonlar','komisyon_'+gelirDocId)); } catch(_) {}
  }

  // Aktif rezervasyonu güncelle — durum:aktif, fiyat ve sozlesmeFiyat koru
  // Önce doğrudan kaynak rezervasyon id'siyle eşleştir (en güvenilir); yoksa tarih/oda örtüşmesine düş
  const aktifRevDoc = (window._ciKaynakRevId ? window._R.find(r => r.id === window._ciKaynakRevId) : null)
    || window._R.find(r =>
    Number(r.odaNo)===Number(no) && r.giris<=giris && r.cikis>giris && rezervasyonOdayiBloklar(r)
  );
  if(aktifRevDoc?.id) {
    const odDurumVal2 = document.getElementById('ci_odeme_durum')?.value || 'odenmedi';
    const kismiTutarVal2 = ['kismi','depozito'].includes(odDurumVal2) ? (Number(document.getElementById('ci_kismi_tutar')?.value)||0) : null;
    // Erken giriş: misafir, rezervasyonda planlanan tarihten daha erken check-in
    // yapmışsa (veya tarih düzeltilmişse), rezervasyon kaydının giris/cikis alanları
    // da gerçek tarihe eşitlenir. Bu yapılmazsa rezervasyon kaydı eski (planlanan)
    // tarihte kalır ve ileride bu konaklama check-out olduğunda kaynak rezervasyonu
    // bulmak için kullanılan eşleştirmeler (giris string karşılaştırması) tutmaz —
    // takvimlerde tutarsızlığa yol açar.
    await updateDoc(doc(db,'rezervasyonlar', aktifRevDoc.id), {
      durum: 'aktif',
      giris, cikis,
      fiyat: fiyat,
      sozlesmeFiyat: sozlesmeFiyatVal || aktifRevDoc.sozlesmeFiyat || null,
      odemeDurum: odDurumVal2,
      odemeTuru: odeme,
      kismiTutar: kismiTutarVal2,
      kismiKalan: kismiTutarVal2!=null ? Math.max(0,((sozlesmeFiyatVal||fiyat)*gece)-kismiTutarVal2) : null,
    });
    if(aktifRevDoc.kaynakTalepId) {
      try {
        await updateDoc(doc(db,'rezervasyon_talepleri',aktifRevDoc.kaynakTalepId), {
          durum:'aktif', rezervasyonId:aktifRevDoc.id, giris, cikis, gece,
          fiyat, sozlesmeFiyat:sozlesmeFiyatVal||null,
          checkinTarih:today(), islemTarih:nowISO()
        });
      } catch(e) { console.warn('Komisyoncu talebi check-in durumuna geçirilemedi:',e); }
    }
  }

  // Müşteri kaydını güncelle / oluştur
  if(tc) {
    const mq = query(collection(db,'musteriler'), where('tc','==',tc));
    const msnap = await getDocs(mq);
    if(msnap.empty) {
      await addDoc(collection(db,'musteriler'),{tc,ad,tel,email,plaka,konaklamaSayisi:1,sonKonaklama:giris,ilkKayit:now,toplamHarcama:toplam});
    } else {
      const mref = msnap.docs[0].ref;
      const mdata = msnap.docs[0].data();
      await updateDoc(mref,{ad,tel,email,plaka,konaklamaSayisi:(mdata.konaklamaSayisi||0)+1,sonKonaklama:giris,toplamHarcama:(mdata.toplamHarcama||0)+toplam});
    }
  }

  renderOdalar();
  closeModal('checkinModal');
  vardiyaIstatistikGuncelle('checkin');
  await logAktivite('checkin', `${ad} · ${gece} gece · ${getTipAd(fiyatTip)} · ${fmt(toplam)}`, no);
  toast(`Oda ${no} — Check-in ✓ ${toplam>0?fmt(toplam)+' gelir kaydedildi':''}`, 'success');
  } catch(e) {
    console.error('Check-in kayıt hatası:', e);
    const msg = String(e?.message||'');
    if(msg.startsWith('ODA_DOLU:')) toast(`Oda ${no} başka bir cihazda dolu hale geldi (${msg.split(':').slice(1).join(':')}). Check-in yapılmadı.`, 'error');
    else if(msg === 'ODA_ARIZALI') toast(`Oda ${no} başka bir cihazda arızalı/bakımda işaretlendi. Check-in yapılmadı.`, 'error');
    else toast('Check-in tamamlanamadı: '+(e?.message||'Bilinmeyen hata'), 'error');
  } finally {
    window._checkinKaydediliyor = false;
    window._ciEkOdeme = null;
    window._ciOncekiOdeme = null;
  }
};

// Rezervasyondan check-in
window.checkindenRezervasyon = function(rev) {
  const mevcutOda = window._O['oda'+rev.odaNo] || {};
  if(mevcutOda.durum === 'dolu') {
    const kalan = window.odaKalanBorc(mevcutOda);
    toast(`Oda ${rev.odaNo} için ${mevcutOda.misafir||'bir misafir'} hâlâ check-in durumda. Önce check-out yapılmalı${kalan>0 ? ` · Kalan ödeme: ${fmt(kalan)}` : ''}.`, 'error');
    return;
  }
  currentCheckinOda = rev.odaNo;
  window._ciKaynakRevId = rev.id || null;
  // Misafir ve komisyoncu ASLA aynı alandan türetilmez. Eski aracirez kayıtlarında
  // araciAd === misafir ise bu, eski sürümün "aracı adını misafir alanına yaz" modelidir.
  const eskiAraciModeli = !!rev.aracirez && !!rev.araciAd && araciAnahtar(rev.araciAd) === araciAnahtar(rev.misafir||'') && !rev.komisyoncuAd;
  const misafirBekleniyor = !!rev.misafirBilgisiBekleniyor || eskiAraciModeli;
  const kayitliAraciAd = rev.komisyoncuAd || window.KOMISYONCULAR?.[rev.komisyoncu]?.ad || (!eskiAraciModeli ? rev.araciAd : '');
  window._ciAraciAd = araciKanonikAd(kayitliAraciAd || '') || null;
  window._ciKomisyoncuKey = rev.komisyoncu || komisyoncuKeyBul(window._ciAraciAd, rev.komisyoncu||'') || null;
  window._ciOncekiOdeme = null;
  window._ciEkOdeme = null;
  document.getElementById('checkinTitle').textContent = `Check-in — Oda ${rev.odaNo} (Rezervasyon)`;
  if(misafirBekleniyor) {
    document.getElementById('ci_tc').value = '';
    document.getElementById('ci_ad').value = '';
    document.getElementById('ci_tel').value = '';
    document.getElementById('ci_email').value = '';
    document.getElementById('ci_not').value = `${window._ciAraciAd ? 'Komisyoncu: '+window._ciAraciAd : 'Misafir bilgileri check-in’de alınacak'}${rev.not ? ' · ' + rev.not : ''}`;
    document.getElementById('checkinTitle').textContent = `Check-in — Oda ${rev.odaNo}${window._ciAraciAd ? ' 🤝 '+window._ciAraciAd : ''}`;
    toast(`👤 Gerçek misafir bilgilerini girin${window._ciAraciAd ? ` · Komisyoncu: ${window._ciAraciAd}` : ''}`, 'info');
  } else {
    document.getElementById('ci_tc').value = rev.tc || '';
    document.getElementById('ci_ad').value = rev.misafir || '';
    document.getElementById('ci_tel').value = rev.tel || '';
    document.getElementById('ci_email').value = rev.email || '';
    document.getElementById('ci_not').value = rev.not || '';
  }
  document.getElementById('ci_ad').dataset.kayitliAd = '';
  document.getElementById('ci_dt').value = rev.dt || '';
  document.getElementById('ci_komisyoncu').value = window._ciAraciAd || '';
  const ciKomAdina = document.getElementById('ci_komisyoncu_adina'); if(ciKomAdina) ciKomAdina.checked = Boolean(window._ciAraciAd||window._ciKomisyoncuKey);
  document.getElementById('ci_giris').value = rev.giris || today();
  window._ciOrijinalGiris = rev.giris || null; // erken giriş rozetini göstermek için orijinal planlanan tarih saklanır
  document.getElementById('ci_kaynak').value = rev.kaynak || 'walk-in';
  document.getElementById('ci_odeme').value = rev.odemeTuru || 'nakit';
  // Rezervasyonda alınmış ödeme/depozito check-in sırasında KAYBOLMAMALI.
  // Eski sürüm ödeme durumunu bilerek boşalttığı için kısmi/depozito tutarı input'a
  // yazılsa bile alan gizli kalıyor ve personel alınmış ön ödemeyi göremiyordu.
  const rezervasyonOnOdeme = Math.max(0, Number(rev.kismiTutar ?? rev.tahsilEdilen ?? 0) || 0);
  let rezervasyonOdemeDurumu = rev.odemeDurum || 'odenmedi';
  if(rezervasyonOnOdeme > 0 && !['kismi','depozito','odendi'].includes(rezervasyonOdemeDurumu)) {
    rezervasyonOdemeDurumu = 'kismi';
  }
  document.getElementById('ci_odeme_durum').value = rezervasyonOdemeDurumu;
  document.getElementById('ci_yetiskin').value = rev.yetiskin || 1;
  document.getElementById('ci_cocuk').value = rev.cocuk || 0;
  document.getElementById('ci_saat').value = new Date().toLocaleTimeString('tr-TR');
  document.getElementById('musteriBulundu').style.display = 'none';

  // Yanında kalanları rezervasyondan taşı
  clearRefakatciler('refakatciListesi');
  (rev.refakatciler || []).forEach(r => {
    refakatciEkle('refakatciListesi');
    const liste = document.getElementById('refakatciListesi');
    const son = liste.lastElementChild;
    if(son) {
      const adEl = son.querySelector('.ref-ad'); if(adEl) adEl.value = r.ad || '';
      const tcEl = son.querySelector('.ref-tc'); if(tcEl) tcEl.value = r.tc || '';
      const dtEl = son.querySelector('.ref-dt'); if(dtEl) dtEl.value = r.dt || '';
    }
  });

  // Rezervasyonda alınmış ön ödemeyi check-in formuna eksiksiz taşı.
  // Böylece toplam borç, daha önce tahsil edilen tutar ve kalan bakiye aynı akışta görünür.
  const ciKismiWrap = document.getElementById('ci_kismi_wrap');
  const ciKismiTutar = document.getElementById('ci_kismi_tutar');
  if(ciKismiTutar) ciKismiTutar.value = rezervasyonOnOdeme > 0 ? rezervasyonOnOdeme : '';
  if(ciKismiWrap) ciKismiWrap.style.display = ['kismi','depozito'].includes(rezervasyonOdemeDurumu) ? 'block' : 'none';
  window._ciOncekiOdeme = rezervasyonOnOdeme > 0 ? {tutar:rezervasyonOnOdeme,tur:rev.odemeTuru||'nakit',tarih:rev.kayitTarih||rev.guncelleme||nowISO(),asama:'rezervasyon_on_odeme'} : null;
  window._ciEkOdeme = null;
  // Sözleşme fiyatı her zaman boş başlar — check-in anında girilmeli
  const sozFiyatEl = document.getElementById('ci_sozlesme_fiyat');
  if(sozFiyatEl) sozFiyatEl.value = '';

  const eski = document.getElementById('tc_uyari');
  if(eski) eski.remove();

  const gece = geceSayisi(rev.giris, rev.cikis);
  document.getElementById('ci_gece').value = gece;
  // Çıkış tarihini rezervasyondan direkt yaz
  document.getElementById('ci_cikis').value = rev.cikis || addDays(rev.giris || today(), gece);
  document.getElementById('ci_cikis_goster').value = (rev.cikis || '') + ` (${gece} gece)`;

  const sel = document.getElementById('ci_fiyat_tip');
  sel.innerHTML = [1,2,3,4].map(t=>`<option value="${t}"${t==(rev.fiyatTip||1)?' selected':''}>${getTipAd(t)} — ${getOdaFiyat(rev.odaNo,t).toLocaleString('tr-TR')} ₺</option>`).join('');

  // Rezervasyondaki fiyatı direkt yaz — sabit fiyatı değil elle girileni kullan
  const fiyatEl = document.getElementById('ci_fiyat');
  if(fiyatEl && rev.fiyat) {
    fiyatEl.value = rev.fiyat;
    fiyatEl.dataset.manuelDegisim = '1';
  }

  // Sözleşme fiyatı da varsa getir
  const sozFiyatEl2 = document.getElementById('ci_sozlesme_fiyat');
  if(sozFiyatEl2 && rev.sozlesmeFiyat) {
    sozFiyatEl2.value = rev.sozlesmeFiyat;
    sozlesmeToplam('ci');
  }

  const ozGirisEl = document.getElementById('ci_ozet_giris'); if(ozGirisEl) ozGirisEl.textContent = formatTarihGoster(rev.giris);
  const ozGirisGunEl = document.getElementById('ci_ozet_giris_gun'); if(ozGirisGunEl) ozGirisGunEl.textContent = gunAdiGoster(rev.giris);
  const ozGeceEl = document.getElementById('ci_ozet_gece'); if(ozGeceEl) ozGeceEl.textContent = gece;
  const ozCikisEl = document.getElementById('ci_ozet_cikis'); if(ozCikisEl) ozCikisEl.textContent = formatTarihGoster(rev.cikis);
  const ozCikisGunEl = document.getElementById('ci_ozet_cikis_gun'); if(ozCikisGunEl) ozCikisGunEl.textContent = `${gunAdiGoster(rev.cikis)} (${gece} Gece)`;
  const ozOdaEl = document.getElementById('ci_ozet_oda'); if(ozOdaEl) ozOdaEl.textContent = rev.odaNo;

  ciFiyatGuncelle();
  odemeDurumAlanGuncelle('ci');
  // odemeDurumAlanGuncelle alanı açtıktan sonra ön ödeme + kalan tutarı yeniden hesapla.
  ciFiyatGuncelle();
  kisilerGuncelle();
  openModal('checkinModal');
};

// ── CHECK-OUT ÖDEME / MASRAF BAĞLAMA YARDIMCILARI ──
// Oda masrafı oda numarasına göre değil KONAKLAMAYA göre bağlanır. Aksi halde
// 302'nin eski misafirinden kalan bir masraf sonraki 302 misafirinin hesabına sızabilir.
function masrafBuKonaklamayaAit(m, o, no) {
  if(!m || !o || String(m.odaNo) !== String(no)) return false;
  if(m.konaklamaKey && o.konaklamaKey) return m.konaklamaKey === o.konaklamaKey;
  if(m.gelirDocId && o.gelirDocId) return m.gelirDocId === o.gelirDocId;
  if(m.rezervasyonId && o.rezervasyonId) return m.rezervasyonId === o.rezervasyonId;

  // Eski kayıtlarla geriye uyumluluk: güçlü kimlik + kayıt tarihi birlikte aranır.
  const kayitGun = String(m.kayitTarih || m.tarih || '').slice(0,10);
  const tarihUygun = !kayitGun || !o.giris || kayitGun >= o.giris;
  const tcEslesir = !!(m.tc && o.tc && String(m.tc) === String(o.tc));
  const adEslesir = !!(m.misafir && o.misafir && String(m.misafir).trim().toLocaleLowerCase('tr-TR') === String(o.misafir).trim().toLocaleLowerCase('tr-TR'));
  return tarihUygun && (tcEslesir || adEslesir);
}

function konaklamaFiyatModeli(o, geceOverride=null) {
  const gecePlanli = geceSayisi(o?.giris, o?.cikis) || 0;
  const gece = geceOverride != null ? Math.max(0, Number(geceOverride)||0) : gecePlanli;
  const otelGecelik = Math.max(0, Number(o?.fiyat)||0);
  const misafirGecelik = Math.max(0, Number(o?.sozlesmeFiyat || o?.fiyat)||0);
  // Sözleşme fiyatı ile otel net fiyatı arasındaki fark yalnızca kayıt bir
  // komisyoncu/acentaya bağlıysa komisyon kabul edilir. Böylece doğrudan yapılan
  // özel fiyatlandırmalar yanlışlıkla komisyon sayılmaz.
  const komisyonGecelik = o?.araciAd && misafirGecelik > otelGecelik
    ? Math.round((misafirGecelik - otelGecelik) * 100) / 100 : 0;
  return {
    gece, gecePlanli, otelGecelik, misafirGecelik, komisyonGecelik,
    misafirToplam: Math.round(gece * misafirGecelik * 100) / 100,
    otelNetToplam: Math.round(gece * otelGecelik * 100) / 100,
    komisyonToplam: Math.round(gece * komisyonGecelik * 100) / 100,
    planliMisafirToplam: Math.round(gecePlanli * misafirGecelik * 100) / 100,
    planliOtelNetToplam: Math.round(gecePlanli * otelGecelik * 100) / 100,
    planliKomisyonToplam: Math.round(gecePlanli * komisyonGecelik * 100) / 100
  };
}

// Eski komisyonlu kayıtlarda "Ödendi" denmesine rağmen tahsilEdilen/odemeToplam
// yalnız otelin net fiyatı üzerinden tutulmuş olabiliyor. Ödeme durumu "ödendi" ise
// misafirin sözleşme hesabını kapanmış kabul ederiz; kısmi/depozitoda ise gerçek
// girilmiş tahsilat tutarına sadık kalırız. Bu geriye uyumluluk özellikle eski
// 2.300 net / 2.700 sözleşme kayıtlarının erken çıkış iadesini doğru hesaplar.
function misafirTahsilEdilenBul(o, fiyatModel=null) {
  const fm = fiyatModel || konaklamaFiyatModeli(o);
  const sakli = Math.max(0, Number(o?.tahsilEdilen != null ? o.tahsilEdilen : o?.kismiTutar) || 0);
  if(o?.odemeDurum === 'odendi' && fm.misafirGecelik > 0 && sakli < fm.planliMisafirToplam - 0.009) {
    return fm.planliMisafirToplam;
  }
  return sakli;
}

function checkoutHesapDurumu(no, geceOverride=null) {
  const o = window._O?.['oda'+no];
  if(!o) return null;
  const fiyatModel = konaklamaFiyatModeli(o, geceOverride);
  const gece = fiyatModel.gece;
  const gecelik = fiyatModel.misafirGecelik;
  const konaklama = fiyatModel.misafirToplam;
  const tumMasraflar = (window._M||[]).filter(m => masrafBuKonaklamayaAit(m,o,no));
  const yansitilan = tumMasraflar.filter(m => m.odemeDurumu === 'odaya_yansitildi');
  const ayriOdenen = tumMasraflar.filter(m => m.odemeDurumu === 'ayri_odendi');
  const yansitilanT = yansitilan.reduce((a,b)=>a+Math.max(0,Number(b.tutar)||0),0);
  const ayriT = ayriOdenen.reduce((a,b)=>a+Math.max(0,Number(b.tutar)||0),0);
  const oncekiTahsil = misafirTahsilEdilenBul(o, konaklamaFiyatModeli(o));
  const hesapToplam = konaklama + yansitilanT;
  const checkoutKalan = Math.max(0, Math.round((hesapToplam - oncekiTahsil)*100)/100);
  const fazlaTahsil = Math.max(0, Math.round((oncekiTahsil - hesapToplam)*100)/100);
  return {o,no,gece,gecelik,konaklama,tumMasraflar,yansitilan,ayriOdenen,yansitilanT,ayriT,oncekiTahsil,hesapToplam,checkoutKalan,fazlaTahsil,fiyatModel};
}

function checkoutFiyatKorelasyonYaz(state) {
  const el = document.getElementById('coz_fiyat_korelasyon');
  if(!el || !state) return;
  const f = state.fiyatModel;
  if(!f || f.komisyonGecelik <= 0.009) { el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='block';
  el.innerHTML = `
    <div style="font-weight:700;color:var(--dark);margin-bottom:6px">Fiyat Dağılımı · ${state.gece} gece</div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:var(--muted)">Misafir sözleşme fiyatı</span><strong>${fmt(f.misafirGecelik)} / gece · ${fmt(f.misafirToplam)}</strong></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:var(--muted)">Otel net fiyatı</span><strong>${fmt(f.otelGecelik)} / gece · ${fmt(f.otelNetToplam)}</strong></div>
    <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Komisyoncu farkı</span><strong style="color:var(--gold2)">${fmt(f.komisyonGecelik)} / gece · ${fmt(f.komisyonToplam)}</strong></div>`;
}

function checkoutErkenCikisMaliOzetYaz(state, planliGece) {
  const el = document.getElementById('erken_cikis_mali_ozet');
  if(!el || !state) return;
  const f = state.fiyatModel;
  const kullanilmayan = Math.max(0, Number(planliGece||0) - Number(state.gece||0));
  if(kullanilmayan <= 0) { el.innerHTML=''; return; }
  const misafirIadeBrut = Math.round(kullanilmayan * f.misafirGecelik * 100) / 100;
  const otelNetDusum = Math.round(kullanilmayan * f.otelGecelik * 100) / 100;
  const komisyonGeri = Math.round(kullanilmayan * f.komisyonGecelik * 100) / 100;
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Kullanılmayan ${kullanilmayan} gece · müşteri fiyatı</span><strong>${fmt(misafirIadeBrut)}</strong></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Otel net hesabından düşecek</span><strong>${fmt(otelNetDusum)}</strong></div>
    ${komisyonGeri>0.009?`<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Komisyoncudan mahsup / geri alınacak</span><strong style="color:var(--red)">${fmt(komisyonGeri)}</strong></div>`:''}
    <div style="display:flex;justify-content:space-between;padding-top:5px;border-top:1px solid #ead8ab;font-weight:700"><span>Müşteriye fiili iade${state.yansitilanT>0?' (oda masrafları sonrası)':''}</span><strong style="color:var(--gold2)">${fmt(state.fazlaTahsil)}</strong></div>`;
}

function checkoutTahsilatOzetYaz(state, tahsilSimdi=null) {
  if(!state) return;
  const form = document.getElementById('coz_tahsilat_form');
  const input = document.getElementById('coz_tahsil_tutar');
  const durumHidden = document.getElementById('coz_odeme_durum');
  const durumGoster = document.getElementById('coz_odeme_durum_goster');
  const fazlaSatir = document.getElementById('coz_fazla_tahsil_satir');

  if(tahsilSimdi == null) tahsilSimdi = state.checkoutKalan;
  tahsilSimdi = Math.max(0, Math.min(Number(tahsilSimdi)||0, state.checkoutKalan));
  const sonKalan = Math.max(0, state.checkoutKalan - tahsilSimdi);
  const durum = state.checkoutKalan <= 0.009 ? 'odendi' : (tahsilSimdi <= 0.009 ? 'odenmedi' : (sonKalan <= 0.009 ? 'odendi' : 'kismi'));

  document.getElementById('coz_onceki_tahsil').textContent = fmt(state.oncekiTahsil);
  document.getElementById('coz_checkout_kalan').textContent = fmt(state.checkoutKalan);
  document.getElementById('coz_son_kalan').textContent = fmt(sonKalan);
  document.getElementById('coz_son_kalan').style.color = sonKalan > 0.009 ? 'var(--red)' : 'var(--green)';
  document.getElementById('coz_fazla_tahsil').textContent = state.fazlaTahsil > 0 ? fmt(state.fazlaTahsil) : '—';
  if(fazlaSatir) fazlaSatir.style.display = state.fazlaTahsil > 0.009 ? 'flex' : 'none';
  if(durumHidden) durumHidden.value = durum;

  if(state.checkoutKalan <= 0.009) {
    if(form) form.style.display = 'none';
    if(input) input.value = '0';
    if(durumGoster) {
      durumGoster.textContent = state.fazlaTahsil > 0.009
        ? `↩ Hesap kapalı; müşteriye ${fmt(state.fazlaTahsil)} iade edilecek.`
        : '✅ Hesap daha önce tamamen ödendi. Check-out sırasında yeni tahsilat yapılmayacak.';
      durumGoster.style.color = state.fazlaTahsil > 0.009 ? 'var(--gold)' : 'var(--green)';
    }
  } else {
    if(form) form.style.display = 'block';
    if(input && document.activeElement !== input) input.value = String(Math.round(tahsilSimdi*100)/100);
    if(durumGoster) {
      durumGoster.textContent = sonKalan <= 0.009
        ? `✅ Bu işlemle hesap kapanacak. Tahsilat: ${fmt(tahsilSimdi)}`
        : (tahsilSimdi > 0 ? `⚠ Kısmi tahsilat. Check-out sonrası alacak: ${fmt(sonKalan)}` : `❌ Tahsilat yapılmadan check-out. Açık alacak: ${fmt(sonKalan)}`);
      durumGoster.style.color = sonKalan <= 0.009 ? 'var(--green)' : 'var(--red)';
    }
  }
  window._checkoutHesapState = {...state,tahsilSimdi,sonKalan,durum};
}

window.cozTahsilatGuncelle = function() {
  const no = currentCheckoutOda;
  const o = window._O?.['oda'+no];
  if(!o) return;
  const geceEl = document.getElementById('coz_fatura_gece');
  const gece = (geceEl && Number(geceEl.value)>0) ? Number(geceEl.value) : geceSayisi(o.giris,o.cikis);
  const state = checkoutHesapDurumu(no,gece);
  const raw = Number(document.getElementById('coz_tahsil_tutar')?.value)||0;
  checkoutTahsilatOzetYaz(state,raw);
};

// ── CHECK-OUT MENÜSÜ ──
window.openCheckoutMenu = function(no) {
  const o = window._O['oda'+no];
  if(!o || o.durum !== 'dolu') { openDurumModal(no); return; }
  const oz = window._OZ?.['oda'+no] || {};
  const gecePlanli = geceSayisi(o.giris, o.cikis);       // rezervasyondaki gece
  const geceGercek = geceSayisi(o.giris, today());        // bugüne kadar konaklanan gece
  const erkenCikis = o.cikis && o.cikis > today();        // planlanandan erken mi?

  let faturaGece = gecePlanli;
  if(erkenCikis && geceGercek > 0 && geceGercek < gecePlanli) {
    faturaGece = geceGercek; // varsayılan: gerçek konaklama
  }

  const checkoutGecelik = Number(o.sozlesmeFiyat || o.fiyat || 0);
  const state0 = checkoutHesapDurumu(no, faturaGece);
  const konaklama = state0.konaklama;
  const tumMasraflar = state0.tumMasraflar;
  const yansitilan  = state0.yansitilan;
  const ayriOdenen  = state0.ayriOdenen;
  const yansitilanT = state0.yansitilanT;
  const ayriT       = state0.ayriT;

  currentCheckoutOda = no;
  const odaAdi = oz.ad ? `Oda ${no} — ${oz.ad}` : `Oda ${no}`;

  document.getElementById('coz_baslik').textContent = odaAdi;
  document.getElementById('coz_misafir').textContent = o.misafir || '—';
  document.getElementById('coz_tarih').textContent = dateStr(nowISO());

  // Erken çıkış bloğu
  const erkenBlok = document.getElementById('erken_cikis_blok');
  if(erkenCikis && geceGercek > 0 && geceGercek < gecePlanli) {
    erkenBlok.style.display = 'block';
    document.getElementById('erken_cikis_bilgi').textContent =
      `Planlanan çıkış: ${o.cikis} (${gecePlanli} gece) · Bugün çıkıyor: ${today()} (${geceGercek} gece konakladı)`;
    document.getElementById('coz_fatura_gece').value = faturaGece;
    document.getElementById('erken_cikis_fiyat_label').textContent =
      `× ${checkoutGecelik.toLocaleString('tr-TR')} ₺ = ${fmt(faturaGece * checkoutGecelik)}`;
  } else {
    erkenBlok.style.display = 'none';
    document.getElementById('coz_fatura_gece').value = faturaGece;
  }

  // Konaklama kalemi
  document.getElementById('coz_konaklama').innerHTML = `
    <div class="folio-item" id="coz_konaklama_item">
      <div>
        <div class="folio-item-name" id="coz_konaklama_ad">${faturaGece} Gece Konaklama${erkenCikis&&geceGercek<gecePlanli?' <span class="badge badge-gold" style="font-size:9px">Erken Çıkış</span>':''}</div>
        <div class="folio-item-meta">${o.giris||'?'} → ${o.cikis||'?'} · ${getTipAd(o.fiyatTip||1)} · ${checkoutGecelik.toLocaleString('tr-TR')} ₺/gece</div>
      </div>
      <div class="folio-item-tutar" id="coz_konaklama_tutar">${fmt(konaklama)}</div>
    </div>`;

  // Masraf kalemleri
  const masrafBlok = document.getElementById('coz_masraf_blok');
  if(tumMasraflar.length === 0) {
    masrafBlok.innerHTML = '';
  } else {
    const durumBadge = (m) => {
      if(m.odemeDurumu === 'ayri_odendi') return `<span class="badge badge-green" style="font-size:9px">Ayrı Ödendi</span>`;
      return `<span class="badge badge-orange" style="font-size:9px">Odaya Yansıtıldı</span>`;
    };
    let html = '<div class="section-mini-title" style="margin-top:14px">Oda Masrafları</div><div id="coz_masraflar_list">';
    tumMasraflar.forEach(m => {
      html += `<div class="folio-item">
        <div style="flex:1">
          <div class="folio-item-name">${m.aciklama||'—'} ${durumBadge(m)}</div>
          <div class="folio-item-meta">${m.kategori||'—'} · ${timeStr(m.kayitTarih)} · ${m.kimGirdi||'—'}</div>
        </div>
        <div class="folio-item-tutar ${m.odemeDurumu==='ayri_odendi'?'':'amount-neg'}">${m.odemeDurumu==='ayri_odendi'?'<span style="text-decoration:line-through;color:var(--muted)">'+fmt(m.tutar)+'</span>':fmt(m.tutar)}</div>
      </div>`;
    });
    html += '</div>';
    masrafBlok.innerHTML = html;
  }

  document.getElementById('coz_toplam').textContent = fmt(state0.hesapToplam);
  document.getElementById('coz_ayri_toplam').textContent = ayriT > 0 ? fmt(ayriT) : '—';
  checkoutFiyatKorelasyonYaz(state0);
  if(erkenCikis && geceGercek > 0 && geceGercek < gecePlanli) checkoutErkenCikisMaliOzetYaz(state0, gecePlanli);
  checkoutTahsilatOzetYaz(state0, state0.checkoutKalan);
  const ekleBtn = document.getElementById('coz_masraf_ekle_btn');
  if(ekleBtn) ekleBtn.onclick = () => openMasrafModal(no);

  openModal('checkoutOzetModal');
  // Check-out işlemi resepsiyonun kararıdır; sözleşme yazdırma zorunluluğu yoktur.
  // Oda dolu olduğu sürece buton her zaman aktif kalır; erken/planlı çıkış aynı akışı kullanır.
  const coBtn = document.getElementById('coz_checkout_btn');
  if(coBtn) { coBtn.disabled = false; coBtn.style.opacity = '1'; coBtn.style.cursor = 'pointer'; coBtn.title = ''; }
};

// Erken çıkış gece değişince toplamı güncelle
window.cozGeceGuncelle = function() {
  const no = currentCheckoutOda;
  const o  = window._O['oda'+no];
  if(!o) return;
  const gece = parseInt(document.getElementById('coz_fatura_gece').value) || 1;
  const checkoutGecelik = Number(o.sozlesmeFiyat || o.fiyat || 0);
  const state = checkoutHesapDurumu(no,gece);
  const konaklama = state.konaklama;

  const adEl = document.getElementById('coz_konaklama_ad');
  const tutarEl = document.getElementById('coz_konaklama_tutar');
  const labelEl = document.getElementById('erken_cikis_fiyat_label');
  if(adEl) adEl.innerHTML = `${gece} Gece Konaklama <span class="badge badge-gold" style="font-size:9px">Erken Çıkış</span>`;
  if(tutarEl) tutarEl.textContent = fmt(konaklama);
  if(labelEl) labelEl.textContent = `× ${checkoutGecelik.toLocaleString('tr-TR')} ₺ = ${fmt(konaklama)}`;
  document.getElementById('coz_toplam').textContent = fmt(state.hesapToplam);
  checkoutFiyatKorelasyonYaz(state);
  checkoutErkenCikisMaliOzetYaz(state, geceSayisi(o.giris,o.cikis));
  checkoutTahsilatOzetYaz(state, state.checkoutKalan);
};

window.saveCheckoutFromOzet = async function() {
  const no = currentCheckoutOda;
  const o  = window._O['oda'+no];
  if(!o) return;
  if(window._checkoutKaydediliyor) { toast('Check-out zaten kaydediliyor…','info'); return; }
  window._checkoutKaydediliyor = true;
  try {
  const oz = window._OZ?.['oda'+no] || {};
  const odeme = document.getElementById('coz_odeme')?.value || o.odemeTuru || 'nakit';
  // Erken çıkış: kullanıcının girdiği gece sayısını kullan
  const faturaGeceEl = document.getElementById('coz_fatura_gece');
  const gece = (faturaGeceEl && parseInt(faturaGeceEl.value) > 0)
    ? parseInt(faturaGeceEl.value)
    : geceSayisi(o.giris, o.cikis);
  const now  = nowISO();
  const state = checkoutHesapDurumu(no,gece);
  if(!state) throw new Error('CHECKOUT_HESAP_YOK');

  let tahsilSimdi = state.checkoutKalan <= 0.009 ? 0 : (Number(document.getElementById('coz_tahsil_tutar')?.value)||0);
  if(tahsilSimdi < 0) { toast('Tahsilat tutarı negatif olamaz.','error'); return; }
  if(tahsilSimdi > state.checkoutKalan + 0.009) {
    toast(`Check-out tahsilatı kalan borçtan (${fmt(state.checkoutKalan)}) fazla olamaz.`,'error'); return;
  }
  tahsilSimdi = Math.round(tahsilSimdi*100)/100;
  const iadeSimdi = Math.round((state.fazlaTahsil||0)*100)/100;
  if(iadeSimdi > 0.009) {
    const ok = confirm(`Erken çıkış / hesap düzeltmesi nedeniyle müşteriye ${fmt(iadeSimdi)} iade kaydedilecek. Devam edilsin mi?`);
    if(!ok) return;
  }
  const sonKalan = Math.max(0, Math.round((state.checkoutKalan-tahsilSimdi)*100)/100);
  const odemeDurum = sonKalan <= 0.009 ? 'odendi' : (tahsilSimdi > 0 ? 'kismi' : 'odenmedi');

  const yansitilan = state.yansitilan;
  const yansitilanT = state.yansitilanT;
  const konaklama = state.konaklama; // misafirin sözleşme toplamı
  const checkoutGecelik = state.gecelik;
  const otelKonaklamaGeliri = state.fiyatModel.otelNetToplam;
  const komisyonToplamFinal = state.fiyatModel.komisyonToplam;
  const toplam = state.hesapToplam;
  const odaAdi = oz.ad ? `Oda ${no} (${oz.ad})` : `Oda ${no}`;

  // Yeni tahsilatı önce konaklama borcuna, sonra oda masraflarına dağıt.
  // Erken çıkış nedeniyle önceden konaklamaya fazla ödeme oluşmuşsa bu kredi de
  // odaya yansıtılan masrafları kapatabilir.
  const oncekiKonaklamaTahsil = Math.max(0, state.oncekiTahsil);
  const konaklamaKalanOnceki = Math.max(0, konaklama - oncekiKonaklamaTahsil);
  const konaklamaTahsilSimdi = Math.min(tahsilSimdi, konaklamaKalanOnceki);
  const konaklamaTahsilToplam = Math.min(konaklama, oncekiKonaklamaTahsil + konaklamaTahsilSimdi);
  const oncekiFazlaKredi = Math.max(0, oncekiKonaklamaTahsil - konaklama);
  let masrafTahsilButce = Math.max(0, oncekiFazlaKredi + tahsilSimdi - konaklamaTahsilSimdi);

  for(const m of yansitilan) {
    const masrafTutar = Math.max(0,Number(m.tutar)||0);
    const masrafTahsil = Math.min(masrafTutar, masrafTahsilButce);
    masrafTahsilButce = Math.max(0,masrafTahsilButce-masrafTahsil);
    const masrafKalan = Math.max(0,masrafTutar-masrafTahsil);
    const masrafDurum = masrafKalan <= 0.009 ? 'checkout_odendi' : (masrafTahsil > 0 ? 'checkout_kismi' : 'checkout_borc');
    const gelirOdemeDurum = masrafKalan <= 0.009 ? 'odendi' : (masrafTahsil > 0 ? 'kismi' : 'odenmedi');
    await updateDoc(doc(db,'odaMasraflari',m.id), {
      odemeDurumu:masrafDurum, checkoutTarih:now,
      checkoutTahsilEdilen:masrafTahsil, checkoutKalan:masrafKalan,
      checkoutOdemeTuru:masrafTahsil>0 ? odeme : ''
    });
    await setDoc(doc(db,'gelirler',`oda_masrafi_${m.id}`), {
      masrafId:m.id, tarih: today(), tutar: masrafTutar,
      odaNo: String(no), odemeTuru: masrafTahsil>0 ? odeme : '', odemeDurum:gelirOdemeDurum,
      tahsilEdilen:masrafTahsil, kalanTahsilat:masrafKalan,
      misafir: o.misafir, tc: o.tc||'', konaklamaKey:o.konaklamaKey||null,
      gelirDocId:o.gelirDocId||null, rezervasyonId:o.rezervasyonId||null,
      kaynak: 'oda-masrafi',
      aciklama: `${odaAdi} · Masraf · ${m.aciklama}`,
      kayitTarih: m.kayitTarih||now, guncelleme:now
    },{merge:true});
  }

  // Konaklama gelir kaydı: check-in'deki kaydı güncelle, ikinci kez ekleme.
  // ÖNEMLİ: cikis alanı PLANLANAN çıkış tarihi (o.cikis) değil, GERÇEK çıkış tarihi
  // olmalı — erken çıkışta bu ikisi farklıdır. Eskiden burada o.cikis (planlanan,
  // gelecekteki) tarih yazılıyordu; bu yüzden erken çıkışta gelir kaydı hâlâ ileri
  // bir tarihe kadar "dolu" gibi görünüyordu ve komisyoncu takviminde oda gerçek
  // çıkıştan sonraki günlerde de dolu gösterilmeye devam ediyordu.
  const gercekCikis = today();
  if(konaklama > 0) {
    const gelirId = o.gelirDocId || konaklamaGelirId(no,o.giris,o.tc,o.misafir,o.rezervasyonId||'');
    const konaklamaKey = o.konaklamaKey || `${no}|${temizAnahtar(o.tc||o.misafir)}|${o.giris}`;
    const sozlesmeToplam = konaklama;
    const konaklamaOdemeDurum = konaklamaTahsilToplam >= sozlesmeToplam-0.009
      ? 'odendi' : (konaklamaTahsilToplam > 0 ? 'kismi' : 'odenmedi');
    const checkoutHareketleri = Array.isArray(o.odemeHareketleri) ? [...o.odemeHareketleri] : [];
    if(konaklamaTahsilSimdi > 0) checkoutHareketleri.push({tutar:konaklamaTahsilSimdi,tur:odeme,tarih:now,asama:'checkout'});
    if(iadeSimdi > 0) checkoutHareketleri.push({tutar:-iadeSimdi,tur:o.odemeTuru||odeme,tarih:now,asama:'erken_cikis_iade',aciklama:'Erken çıkış / fazla tahsil iadesi'});
    await setDoc(doc(db,'gelirler',gelirId), {
      kayitTip:'konaklama', konaklamaKey, giris:o.giris, cikis:gercekCikis, checkoutTarih:today(),
      tarih: o.giris||today(), tutar: otelKonaklamaGeliri,
      odaNo: String(no), odemeTuru: konaklamaTahsilSimdi>0 ? odeme : (o.odemeTuru||odeme), odemeDurum:konaklamaOdemeDurum,
      odemeToplam:sozlesmeToplam,
      tahsilEdilen:konaklamaTahsilToplam, kalanTahsilat:Math.max(0,sozlesmeToplam-konaklamaTahsilToplam),
      iadeTutar:iadeSimdi, iadeTarih:iadeSimdi>0?today():null,
      otelNetToplam:otelKonaklamaGeliri, komisyonToplam:komisyonToplamFinal,
      odemeHareketleri: checkoutHareketleri,
      misafir: o.misafir, tc: o.tc||'', kaynak: o.kaynak||'walk-in',
      fiyatTip: o.fiyatTip||1, fiyatTipAd: getTipAd(o.fiyatTip||1),
      gece, fiyat:o.fiyat||0, sozlesmeFiyat:o.sozlesmeFiyat||null,
      aciklama: `${odaAdi} · ${gece} gece konaklama`,
      kayitTarih: o.kayitTarih||now, guncelleme:now
    },{merge:true});
  }

  // Odayı temizliğe al
  const temizlikKaydi = bosOdaKaydi('temizlik', {_otoTemizlik:today(),temizlikBaslangic:now,manuelCheckout:true,sonCheckoutTarih:today()});
  await odaMetaKaydet(no, temizlikKaydi);

  // Bu konaklamayı doğuran rezervasyon kaydını da tamamlanmış olarak işaretle ve
  // GERÇEK çıkış tarihine küçült. Bu yapılmazsa: (1) rezervasyon durum='aktif' ve
  // eski (planlanan/ileri) cikis tarihiyle kalmaya devam eder, bu da yeni bir
  // rezervasyon/check-in girişimini "çakışma var" diyerek engeller; (2) komisyoncu
  // takvimindeki hücre rengi de bu rezervasyon kaydına bakarak hesaplandığından,
  // gerçek çıkıştan sonraki günlerde oda hâlâ dolu/rezerve görünmeye devam eder.
  // ÖNEMLİ: giris string eşleştirmesi kırılgandı — misafir erken giriş yaptığında
  // (check-in'de gerçek/erken tarih girilip rezervasyon kaydının giris alanı
  // güncellenmediği durumlarda) bu eşleşme tutmuyor ve kaynak rezervasyon
  // bulunamıyordu, dolayısıyla check-out'ta rezervasyon hiç güncellenmiyordu.
  // Artık check-in sırasında oda meta'sına doğrudan kaydedilen rezervasyonId
  // üzerinden buluyoruz — bu her durumda güvenilir.
  const kaynakRev = o.rezervasyonId
    ? (window._R||[]).find(r => r.id === o.rezervasyonId)
    : (window._R||[]).find(r => Number(r.odaNo)===Number(no) && r.giris===o.giris && rezervasyonOdayiBloklar(r));
  if(kaynakRev?.id) {
    try {
      await updateDoc(doc(db,'rezervasyonlar',kaynakRev.id), {
        durum: 'tamamlandi', cikis: gercekCikis, gece,
        odemeToplam:state.fiyatModel.misafirToplam, otelNetToplam:state.fiyatModel.otelNetToplam,
        komisyonToplam:state.fiyatModel.komisyonToplam, iadeTutar:iadeSimdi,
        guncelleme: now
      });
      if(kaynakRev.kaynakTalepId) {
        try {
          await updateDoc(doc(db,'rezervasyon_talepleri',kaynakRev.kaynakTalepId), {
            durum:'tamamlandi', rezervasyonId:kaynakRev.id, cikis:gercekCikis, gece,
            odemeToplam:state.fiyatModel.misafirToplam, otelNetToplam:state.fiyatModel.otelNetToplam,
            komisyonToplam:state.fiyatModel.komisyonToplam, iadeTutar:iadeSimdi,
            checkoutTarih:gercekCikis, islemTarih:nowISO()
          });
        } catch(e) { console.warn('Komisyoncu talebi tamamlandı durumuna geçirilemedi:',e); }
      }
    } catch(e) { console.warn('Kaynak rezervasyon check-out ile güncellenemedi:', e); }
  }

  // Erken çıkış nedeniyle konaklanan gece, planlanandan az olduysa komisyoncu
  // hakedişini de orantılı düşür (ya da o gece için komisyon yoksa hiçbir şey yapmaz).
  let komSonuc = null;
  const gecePlanliOrijinal = geceSayisi(o.giris, o.cikis);
  if(gece !== gecePlanliOrijinal) {
    komSonuc = await komisyonSureGuncelle(o.gelirDocId, gece);
  }

  renderOdalar();
  closeModal('checkoutOzetModal');
  vardiyaIstatistikGuncelle('checkout', tahsilSimdi - iadeSimdi);
  await logAktivite('checkout', `${o.misafir||'?'} · ${gece} gece · Misafir hesabı ${fmt(toplam)} · Otel net ${fmt(state.fiyatModel.otelNetToplam)} · Önceki tahsil ${fmt(state.oncekiTahsil)} · Check-out tahsil ${fmt(tahsilSimdi)} · İade ${fmt(iadeSimdi)} · Kalan ${fmt(sonKalan)}${komSonuc?' · Komisyon: '+komSonuc.eski+'→'+komSonuc.yeni:''}`, no);
  let coMesaj = `${odaAdi} — Check-out tamamlandı ✓ · Misafir hesabı ${fmt(toplam)} · Otel net ${fmt(state.fiyatModel.otelNetToplam)} · Şimdi tahsil ${fmt(tahsilSimdi)}${iadeSimdi>0.009?' · Müşteriye iade '+fmt(iadeSimdi):''}${sonKalan>0.009?' · Açık alacak '+fmt(sonKalan):' · Hesap kapalı'}`;
  if(komSonuc) {
    coMesaj += komSonuc.silindi
      ? ` · Komisyon hakedişi kaldırıldı (${komSonuc.eski.toLocaleString('tr-TR')} ₺ → 0 ₺)`
      : ` · Komisyon güncellendi: ${fmt(komSonuc.eski)} → ${fmt(komSonuc.yeni)}${komSonuc.mahsup>0.009?' · Komisyoncudan mahsup '+fmt(komSonuc.mahsup):''}`;
  }
  toast(coMesaj, 'success');
  } catch(e) {
    console.error('Check-out kayıt hatası:',e);
    toast('Check-out tamamlanamadı: '+(e?.message||'Bilinmeyen hata'),'error');
  } finally {
    window._checkoutKaydediliyor = false;
  }
};

// Eski referansları karşıla
window.saveCheckout = window.saveCheckoutFromOzet;
window.printFolioFromOzet = function() { printFolio(); };

// ── MASRAF ──
window.masrafOdemeToggle = function() {
  const val = document.querySelector('input[name="masraf_odeme"]:checked')?.value;
  const turWrap = document.getElementById('masraf_odeme_turu');
  if(val === 'ayri_odendi') {
    turWrap.style.display = 'block';
  } else {
    turWrap.style.display = 'none';
  }
};

// Genel sekmeden masraf ekle
window.openMasrafModalGenel = function() {
  const dolular = [];
  for(const i of HOTEL_ODALAR) {
    const o = window._O['oda'+i];
    if(o && o.durum === 'dolu') {
      const oz = window._OZ?.['oda'+i] || {};
      dolular.push({no:i, misafir:o.misafir, ad:oz.ad});
    }
  }
  if(!dolular.length) { toast('Şu an dolu oda yok','error'); return; }
  // Birden fazla dolu oda varsa seçtir
  openMasrafModal(dolular[0].no, dolular);
};

window.openMasrafModal = function(no, dolularList) {
  const o = window._O['oda'+no];
  if(!o || o.durum !== 'dolu') { toast('Sadece dolu odalara masraf eklenebilir','error'); return; }
  const oz = window._OZ?.['oda'+no] || {};
  const odaAdi = oz.ad ? `Oda ${no} — ${oz.ad}` : `Oda ${no}`;

  document.getElementById('masrafTitle').textContent = 'Masraf Ekle';
  document.getElementById('masraf_oda_no').value = no;
  document.getElementById('masraf_info_no').textContent = no;
  document.getElementById('masraf_info_ad').textContent = odaAdi;
  document.getElementById('masraf_info_misafir').textContent = o.misafir ? `Misafir: ${o.misafir}` : '—';
  document.getElementById('masraf_tutar').value = '';
  document.getElementById('masraf_aciklama').value = '';
  document.getElementById('masraf_kategori').value = 'Minibar';
  document.querySelector('input[name="masraf_odeme"][value="odaya_yansitildi"]').checked = true;
  document.getElementById('masraf_odeme_turu').style.display = 'none';

  // Eğer seçim listesi varsa oda seçtir
  if(dolularList && dolularList.length > 1) {
    const sel = document.getElementById('masraf_oda_no');
    // Oda no'yu dinamik select'e çevir
    const infoNo = document.getElementById('masraf_info_no');
    infoNo.innerHTML = '';
    const s = document.createElement('select');
    s.style.cssText = 'font-family:Cormorant Garamond,serif;font-size:22px;font-weight:700;color:var(--dark);border:none;background:none;outline:none;padding:0;width:100%';
    dolularList.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.no;
      const oz2 = window._OZ?.['oda'+d.no] || {};
      opt.textContent = oz2.ad ? `Oda ${d.no} — ${oz2.ad}` : `Oda ${d.no}`;
      if(d.no === no) opt.selected = true;
      s.appendChild(opt);
    });
    s.onchange = () => {
      const n = s.value;
      const o2 = window._O['oda'+n];
      const oz2 = window._OZ?.['oda'+n] || {};
      document.getElementById('masraf_oda_no').value = n;
      document.getElementById('masraf_info_ad').textContent = oz2.ad ? `Oda ${n} — ${oz2.ad}` : `Oda ${n}`;
      document.getElementById('masraf_info_misafir').textContent = o2?.misafir ? `Misafir: ${o2.misafir}` : '—';
    };
    infoNo.appendChild(s);
  }

  closeModal('checkoutOzetModal');
  openModal('masrafModal');
};

window.saveMasraf = async function() {
  const no       = document.getElementById('masraf_oda_no').value;
  const tutar    = Number(document.getElementById('masraf_tutar').value);
  const aciklama = document.getElementById('masraf_aciklama').value.trim();
  const kategori = document.getElementById('masraf_kategori').value;
  const odemeDurumu = document.querySelector('input[name="masraf_odeme"]:checked')?.value || 'odaya_yansitildi';
  const odemeTuru = document.getElementById('masraf_odeme_turu').value || '';
  if(!tutar || !aciklama) { toast('Tutar ve açıklama zorunlu','error'); return; }
  const o  = window._O['oda'+no];
  const oz = window._OZ?.['oda'+no] || {};
  const now = nowISO();
  const masrafRef = await addDoc(collection(db,'odaMasraflari'), {
    odaNo: String(no),
    odaAdi: oz.ad || '',
    misafir: o?.misafir || '—',
    tc: o?.tc || '',
    konaklamaKey: o?.konaklamaKey || null,
    gelirDocId: o?.gelirDocId || null,
    rezervasyonId: o?.rezervasyonId || null,
    giris: o?.giris || null,
    tutar,
    aciklama,
    kategori,
    odemeDurumu,   // 'odaya_yansitildi' | 'ayri_odendi'
    odemeTuru: odemeDurumu === 'ayri_odendi' ? odemeTuru : '',
    kimGirdi: auth.currentUser?.email || 'resepsiyon',
    kayitTarih: now
  });
  // Ayrı ödendiyse direkt gelir kaydı yaz
  if(odemeDurumu === 'ayri_odendi') {
    await setDoc(doc(db,'gelirler',`oda_masrafi_${masrafRef.id}`), {
      masrafId:masrafRef.id, tarih: today(), tutar,
      odaNo: String(no),
      odemeTuru,
      misafir: o?.misafir || '—',
      tc: o?.tc || '',
      kaynak: 'oda-masrafi',
      aciklama: `Oda ${no}${oz.ad?' ('+oz.ad+')':''} · Masraf · ${aciklama}`,
      kayitTarih: now, guncelleme:now
    },{merge:true});
  }
  closeModal('masrafModal');
  await logAktivite('masraf', `${kategori} · ${aciklama} · ${tutar.toLocaleString('tr-TR')} ₺ · ${odemeDurumu==='ayri_odendi'?'Ayrı ödendi':'Odaya yansıtıldı'}`, no);
  toast(`Oda ${no} — Masraf eklendi ✓`,'success');
};

// ── FOLIO PRINT ──
window.printFolio = function() {
  const no = currentCheckoutOda;
  const o  = window._O['oda'+no];
  if(!o) return;
  const oz = window._OZ?.['oda'+no] || {};

  const faturaGeceEl = document.getElementById('coz_fatura_gece');
  const gece = (faturaGeceEl && parseInt(faturaGeceEl.value) > 0)
    ? parseInt(faturaGeceEl.value)
    : geceSayisi(o.giris, o.cikis);
  const faturaGecelik = Number(o.sozlesmeFiyat || o.fiyat || 0);
  const konaklama = gece * faturaGecelik;
  const tumMasraflar = (window._M||[]).filter(m=>masrafBuKonaklamayaAit(m,o,no));
  const yansitilan = tumMasraflar.filter(m=>m.odemeDurumu==='odaya_yansitildi');
  const masrafToplam = yansitilan.reduce((a,b)=>a+Number(b.tutar||0),0);
  const genel = konaklama + masrafToplam;
  const odaAdi = oz.ad ? `Oda ${no} — ${oz.ad}` : `Oda ${no}`;
  const faturaTarih = new Date().toLocaleDateString('tr-TR',{day:'2-digit',month:'long',year:'numeric'});
  const faturaNo = `SW-${Date.now().toString().slice(-6)}`;

  const masrafSatir = yansitilan.map(m=>`
    <tr>
      <td style="padding:9px 0;color:#555;border-bottom:1px solid #e8e4dc">${m.aciklama||'—'}</td>
      <td style="padding:9px 0;color:#888;text-align:center;border-bottom:1px solid #e8e4dc">${m.kategori||'—'}</td>
      <td style="padding:9px 0;font-weight:600;text-align:right;border-bottom:1px solid #e8e4dc">${fmt(m.tutar)}</td>
    </tr>`).join('');

  const html = `
    <!DOCTYPE html><html lang="tr"><head>
    <meta charset="UTF-8">
    <title>Fatura ${faturaNo}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;600;700&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
    <style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{font-family:'Jost',sans-serif;background:#f5f2ec;padding:40px;color:#2a2520;}
      .invoice{background:#fff;max-width:720px;margin:0 auto;padding:48px 52px;box-shadow:0 2px 24px rgba(0,0,0,.08);}
      .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px;padding-bottom:28px;border-bottom:2px solid #1e1b17;}
      .logo-area .name{font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:300;letter-spacing:6px;text-transform:uppercase;}
      .logo-area .sub{font-size:10px;letter-spacing:3px;color:#9a7c3f;text-transform:uppercase;margin-top:4px;}
      .fatura-no{text-align:right;}
      .fatura-no .label{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#9a8a7a;margin-bottom:6px;}
      .fatura-no .num{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:700;color:#1e1b17;}
      .fatura-no .tarih{font-size:12px;color:#9a8a7a;margin-top:4px;}
      .bilgiler{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:36px;}
      .bilgi-blok .baslik{font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#9a7c3f;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #e8e4dc;}
      .bilgi-blok .satir{font-size:13px;margin-bottom:5px;display:flex;gap:8px;}
      .bilgi-blok .satir .etiket{color:#9a8a7a;min-width:90px;flex-shrink:0;}
      .bilgi-blok .satir .deger{font-weight:500;}
      .tablo{width:100%;border-collapse:collapse;margin-bottom:24px;}
      .tablo thead th{padding:10px 0;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9a8a7a;border-bottom:2px solid #1e1b17;text-align:left;}
      .tablo thead th:last-child{text-align:right;}
      .toplam-blok{border-top:2px solid #1e1b17;padding-top:16px;display:flex;justify-content:space-between;align-items:center;}
      .toplam-blok .toplam-lbl{font-size:14px;font-weight:600;letter-spacing:1px;text-transform:uppercase;}
      .toplam-blok .toplam-val{font-family:'Cormorant Garamond',serif;font-size:38px;font-weight:700;color:#9a7c3f;}
      .footer{margin-top:40px;padding-top:20px;border-top:1px solid #e8e4dc;text-align:center;font-size:11px;color:#b0a89a;letter-spacing:1px;}
      @media print{body{background:#fff;padding:0;}.invoice{box-shadow:none;padding:32px;}}
    </style></head><body>
    <div class="invoice">
      <div class="header">
        <div class="logo-area">
          <div class="name">Swiss House</div>
          <div class="sub">& Suites</div>
        </div>
        <div class="fatura-no">
          <div class="label">Fatura No</div>
          <div class="num">${faturaNo}</div>
          <div class="tarih">${faturaTarih}</div>
        </div>
      </div>

      <div class="bilgiler">
        <div class="bilgi-blok">
          <div class="baslik">Misafir Bilgileri</div>
          <div class="satir"><span class="etiket">Ad Soyad</span><span class="deger">${o.misafir||'—'}</span></div>
          ${o.tc?`<div class="satir"><span class="etiket">TC Kimlik</span><span class="deger">${o.tc}</span></div>`:''}
          ${o.tel?`<div class="satir"><span class="etiket">Telefon</span><span class="deger">${o.tel}</span></div>`:''}
          ${o.email?`<div class="satir"><span class="etiket">E-posta</span><span class="deger">${o.email}</span></div>`:''}
        </div>
        <div class="bilgi-blok">
          <div class="baslik">Konaklama Bilgileri</div>
          <div class="satir"><span class="etiket">Oda</span><span class="deger">${odaAdi}</span></div>
          <div class="satir"><span class="etiket">Giriş</span><span class="deger">${o.giris||'—'} ${o.girisSaati?'· '+o.girisSaati:''}</span></div>
          <div class="satir"><span class="etiket">Çıkış</span><span class="deger">${o.cikis||'—'}</span></div>
          <div class="satir"><span class="etiket">Süre</span><span class="deger">${gece} gece</span></div>
          <div class="satir"><span class="etiket">Kaynak</span><span class="deger">${o.kaynak||'walk-in'}</span></div>
        </div>
      </div>

      <table class="tablo">
        <thead><tr>
          <th>Açıklama</th>
          <th style="text-align:center">Birim</th>
          <th style="text-align:right">Tutar</th>
        </tr></thead>
        <tbody>
          <tr>
            <td style="padding:12px 0;border-bottom:1px solid #e8e4dc">
              <div style="font-weight:600">${gece} Gece Konaklama</div>
              <div style="font-size:11px;color:#9a8a7a;margin-top:3px">${getTipAd(o.fiyatTip||1)} · ${faturaGecelik.toLocaleString('tr-TR')} ₺/gece</div>
            </td>
            <td style="padding:12px 0;text-align:center;color:#888;border-bottom:1px solid #e8e4dc">${gece} × ${faturaGecelik.toLocaleString('tr-TR')} ₺</td>
            <td style="padding:12px 0;font-weight:600;text-align:right;border-bottom:1px solid #e8e4dc">${fmt(konaklama)}</td>
          </tr>
          ${masrafSatir}
        </tbody>
      </table>

      <div class="toplam-blok">
        <div class="toplam-lbl">Genel Toplam</div>
        <div class="toplam-val">${fmt(genel)}</div>
      </div>

      <div class="footer">
        Swiss House & Suites · Teşekkür ederiz · Tekrar görüşmek dileğiyle
      </div>
    </div>
    <script>window.onload=()=>window.print();<\/script>
    </body></html>`;

  const w = window.open('','_blank');
  w.document.write(html);
  w.document.close();
};

// ── DURUM MODAL ──
window.openDurumModal = function(no) {
  const o = window._O['oda'+no]||{durum:'bos'};
  const dolu = o.durum === 'dolu';
  document.getElementById('durumTitle').textContent = `Oda ${no} — Durum`;
  document.getElementById('durum_oda_no').value = no;

  // Dolu odanın durumu elle değiştirilemez. Konaklamayı kapatan tek akış Check-out'tur.
  const sel = document.getElementById('durum_select');
  sel.innerHTML = dolu
    ? `<option value="dolu">🔒 Dolu — önce Check-out yapın</option>`
    : `<option value="bos">Boş</option>
       <option value="temizlik">Temizlikte</option>
       <option value="arizali">🔧 Arızalı / Bakımda</option>`;

  sel.value = dolu ? 'dolu' : o.durum;
  document.getElementById('durum_not_wrap').style.display = (!dolu && o.durum==='arizali') ? 'block' : 'none';

  if(dolu) {
    // Uyarı mesajı göster
    let uyari = document.getElementById('durum_dolu_uyari');
    if(!uyari) {
      uyari = document.createElement('div');
      uyari.id = 'durum_dolu_uyari';
      uyari.style.cssText = 'background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:10px 14px;font-size:12px;margin-bottom:12px';
      sel.parentElement.insertBefore(uyari, sel);
    }
    uyari.textContent = '⚠ Bu oda şu an dolu. Durum değişikliği için önce Check-out yapılmalıdır.';
    uyari.style.display = 'block';
  } else {
    const uyari = document.getElementById('durum_dolu_uyari');
    if(uyari) uyari.style.display = 'none';
  }

  openModal('durumModal');
};

window.saveDurum = async function() {
  const no    = document.getElementById('durum_oda_no').value;
  const durum = document.getElementById('durum_select').value;
  const arizaNot = document.getElementById('durum_not')?.value.trim() || '';
  const mevcutOda = window._O['oda'+no] || {};

  // Dolu odanın durumunu hiçbir manuel seçim değiştiremez — tek çıkış Check-out.
  if(mevcutOda.durum === 'dolu') {
    toast('Dolu odada durum değiştirilemez. Önce Check-out yapılmalı.', 'error');
    return;
  }

  if(durum==='arizali' && mevcutOda.durum==='dolu') {
    toast(`Oda ${no} doluyken Arızalı/Bakımda durumuna alınamaz. Önce mevcut konaklamanın check-out işlemini tamamlayın.`, 'error');
    return;
  }
  const now   = nowISO();
  window._O['oda'+no] = {...(window._O['oda'+no]||{}), durum, guncelleme:now};
  if(durum==='bos'||durum==='temizlik') {
    window._O['oda'+no] = {durum,misafir:'',tc:'',tel:'',email:'',plaka:'',kaynak:'',fiyatTip:1,fiyat:0,odemeTuru:'nakit',giris:'',cikis:'',girisSaati:'',yetiskin:1,cocuk:0,not:'',guncelleme:now};
    // Yanlışlıkla aktifleşmiş GELECEK tarihli rezervasyonları "bekliyor"a döndür
    const td = today();
    const hataliAktifler = (window._R||[]).filter(r =>
      Number(r.odaNo) === Number(no) && r.durum === 'aktif' && r.giris > td
    );
    for(const r of hataliAktifler) {
      await updateDoc(doc(db,'rezervasyonlar', r.id), {durum:'bekliyor', guncelleme:now});
      await logAktivite('rez_duzeltme', `Oda ${no} — ${r.misafir||'?'} rezervasyonu bekliyor durumuna döndürüldü (${r.giris})`, no);
    }
    if(hataliAktifler.length) toast(`${hataliAktifler.length} gelecek tarihli rezervasyon "bekliyor" durumuna döndürüldü`, 'info');
  } else if(durum==='arizali') {
    window._O['oda'+no] = {durum,misafir:'',tc:'',tel:'',email:'',plaka:'',kaynak:'',fiyatTip:1,fiyat:0,odemeTuru:'nakit',giris:'',cikis:'',girisSaati:'',yetiskin:1,cocuk:0,not:arizaNot,arizaNot,arizaBaslangic:now,arizaBitis:document.getElementById('durum_arizaBitis')?.value||null,guncelleme:now};
  }
  await odaMetaKaydet(no, window._O['oda'+no]);
  renderOdalar();
  closeModal('durumModal');
  await logAktivite('durum_degisim', `Oda ${no} → ${durum}${arizaNot?' ('+arizaNot+')':''}`, no);
  toast(`Oda ${no} güncellendi ✓`, 'success');
};

// ── REZERVASYONLAR ──
// ── UYGUN ODA BULUCU ──
// Verilen gece sayısı için her odayı en erken giriş tarihini bulana kadar gün gün tarar,
// sonuçları en yakın tarihten başlayarak sıralar. odaCakismaKontrol ile aynı çakışma
// mantığını kullanır — rezervasyon.html'in geri kalanıyla tutarlı.
function odaBulTara(gece, enErkenTarih) {
  const LIMIT_GUN = 120; // 4 ay ileriye kadar bak, sonrasında "bulunamadı" say
  const sonuclar = [];
  for(const no of HOTEL_ODALAR) {
    if(window._O['oda'+no]?.durum === 'arizali') continue; // arızalı odayı hiç önerme
    let aday = enErkenTarih;
    let bulundu = null;
    for(let i = 0; i < LIMIT_GUN; i++) {
      const cikisAday = addDays(aday, gece);
      const kontrol = odaCakismaKontrol(no, aday, cikisAday);
      if(!kontrol.cakisma) { bulundu = { giris: aday, cikis: cikisAday }; break; }
      aday = addDays(aday, 1);
    }
    if(bulundu) {
      sonuclar.push({ odaNo: no, giris: bulundu.giris, cikis: bulundu.cikis, fiyat: getOdaFiyat(no, 1) });
    }
  }
  sonuclar.sort((a,b) => a.giris.localeCompare(b.giris) || a.odaNo - b.odaNo);
  return sonuclar;
}

window.odaBulAc = function() {
  document.getElementById('ob_gece').value = 1;
  document.getElementById('ob_baslangic').value = today();
  document.getElementById('odaBulSonuc').innerHTML = '';
  openModal('odaBulModal');
};

window.odaBulAra = function() {
  const gece = Math.max(1, parseInt(document.getElementById('ob_gece').value) || 1);
  const baslangic = document.getElementById('ob_baslangic').value || today();
  const sonuclar = odaBulTara(gece, baslangic);
  const govde = document.getElementById('odaBulSonuc');
  if(sonuclar.length === 0) {
    govde.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-style:italic">4 ay içinde müsait oda bulunamadı</div>';
    return;
  }
  govde.innerHTML = sonuclar.map(s => {
    const bugunMi = s.giris === today();
    const oz = window._OZ?.['oda'+s.odaNo] || {};
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--parchment);border:1px solid var(--border);border-left:3px solid ${bugunMi?'var(--green)':'var(--blue)'};margin-bottom:6px">
      <div>
        <div style="font-size:14px;font-weight:700;color:var(--dark)">Oda ${s.odaNo}${oz.ad?' — '+oz.ad:''} ${bugunMi?'<span class="badge badge-green" style="margin-left:4px">Bugün Müsait</span>':''}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${s.giris} → ${s.cikis} · ${gece} gece · ${s.fiyat?fmt(s.fiyat*gece):'—'}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="closeModal('odaBulModal');odaBulSecVeRezervAc(${s.odaNo},'${s.giris}',${gece})">Rezervasyon Yap</button>
    </div>`;
  }).join('');
};

// Bulunan sonucu doğrudan rezervasyon formuna aktarır
window.odaBulSecVeRezervAc = function(odaNo, giris, gece) {
  openRezervModalForOda(odaNo);
  setTimeout(() => {
    document.getElementById('rev_giris').value = giris;
    document.getElementById('rev_gece').value = gece;
    const sel = document.getElementById('rev_oda');
    if(sel) { [...sel.options].forEach(o => { o.selected = Number(o.value) === Number(odaNo); }); revOdaSecildi(); }
    revHesapla();
  }, 150);
};

window.openRezervModalForOda = function(odaNo, kaynakTalepId = null) {
  // Sadece doğrudan "Yeni Rezervasyon" butonundan açılınca sıfırla
  // talepOnayla'dan geliyorsa (kaynakTalepId var) sıfırlama
  if(!kaynakTalepId) {
    window._onaylananTalepId = null;
    window._onaylananKomisyoncu = null;
    window._onaylananKomisyoncuAd = null;
  }
  if(odaNo && window._O['oda'+odaNo]?.durum === 'arizali') {
    toast(`Oda ${odaNo} arızalı/bakımda — rezervasyon alınamaz.`, 'error');
    return;
  }
  // Formu sıfırla
  ['rev_giris','rev_gece','rev_tc','rev_ad','rev_tel','rev_not','rev_fiyat','rev_sozlesme_fiyat','rev_kismi_tutar','rev_dt','rev_komisyoncu'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('rev_gece').value = 1;
  document.getElementById('rev_cikis_goster').value = '';
  document.getElementById('rev_cikis').value = '';
  document.getElementById('rev_carpısma').style.display = 'none';
  document.getElementById('rev_kismi_wrap').style.display = 'none';
  const rfEl = document.getElementById('rev_fiyat'); if(rfEl) rfEl.dataset.manuelDegisim='';
  const arEl = document.getElementById('rev_araci'); if(arEl) arEl.checked=false;
  clearRefakatciler('revRefakatciListesi');
  ['rev_ozet_giris','rev_ozet_gece','rev_ozet_cikis','rev_ozet_oda','rev_ozet_toplam','rev_ozet_giris_gun','rev_ozet_cikis_gun','rev_ozet_oda_tip'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='—';});

  // Bugünü giriş tarihi olarak set et
  document.getElementById('rev_giris').value = today();
  rezervasyonKomisyoncuSecenekleriniGuncelle('rev_komisyoncu');
  document.getElementById('rev_odeme_durum').value = 'odenmedi';
  odemeDurumAlanGuncelle('rev');

  openModal('rezervModal');

  setTimeout(() => {
    const sel = document.getElementById('rev_oda');
    if(sel && odaNo) {
      [...sel.options].forEach(o => { o.selected = Number(o.value) === Number(odaNo); });
      revOdaSecildi();
    }
    revHesapla();
  }, 80);
};

window.revHesapla = function() {
  const giris = document.getElementById('rev_giris').value;
  const gece  = parseInt(document.getElementById('rev_gece').value)||1;

  // Geçmiş tarih engeli
  if(giris && giris < today()) {
    toast('Rezervasyon geçmiş tarihe yapılamaz', 'error');
    document.getElementById('rev_giris').value = today();
    return;
  }

  if(giris) {
    const cikis = addDays(giris, gece);
    document.getElementById('rev_cikis').value = cikis;
    const cikisGosterEl = document.getElementById('rev_cikis_goster'); if(cikisGosterEl) cikisGosterEl.value = cikis + ` (${gece} gece)`;
    const ozGirisEl = document.getElementById('rev_ozet_giris'); if(ozGirisEl) ozGirisEl.textContent = formatTarihGoster(giris);
    const ozGirisGunEl = document.getElementById('rev_ozet_giris_gun'); if(ozGirisGunEl) ozGirisGunEl.textContent = gunAdiGoster(giris);
    const ozGeceEl = document.getElementById('rev_ozet_gece'); if(ozGeceEl) ozGeceEl.textContent = gece;
    const ozCikisEl = document.getElementById('rev_ozet_cikis'); if(ozCikisEl) ozCikisEl.textContent = formatTarihGoster(cikis);
    const ozCikisGunEl = document.getElementById('rev_ozet_cikis_gun'); if(ozCikisGunEl) ozCikisGunEl.textContent = `${gunAdiGoster(cikis)} (${gece} Gece)`;

    // Uygun oda filtresi — seçilen tarih aralığında dolu/arızalı odaları işaretle
    revOdaFiltrele(giris, cikis);
  }
  revCarpısmaKontrol();
  revFiyatGuncelle();
};

function revOdaFiltrele(giris, cikis) {
  const sel = document.getElementById('rev_oda');
  if(!sel) return;
  const mevcutOda = sel.value;

  // Tüm oda seçeneklerini yeniden oluştur
  sel.innerHTML = '<option value="">— Seç —</option>';
  HOTEL_ODALAR.forEach(no => {
    const oda = window._O['oda'+no] || {durum:'bos'};

    // Rezervasyon çakışması kontrolü
    const cakisan = (window._R||[]).find(r =>
      Number(r.odaNo) === no && rezervasyonOdayiBloklar(r) &&
      (r.giris||'') < cikis && (r.cikis||'') > giris
    );

    // Fiili doluluk (check-in yapılmış)
    const fiiliDolu = oda.durum === 'dolu' && oda.giris && oda.giris < cikis && oda.cikis > giris;

    // Arızalı tarih aralığı kontrolü
    const arizaBas = String(oda.arizaBaslangic || today()).slice(0,10);
    const arizaBit = oda.arizaBitis ? String(oda.arizaBitis).slice(0,10) : null;
    const arizali = oda.durum === 'arizali' &&
      arizaBas < cikis && (!arizaBit || arizaBit > giris);

    const musaitDegil = cakisan || fiiliDolu || arizali;
    const opt = document.createElement('option');
    opt.value = no;
    opt.textContent = musaitDegil
      ? `Oda ${no} — ${arizali ? '🔧 Arızalı' : '🔴 Dolu'}`
      : `Oda ${no} ✓`;
    if(musaitDegil) {
      opt.disabled = true;
      opt.style.color = '#ccc';
    } else {
      opt.style.fontWeight = '600';
    }
    sel.appendChild(opt);
  });

  // Önceki seçimi koru (hâlâ müsaitse)
  if(mevcutOda) {
    const prevOpt = [...sel.options].find(o => o.value == mevcutOda);
    if(prevOpt && !prevOpt.disabled) sel.value = mevcutOda;
    else { sel.value = ''; revOdaSecildi(); }
  }
}

window.revOdaSecildi = function() {
  const odaNo = document.getElementById('rev_oda').value;
  if(!odaNo) return;
  if(window._O['oda'+odaNo]?.durum === 'arizali') {
    toast(`Oda ${odaNo} arızalı/bakımda — rezervasyon alınamaz.`, 'error');
    document.getElementById('rev_oda').value = '';
    const ozOdaElReset = document.getElementById('rev_ozet_oda'); if(ozOdaElReset) ozOdaElReset.textContent = '—';
    return;
  }
  const ozOdaEl = document.getElementById('rev_ozet_oda'); if(ozOdaEl) ozOdaEl.textContent = odaNo;
  const ozOdaTipEl = document.getElementById('rev_ozet_oda_tip');
  if(ozOdaTipEl) { const oz = window._OZ?.['oda'+odaNo] || {}; ozOdaTipEl.textContent = oz.tip || ''; }
  const sel = document.getElementById('rev_fiyat_tip');
  sel.innerHTML = '<option value="">— Fiyat tipi seçin —</option>' + [1,2,3,4].map(t=>`<option value="${t}">${getTipAd(t)} — ${getOdaFiyat(odaNo,t).toLocaleString('tr-TR')} ₺</option>`).join('');
  revFiyatGuncelle();
  revCarpısmaKontrol();
};

window.revFiyatGuncelle = function() {
  const odaNo = document.getElementById('rev_oda').value;
  const tipVal = document.getElementById('rev_fiyat_tip').value;
  const tip   = tipVal ? Number(tipVal) : 0;
  const gece  = parseInt(document.getElementById('rev_gece').value)||1;
  const fiyatEl = document.getElementById('rev_fiyat');
  // Manuel değişim yoksa otomatik doldur
  if(!fiyatEl.dataset.manuelDegisim) {
    const fiyat = tip>0 ? getOdaFiyat(odaNo, tip) : 0;
    fiyatEl.value = fiyat || '';
  }
  const fiyat = Number(fiyatEl.value)||0;
  const toplam = gece*fiyat;
  const subEl = document.getElementById('rev_fiyat_toplam_sub');
  if(subEl) subEl.textContent = toplam > 0 ? fmt(toplam) : '—';
  const ozTutarEl = document.getElementById('rev_ozet_toplam');
  if(ozTutarEl) ozTutarEl.textContent = toplam > 0 ? fmt(toplam) : '—';
  sozlesmeToplam('rev');
};

window.revCarpısmaKontrol = function() {
  const giris  = document.getElementById('rev_giris').value;
  const cikis  = document.getElementById('rev_cikis').value;
  const odaNo  = document.getElementById('rev_oda').value;
  const carpEl = document.getElementById('rev_carpısma');
  if(giris&&cikis&&odaNo) {
    const kontrol = odaCakismaKontrol(odaNo, giris, cikis);
    if(kontrol.cakisma) {
      carpEl.textContent = `⚠ Bu oda seçilen tarihlerde dolu! (${kontrol.detay})`;
      carpEl.style.display = 'block';
    } else carpEl.style.display = 'none';
  } else carpEl.style.display='none';
};

window.revTcAra = async function(tc) {
  if(!/^\d{11}$/.test(tc)) { document.getElementById('revMusteriBulundu').style.display='none'; return; }
  const q = query(collection(db,'musteriler'), where('tc','==',tc));
  const snap = await getDocs(q);
  if(!snap.empty) {
    const m = snap.docs[0].data();
    document.getElementById('rev_ad').value = m.ad||'';
    document.getElementById('rev_tel').value = m.tel||'';
    document.getElementById('rev_mb_ad').textContent = `${m.ad} — Kayıtlı Müşteri`;
    document.getElementById('rev_mb_meta').textContent = `${m.konaklamaSayisi||0} kez konaklamış`;
    document.getElementById('revMusteriBulundu').style.display = 'block';
  } else document.getElementById('revMusteriBulundu').style.display='none';
};

window.saveRezervasyon = async function(mod = '') {
  const giris   = document.getElementById('rev_giris').value;
  const cikis   = document.getElementById('rev_cikis').value;
  const gece    = parseInt(document.getElementById('rev_gece').value)||1;
  const odaNo   = document.getElementById('rev_oda').value;
  const todayStr = today();
  const odaMetaKontrol = window._O['oda'+odaNo];
  if(odaMetaKontrol?.durum === 'arizali') {
    const arizaBas = String(odaMetaKontrol.arizaBaslangic || todayStr).slice(0,10);
    const arizaBit = odaMetaKontrol.arizaBitis ? String(odaMetaKontrol.arizaBitis).slice(0,10) : '9999-12-31';
    const rezervasyonBakimaCarpiyor = !!giris && !!cikis && arizaBas < cikis && arizaBit > giris;
    if(rezervasyonBakimaCarpiyor) { toast(`Oda ${odaNo} seçilen tarihlerde arızalı/bakımda (${arizaBas} → ${arizaBit==='9999-12-31'?'süresiz':arizaBit}).`, 'error'); return; }
  }
  const tc      = document.getElementById('rev_tc').value.trim();
  const ad      = document.getElementById('rev_ad').value.trim();
  const tel     = document.getElementById('rev_tel').value.trim();
  const yetiskin= parseInt(document.getElementById('rev_yetiskin').value)||1;
  const cocuk   = parseInt(document.getElementById('rev_cocuk').value)||0;
  const kaynak  = document.getElementById('rev_kaynak').value;
  const fiyatTipHam = document.getElementById('rev_fiyat_tip').value;
  const fiyatTip= fiyatTipHam ? Number(fiyatTipHam) : 0;
  const fiyat   = Number(document.getElementById('rev_fiyat').value)||0;
  const odemeDurum = document.getElementById('rev_odeme_durum').value;
  const odemeTipHam = document.getElementById('rev_odeme_tip').value;
  const odemeTip   = odemeDurum==='odenmedi' ? null : (odemeTipHam||'nakit');
  const not_    = document.getElementById('rev_not').value;
  const misafirBilgisiBekleniyor = document.getElementById('rev_araci')?.checked || false;
  const komisyoncuSecim = document.getElementById('rev_komisyoncu')?.value || window._onaylananKomisyoncu || '';
  if(komisyoncuSecim === '__legacy__') { toast('Eski komisyoncu kaydı doğrulanmadan rezervasyon kaydedilemez','error'); return; }
  const komisyoncuKey = String(komisyoncuSecim||'');
  const komisyoncuAdi = komisyoncuKey ? (window.KOMISYONCULAR?.[komisyoncuKey]?.ad || '') : '';
  const misafirKayit = ad || (misafirBilgisiBekleniyor ? 'Misafir bilgisi check-in’de alınacak' : '');
  const now     = nowISO();

  if(!giris||!cikis||!odaNo||!misafirKayit) { toast('Zorunlu alanları doldurun','error'); return; }
  if(misafirBilgisiBekleniyor && !komisyoncuAdi && !komisyoncuKey) { toast('Misafir bilgileri sonra alınacaksa Komisyoncu / Acente seçimi zorunludur','error'); return; }
  if(!fiyatTip) { toast('Fiyat tipi seçilmeden rezervasyon kaydedilemez','error'); return; }
  if(!fiyat || fiyat <= 0) { toast('Otel net gecelik fiyat 0 olamaz — Oda ve fiyat tipini kontrol edin','error'); return; }

  // ÇAKIŞMA KONTROLÜ — hem rezervasyonlar hem dolu odanın konaklaması
  const kontrol = odaCakismaKontrol(odaNo, giris, cikis);
  if(kontrol.cakisma) {
    toast(`⚠ Oda ${odaNo} bu tarihlerde dolu! (${kontrol.tip === 'rezervasyon' ? 'Rezervasyon' : 'Konaklama'}: ${kontrol.detay})`, 'error');
    return;
  }

  const sozlesmeFiyat = document.getElementById('rev_sozlesme_fiyat')?.value ? Number(document.getElementById('rev_sozlesme_fiyat').value) : null;
  if(komisyoncuKey && (!sozlesmeFiyat || sozlesmeFiyat<=0)) { toast('Komisyoncu seçiliyse müşteriye uygulanacak Sözleşme Fiyatı zorunludur','error'); return; }
  const revFiyatKontrol = komisyonFiyatDogrula(fiyat, sozlesmeFiyat, komisyoncuAdi, komisyoncuKey);
  if(!revFiyatKontrol.ok) { toast('⚠ '+revFiyatKontrol.mesaj,'error'); return; }
  const refakatciler = getRefakatciler('revRefakatciListesi');
  const kismiTutar = ['kismi','depozito'].includes(odemeDurum) ? (Number(document.getElementById('rev_kismi_tutar')?.value)||0) : null;
  const odemeToplamBaz = (sozlesmeFiyat||fiyat)*gece;
  if(kismiTutar != null && (kismiTutar <= 0 || kismiTutar > odemeToplamBaz)) {
    toast(`Alınan/depozito tutarı 0'dan büyük ve toplamdan (${fmt(odemeToplamBaz)}) fazla olmamalı`,'error'); return;
  }

  const kaynakTalep = window._onaylananTalepId ? (window._TALEP||[]).find(t=>t.id===window._onaylananTalepId) : null;
  const komSnapshot = komisyonSnapshotAl(komisyoncuKey, komisyoncuAdi, kaynakTalep);
  const revRef = await addDoc(collection(db,'rezervasyonlar'),{
    giris,cikis,gece,odaNo:Number(odaNo),tc,misafir:misafirKayit,tel,
    yetiskin,cocuk,kaynak,fiyatTip,fiyatTipAd:getTipAd(fiyatTip),
    fiyat,sozlesmeFiyat,durum:'bekliyor',odemeDurum,odemeTuru:odemeTip,not:not_,
    kismiTutar, kismiKalan: kismiTutar!=null ? Math.max(0,((sozlesmeFiyat||fiyat)*gece)-kismiTutar) : null,
    aracirez:misafirBilgisiBekleniyor,
    misafirBilgisiBekleniyor,
    araciAd: komisyoncuAdi || null,
    refakatciler,
    dt: document.getElementById('rev_dt')?.value || '',
    kaynakTalepId: window._onaylananTalepId || null,
    komisyoncu: komisyoncuKey || window._onaylananKomisyoncu || null,
    komisyoncuAd: komisyoncuAdi || window._onaylananKomisyoncuAd || null,
    komisyonTipSnapshot: komisyoncuKey ? komSnapshot.tip : 'manuel',
    komisyonDegerSnapshot: komisyoncuKey ? komSnapshot.deger : 0,
    komisyonSnapshotKaynak: komisyoncuKey ? komSnapshot.kaynak : 'yok',
    kayitTarih:now
  });

  await logAktivite('rezervasyon', `${misafirKayit} · Oda ${odaNo} · ${giris}→${cikis} · ${gece} gece · ${fmt(gece*fiyat)}`, odaNo);
  // Bu rezervasyon bir Instagram/komisyoncu talebinden onaylandıysa, talebin durumunu güncelle
  if(window._onaylananTalepId) {
    await updateDoc(doc(db,'rezervasyon_talepleri', window._onaylananTalepId), {durum:'onaylandi', islemTarih: nowISO()});
    window._onaylananTalepId = null;
    window._onaylananKomisyoncu = null;
    window._onaylananKomisyoncuAd = null;
  }

  if(mod === 'yeniOda') {
    // Sadece oda/tarih/fiyat alanlarını sıfırla — misafir bilgileri kalsın
    ['rev_giris','rev_gece','rev_fiyat','rev_sozlesme_fiyat','rev_kismi_tutar','rev_not','rev_komisyoncu'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    document.getElementById('rev_oda').value='';
    document.getElementById('rev_cikis_goster').value='';
    document.getElementById('rev_carpısma').style.display='none';
    document.getElementById('rev_kismi_wrap').style.display='none';
    const rfEl = document.getElementById('rev_fiyat'); if(rfEl) rfEl.dataset.manuelDegisim='';
    const rstEl = document.getElementById('rev_sozlesme_toplam'); if(rstEl) rstEl.textContent='0,00 ₺';
    const rftEl = document.getElementById('rev_fiyat_toplam_sub'); if(rftEl) rftEl.textContent='';
    ['rev_ozet_giris','rev_ozet_gece','rev_ozet_cikis','rev_ozet_oda','rev_ozet_toplam','rev_ozet_giris_gun','rev_ozet_cikis_gun','rev_ozet_oda_tip'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='—';});
    // Gece sayısını 1'e sıfırla
    const revGeceEl = document.getElementById('rev_gece'); if(revGeceEl) revGeceEl.value=1;
    toast(`Oda ${odaNo} kaydedildi ✓ — ${misafirKayit} için yeni oda ekleyebilirsiniz`, 'success');
    // Modal açık kalır, scroll en üste
    document.querySelector('#rezervModal .modal')?.scrollTo(0,0);
  } else {
    // Normal kaydet — her şeyi temizle ve kapat
    ['rev_giris','rev_gece','rev_tc','rev_ad','rev_tel','rev_not','rev_fiyat','rev_sozlesme_fiyat','rev_kismi_tutar','rev_dt','rev_komisyoncu'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    document.getElementById('rev_oda').value='';
    document.getElementById('rev_cikis_goster').value='';
    document.getElementById('rev_carpısma').style.display='none';
    document.getElementById('rev_kismi_wrap').style.display='none';
    clearRefakatciler('revRefakatciListesi');
    const rfEl = document.getElementById('rev_fiyat'); if(rfEl) rfEl.dataset.manuelDegisim='';
    const arEl = document.getElementById('rev_araci'); if(arEl) arEl.checked=false;
    const rstEl = document.getElementById('rev_sozlesme_toplam'); if(rstEl) rstEl.textContent='0,00 ₺';
    const rftEl = document.getElementById('rev_fiyat_toplam_sub'); if(rftEl) rftEl.textContent='';
    closeModal('rezervModal');
    toast('Rezervasyon kaydedildi ✓','success');
  }
};

window.renderRezervasyonlar = function() {
  const fd = document.getElementById('rev-filter-durum')?.value||'';
  const fo = document.getElementById('rev-filter-oda')?.value||'';
  const todayStr = today();

  const withDurum = window._R.map(r=>{
    let durum=String(r.durum||'bekliyor');
    if(['iptal','noshow'].includes(durum)) return {...r,_durum:durum};
    if(durum==='tamamlandi' || r.checkoutTarih) return {...r,_durum:'tamamlandi'};
    if(durum==='aktif' || rezervasyonCheckinOlmus(r)) return {...r,_durum:'aktif'};
    if(r.giris && r.giris<=todayStr) return {...r,_durum:'karar_bekliyor'};
    return {...r,_durum:'bekliyor'};
  });

  let d = withDurum;
  if(fd === 'bekleyenler') d = d.filter(r => r._durum==='bekliyor' || r._durum==='karar_bekliyor');
  else if(fd) d = d.filter(r=>r._durum===fd);
  if(fo) d=d.filter(r=>String(r.odaNo)===String(fo));

  const odaSel = document.getElementById('rev-filter-oda');
  if(odaSel&&odaSel.children.length<=1) for(const i of HOTEL_ODALAR) odaSel.innerHTML+=`<option value="${i}">Oda ${i}</option>`;

  const dc={bekliyor:'badge-blue',aktif:'badge-green',tamamlandi:'badge-gray',iptal:'badge-red',noshow:'badge-red',karar_bekliyor:'badge-orange'};
  const dt={bekliyor:'Bekliyor',aktif:'Aktif',tamamlandi:'Tamamlandı',iptal:'İptal',noshow:'No-show',karar_bekliyor:'⚠ Check-in Kararı Bekliyor'};

  const odDurumMap = {odendi:'✓ Ödendi', odenmedi:'Ödenmedi', depozito:'Depozito', kismi:'Kısmi'};
  const odDurumCls = {odendi:'badge-green', odenmedi:'badge-red', depozito:'badge-gold', kismi:'badge-orange'};

  document.getElementById('rezervBody').innerHTML = d.length ? d.map(r=>`
    <tr>
      <td>${r.giris||'—'}</td>
      <td>${r.cikis||'—'}</td>
      <td>${r.gece||geceSayisi(r.giris,r.cikis)||'—'}</td>
      <td>Oda ${r.odaNo}</td>
      <td>${r.aracirez?'🤝 ':''}${r.misafir||'—'}${r.aracirez?' <span style="font-size:9px;color:var(--gold2);font-weight:700">ARACI</span>':''}</td>
      <td style="font-size:11px;color:var(--muted)">${r.tc||'—'}</td>
      <td style="font-size:11px">${(r.yetiskin||1)+(r.cocuk||0)} kişi</td>
      <td>${r.kaynak?`<span class="badge badge-blue">${r.kaynak}</span>`:'—'}</td>
      <td>
        <div class="amount-pos" style="font-size:12px">${r.fiyat?fmt(r.fiyat)+'/gece':'—'}</div>
        ${r.odemeDurum?`<span class="badge ${odDurumCls[r.odemeDurum]||'badge-gray'}" style="font-size:9px;margin-top:2px">${odDurumMap[r.odemeDurum]||r.odemeDurum}${['kismi','depozito'].includes(r.odemeDurum)&&r.kismiTutar!=null?` (${r.kismiTutar.toLocaleString('tr-TR')}₺)`:''}</span>`:''}
      </td>
      <td><span class="badge ${dc[r._durum]||'badge-gray'}">${dt[r._durum]||r._durum}</span></td>
      <td style="display:flex;gap:4px;padding:6px;flex-wrap:wrap">
        ${['bekliyor','karar_bekliyor'].includes(r._durum)?`<button class="btn btn-success btn-sm" onclick="checkindenRezervasyon(${JSON.stringify({...r,id:r.id}).replace(/"/g,'&quot;')})">Check-in</button>`:''}
        ${['bekliyor','aktif','karar_bekliyor'].includes(r._durum)?`<button class="btn btn-ghost btn-sm" onclick="sozlesmeOnaysiziGonder('${r.odaNo}','${r.id}')">📄 Sözleşme</button>`:''}
        ${['bekliyor','karar_bekliyor'].includes(r._durum)?`<button class="btn btn-ghost btn-sm" onclick="revDuzenleAc(${JSON.stringify({...r,id:r.id}).replace(/"/g,'&quot;')})">✏ Düzenle</button>`:''}
        ${['bekliyor','karar_bekliyor'].includes(r._durum)?`<button class="btn btn-warning btn-sm" onclick="noShowModal('${r.id}','${r.misafir||''}',${r.fiyat||0},'${r.odaNo}')">No-show</button>`:''}
        ${['bekliyor','karar_bekliyor'].includes(r._durum)?`<button class="btn btn-danger btn-sm" onclick="iptalRezervasyon('${r.id}')">İptal</button>`:''}
        ${r._durum==='aktif'?`<span class="badge badge-green" style="align-self:center">Aktif konaklama · oda kartından yönetilir</span>`:''}
      </td>
    </tr>`).join('')
  : '<tr class="empty-row"><td colspan="11">Rezervasyon bulunamadı</td></tr>';
};

window.noShowModal = function(id, misafir, fiyat, odaNo) {
  const rev = (window._R||[]).find(r=>r.id===id) || {};
  const gece = geceSayisi(rev.giris,rev.cikis);
  const musteriGecelik = Math.max(0,Number(rev.sozlesmeFiyat||rev.fiyat||fiyat)||0);
  const toplam = Math.max(0,musteriGecelik*gece);
  const tahsil = rezervasyonTahsilEdilenTutar(rev);
  const birGece = Math.min(toplam, musteriGecelik);
  const tamKom = komisyonToplamHesapla({otelFiyat:rev.fiyat,sozlesmeFiyat:rev.sozlesmeFiyat,gece,araciAd:rev.araciAd||rev.komisyoncuAd||'',komisyoncuKey:rev.komisyoncu||''});
  document.getElementById('ns_id').value = id;
  document.getElementById('ns_fiyat').value = Number(rev.fiyat||fiyat)||0;
  document.getElementById('ns_oda').value = odaNo;
  document.getElementById('ns_misafir_ad').textContent = misafir || rev.misafir || 'Misafir';
  document.getElementById('ns_ucret_lbl').textContent = `1 Gecelik Bedeli Gelirleştir (${birGece.toLocaleString('tr-TR')} ₺)`;
  const tahsilBtn=document.getElementById('ns_tahsil_btn');
  if(tahsilBtn) tahsilBtn.style.display = tahsil>0.009 ? 'flex' : 'none';
  const tahsilLbl=document.getElementById('ns_tahsil_lbl');
  if(tahsilLbl) tahsilLbl.textContent = `Alınmış Ödemeyi Gelirleştir (${tahsil.toLocaleString('tr-TR')} ₺)`;
  const ozet=document.getElementById('ns_finans_ozet');
  if(ozet) ozet.innerHTML = `Sözleşme: <b style="color:var(--dark)">${toplam.toLocaleString('tr-TR')} ₺</b> · Alınmış ödeme: <b style="color:${tahsil>0?'var(--green)':'var(--muted)'}">${tahsil.toLocaleString('tr-TR')} ₺</b><br>Tam rezervasyon komisyonu: <b style="color:var(--gold2)">${Number(tamKom.toplam||0).toLocaleString('tr-TR')} ₺</b>`;
  openModal('noShowModal');
};

window.saveNoShow = async function(tip) {
  const id    = document.getElementById('ns_id').value;
  const odaNo = document.getElementById('ns_oda').value;
  const rev   = (window._R||[]).find(r => r.id === id);
  if(!rev) { toast('Rezervasyon bulunamadı','error'); return; }
  const now   = nowISO();
  const gece = geceSayisi(rev.giris,rev.cikis);
  const musteriGecelik = Math.max(0,Number(rev.sozlesmeFiyat||rev.fiyat)||0);
  const musteriToplam = Math.max(0,musteriGecelik*gece);
  const tahsil = rezervasyonTahsilEdilenTutar(rev);

  // Ne kadarı gerçekten otelde kalacak? Ücretsiz iptal=0, bir gece=1 gecelik sözleşme bedeli,
  // tahsil=check-in öncesi alınmış ödemenin iade edilmeyen tamamı.
  let gelirlesen = 0;
  if(tip==='ucret') gelirlesen = Math.min(musteriToplam, musteriGecelik);
  if(tip==='tahsil') gelirlesen = Math.min(musteriToplam, tahsil);
  gelirlesen = Math.round(Math.max(0,gelirlesen)*100)/100;
  const tahsilMahsup = Math.min(tahsil, gelirlesen);
  const kalanAlacak = Math.max(0,Math.round((gelirlesen-tahsilMahsup)*100)/100);
  const iadeBekleyen = Math.max(0,Math.round((tahsil-gelirlesen)*100)/100);
  const kom = gelirlesenRezervasyonKomisyonu(rev, gelirlesen);

  const sonucDurum = tip==='iptal' ? 'iptal' : 'noshow';
  await updateDoc(doc(db,'rezervasyonlar',id), {
    durum:sonucDurum, noShowTarih:tip==='iptal'?null:now, noShowTip:tip,
    iptalTarih:tip==='iptal'?now:null,
    noShowGelirlesenTutar:gelirlesen, noShowTahsilEdilen:tahsilMahsup,
    noShowKalanAlacak:kalanAlacak, iadeBekleyen,
    noShowKomisyon:Number(kom.toplam)||0, guncelleme:now
  });

  const gelirId=`noshow_${id}`;
  if(gelirlesen > 0.009) {
    await setDoc(doc(db,'gelirler',gelirId), {
      rezervasyonId:id, tarih:today(), tutar:gelirlesen,
      odaNo:String(odaNo), giris:rev.giris||'', cikis:rev.cikis||'', gece:0,
      fiyat:Number(rev.fiyat)||0, sozlesmeFiyat:Number(rev.sozlesmeFiyat)||0,
      odemeTuru:rev.odemeTuru||'—',
      odemeDurum:kalanAlacak<=0.009?'odendi':'kismi',
      tahsilEdilen:tahsilMahsup, kalanTahsilat:kalanAlacak, iadeBekleyen,
      misafir:rev.misafir||'—', tc:rev.tc||'', kaynak:'no-show',
      araciAd:araciKanonikAd(rev.araciAd||rev.komisyoncuAd||'')||null,
      komisyoncu:kom.komisyoncu||rev.komisyoncu||null,
      komisyoncuAd:kom.araciAd||rev.komisyoncuAd||null,
      komisyonFark:Number(kom.toplam)||0,
      aciklama:`No-show gelirleşen bedel — Oda ${odaNo} · ${rev.misafir||'—'}`,
      kayitTarih:now, guncelleme:now
    },{merge:true});
  } else {
    try { await deleteDoc(doc(db,'gelirler',gelirId)); } catch(_) {}
  }

  const komId='komisyon_'+gelirId;
  if(gelirlesen>0.009 && Number(kom.toplam)>0.009) {
    await setDoc(doc(db,'komisyonlar',komId), {
      gelirDocId:gelirId, rezervasyonId:id, tarih:today(), odaNo:String(odaNo),
      misafir:rev.misafir||'—', kaynak:'no-show-gelirlesmis',
      gece:kom.esdegerGece, gercekFiyat:Number(rev.fiyat)||0, sozlesmeFiyat:Number(rev.sozlesmeFiyat)||0,
      gecelikKomisyon:Number(kom.gecelik)||0, komisyonKaynak:kom.kaynak,
      komisyonFark:Number(kom.toplam)||0, toplamKomisyon:Number(kom.toplam)||0,
      gelirlesenTutar:gelirlesen, gelirlesmeOrani:Number(kom.oran)||0,
      araciAd:kom.araciAd||araciKanonikAd(rev.araciAd||rev.komisyoncuAd||'')||null,
      komisyoncu:kom.komisyoncu||rev.komisyoncu||null,
      komisyoncuAd:kom.araciAd||rev.komisyoncuAd||null,
      komisyonTipSnapshot:rev.komisyonTipSnapshot||rev.komisyonTip||'manuel',
      komisyonDegerSnapshot:Number(rev.komisyonDegerSnapshot??rev.komisyonDeger)||0,
      cariDahil:true, mutabakatDurum:'no_show_dogrulanmis',
      komisyonHareketleri:[{tarih:now,tutar:Number(kom.toplam)||0,tip:'hakedis',aciklama:`No-show gelirleşen ödeme hakedişi · Oda ${odaNo} · ${fmt(gelirlesen)}`}],
      kayitTarih:now,guncelleme:now
    },{merge:true});
  } else {
    try { await deleteDoc(doc(db,'komisyonlar',komId)); } catch(_) {}
  }

  await talepIptalGuncelle(rev,sonucDurum,tip==='iptal'?'Ücretsiz iptal':(gelirlesen>0?`No-show · ${fmt(gelirlesen)} gelirleşti`:'No-show'));
  await logAktivite(tip==='iptal'?'rezervasyon_iptal':'no_show', `${rev.misafir||'?'} · Oda ${odaNo} · gelirleşen ${fmt(gelirlesen)} · komisyon ${fmt(kom.toplam||0)}${iadeBekleyen>0?' · iade bekleyen '+fmt(iadeBekleyen):''}`, odaNo);
  closeModal('noShowModal');
  toast(`${tip==='iptal'?'Rezervasyon iptal edildi':'No-show işlendi'} · Gelirleşen ${fmt(gelirlesen)}${Number(kom.toplam)>0?' · Kesin komisyon '+fmt(kom.toplam):''}${iadeBekleyen>0?' · İade bekleyen '+fmt(iadeBekleyen):''}`, 'success');

  if(window._noShowSonrasiCheckinOda) {
    const devamOda=Number(window._noShowSonrasiCheckinOda);
    window._noShowSonrasiCheckinOda=null;
    setTimeout(()=>openCheckin(devamOda),180);
  }
};

window.iptalRezervasyon = async function(id) {
  const rev = window._R.find(r => r.id === id);
  if(!rev) { toast('Rezervasyon bulunamadı','error'); return; }
  const aktifOda = window._O?.['oda'+rev.odaNo];
  if(rev.durum === 'aktif' || (aktifOda?.durum === 'dolu' && aktifOda?.rezervasyonId === id)) {
    toast(`Oda ${rev.odaNo} için konaklama başlamış. Aktif rezervasyon iptal edilemez; oda kartından Check-out işlemi kullanılmalı.`, 'error');
    return;
  }
  if(!confirm('Rezervasyon iptal edilsin mi? Kayıt geçmişi silinmeyecek, iptal olarak işaretlenecek.')) return;
  const now = nowISO();
  await updateDoc(doc(db,'rezervasyonlar',id), {durum:'iptal', iptalTarih:now, guncelleme:now});
  // Finansal kayıtlar fiziksel olarak silinmez. Varsa eski/yanlış bağlı kayıtlar denetim
  // izi olarak kalır; aktif gelir/komisyon üretme akışları durum='iptal'i dikkate almaz.
  await talepIptalGuncelle(rev, 'iptal', 'Rezervasyon iptal edildi');
  await logAktivite('rezervasyon_iptal', `Rezervasyon iptal edildi (ID: ${id})`);
  toast('Rezervasyon iptal edildi','success');
};

// Bağlı komisyoncu talebini bul ve durumunu güncelle
async function talepIptalGuncelle(rev, yeniDurum, not) {
  if(!rev) return;
  try {
    // Önce kaynakTalepId ile direkt bul
    if(rev.kaynakTalepId) {
      await updateDoc(doc(db,'rezervasyon_talepleri', rev.kaynakTalepId), {
        durum: yeniDurum,
        iptalNot: not,
        iptalTarih: nowISO()
      });
      return;
    }
    // Fallback: misafir + oda ile eşleştir
    const snap = await getDocs(query(
      collection(db,'rezervasyon_talepleri'),
      where('kaynak','==','komisyoncu'),
      where('durum','==','onaylandi')
    ));
    const eslesen = snap.docs.find(d => {
      const t = d.data();
      return t.misafir === rev.misafir && Number(t.odaNo) === Number(rev.odaNo);
    });
    if(eslesen) {
      await updateDoc(doc(db,'rezervasyon_talepleri', eslesen.id), {
        durum: yeniDurum,
        iptalNot: not,
        iptalTarih: nowISO()
      });
    }
  } catch(e) { console.warn('Talep güncelleme hatası:', e); }
}

// ── MASRAF LİSTESİ ──
window.renderMasraflar = function() {
  const fo  = document.getElementById('masraf-filter-oda')?.value || '';
  const fd  = document.getElementById('masraf-filter-durum')?.value || '';
  const fk  = document.getElementById('masraf-filter-kategori')?.value || '';
  let d = window._M;
  if(fo) d = d.filter(m => String(m.odaNo) === String(fo));
  if(fd) d = d.filter(m => m.odemeDurumu === fd || m.durum === fd);
  if(fk) d = d.filter(m => m.kategori === fk);

  // Filtre oda listesini doldur (oda adıyla)
  const odaSel = document.getElementById('masraf-filter-oda');
  if(odaSel && odaSel.children.length <= 1) {
    for(const i of HOTEL_ODALAR) {
      const oz = window._OZ?.['oda'+i] || {};
      const label = oz.ad ? `Oda ${i} — ${oz.ad}` : `Oda ${i}`;
      odaSel.innerHTML += `<option value="${i}">${label}</option>`;
    }
  }

  // Özet kartları güncelle
  const acikDurumlar = new Set(['odaya_yansitildi','acik','checkout_kismi','checkout_borc']);
  const acik = window._M.filter(m => acikDurumlar.has(m.odemeDurumu));
  const yansi = window._M.filter(m => m.odemeDurumu === 'odaya_yansitildi');
  const ayri  = window._M.filter(m => m.odemeDurumu === 'ayri_odendi');
  const masrafAcikTutar = m => (m.checkoutKalan != null ? Math.max(0,Number(m.checkoutKalan)||0) : Math.max(0,Number(m.tutar)||0));
  document.getElementById('masraf-acik-toplam').textContent  = fmt(acik.reduce((a,b)=>a+masrafAcikTutar(b),0));
  document.getElementById('masraf-yansi-toplam').textContent = fmt(yansi.reduce((a,b)=>a+Number(b.tutar||0),0));
  document.getElementById('masraf-ayri-toplam').textContent  = fmt(ayri.reduce((a,b)=>a+Number(b.tutar||0),0));

  const durumBadge = (m) => {
    const map = {
      'odaya_yansitildi': ['badge-orange','Odaya Yansıtıldı'],
      'ayri_odendi':      ['badge-green', 'Ayrı Ödendi'],
      'checkout_odendi':  ['badge-blue',  'Check-out\'ta Ödendi'],
      'checkout_kismi':   ['badge-orange','Check-out Kısmi'],
      'checkout_borc':    ['badge-red',   'Check-out Borcu'],
      'acik':             ['badge-red',   'Açık'],
    };
    const [cls, lbl] = map[m.odemeDurumu] || map[m.durum] || ['badge-gray','—'];
    return `<span class="badge ${cls}">${lbl}</span>`;
  };

  document.getElementById('masrafBody').innerHTML = d.length ? d.map(m => {
    const oz = window._OZ?.['oda'+m.odaNo] || {};
    const odaLabel = oz.ad ? `Oda ${m.odaNo}<br><span style="font-size:10px;color:var(--gold)">${oz.ad}</span>` : `Oda ${m.odaNo}`;
    return `<tr>
      <td style="font-size:11px;white-space:nowrap">${timeStr(m.kayitTarih)}</td>
      <td style="font-family:'Cormorant Garamond',serif;font-size:15px;font-weight:700">${odaLabel}</td>
      <td style="font-size:12px">${m.misafir||'—'}</td>
      <td><span class="badge badge-orange">${m.kategori||'—'}</span></td>
      <td style="font-size:12px">${m.aciklama||'—'}</td>
      <td class="amount-neg" style="white-space:nowrap">−${fmt(m.tutar)}</td>
      <td>${durumBadge(m)}</td>
      <td style="font-size:11px;color:var(--muted)">${m.kimGirdi||'—'}</td>
      <td style="display:flex;gap:4px;padding:6px;flex-wrap:wrap">
        ${(['odaya_yansitildi','acik','checkout_kismi','checkout_borc'].includes(m.odemeDurumu))
          ?`<button class="btn btn-success btn-sm" onclick="masrafAyriOde('${m.id}')">Kalanı Tahsil Et</button>`:''}
        <button class="btn btn-danger btn-sm" onclick="deleteMasraf('${m.id}')">Sil</button>
      </td>
    </tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="9">Masraf kaydı yok</td></tr>';

  const top = d.reduce((a,b)=>a+Number(b.tutar||0),0);
  document.getElementById('masrafToplam').textContent = d.length ? `${d.length} kayıt · Toplam: ${fmt(top)}` : '';
};

window.masrafAyriOde = async function(id) {
  const m = window._M.find(x => x.id === id);
  if(!m) return;
  const odeme = prompt('Ödeme türü: nakit / kart / havale', 'nakit');
  if(!odeme) return;
  const now = nowISO();
  const toplamMasraf = Math.max(0,Number(m.tutar)||0);
  const oncekiTahsil = Math.max(0,Number(m.checkoutTahsilEdilen)||0);
  const kalan = m.checkoutKalan != null ? Math.max(0,Number(m.checkoutKalan)||0) : Math.max(0,toplamMasraf-oncekiTahsil);
  if(kalan <= 0.009) { toast('Bu masrafın açık bakiyesi yok.','info'); return; }
  await updateDoc(doc(db,'odaMasraflari',id), {
    odemeDurumu:'ayri_odendi', odemeTuru:odeme, odemeZamani:now,
    checkoutTahsilEdilen:Math.min(toplamMasraf,oncekiTahsil+kalan), checkoutKalan:0
  });
  await setDoc(doc(db,'gelirler',`oda_masrafi_${id}`), {
    masrafId:id, tarih: today(), tutar: toplamMasraf,
    odaNo: m.odaNo, odemeTuru: odeme, odemeDurum:'odendi',
    tahsilEdilen:toplamMasraf, kalanTahsilat:0,
    misafir: m.misafir, tc: m.tc||'', konaklamaKey:m.konaklamaKey||null,
    gelirDocId:m.gelirDocId||null, rezervasyonId:m.rezervasyonId||null,
    kaynak: 'oda-masrafi',
    aciklama: `Oda ${m.odaNo} · Masraf · ${m.aciklama}`,
    kayitTarih: m.kayitTarih||now, guncelleme:now
  },{merge:true});
  toast(`Masrafın kalan ${fmt(kalan)} tutarı tahsil edildi ✓`,'success');
};

window.deleteMasraf = async function(id) {
  if(!confirm('Masraf silinsin mi?')) return;
  await deleteDoc(doc(db,'odaMasraflari',id));
  toast('Masraf silindi','success');
};

// ── MODAL & SAYFA ──
window.openModal = function(id) {
  document.getElementById(id).classList.add('active');
  // Tarih inputlarına bugünü min olarak set et
  const t = today();
  document.querySelectorAll(`#${id} input[type=date]`).forEach(inp => {
    if(!inp.value) inp.value = t;
    // Geçmiş tarih engeli — sadece rezervasyon ve checkin tarih inputlarına
    if(inp.id === 'ci_giris' || inp.id === 'rev_giris') inp.min = t;
  });
};
window.closeModal = function(id) { document.getElementById(id).classList.remove('active'); };
document.querySelectorAll('.modal-overlay').forEach(el=>el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('active');}));

const RAPOR_PIN_HASH = 'a8c42a5a10da46f05265436854dc4e59d412d694214bbe67d22c656e481d97bf';
let _raporKilitli = true;
let _raporTab = null;

window.raporPinIste = function(tab) {
  if(!_raporKilitli) { showPage('rapor', tab); return; }
  _raporTab = tab;
  document.getElementById('rapor_pin').value = '';
  document.getElementById('rapor_pin_hata').style.display = 'none';
  openModal('raporPinModal');
  setTimeout(() => document.getElementById('rapor_pin').focus(), 150);
};

window.raporPinDogrula = async function() {
  const pin = document.getElementById('rapor_pin').value.trim();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  const hash = Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
  if(hash === RAPOR_PIN_HASH) {
    _raporKilitli = false;
    closeModal('raporPinModal');
    showPage('rapor', _raporTab);
    // 30 dakika sonra tekrar kilitle
    setTimeout(() => { _raporKilitli = true; }, 30 * 60 * 1000);
  } else {
    document.getElementById('rapor_pin_hata').style.display = 'block';
    document.getElementById('rapor_pin').value = '';
    document.getElementById('rapor_pin').focus();
  }
};

window.showPage = function(id, tab) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('page-'+id)?.classList.add('active');
  tab.classList.add('active');
  if(id==='takvim') setTimeout(renderTakvim,50);
  if(id==='rapor') { renderRapor(); fillRaporAy(); }
};

// ── RAPOR ──

window.raporBolumeGit = function(id) {
  const el=document.getElementById(id);
  if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
};

function fillRaporAy() {
  const sel = document.getElementById('rapor-ay');
  if(!sel || sel.children.length > 1) return;
  const aylar = [...new Set([
    ...window._G.map(g=>g.tarih?.slice(0,7)),
    ...(window._R||[]).map(r=>r.giris?.slice(0,7))
  ].filter(Boolean))].sort().reverse();
  aylar.forEach(ay => {
    const o = document.createElement('option');
    o.value = ay; o.textContent = ay;
    sel.appendChild(o);
  });
}

function thisMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}

window.renderRapor = function() {
  const secilenAy = document.getElementById('rapor-ay')?.value || thisMonth();
  const ay = secilenAy || thisMonth();
  const fmt2 = n => Number(n||0).toLocaleString('tr-TR', {minimumFractionDigits:0}) + ' ₺';

  // Ay içindeki rezervasyonlar (giriş veya çıkış bu ayda olanlar — doluluk hesabı için)
  // Ayla herhangi bir noktada örtüşen, iptal/no-show olmayan rezervasyonlar.
  const [rapYil, rapAyNo] = ay.split('-').map(Number);
  const rapAyBas = ay + '-01';
  const rapSonrakiYil = rapAyNo === 12 ? rapYil + 1 : rapYil;
  const rapSonrakiAy = rapAyNo === 12 ? 1 : rapAyNo + 1;
  const rapAyBit = rapSonrakiYil + '-' + String(rapSonrakiAy).padStart(2,'0') + '-01';
  const ayRezervler = (window._R||[]).filter(r => {
    if(r.durum==='iptal' || r.durum==='noshow') return false;
    return Boolean(r.giris && r.cikis && r.giris < rapAyBit && r.cikis > rapAyBas);
  });

  // Ay içindeki tüm gelirler ve gerçek konaklamalar ayrı tutulur.
  // Oda masrafları toplam gelire dahildir; check-in sayısını ve komisyonu şişirmez.
  const ayTumGelirler = (window._G||[]).filter(g => (g.tarih||'').startsWith(ay));
  const ayGelirler = ayTumGelirler.filter(g => g.kaynak !== 'oda-masrafi' && g.kaynak !== 'no-show');
  const toplamGelir = ayTumGelirler.reduce((a,b)=>a+Number(b.tutar||0), 0);

  // No-show geliri toplam gelire dahildir ama fiziksel check-in değildir.
  const checkinSay = ayGelirler.length;

  // ── KOMİSYON — KESİNLEŞEN ──
  // Komisyonlar koleksiyonu finansal kaynak gerçeğidir. Erken çıkış / fiyat değişikliği
  // burada güncellendiği için aylık rapor eski gelirler.komisyonFark değerine takılı kalmaz.
  const gelirByIdKom = new Map((window._G||[]).map(g=>[String(g.id),g]));
  const kesinGelirIds = new Set();
  const gerceklesenKomisyonlar = (window._KOM||[])
    .filter(k => String(k.tarih||k.kayitTarih||'').startsWith(ay) && Number(k.toplamKomisyon)>0 && !komisyonKaydiSupheli(k))
    .map(k => {
      const g = gelirByIdKom.get(String(k.gelirDocId||'')) || {};
      if(k.gelirDocId) kesinGelirIds.add(String(k.gelirDocId));
      return {
        ...g, ...k,
        fiyat:Number(k.gercekFiyat ?? g.fiyat)||0,
        sozlesmeFiyat:Number(k.sozlesmeFiyat ?? g.sozlesmeFiyat)||0,
        odemeDurum:g.odemeDurum||k.odemeDurum||'',
        _komisyonTutar:Number(k.toplamKomisyon)||0
      };
    });

  // Eski veri uyumluluğu: henüz komisyonlar koleksiyonuna taşınmamış gelir varsa bir kez göster.
  ayGelirler.forEach(g => {
    if(!g.araciAd || kesinGelirIds.has(String(g.id))) return;
    const h = komisyonToplamHesapla({
      otelFiyat:g.fiyat, sozlesmeFiyat:g.sozlesmeFiyat, gece:Number(g.gece)||geceSayisi(g.giris,g.cikis),
      araciAd:g.araciAd, komisyoncuKey:g.komisyoncu||''
    });
    if(h.toplam>0) gerceklesenKomisyonlar.push({...g,_komisyonTutar:h.toplam});
  });
  const toplamKomisyonGerceklesen = gerceklesenKomisyonlar.reduce((a,b)=>a+Number(b._komisyonTutar||0), 0);

  // ── KOMİSYON — BEKLENEN ──
  // Sadece gerçekten check-in olmamış BEKLİYOR rezervasyonlar. Kesin komisyon kaydı,
  // gelir kaydı veya aktif/tamamlanmış durum varsa ikinci kez beklenen sayılmaz.
  const yaklasanKomisyonlar = ayRezervler.map(r => {
    const b = rezervasyonBeklenenKomisyon(r);
    return b ? {...r,_gece:b.gece,_komisyonTutar:b.toplam} : null;
  }).filter(Boolean);

  const toplamKomisyonYaklasan = yaklasanKomisyonlar.reduce((a,b)=>a+Number(b._komisyonTutar||0), 0);
  const toplamKomisyon = toplamKomisyonGerceklesen;

  // Doluluk — ay kaç gün?
  const [yil, mNo] = ay.split('-').map(Number);
  const ayGunSayisi = new Date(yil, mNo, 0).getDate();
  const toplamOdaGun = HOTEL_ODALAR.length * ayGunSayisi;

  // Ayın ilk günü ve bir sonraki ayın ilk günü (yarı-açık aralık: [ayBas, ayBit))
  const ayBas = ay + '-01';
  const sonrakiYil = mNo === 12 ? yil + 1 : yil;
  const sonrakiAy = mNo === 12 ? 1 : mNo + 1;
  const ayBit = sonrakiYil + '-' + String(sonrakiAy).padStart(2,'0') + '-01';

  // Bir konaklamanın SADECE seçilen ay içine düşen gece sayısını hesaplar.
  // Ay sınırını aşan rezervasyonlarda (örn. 20 Haziran → 15 Temmuz) tüm geceleri
  // her iki aya da tam olarak sayan eski mantık, dolulukta %100'ü aşan hatalı
  // sonuçlara yol açıyordu (bkz. 106%, 126%, 139% gibi değerler). Bu yüzden
  // tarih aralığı ay sınırlarına göre kırpılıyor.
  function ayIciGeceSayisi(giris, cikis) {
    if(!giris || !cikis) return 0;
    const bas = giris > ayBas ? giris : ayBas;
    const bit = cikis < ayBit ? cikis : ayBit;
    if(bas >= bit) return 0;
    const [by,bm,bd] = bas.split('-').map(Number);
    const [ey,em,ed] = bit.split('-').map(Number);
    return Math.round((new Date(ey,em-1,ed) - new Date(by,bm-1,bd)) / 864e5);
  }

  // Oda + gün bazında tekilleştirme: aynı odada aynı takvim gecesi, eski
  // mükerrer rezervasyon/gelir bulunsa bile yalnız bir kez sayılabilir.
  const odaGunleri = {};
  HOTEL_ODALAR.forEach(no => odaGunleri[String(no)] = new Map());
  const tumKonaklamaGelirler = (window._G||[]).filter(g => g.kaynak!=='no-show' && g.kaynak!=='oda-masrafi');
  const gelirByRezervasyon = new Map();
  tumKonaklamaGelirler.forEach(g => {
    if(!g.rezervasyonId) return;
    const eski=gelirByRezervasyon.get(String(g.rezervasyonId));
    if(!eski || String(g.guncelleme||g.kayitTarih||'')>String(eski.guncelleme||eski.kayitTarih||'')) gelirByRezervasyon.set(String(g.rezervasyonId),g);
  });
  const gunGunEkle = (noRaw, giris, cikis, kayit) => {
    const no=String(noRaw), map=odaGunleri[no];
    if(!map || !giris || !cikis) return;
    let gun=giris>ayBas?giris:ayBas;
    const bit=cikis<ayBit?cikis:ayBit;
    while(gun<bit) {
      const mevcut=map.get(gun);
      if(!mevcut || kayit.oncelik>mevcut.oncelik || (kayit.oncelik===mevcut.oncelik && kayit.zaman>mevcut.zaman)) map.set(gun,kayit);
      gun=addDays(gun,1);
    }
  };
  ayRezervler.forEach(r => {
    const bagli=gelirByRezervasyon.get(String(r.id));
    const gerceklesmis = r.durum==='aktif'||r.durum==='tamamlandi'||Boolean(bagli);
    gunGunEkle(r.odaNo,r.giris,r.cikis,{
      fiyat:Number(r.fiyat ?? bagli?.fiyat)||0,
      oncelik:gerceklesmis?3:2,
      zaman:String(r.guncelleme||r.kayitTarih||'')
    });
  });
  // Rezervasyon kimliği olmayan eski/walk-in gelir yalnız o gün için henüz bir
  // rezervasyon bulunmuyorsa eklenir; böylece 203 gibi 39 gece/%126 oluşamaz.
  tumKonaklamaGelirler.forEach(g => {
    if(g.rezervasyonId || !g.giris || !g.cikis) return;
    gunGunEkle(g.odaNo,g.giris,g.cikis,{fiyat:Number(g.fiyat)||0,oncelik:1,zaman:String(g.guncelleme||g.kayitTarih||'')});
  });
  const odaDolu={}, odaGelir={};
  HOTEL_ODALAR.forEach(no => {
    const kayitlar=[...odaGunleri[String(no)].values()];
    odaDolu[no]=kayitlar.length;
    odaGelir[String(no)]=kayitlar.reduce((t,k)=>t+(Number(k.fiyat)||0),0);
  });
  const toplamDoluGun = Object.values(odaDolu).reduce((a,b)=>a+b, 0);
  const dolulukOrani = toplamOdaGun > 0 ? Math.round(toplamDoluGun / toplamOdaGun * 100) : 0;

  // Özet kartlar
  document.getElementById('rapor-toplam-gelir').textContent = fmt2(toplamGelir);
  document.getElementById('rapor-doluluk').textContent = dolulukOrani + '%';
  document.getElementById('rapor-checkin-say').textContent = checkinSay;
  document.getElementById('rapor-komisyon').textContent = toplamKomisyon > 0 ? fmt2(toplamKomisyon) : '—';

  // Oda bazlı doluluk tablosu
  document.getElementById('rapor-doluluk-body').innerHTML = HOTEL_ODALAR.map(no => {
    const gece = odaDolu[no] || 0;
    const oran = ayGunSayisi > 0 ? Math.round(gece / ayGunSayisi * 100) : 0;
    const gelir = odaGelir[String(no)] || 0;
    const oz = window._OZ?.['oda'+no] || {};
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border)">
        <strong style="font-family:'Cormorant Garamond',serif">${no}</strong>
        ${oz.ad ? `<span style="font-size:10px;color:var(--gold);display:block">${oz.ad}</span>` : ''}
      </td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">${gece}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px">
          <div style="width:60px;height:6px;background:var(--border);border-radius:3px">
            <div style="width:${oran}%;height:100%;background:${oran>70?'var(--green)':oran>40?'var(--gold)':'var(--red)'};border-radius:3px"></div>
          </div>
          <span style="font-size:11px;font-weight:600">${oran}%</span>
        </div>
      </td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;color:var(--green);font-weight:600">${gelir > 0 ? gelir.toLocaleString('tr-TR') + ' ₺' : '—'}</td>
    </tr>`;
  }).join('');

  // ── Komisyon tablosu — GERÇEKLEŞEN ──
  const odDurumMap = {odendi:'✓ Ödendi', odenmedi:'Ödenmedi', depozito:'Depozito', kismi:'Kısmi', '':'—'};
  const odDurumCls = {odendi:'color:var(--green)', odenmedi:'color:var(--red)', depozito:'color:var(--gold2)', kismi:'color:var(--orange)'};

  if(gerceklesenKomisyonlar.length === 0) {
    document.getElementById('rapor-komisyon-body').innerHTML =
      '<tr class="empty-row"><td colspan="8">Bu ay gerçekleşen komisyon kaydı yok</td></tr>';
    document.getElementById('rapor-komisyon-toplam').textContent = '';
  } else {
    document.getElementById('rapor-komisyon-body').innerHTML = gerceklesenKomisyonlar.map(k => {
      const odDurum = k.odemeDurum || '';
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border)">${k.misafir||'—'}${String(k.kaynak||'').includes('no-show')?'<span class="badge badge-orange" style="font-size:8px;margin-left:5px">No-show Geliri</span>':''}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--gold2);font-weight:600">${k.araciAd?'🤝 '+k.araciAd:'—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border)">Oda ${k.odaNo}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center;font-size:11px">${k.gece||'—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-size:11px">${k.fiyat?Number(k.fiyat).toLocaleString('tr-TR'):'—'} ₺</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-size:11px">${k.sozlesmeFiyat?Number(k.sozlesmeFiyat).toLocaleString('tr-TR'):'—'} ₺</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-weight:600;color:var(--gold2)">${k._komisyonTutar>0?fmt2(k._komisyonTutar):'—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;${odDurumCls[odDurum]||''}">${odDurumMap[odDurum]||'—'}</td>
      </tr>`;
    }).join('');
    document.getElementById('rapor-komisyon-toplam').textContent =
      `${gerceklesenKomisyonlar.length} kayıt · Toplam: ${fmt2(toplamKomisyonGerceklesen)}`;
  }

  // ── Komisyon tablosu — YAKLAŞAN (henüz check-in yapılmamış rezervasyonlar) ──
  if(yaklasanKomisyonlar.length === 0) {
    document.getElementById('rapor-komisyon-yaklasan-body').innerHTML =
      '<tr class="empty-row"><td colspan="8">Bu ay için aracılı/komisyonlu yaklaşan rezervasyon yok</td></tr>';
    document.getElementById('rapor-komisyon-yaklasan-toplam').textContent = '';
  } else {
    document.getElementById('rapor-komisyon-yaklasan-body').innerHTML = yaklasanKomisyonlar.map(r => {
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border)">${r.misafir||'—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--gold2);font-weight:600">🤝 ${r.araciAd}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border)">Oda ${r.odaNo}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px">${r.giris||'—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center;font-size:11px">${r._gece||'—'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-size:11px">${r.fiyat?Number(r.fiyat).toLocaleString('tr-TR'):'—'} ₺</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-size:11px">${r.sozlesmeFiyat?Number(r.sozlesmeFiyat).toLocaleString('tr-TR'):'—'} ₺</td>
        <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-weight:600;color:var(--gold2)">${r._komisyonTutar>0?fmt2(r._komisyonTutar):'—'}</td>
      </tr>`;
    }).join('');
    document.getElementById('rapor-komisyon-yaklasan-toplam').textContent =
      `${yaklasanKomisyonlar.length} kayıt · Beklenen Toplam: ${fmt2(toplamKomisyonYaklasan)}`;
  }

  renderKomisyonCari();
  renderOdemeGecmisi();
  renderKomisyoncuYonetimi();
  renderRaporTarihDetay(); // v6 tarih detayı
  renderRaporKomisyonRez(); // komisyoncu rezervasyon raporu

};

// ── KOMİSYONCU CARİ HESAP ──
// window._KOM  : her konaklama için hakedilen komisyon ("borç") kayıtları — otomatik, check-in'de oluşur.
// window._KOMODEME : otelin komisyoncuya fiilen ödediği tutarlar — manuel, burada girilir.
// Bu ikisi TAMAMEN misafirin odaya yaptığı ödemeden bağımsızdır.
// "Pune", "PUNE", "pune", "pune iran" gibi yazım farklarını TEK komisyoncu olarak
// birleştirmek için normalize edilmiş anahtar (küçük harf + kırpılmış + tek boşluk).

// ── TARİH BAZLI RAPOR DETAYI ───────────────────────────────────────────────
function shEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function raporTarihKaydiOlustur(tarih) {
  const R = window._R || [], G = (window._G || []).filter(g => g.kaynak !== 'oda-masrafi' && g.kaynak !== 'no-show');
  const O = window._O || {};
  const byRev = new Map();
  G.forEach(g => { if(g.rezervasyonId) byRev.set(String(g.rezervasyonId), g); });
  const sonuc = [];
  const kullanilanGelir = new Set();
  const tarihIcerir = (giris,cikis) => !!giris && !!cikis && giris <= tarih && cikis >= tarih; // giriş ve çıkış günü de raporda görünür

  R.forEach(r => {
    if(!tarihIcerir(r.giris,r.cikis)) return;
    const g = byRev.get(String(r.id)) || G.find(x => !x.rezervasyonId && String(x.odaNo)===String(r.odaNo) && x.giris===r.giris && (x.tc&&r.tc ? x.tc===r.tc : x.misafir===r.misafir));
    if(g?.id) kullanilanGelir.add(g.id);
    const oda = O['oda'+r.odaNo];
    const aktifOda = oda?.durum==='dolu' && (oda.rezervasyonId===r.id || (oda.giris===r.giris && String(oda.odaNo||r.odaNo)===String(r.odaNo)));
    const m = {...r, ...(g||{}), ...(aktifOda?oda:{})};
    const gercekKonaklama = !!g || !!aktifOda || ['aktif','tamamlandi'].includes(r.durum);
    sonuc.push({
      id:`r:${r.id}`, tur:gercekKonaklama?'konaklama':'rezervasyon', rezervasyon:r, gelir:g||null, oda:aktifOda?oda:null,
      misafir:m.misafir||r.misafir||'—', odaNo:r.odaNo, giris:m.giris||r.giris, cikis:m.cikis||r.cikis,
      tc:m.tc||r.tc||'', tel:m.tel||r.tel||'', email:m.email||'', plaka:m.plaka||'', pasaport:m.pasaport||'', dt:m.dt||r.dt||'',
      yetiskin:Number(m.yetiskin??r.yetiskin??1), cocuk:Number(m.cocuk??r.cocuk??0), refakatciler:m.refakatciler||r.refakatciler||[],
      kaynak:m.kaynak||r.kaynak||'', araciAd:m.araciAd||r.araciAd||r.komisyoncuAd||'',
      fiyat:Number(m.fiyat??r.fiyat)||0, sozlesmeFiyat:Number(m.sozlesmeFiyat??r.sozlesmeFiyat)||0,
      odemeToplam:Number(m.odemeToplam)||((Number(m.sozlesmeFiyat??r.sozlesmeFiyat)||Number(m.fiyat??r.fiyat)||0)*Number((m.gece??r.gece)||0)),
      tahsilEdilen:Number(m.tahsilEdilen ?? (m.odemeDurum==='odendi' ? (((Number(m.sozlesmeFiyat??r.sozlesmeFiyat)||Number(m.fiyat??r.fiyat)||0)*Number((m.gece??r.gece)||0))) : (m.kismiTutar||0)))||0,
      kalanTahsilat:Number(m.kalanTahsilat ?? m.kalanTutar ?? m.kismiKalan)||0,
      iadeTutar:Number(m.iadeTutar)||0, odemeDurum:m.odemeDurum||r.odemeDurum||'', odemeTuru:m.odemeTuru||r.odemeTuru||'',
      not:m.not||r.not||'', durum:r.durum||'', kayitTarih:r.kayitTarih||'', checkinTarih:g?.giris||'', checkoutTarih:g?.checkoutTarih||'',
      rezervasyonId:r.id
    });
  });

  // Walk-in veya rezervasyon bağı olmayan gerçek konaklamalar.
  G.forEach(g => {
    if(g.id && kullanilanGelir.has(g.id)) return;
    if(!tarihIcerir(g.giris,g.cikis)) return;
    const oda = O['oda'+g.odaNo];
    const aktifOda = oda?.durum==='dolu' && (oda.gelirDocId===g.id || oda.konaklamaKey===g.konaklamaKey);
    const m={...g,...(aktifOda?oda:{})};
    sonuc.push({
      id:`g:${g.id||g.gelirDocId||Math.random()}`, tur:'konaklama', rezervasyon:null, gelir:g, oda:aktifOda?oda:null,
      misafir:m.misafir||'—', odaNo:m.odaNo||g.odaNo, giris:m.giris||g.giris, cikis:m.cikis||g.cikis,
      tc:m.tc||'', tel:m.tel||'', email:m.email||'', plaka:m.plaka||'', pasaport:m.pasaport||'', dt:m.dt||'',
      yetiskin:Number(m.yetiskin||1), cocuk:Number(m.cocuk||0), refakatciler:m.refakatciler||[], kaynak:m.kaynak||'', araciAd:m.araciAd||'',
      fiyat:Number(m.fiyat)||0, sozlesmeFiyat:Number(m.sozlesmeFiyat)||0, odemeToplam:Number(m.odemeToplam)||((Number(m.sozlesmeFiyat)||Number(m.fiyat)||0)*Number(m.gece||0)),
      tahsilEdilen:Number(m.tahsilEdilen)||0, kalanTahsilat:Number(m.kalanTahsilat??m.kalanTutar)||0, iadeTutar:Number(m.iadeTutar)||0,
      odemeDurum:m.odemeDurum||'', odemeTuru:m.odemeTuru||'', not:m.not||'', durum:'aktif', kayitTarih:m.kayitTarih||'', checkinTarih:g.giris||'', checkoutTarih:g.checkoutTarih||'', rezervasyonId:g.rezervasyonId||null
    });
  });
  sonuc.forEach(x => {
    if(!x.odemeToplam) x.odemeToplam=(x.sozlesmeFiyat||x.fiyat||0)*Math.max(0,geceSayisi(x.giris,x.cikis));
    if(!Number.isFinite(x.tahsilEdilen)) x.tahsilEdilen=0;
    if(x.odemeDurum!=='odendi' && !(x.kalanTahsilat>0)) x.kalanTahsilat=Math.max(0,(x.odemeToplam||0)-(x.tahsilEdilen||0));
    if(x.odemeDurum==='odendi') x.kalanTahsilat=0;
  });
  return sonuc.sort((a,b)=>Number(a.odaNo)-Number(b.odaNo) || String(a.misafir).localeCompare(String(b.misafir),'tr'));
}

window.renderRaporTarihDetay = function() {
  const tarihEl=document.getElementById('rapor-detay-tarih'); if(!tarihEl) return;
  if(!tarihEl.value) tarihEl.value=today();
  const tarih=tarihEl.value, tur=document.getElementById('rapor-detay-tur')?.value||'hepsi';
  const ara=String(document.getElementById('rapor-detay-ara')?.value||'').trim().toLocaleLowerCase('tr-TR');
  let liste=raporTarihKaydiOlustur(tarih);
  if(tur!=='hepsi') liste=liste.filter(x=>x.tur===tur);
  if(ara) liste=liste.filter(x=>[x.misafir,x.odaNo,x.tc,x.tel,x.araciAd,x.kaynak,x.durum].some(v=>String(v||'').toLocaleLowerCase('tr-TR').includes(ara)));
  window._raporTarihKayitlar=liste;
  const body=document.getElementById('rapor-tarih-detay-body');
  if(!liste.length){body.innerHTML='<tr class="empty-row"><td colspan="9">Bu kriterlerde kayıt yok</td></tr>';document.getElementById('rapor-tarih-detay-toplam').textContent='0 kayıt';return;}
  const odemeEtiket={odendi:'✓ Ödendi',odenmedi:'Ödenmedi',kismi:'Kısmi',depozito:'Depozito'};
  body.innerHTML=liste.map((x,i)=>{
    const musteriToplam=x.odemeToplam||((x.sozlesmeFiyat||x.fiyat)*Math.max(0,geceSayisi(x.giris,x.cikis)));
    const durumEk=x.durum==='iptal'?' · İptal':x.durum==='noshow'?' · No-show':x.durum==='tamamlandi'?' · Tamamlandı':x.durum==='aktif'?' · Aktif':'';
    const kayit=x.tur==='konaklama'?`<span style="color:var(--green);font-weight:700">● Konaklama${durumEk}</span>`:`<span style="color:var(--blue);font-weight:700">◆ Rezervasyon${durumEk}</span>`;
    return `<tr>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border)">${kayit}</td>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border);font-weight:600">${shEsc(x.misafir)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border)">Oda ${shEsc(x.odaNo)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border);font-size:11px">${shEsc(x.giris)} → ${shEsc(x.cikis)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border);text-align:center">${x.yetiskin+x.cocuk}</td>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border);font-size:11px">${shEsc(x.araciAd?('🤝 '+x.araciAd):(x.kaynak||'—'))}</td>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border);text-align:right;font-weight:600">${musteriToplam?fmt(musteriToplam):'—'}</td>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border);font-size:11px">${shEsc(odemeEtiket[x.odemeDurum]||x.odemeDurum||'—')}${x.kalanTahsilat>0?`<br><span style="color:var(--red)">Kalan ${fmt(x.kalanTahsilat)}</span>`:''}</td>
      <td style="padding:7px 8px;border-bottom:1px solid var(--border);text-align:center"><button class="btn btn-ghost" style="padding:4px 10px;font-size:10px" onclick="raporKayitDetayAc(${i})">Detay</button></td>
    </tr>`;
  }).join('');
  const konak=liste.filter(x=>x.tur==='konaklama').length, rez=liste.length-konak;
  document.getElementById('rapor-tarih-detay-toplam').textContent=`${tarih} · ${liste.length} kayıt · ${konak} konaklama · ${rez} rezervasyon`;
};

window.raporKayitDetayAc = async function(i) {
  const x=(window._raporTarihKayitlar||[])[i]; if(!x) return;
  let musteri={};
  if(x.tc){try{const ms=await getDocs(query(collection(db,'musteriler'),where('tc','==',x.tc)));if(!ms.empty)musteri=ms.docs[0].data();}catch(_){}}
  const tel=x.tel||musteri.tel||'—', email=x.email||musteri.email||'—', plaka=x.plaka||musteri.plaka||'—';
  const ref=Array.isArray(x.refakatciler)&&x.refakatciler.length ? x.refakatciler.map((r,n)=>`<div>${n+1}. ${shEsc(r.ad||r.isim||'—')} ${r.tc?`· TC ${shEsc(r.tc)}`:''}</div>`).join('') : '—';
  const gece=Math.max(0,geceSayisi(x.giris,x.cikis));
  const musteriGecelik=x.sozlesmeFiyat||x.fiyat, musteriToplam=x.odemeToplam||(musteriGecelik*gece), otelToplam=x.fiyat*gece, komisyon=Math.max(0,(x.sozlesmeFiyat-x.fiyat))*gece;
  const row=(k,v)=>`<div style="padding:8px 0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:180px 1fr;gap:12px"><b style="color:var(--muted)">${k}</b><span>${v}</span></div>`;
  document.getElementById('raporKayitDetayBaslik').textContent=`Oda ${x.odaNo} · ${x.misafir}`;
  document.getElementById('raporKayitDetayIcerik').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
      <div>${row('Kayıt Türü',x.tur==='konaklama'?'Gerçek konaklama':'Rezervasyon')}${row('Misafir',shEsc(x.misafir))}${row('TC / Pasaport',shEsc(x.tc||x.pasaport||'—'))}${row('Telefon',shEsc(tel))}${row('E-posta',shEsc(email))}${row('Plaka',shEsc(plaka))}${row('DT',shEsc(x.dt||'—'))}</div>
      <div>${row('Oda','Oda '+shEsc(x.odaNo))}${row('Giriş / Çıkış',`${shEsc(x.giris)} → ${shEsc(x.cikis)} · ${gece} gece`)}${row('Kişi',`${x.yetiskin} yetişkin · ${x.cocuk} çocuk`)}${row('Kaynak / Aracı',shEsc(x.araciAd||x.kaynak||'—'))}${row('Rezervasyon Oluşturma',shEsc((x.kayitTarih||'—').replace('T',' ').slice(0,19)))}${row('Check-in / Check-out',`${shEsc(x.checkinTarih||'—')} / ${shEsc(x.checkoutTarih||'—')}`)}</div>
    </div>
    <div style="margin-top:16px;background:var(--parchment);border:1px solid var(--border);padding:12px 14px">
      ${row('Misafir Gecelik',musteriGecelik?fmt(musteriGecelik):'—')}${row('Otel Net Gecelik',x.fiyat?fmt(x.fiyat):'—')}${row('Komisyon',komisyon?fmt(komisyon):'—')}${row('Müşteri Hesabı',musteriToplam?fmt(musteriToplam):'—')}${row('Tahsil Edilen',fmt(x.tahsilEdilen||0))}${row('Kalan',fmt(x.kalanTahsilat||0))}${row('İade',x.iadeTutar?fmt(x.iadeTutar):'—')}${row('Ödeme Türü / Durumu',`${shEsc(x.odemeTuru||'—')} / ${shEsc(x.odemeDurum||'—')}`)}
    </div>
    <div style="margin-top:16px"><b style="display:block;margin-bottom:6px">Refakatçiler</b>${ref}</div>
    <div style="margin-top:16px"><b style="display:block;margin-bottom:6px">Not</b><div style="white-space:pre-wrap;background:var(--cream);padding:10px;border:1px solid var(--border)">${shEsc(x.not||'—')}</div></div>`;
  openModal('raporKayitDetayModal');
};

window.raporTarihDetayPdf = function() {
  const liste=window._raporTarihKayitlar||[]; if(!liste.length){toast('Döküm alınacak kayıt yok','error');return;}
  const tarih=document.getElementById('rapor-detay-tarih')?.value||today();
  const rows=liste.map(x=>{const gece=Math.max(0,geceSayisi(x.giris,x.cikis));const toplam=x.odemeToplam||((x.sozlesmeFiyat||x.fiyat)*gece);return `<tr><td>${x.tur==='konaklama'?'Konaklama':'Rezervasyon'}</td><td>${shEsc(x.misafir)}</td><td>${shEsc(x.odaNo)}</td><td>${shEsc(x.giris)} → ${shEsc(x.cikis)}</td><td>${shEsc(x.araciAd||x.kaynak||'—')}</td><td class="num">${toplam?fmt(toplam):'—'}</td><td>${shEsc(x.odemeDurum||'—')}</td></tr>`}).join('');
  const html=`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Swiss House Tarih Raporu</title><style>@page{size:A4 landscape;margin:10mm}body{font-family:Arial;color:#222;font-size:10px}.head{border-bottom:3px solid #c8102e;margin-bottom:14px;padding-bottom:10px}h1{font-size:18px;margin:0 0 5px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px}th{background:#eee;text-align:left}.num{text-align:right}</style></head><body><div class="head"><h1>SWISS HOUSE · Tarih Bazlı Konaklama / Rezervasyon Raporu</h1><b>Tarih:</b> ${tarih} · <b>Kayıt:</b> ${liste.length}</div><table><thead><tr><th>Kayıt</th><th>Misafir</th><th>Oda</th><th>Konaklama</th><th>Kaynak / Aracı</th><th>Müşteri Hesabı</th><th>Ödeme</th></tr></thead><tbody>${rows}</tbody></table><script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script><script>window.onload=()=>html2pdf().set({filename:'swiss-house-${tarih}-konaklama-rezervasyon.pdf',html2canvas:{scale:2},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}}).from(document.body).save();<\/script></body></html>`;
  const w=window.open('','_blank');if(w){w.document.write(html);w.document.close();}
};



// ── KOMİSYONCU REZERVASYON RAPORU (RESEPSİYON > RAPOR) ───────────────────
function raporKomZamanMs(v){
  if(!v) return 0;
  try {
    if(v instanceof Date) return v.getTime();
    if(typeof v?.toDate === 'function') return v.toDate().getTime();
    if(typeof v === 'object' && Number.isFinite(Number(v.seconds))) return Number(v.seconds)*1000;
    const s=String(v).trim();
    const d=new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s+'T00:00:00' : s);
    const ms=d.getTime(); return Number.isFinite(ms)?ms:0;
  } catch(_) { return 0; }
}
function raporKomIsoGun(v){
  if(!v) return '';
  if(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0,10);
  const ms=raporKomZamanMs(v); if(!ms) return '';
  const d=new Date(ms), p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function raporKomTarihMetni(v, saat=true){
  if(!v) return '—';
  if(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return saat ? v.replace('T',' ').slice(0,16) : v.slice(0,10);
  const ms=raporKomZamanMs(v); if(!ms) return '—';
  return new Date(ms).toLocaleString('tr-TR', saat?{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}:{year:'numeric',month:'2-digit',day:'2-digit'});
}
function raporKomAraciAd(t,r,g){
  const raw=t?.komisyoncuAd||r?.komisyoncuAd||g?.komisyoncuAd||t?.araciAd||r?.araciAd||g?.araciAd||t?.komisyoncu||r?.komisyoncu||g?.komisyoncu||'';
  return raw ? (araciKanonikAd(raw)||raw) : '—';
}
function raporKomKayitMi(x){
  return !!(x && (x.kaynak==='komisyoncu'||x.komisyoncu||x.komisyoncuAd||x.araciAd));
}
function raporKomBagliKayitlar(t){
  const R=window._R||[], G=(window._G||[]).filter(x=>x.kaynak!=='oda-masrafi'&&x.kaynak!=='no-show'), O=window._O||{};
  const r=R.find(x => x.kaynakTalepId===t.id || (t.rezervasyonId && x.id===t.rezervasyonId) || (t._rezervasyonId && x.id===t._rezervasyonId)) || null;
  const hedefOda=String(r?.odaNo||t.odaNo||'');
  const hedefMisafir=temizAnahtar(r?.misafir||t.misafir||'');
  const hedefGiris=String(r?.giris||t.giris||'');
  const hedefCikis=String(r?.cikis||t.cikis||'');
  const g=G.find(x =>
    (t._gelirId && x.id===t._gelirId) ||
    (r?.id && x.rezervasyonId===r.id) ||
    (t.rezervasyonId && x.rezervasyonId===t.rezervasyonId) ||
    // Legacy eşleşme: eski check-in kaydında rezervasyonId/tarih alanları eksik kalmış olabilir.
    // Aynı oda + aynı misafir güçlü eşleşmedir; tarih varsa ayrıca örtüşme aranır.
    (hedefOda && String(x.odaNo||'')===hedefOda && hedefMisafir &&
      temizAnahtar(x.misafir||'')===hedefMisafir &&
      (!x.giris || !hedefGiris || String(x.giris||x.tarih||'')===hedefGiris ||
       (hedefCikis && String(x.giris||x.tarih||'')<hedefCikis && String(x.cikis||x.checkoutTarih||'9999-12-31')>hedefGiris)))
  ) || null;
  const odaNo=r?.odaNo||t.odaNo||g?.odaNo;
  const oda=O['oda'+odaNo];
  const o=oda?.durum==='dolu' && ((r?.id&&oda.rezervasyonId===r.id) || oda.kaynakTalepId===t.id || (g?.id&&oda.gelirDocId===g.id) || (oda.giris===(t.giris||r?.giris||g?.giris) && String(odaNo||'')===String(oda.odaNo||odaNo))) ? oda : null;
  return {r,g,o};
}
function raporKomKonaklamaDurumu(t){
  const {r,g,o}=raporKomBagliKayitlar(t), bugun=today(), d=String(t.durum||''), rd=String(r?.durum||'');
  if(['reddedildi','iptal'].includes(d)||rd==='iptal') return {kod:'iptal',etiket:'❌ İptal / Reddedildi',renk:'var(--red)',r,g,o};
  if(d==='noshow'||rd==='noshow') return {kod:'noshow',etiket:'🚫 No-show',renk:'var(--red)',r,g,o};
  if(d==='tamamlandi'||rd==='tamamlandi'||g?.checkoutTarih||t.checkoutTarih) return {kod:'tamamlandi',etiket:'✅ Konakladı / Check-out Tamamlandı',renk:'var(--green)',r,g,o};
  if(d==='aktif'||rd==='aktif'||o||g){
    const cikis=t.cikis||r?.cikis||g?.cikis||'';
    if(cikis && bugun>=cikis) return {kod:'checkout_bekliyor',etiket:'⚠ Check-out Bekleniyor',renk:'#d97706',r,g,o};
    return {kod:'aktif',etiket:'🟢 Konaklıyor / Check-in Var',renk:'var(--green)',r,g,o};
  }
  const giris=t.giris||r?.giris||g?.giris||'', cikis=t.cikis||r?.cikis||g?.cikis||'';
  if(giris && bugun<giris) return {kod:'planlandi',etiket:'🗓 Planlandı',renk:'var(--blue)',r,g,o};
  if(cikis&&bugun>=cikis && !g && !o) return {kod:'karar_bekliyor',etiket:'⚠ Geçmiş Rezervasyon · Karar Bekliyor',renk:'#d97706',r,g,o};
  if(giris&&bugun>=giris && !g && !o) return {kod:'karar_bekliyor',etiket:'⚠ Check-in Kararı Bekliyor',renk:'#d97706',r,g,o};
  return {kod:'planlandi',etiket:d==='bekliyor'?'Talep Bekliyor':'Onaylandı / Planlandı',renk:'var(--muted)',r,g,o};
}
function raporKomTamamlanma(t,k){
  k=k||raporKomKonaklamaDurumu(t); const d=String(t?.durum||''), rd=String(k.r?.durum||'');
  if(['reddedildi','iptal','noshow'].includes(d)||['iptal','noshow'].includes(rd)||['iptal','noshow'].includes(k.kod)) return {kod:'iptal',etiket:'İptal / No-show',renk:'var(--red)'};
  if(d==='tamamlandi'||rd==='tamamlandi'||k.kod==='tamamlandi'||k.g?.checkoutTarih||t.checkoutTarih) return {kod:'tamamlandi',etiket:'Tamamlanmış',renk:'var(--green)'};
  return {kod:'tamamlanmadi',etiket:'Tamamlanmamış',renk:'#d97706'};
}
function raporKomTalepMi(t){ return t && (t.kaynak==='komisyoncu'||t.komisyoncu||t.komisyoncuAd); }
function raporKomSatir(t){
  const k=raporKomKonaklamaDurumu(t), grup=raporKomTamamlanma(t,k), r=k.r||{}, g=k.g||{}, o=k.o||{};
  // Finansal gerçek için yaşam döngüsünde ileride olan kayıt önceliklidir: konaklama > rezervasyon > talep.
  const ana = g?.id ? g : (r?.id ? r : t);
  const giris=ana.giris||t.giris||r.giris||g.giris||o.giris||'', cikis=ana.cikis||t.cikis||r.cikis||g.cikis||o.cikis||'';
  const poz=(...vals)=>{for(const v of vals){const n=Number(v);if(Number.isFinite(n)&&n>0)return n;}return 0;};
  const rawNegatif=[t.odemeToplam,r.odemeToplam,g.odemeToplam,t.otelToplam,r.otelToplam,g.otelToplam,t.otelNetToplam,r.otelNetToplam,g.otelNetToplam].some(v=>Number.isFinite(Number(v))&&Number(v)<0);
  const gece=poz(ana.gece,g.gece,r.gece,t.gece)||Math.max(0,geceSayisi(giris,cikis));
  const musteriGecelik=poz(ana.sozlesmeFiyat,g.sozlesmeFiyat,r.sozlesmeFiyat,t.sozlesmeFiyat,ana.fiyat,g.fiyat,r.fiyat,t.fiyat);
  const otelGecelik=poz(ana.fiyat,g.fiyat,r.fiyat,t.fiyat);
  let musteriToplam=poz(ana.odemeToplam,g.odemeToplam,r.odemeToplam,t.odemeToplam)||(musteriGecelik*gece);
  let otelToplam=poz(ana.otelNetToplam,ana.otelToplam,g.otelNetToplam,g.otelToplam,r.otelNetToplam,r.otelToplam,t.otelNetToplam,t.otelToplam)||(otelGecelik*gece);
  let komisyon=0, finansUyari='';
  const araciAd=raporKomAraciAd(t,r,g), araciKey=araciAd==='—'?'':araciAnahtar(araciAd);

  if(grup.kod==='iptal') {
    if(k.kod==='noshow') {
      // No-show'da yalnız gelirleşmiş (iade edilmeyen) para finansal gerçektir.
      const gelirlesen=poz(r.noShowGelirlesenTutar,t.noShowGelirlesenTutar,g.tutar);
      const noShowKom=poz(r.noShowKomisyon,t.noShowKomisyon,g.komisyonToplam,g.komisyonFark);
      musteriToplam=gelirlesen;
      komisyon=Math.min(gelirlesen,noShowKom);
      otelToplam=Math.max(0,gelirlesen-komisyon);
    } else {
      // İptal/Reddedildi: planlanan tutarlar bilgi olarak kalabilir fakat HAKEDİŞ sıfırdır.
      komisyon=0;
    }
  } else {
    const kayitliKom=poz(ana.komisyonToplam,ana.komisyonFark,g.komisyonToplam,g.komisyonFark,r.komisyonToplam,t.komisyonToplam);
    if(otelToplam>musteriToplam+0.009 && araciAd!=='—') {
      // Eski sürümlerde manuel komisyoncu talebinde hotel fiyatı sonradan oda tarifesinden
      // doldurulabildiği için müşteri<otel gibi imkânsız kayıtlar oluştu. Rapor bunu komisyona
      // çevirmek yerine denetim kaydı olarak işaretler.
      finansUyari='Müşteri fiyatı < otel neti — eski/uyumsuz fiyat kaydı';
      komisyon=0;
    } else {
      komisyon=kayitliKom || Math.max(0,musteriToplam-otelToplam);
      komisyon=Math.min(Math.max(0,komisyon),Math.max(0,musteriToplam));
    }
  }
  if(rawNegatif) finansUyari=(finansUyari?finansUyari+' · ':'')+'Negatif eski finans kaydı raporda sıfır/hesaplanan değerle normalize edildi';
  const kayitTarih=t.kayitTarih||r.kayitTarih||g.rezervasyonKayitTarih||g.kayitTarih||'';
  return {t,k,grup,r,g,o,giris,cikis,gece,musteriGecelik,otelGecelik,musteriToplam:Math.max(0,musteriToplam),otelToplam:Math.max(0,otelToplam),komisyon:Math.max(0,komisyon),finansUyari,araciAd,araciKey,misafir:t.misafir||r.misafir||g.misafir||o.misafir||'—',odaNo:t.odaNo||r.odaNo||g.odaNo||o.odaNo||'—',kayitTarih,talepDurum:t.durum||r.durum||'—',kaynakTip:t._kaynakTip||'talep'};
}
function raporKomTumSatirlar(){
  const satirlar=[], kullanilanR=new Set(), kullanilanG=new Set();
  const talepler=(window._TALEP||[]).filter(raporKomTalepMi);
  talepler.forEach(t=>{ const x=raporKomSatir(t); satirlar.push(x); if(x.r?.id)kullanilanR.add(x.r.id); if(x.g?.id)kullanilanG.add(x.g.id); });
  (window._R||[]).filter(raporKomKayitMi).forEach(r=>{
    if(kullanilanR.has(r.id)) return;
    const t={...r,id:'rev:'+r.id,_kaynakTip:'rezervasyon',_rezervasyonId:r.id,rezervasyonId:r.id,kaynak:'komisyoncu',komisyoncuAd:r.komisyoncuAd||r.araciAd||r.komisyoncu||'',kayitTarih:r.kayitTarih||r.guncelleme||r.giris||''};
    const x=raporKomSatir(t); satirlar.push(x); kullanilanR.add(r.id); if(x.g?.id)kullanilanG.add(x.g.id);
  });
  (window._G||[]).filter(g=>g.kaynak!=='oda-masrafi'&&g.kaynak!=='no-show'&&raporKomKayitMi(g)).forEach(g=>{
    if(kullanilanG.has(g.id)) return;
    const t={...g,id:'gelir:'+g.id,_kaynakTip:'konaklama',_gelirId:g.id,kaynak:'komisyoncu',komisyoncuAd:g.komisyoncuAd||g.araciAd||g.komisyoncu||'',durum:g.checkoutTarih?'tamamlandi':'aktif',kayitTarih:g.rezervasyonKayitTarih||g.kayitTarih||g.giris||''};
    const x=raporKomSatir(t); satirlar.push(x); kullanilanG.add(g.id);
  });
  return satirlar;
}
function raporKomAraciSecenekleriniDoldur(list){
  const sel=document.getElementById('rapor-kom-araci'); if(!sel) return;
  const mevcut=sel.value||'hepsi', map=new Map();
  const ekle=raw=>{
    const ad=araciKanonikAd(raw||'')||String(raw||'').trim(); if(!ad) return;
    const key=araciAnahtar(ad); if(!key) return;
    if(!map.has(key)) map.set(key,ad);
  };
  Object.entries(window.KOMISYONCULAR||{}).forEach(([key,k])=>ekle(k?.ad||key));
  (list||[]).forEach(x=>ekle(x.araciAd));
  (window._KOM||[]).forEach(x=>ekle(x.araciAd));
  (window._KOMODEME||[]).forEach(x=>ekle(x.araciAd));
  const sayac=new Map(); (list||[]).forEach(x=>{if(x.araciKey)sayac.set(x.araciKey,(sayac.get(x.araciKey)||0)+1);});
  const opts=[...map.entries()].sort((a,b)=>a[1].localeCompare(b[1],'tr')).map(([key,ad])=>`<option value="${shEsc(key)}">${shEsc(ad)} (${sayac.get(key)||0})</option>`).join('');
  sel.innerHTML='<option value="hepsi">Tüm Komisyoncular</option>'+opts;
  if([...sel.options].some(o=>o.value===mevcut)) sel.value=mevcut;
  else sel.value='hepsi';
}
function raporKomSiraDegeri(x,kriter){
  if(kriter==='odaNo') return {tip:'num',v:Number(x.odaNo)||0};
  if(kriter==='komisyoncu') return {tip:'str',v:String(x.araciAd||'').toLocaleLowerCase('tr-TR')};
  if(kriter==='misafir') return {tip:'str',v:String(x.misafir||'').toLocaleLowerCase('tr-TR')};
  if(kriter==='tamamlanma') return {tip:'num',v:({iptal:0,tamamlanmadi:1,tamamlandi:2})[x.grup.kod]??9};
  if(kriter==='kayitTarih') return {tip:'num',v:raporKomZamanMs(x.kayitTarih)};
  if(kriter==='cikis') return {tip:'num',v:raporKomZamanMs(x.cikis)};
  return {tip:'num',v:raporKomZamanMs(x.giris)};
}
function raporKomKarsilastir(a,b,kriter){
  const av=raporKomSiraDegeri(a,kriter), bv=raporKomSiraDegeri(b,kriter);
  if(av.tip==='num') return av.v-bv.v;
  return String(av.v).localeCompare(String(bv.v),'tr',{numeric:true,sensitivity:'base'});
}
function raporKomFiltrele(){
  let list=raporKomTumSatirlar();
  raporKomAraciSecenekleriniDoldur(list);
  const araci=document.getElementById('rapor-kom-araci')?.value||'hepsi';
  const tamam=document.getElementById('rapor-kom-tamamlanma')?.value||'hepsi';
  const konak=document.getElementById('rapor-kom-konaklama')?.value||'hepsi';
  const konBas=document.getElementById('rapor-kom-kon-bas')?.value||'', konBit=document.getElementById('rapor-kom-kon-bit')?.value||'';
  const talepBas=document.getElementById('rapor-kom-talep-bas')?.value||'', talepBit=document.getElementById('rapor-kom-talep-bit')?.value||'';
  const sirala=document.getElementById('rapor-kom-sirala')?.value||'giris', sirala2=document.getElementById('rapor-kom-sirala2')?.value||'yok', yon=document.getElementById('rapor-kom-yon')?.value||'desc';
  const ara=String(document.getElementById('rapor-kom-ara')?.value||'').trim().toLocaleLowerCase('tr-TR');
  if(araci!=='hepsi') list=list.filter(x=>x.araciKey===araci);
  if(tamam!=='hepsi') list=list.filter(x=>x.grup.kod===tamam);
  if(konak!=='hepsi') list=list.filter(x=>x.k.kod===konak);
  if(konBas||konBit){
    list=list.filter(x=>{
      const g=raporKomIsoGun(x.giris); if(!g) return false;
      const c=raporKomIsoGun(x.cikis)||g;
      return (!konBas||c>=konBas) && (!konBit||g<=konBit);
    });
  }
  if(talepBas||talepBit){
    list=list.filter(x=>{ const v=raporKomIsoGun(x.kayitTarih); return !!v && (!talepBas||v>=talepBas) && (!talepBit||v<=talepBit); });
  }
  if(ara) list=list.filter(x=>[x.araciAd,x.misafir,x.odaNo,x.giris,x.cikis,raporKomTarihMetni(x.kayitTarih),x.grup.etiket,x.k.etiket,x.talepDurum,x.t?.not].some(v=>String(v||'').toLocaleLowerCase('tr-TR').includes(ara)));
  list.sort((a,b)=>{
    let c=raporKomKarsilastir(a,b,sirala);
    if(c===0 && sirala2!=='yok' && sirala2!==sirala) c=raporKomKarsilastir(a,b,sirala2);
    if(c===0) c=raporKomKarsilastir(a,b,'kayitTarih');
    if(c===0) c=String(a.t?.id||'').localeCompare(String(b.t?.id||''),'tr');
    return yon==='asc'?c:-c;
  });
  return list;
}
window.raporKomFiltreTemizle=function(){
  ['rapor-kom-kon-bas','rapor-kom-kon-bit','rapor-kom-talep-bas','rapor-kom-talep-bit','rapor-kom-ara'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  const vals={'rapor-kom-araci':'hepsi','rapor-kom-tamamlanma':'hepsi','rapor-kom-konaklama':'hepsi','rapor-kom-sirala':'giris','rapor-kom-sirala2':'yok','rapor-kom-yon':'desc'};
  Object.entries(vals).forEach(([id,v])=>{const el=document.getElementById(id);if(el)el.value=v;});
  renderRaporKomisyonRez();
};
window.renderRaporKomisyonRez=function(){
  const body=document.getElementById('rapor-kom-body'); if(!body) return;
  const tum=raporKomTumSatirlar();
  const liste=raporKomFiltrele(); window._raporKomListe=liste;
  const toplamlar={tamamlandi:0,tamamlanmadi:0,iptal:0}; tum.forEach(x=>toplamlar[x.grup.kod]=(toplamlar[x.grup.kod]||0)+1);
  const aracSayisi=new Set(tum.map(x=>x.araciKey).filter(Boolean)).size;
  const tanimliSayisi=Object.keys(window.KOMISYONCULAR||{}).length;
  const siralama=document.getElementById('rapor-kom-sirala')?.selectedOptions?.[0]?.textContent||'Konaklama Tarihi';
  const siralama2=document.getElementById('rapor-kom-sirala2')?.selectedOptions?.[0]?.textContent||'Yok';
  const oz=document.getElementById('rapor-kom-ozet'); if(oz) oz.innerHTML=`Kayıtlarda görülen komisyoncu: <b>${aracSayisi}</b> · Portal kullanıcısı olarak tanımlı: <b>${tanimliSayisi}</b> · Tüm kayıtlar: <b>${tum.length}</b> · <span style="color:var(--green)">Tamamlanmış <b>${toplamlar.tamamlandi}</b></span> · <span style="color:#d97706">Tamamlanmamış <b>${toplamlar.tamamlanmadi}</b></span> · <span style="color:var(--red)">İptal / No-show <b>${toplamlar.iptal}</b></span> · Filtre sonucu <b>${liste.length}</b> · Sıra: <b>${shEsc(siralama)}</b>${siralama2!=='Yok'?` → <b>${shEsc(siralama2)}</b>`:''}`;
  if(!liste.length){body.innerHTML='<tr class="empty-row"><td colspan="11">Bu kriterlerde komisyoncu rezervasyonu yok</td></tr>';document.getElementById('rapor-kom-toplam').textContent='0 kayıt';return;}
  body.innerHTML=liste.map((x,i)=>`<tr>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);color:var(--gold2);font-weight:700">${shEsc(x.araciAd)}</td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);font-weight:600">${shEsc(x.misafir)}</td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border)">Oda ${shEsc(x.odaNo)}</td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border)">${shEsc(x.giris||'—')} → ${shEsc(x.cikis||'—')}<br><span style="font-size:9px;color:var(--muted)">${x.gece} gece</span></td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);font-size:10px">${shEsc(raporKomTarihMetni(x.kayitTarih))}<br><span style="font-size:9px;color:var(--muted)">${x.kaynakTip==='talep'?'Talep':x.kaynakTip==='rezervasyon'?'Rezervasyon kaydı':'Konaklama kaydı'}</span></td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);font-weight:800;color:${x.grup.renk}">${shEsc(x.grup.etiket)}</td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);font-weight:700;color:${x.k.renk}">${shEsc(x.k.etiket)}</td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);text-align:right">${x.musteriToplam?fmt(x.musteriToplam):'—'}</td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);text-align:right">${x.otelToplam?fmt(x.otelToplam):'—'}</td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);text-align:right;color:var(--gold2);font-weight:700">${x.komisyon?fmt(x.komisyon):'—'}</td>
    <td style="padding:7px 8px;border-bottom:1px solid var(--border);text-align:center"><button class="btn btn-ghost" style="padding:4px 10px;font-size:10px" onclick="raporKomTalepDetayAc(${i})">Detay</button></td>
  </tr>`).join('');
  const musteri=liste.reduce((a,x)=>a+x.musteriToplam,0), net=liste.reduce((a,x)=>a+x.otelToplam,0), kom=liste.reduce((a,x)=>a+x.komisyon,0);
  document.getElementById('rapor-kom-toplam').textContent=`${liste.length} kayıt · Müşteri: ${fmt(musteri)} · Otel net: ${fmt(net)} · Komisyon: ${fmt(kom)}`;
};
window.raporKomTalepDetayAc=function(i){
  const x=(window._raporKomListe||[])[i]; if(!x) return;
  const t=x.t, r=x.r||{}, g=x.g||{}, o=x.o||{};
  const row=(k,v)=>`<div style="padding:8px 0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:180px 1fr;gap:12px"><b style="color:var(--muted)">${k}</b><span>${v}</span></div>`;
  const tc=t.tc||r.tc||g.tc||o.tc||'—', tel=t.tel||r.tel||g.tel||o.tel||'—';
  document.getElementById('raporKayitDetayBaslik').textContent=`${x.araciAd} · Oda ${x.odaNo} · ${x.misafir}`;
  document.getElementById('raporKayitDetayIcerik').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
      <div>${row('Komisyoncu',shEsc(x.araciAd))}${row('Misafir',shEsc(x.misafir))}${row('TC / Pasaport',shEsc(tc))}${row('Telefon',shEsc(tel))}${row('Oda','Oda '+shEsc(x.odaNo))}${row('Konaklama',`${shEsc(x.giris||'—')} → ${shEsc(x.cikis||'—')} · ${x.gece} gece`)}</div>
      <div>${row('Kayıt Kaynağı',x.kaynakTip==='talep'?'Komisyoncu portalı talebi':x.kaynakTip==='rezervasyon'?'Eski/manuel rezervasyon kaydı':'Geçmiş konaklama kaydı')}${row('Tamamlanma',`<b style="color:${x.grup.renk}">${shEsc(x.grup.etiket)}</b>`)}${row('Gerçek Konaklama',`<b style="color:${x.k.renk}">${shEsc(x.k.etiket)}</b>`)}${row('Talep / Rezervasyon Durumu',shEsc(x.talepDurum||'—'))}${row('Talep / Kayıt Tarihi',shEsc(raporKomTarihMetni(x.kayitTarih)))}${row('Onay / İşlem',shEsc(raporKomTarihMetni(t.islemTarih||t.guncelleme)))}${row('Check-in / Check-out',`${shEsc(g.giris||o.giris||'Yok')} / ${shEsc(g.checkoutTarih||t.checkoutTarih||'Yok')}`)}</div>
    </div>
    <div style="margin-top:16px;background:var(--parchment);border:1px solid var(--border);padding:12px 14px">${row('Müşteri Gecelik',x.musteriGecelik?fmt(x.musteriGecelik):'—')}${row('Otel Net Gecelik',x.otelGecelik?fmt(x.otelGecelik):'—')}${row('Müşteri Toplam',x.musteriToplam?fmt(x.musteriToplam):'—')}${row('Otel Net Toplam',x.otelToplam?fmt(x.otelToplam):'—')}${row('Komisyon',x.komisyon?fmt(x.komisyon):'—')}</div>${x.finansUyari?`<div style="margin-top:10px;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:11px"><b>⚠ Finans Kontrolü:</b> ${shEsc(x.finansUyari)}</div>`:''}
    <div style="margin-top:16px">${row('Rezervasyon Kaydı',r.id?'Bağlı rezervasyon bulundu':'Bağlı rezervasyon yok')}${row('Konaklama / Gelir Kaydı',g.id?'Check-in/gelir kaydı bulundu':'Kayıt yok')}${row('Not',`<span style="white-space:pre-wrap">${shEsc(t.degisiklikNot||t.iptalNot||t.not||r.not||g.not||'—')}</span>`)}</div>`;
  openModal('raporKayitDetayModal');
};
window.raporKomisyonRezPdf=function(){
  const liste=window._raporKomListe||[]; if(!liste.length){toast('Döküm alınacak kayıt yok','error');return;}
  const rows=liste.map(x=>`<tr><td>${shEsc(x.araciAd)}</td><td>${shEsc(x.misafir)}</td><td>${shEsc(x.odaNo)}</td><td>${shEsc(x.giris||'—')} → ${shEsc(x.cikis||'—')}</td><td>${shEsc(raporKomTarihMetni(x.kayitTarih))}</td><td>${shEsc(x.grup.etiket)}</td><td>${shEsc(x.k.etiket)}</td><td class="num">${x.musteriToplam?fmt(x.musteriToplam):'—'}</td><td class="num">${x.otelToplam?fmt(x.otelToplam):'—'}</td><td class="num">${x.komisyon?fmt(x.komisyon):'—'}</td></tr>`).join('');
  const kriter=`Komisyoncu: ${document.getElementById('rapor-kom-araci')?.selectedOptions?.[0]?.textContent||'Tümü'} · Tamamlanma: ${document.getElementById('rapor-kom-tamamlanma')?.selectedOptions?.[0]?.textContent||'Tümü'} · Konaklama durumu: ${document.getElementById('rapor-kom-konaklama')?.selectedOptions?.[0]?.textContent||'Tümü'} · Konaklama tarihi: ${document.getElementById('rapor-kom-kon-bas')?.value||'—'} → ${document.getElementById('rapor-kom-kon-bit')?.value||'—'} · Talep tarihi: ${document.getElementById('rapor-kom-talep-bas')?.value||'—'} → ${document.getElementById('rapor-kom-talep-bit')?.value||'—'} · Sıralama: ${document.getElementById('rapor-kom-sirala')?.selectedOptions?.[0]?.textContent||'—'}${document.getElementById('rapor-kom-sirala2')?.value!=='yok'?' / '+document.getElementById('rapor-kom-sirala2')?.selectedOptions?.[0]?.textContent:''} · ${document.getElementById('rapor-kom-yon')?.selectedOptions?.[0]?.textContent||''}`;
  const html=`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Komisyoncu Rezervasyon Raporu</title><style>@page{size:A4 landscape;margin:9mm}body{font-family:Arial;color:#222;font-size:8.5px}.head{border-bottom:3px solid #c8102e;padding-bottom:10px;margin-bottom:12px}h1{font-size:17px;margin:0 0 5px}.meta{font-size:8.5px;color:#555;margin-top:4px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:5px}th{background:#eee;text-align:left}.num{text-align:right}</style></head><body><div class="head"><h1>SWISS HOUSE · Komisyoncu Rezervasyon Raporu</h1><div><b>Kayıt:</b> ${liste.length} · <b>Rapor:</b> ${new Date().toLocaleString('tr-TR')}</div><div class="meta">${shEsc(kriter)}</div></div><table><thead><tr><th>Komisyoncu</th><th>Misafir</th><th>Oda</th><th>Konaklama</th><th>Talep/Kayıt Tarihi</th><th>Tamamlanma</th><th>Gerçek Konaklama</th><th>Müşteri</th><th>Otel Net</th><th>Komisyon</th></tr></thead><tbody>${rows}</tbody></table><script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script><script>window.onload=()=>html2pdf().set({filename:'swiss-house-komisyoncu-rezervasyon-raporu.pdf',html2canvas:{scale:2,useCORS:true},jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}}).from(document.body).save();<\/script></body></html>`;
  const w=window.open('','_blank'); if(w){w.document.write(html);w.document.close();}
};

function araciAnahtar(ad) {
  return String(ad||'').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
}
// Bir grup içindeki en sık kullanılan orijinal yazımı ekranda göstermek için seçer.
function araciGosterAdi(adSayaci) {
  let en = '', enSayi = -1;
  for(const [ad, sayi] of adSayaci) { if(sayi > enSayi) { en = ad; enSayi = sayi; } }
  return en;
}

// ── GEÇMİŞ KOMİSYON TARAMA/DÜZELTME ──
// Sözleşme fiyatı unutulduğu için komisyonu 0 hesaplanmış ama komisyoncunun tanımlı
// bir ayarı olan geçmiş check-in kayıtlarını bulur, önizleme gösterir, onaylanırsa
// hem gelirler hem komisyonlar koleksiyonunu günceller (Cari Hesap'a otomatik yansır).
let _gecmisKomisyonBulunanlar = [];

function komMutabakatSatirVerisi(k) {
  const r=(window._R||[]).find(x=>k.rezervasyonId && x.id===k.rezervasyonId)||null;
  const g=(window._G||[]).find(x=>k.gelirDocId && x.id===k.gelirDocId)||null;
  const durum=komisyonMutabakatDurumu(k);
  const gece=Math.max(0,Number(k.gece)||Number(g?.gece)||geceSayisi(r?.giris,r?.cikis)||0);
  const otel=Math.max(0,Number(k.gercekFiyat ?? g?.fiyat ?? r?.fiyat)||0);
  const musteri=Math.max(0,Number(k.sozlesmeFiyat ?? g?.sozlesmeFiyat ?? r?.sozlesmeFiyat)||0);
  const ad=araciKanonikAd(k.araciAd||k.komisyoncuAd||window.KOMISYONCULAR?.[k.komisyoncu]?.ad||'')||'—';
  return {k,r,g,durum,gece,otel,musteri,ad};
}

window.gecmisKomisyonTara = function() {
  const tum=(window._KOM||[]).map(komMutabakatSatirVerisi);
  _gecmisKomisyonBulunanlar=tum;
  const sorun=tum.filter(x=>!x.durum.uygun);
  const uygun=tum.length-sorun.length;
  const ozet=document.getElementById('gecmisKomisyonOzet');
  const govde=document.getElementById('gecmisKomisyonBody');
  ozet.innerHTML=`<div style="display:flex;gap:10px;flex-wrap:wrap"><span class="badge badge-green">✓ Cari Uygun: ${uygun}</span><span class="badge badge-red">⚠ Kontrol Bekleyen: ${sorun.length}</span><span style="color:var(--muted)">Kontrol bekleyen kayıtlar bakiyeye dahil edilmez.</span></div>`;
  const liste=[...sorun,...tum.filter(x=>x.durum.uygun)].slice(0,500);
  govde.innerHTML=liste.length?liste.map(x=>{
    const k=x.k; const renk=x.durum.uygun?'var(--green)':'var(--red)';
    const islem=x.durum.uygun
      ? `<span style="color:var(--green);font-size:10px">Cari dahil</span>`
      : `<button class="btn btn-ghost btn-sm" onclick="komMutabakatDuzeltAc('${String(k.id).replace(/'/g,"\\'")}')">Düzelt</button> <button class="btn btn-danger btn-sm" onclick="komMutabakatCariDisi('${String(k.id).replace(/'/g,"\\'")}')">Cari Dışı</button>`;
    return `<tr style="border-bottom:1px solid var(--border)"><td style="padding:7px"><b>${k.misafir||x.r?.misafir||'—'}</b><br><span style="color:var(--muted)">Oda ${k.odaNo||x.r?.odaNo||'—'} · ${x.gece} gece</span></td><td style="padding:7px">${x.ad}</td><td style="padding:7px;text-align:right">${x.otel?fmt(x.otel):'—'}</td><td style="padding:7px;text-align:right">${x.musteri?fmt(x.musteri):'—'}</td><td style="padding:7px;text-align:right;font-weight:700">${fmt(Number(k.toplamKomisyon)||0)}</td><td style="padding:7px;color:${renk};max-width:260px">${x.durum.uygun?'✓ ': '⚠ '}${x.durum.neden}</td><td style="padding:7px;text-align:center;white-space:nowrap">${islem}</td></tr>`;
  }).join(''):'<tr><td colspan="7" style="padding:20px;text-align:center">Komisyon kaydı yok</td></tr>';
  openModal('gecmisKomisyonModal');
};

window.komMutabakatCariDisi = async function(id) {
  const k=(window._KOM||[]).find(x=>x.id===id); if(!k) return;
  if(!confirm(`${k.misafir||'Bu kayıt'} cari hesaptan çıkarılsın mı? Kayıt silinmeyecek.`)) return;
  await updateDoc(doc(db,'komisyonlar',id),{cariDahil:false,mutabakatDurum:'cari_disi_onaylandi',mutabakatTarih:nowISO()});
  toast('Kayıt cari dışına alındı','success');
  setTimeout(()=>gecmisKomisyonTara(),150);
};

window.komMutabakatDuzeltAc = function(id) {
  const x=_gecmisKomisyonBulunanlar.find(v=>v.k.id===id) || komMutabakatSatirVerisi((window._KOM||[]).find(k=>k.id===id));
  if(!x?.k) return;
  document.getElementById('kmd_id').value=id;
  document.getElementById('kmd_bilgi').textContent=`${x.k.misafir||x.r?.misafir||'—'} · Oda ${x.k.odaNo||x.r?.odaNo||'—'} · ${x.durum.neden}`;
  const sel=document.getElementById('kmd_komisyoncu');
  sel.innerHTML='<option value="">— Seçin —</option>'+Object.entries(window.KOMISYONCULAR||{}).map(([key,v])=>`<option value="${key}">${v.ad||key}</option>`).join('');
  sel.value=x.k.komisyoncu || komisyoncuKeyBul(x.ad)||'';
  document.getElementById('kmd_gece').value=x.gece||1;
  document.getElementById('kmd_otel').value=x.otel||'';
  document.getElementById('kmd_musteri').value=x.musteri||'';
  komMutabakatDuzeltHesap();
  openModal('komMutabakatDuzeltModal');
};
window.komMutabakatDuzeltHesap = function() {
  const gece=Math.max(0,Number(document.getElementById('kmd_gece')?.value)||0);
  const otel=Math.max(0,Number(document.getElementById('kmd_otel')?.value)||0);
  const musteri=Math.max(0,Number(document.getElementById('kmd_musteri')?.value)||0);
  const el=document.getElementById('kmd_hesap');
  if(!otel||!musteri||musteri<otel) { el.textContent=musteri&&otel&&musteri<otel?'⚠ Müşteri fiyatı otel netinden düşük olamaz':'Komisyon: —'; el.style.color='var(--red)'; return; }
  const toplam=Math.round((musteri-otel)*gece*100)/100;
  el.textContent=`Komisyon: (${fmt(musteri)} − ${fmt(otel)}) × ${gece} = ${fmt(toplam)} ₺`; el.style.color='var(--gold2)';
};
window.komMutabakatDuzeltKaydet = async function() {
  const id=document.getElementById('kmd_id').value;
  const k=(window._KOM||[]).find(x=>x.id===id); if(!k) return;
  const key=document.getElementById('kmd_komisyoncu').value;
  const gece=Math.max(0,Number(document.getElementById('kmd_gece').value)||0);
  const otel=Math.max(0,Number(document.getElementById('kmd_otel').value)||0);
  const musteri=Math.max(0,Number(document.getElementById('kmd_musteri').value)||0);
  if(!key||gece<=0||otel<=0||musteri<=0) { toast('Komisyoncu, gece ve iki fiyat zorunludur','error'); return; }
  if(musteri+0.009<otel) { toast('Müşteri fiyatı otel netinden düşük olamaz','error'); return; }
  const toplam=Math.round((musteri-otel)*gece*100)/100;
  const ad=window.KOMISYONCULAR?.[key]?.ad||key;
  const batch=writeBatch(db); const now=nowISO();
  batch.set(doc(db,'komisyonlar',id),{gece,gercekFiyat:otel,sozlesmeFiyat:musteri,gecelikKomisyon:Math.round((musteri-otel)*100)/100,komisyonKaynak:'mutabakat_fiyat_farki',toplamKomisyon:toplam,komisyonFark:toplam,araciAd:ad,komisyoncu:key,komisyoncuAd:ad,cariDahil:true,mutabakatDurum:'dogrulandi',mutabakatTarih:now,guncelleme:now},{merge:true});
  if(k.gelirDocId) batch.set(doc(db,'gelirler',k.gelirDocId),{fiyat:otel,sozlesmeFiyat:musteri,komisyonFark:toplam,araciAd:ad,komisyoncu:key,guncelleme:now},{merge:true});
  if(k.rezervasyonId) batch.set(doc(db,'rezervasyonlar',k.rezervasyonId),{fiyat:otel,sozlesmeFiyat:musteri,araciAd:ad,komisyoncu:key,komisyoncuAd:ad,guncelleme:now},{merge:true});
  await batch.commit();
  closeModal('komMutabakatDuzeltModal'); toast('Komisyon kaydı doğrulandı ve cari hesaba dahil edildi','success');
  setTimeout(()=>gecmisKomisyonTara(),180);
};

window.renderKomisyonCari = function() {
  const govde = document.getElementById('komcari-body');
  if(!govde) return; // Rapor sayfası henüz açılmamış olabilir

  const komTum = window._KOM || [];
  const komList = komTum.filter(k=>!komisyonKaydiSupheli(k));
  const komKontrol = komTum.filter(k=>komisyonKaydiSupheli(k));
  const odemeList = window._KOMODEME || [];

  // key = normalize edilmiş KANONİK isim -> {borc, odeme, sayi, beklenen, adSayaci: Map<orijinalYazım, kaç kez görüldü>}
  // "PUNE" / "Pune" / "pune iran" gibi kısaltılmış yazımlar da artık aynı hesapta birleşiyor.
  const araciler = new Map();
  const ekle = (adRaw, alan, tutar) => {
    const adOrijinal = (adRaw||'').trim();
    if(!adOrijinal) return null;
    const adKanonik = araciKanonikAd(adOrijinal);
    const key = araciAnahtar(adKanonik);
    if(!araciler.has(key)) araciler.set(key, {borc:0, odeme:0, sayi:0, beklenen:0, beklenenSayi:0, kontrol:0, adSayaci:new Map()});
    const rec = araciler.get(key);
    rec[alan] += tutar;
    rec.adSayaci.set(adOrijinal, (rec.adSayaci.get(adOrijinal)||0) + 1);
    return key;
  };
  komList.forEach(k => { const ad=k.araciAd||k.komisyoncuAd||window.KOMISYONCULAR?.[k.komisyoncu]?.ad||''; const key = ekle(ad, 'borc', Number(k.toplamKomisyon)||0); if(key) araciler.get(key).sayi += 1; });
  odemeList.forEach(p => ekle(p.araciAd||p.komisyoncuAd||window.KOMISYONCULAR?.[p.komisyoncu]?.ad||'', 'odeme', Number(p.tutar)||0));
  komKontrol.forEach(k => { const ad=k.araciAd||k.komisyoncuAd||window.KOMISYONCULAR?.[k.komisyoncu]?.ad||''; const key=ekle(ad,'kontrol',1); });

  // Beklenen hakediş bilgi amaçlıdır; KESİN CARİ BORCA EKLENMEZ.
  // Ayrıca rezervasyonId/gelir/komisyon kaydı üzerinden check-in olmuş kayıtlar tekrar beklenen sayılmaz.
  (window._R || []).forEach(r => {
    const beklenen = rezervasyonBeklenenKomisyon(r);
    if(!beklenen) return;
    const adOrijinal = (r.araciAd||r.komisyoncuAd||beklenen.araciAd||'').trim();
    const key = araciAnahtar(araciKanonikAd(adOrijinal));
    if(!key) return;
    if(!araciler.has(key)) araciler.set(key, {borc:0, odeme:0, sayi:0, beklenen:0, beklenenSayi:0, kontrol:0, adSayaci:new Map()});
    const rec = araciler.get(key);
    rec.beklenen += beklenen.toplam;
    rec.beklenenSayi += 1;
    rec.adSayaci.set(adOrijinal, (rec.adSayaci.get(adOrijinal)||0) + 1);
  });

  // Datalist'i güncel komisyoncu isimleriyle doldur (her gruptan en sık kullanılan yazım) —
  // böylece ödeme/check-in formunda otomatik tamamlama yeni yazım farkları oluşmasını azaltır.
  const datalistIsimler = [...new Set([
    ...[...araciler.values()].map(r => araciGosterAdi(r.adSayaci)),
    ...Object.values(window.KOMISYONCULAR||{}).map(k=>k?.ad).filter(Boolean)
  ])].sort((a,b)=>String(a).localeCompare(String(b),'tr'));
  const dl = document.getElementById('komOdeme_araci_list');
  if(dl) dl.innerHTML = datalistIsimler.map(a=>`<option value="${a}">`).join('');
  const dl2 = document.getElementById('ci_komisyoncu_list');
  if(dl2) dl2.innerHTML = datalistIsimler.map(a=>`<option value="${a}">`).join('');

  if(araciler.size === 0) {
    govde.innerHTML = '<tr class="empty-row"><td colspan="6">Henüz komisyonlu rezervasyon yok</td></tr>';
    return;
  }

  const satirlar = [...araciler.entries()].sort((a,b)=>((b[1].borc-b[1].odeme)-(a[1].borc-a[1].odeme)) || (b[1].beklenen-a[1].beklenen));
  govde.innerHTML = satirlar.map(([key, rec]) => {
    const adGoster = araciGosterAdi(rec.adSayaci);
    const kesinHakedis = rec.borc;
    const kalan = kesinHakedis - rec.odeme;
    const kalanRenk = kalan > 0.5 ? 'var(--red)' : (kalan < -0.5 ? 'var(--gold2)' : 'var(--green)');
    const farkliYazimSayisi = rec.adSayaci.size;
    const hakedisDetay = rec.beklenen > 0
      ? `${fmt(kesinHakedis)}<br><span style="font-size:9px;color:var(--gold2);font-weight:400">Beklenen: ${fmt(rec.beklenen)} · bakiyeye dahil değil</span>`
      : fmt(kesinHakedis);
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-weight:600;color:var(--gold2)">🤝 ${adGoster}${farkliYazimSayisi>1 ? ` <span title="${[...rec.adSayaci.keys()].join(', ')}" style="font-size:9px;color:var(--muted);font-weight:400;cursor:help">(${farkliYazimSayisi} yazım birleştirildi)</span>` : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center;font-size:11px">${rec.sayi}${rec.beklenenSayi>0 ? ` <span style="color:var(--gold2)" title="Henüz check-in yapılmamış onaylı rezervasyon">+${rec.beklenenSayi} beklenen</span>` : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right">${hakedisDetay}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;color:var(--green)">${fmt(rec.odeme)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-weight:700;color:${kalanRenk}">${kalan < -0.5 ? 'Komisyoncu borçlu: '+fmt(Math.abs(kalan)) : fmt(kalan)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center;color:${rec.kontrol?'var(--red)':'var(--green)'}">${rec.kontrol ? '⚠ '+rec.kontrol : '✓ 0'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">
        <button class="btn btn-ghost btn-sm" onclick="komDetayAc('${key.replace(/'/g,"\\'")}', '${adGoster.replace(/'/g,"\\'")}')">Detay</button>
      </td>
    </tr>`;
  }).join('');
};

function komisyonHareketleriniAcRes(k) {
  const kayitli = Array.isArray(k.komisyonHareketleri) ? k.komisyonHareketleri : [];
  if(kayitli.length) return kayitli.map(h => {
    const ham = Number(h.tutar)||0;
    return {
      tarih:h.tarih||k.tarih||k.kayitTarih||'',
      tip:ham<0?'mahsup':'borc',
      aciklama:h.aciklama || `${ham<0?'↩ Mahsup':'Hakediş'} · Oda ${k.odaNo||'—'} · ${k.misafir||'—'}`,
      tutar:Math.abs(ham)
    };
  }).filter(h=>h.tutar>0);
  return [{tarih:k.tarih||k.kayitTarih||'',tip:'borc',aciklama:`Oda ${k.odaNo||'—'} · ${k.misafir||'—'} · ${k.gece||'—'} gece`,tutar:Number(k.toplamKomisyon)||0}].filter(h=>h.tutar>0);
}

// Bir komisyoncunun (tüm yazım varyantları dahil) borç + ödeme hareketlerini kronolojik gösterir
window.komDetayAc = function(araciKey, adGoster) {
  document.getElementById('komDetayBaslik').textContent = '🤝 ' + (adGoster || araciKey);
  const borclar = (window._KOM||[])
    .filter(k => !komisyonKaydiSupheli(k) && araciAnahtar(araciKanonikAd(k.araciAd||k.komisyoncuAd||'')) === araciKey)
    .flatMap(komisyonHareketleriniAcRes);
  // Beklenen hareketler ayrı gösterilir; kesin cari bakiyeyi değiştirmez.
  const beklenenler = (window._R||[]).map(r => {
    if(araciAnahtar(araciKanonikAd(r.araciAd||r.komisyoncuAd||'')) !== araciKey) return null;
    const b = rezervasyonBeklenenKomisyon(r);
    if(!b) return null;
    return { tarih:r.giris||'', tip:'beklenen',
      aciklama:`⏳ Oda ${r.odaNo} · ${r.misafir||'—'} · ${b.gece} gece · beklenen hakediş (cariye dahil değil)`,
      tutar:b.toplam };
  }).filter(Boolean);
  const odemeler = (window._KOMODEME||[]).filter(p => araciAnahtar(araciKanonikAd(p.araciAd)) === araciKey).map(p => ({
    tarih: p.tarih || p.kayitTarih || '', tip:'odeme',
    aciklama: p.not ? `Ödeme alındı · ${p.not}` : 'Ödeme alındı',
    tutar: Number(p.tutar)||0
  }));
  const hareketler = [...borclar, ...beklenenler, ...odemeler].sort((a,b) => String(a.tarih).localeCompare(String(b.tarih)));

  let bakiye = 0;
  const satirlar = hareketler.map(h => {
    bakiye += h.tip==='borc' ? h.tutar : (h.tip==='odeme' || h.tip==='mahsup' ? -h.tutar : 0);
    const borcRengi = h.tip==='beklenen' ? 'color:var(--gold2);font-style:italic' : '';
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px">${h.tarih||'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);font-size:11px">${h.aciklama}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-size:11px;${borcRengi}">${(h.tip==='borc'||h.tip==='beklenen')?fmt(h.tutar):'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-size:11px;color:var(--green)">${(h.tip==='odeme'||h.tip==='mahsup')?fmt(h.tutar):'—'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-size:11px;font-weight:600">${fmt(bakiye)}</td>
    </tr>`;
  }).join('');
  document.getElementById('komDetayBody').innerHTML = satirlar || '<tr class="empty-row"><td colspan="5">Hareket yok</td></tr>';
  const adKullan = adGoster || araciKey;
  document.getElementById('komDetayOdemeAlBtn').onclick = () => { closeModal('komDetayModal'); komOdemeModalAc(adKullan); };

  // Yazdır butonu için mevcut ekstre verisini sakla
  window._komEkstreAktif = { araciAd: adKullan, hareketler, bakiyeToplam: bakiye };

  openModal('komDetayModal');
};

// Komisyoncu ekstresini ayrı bir pencerede yazdırılabilir olarak açar —
// ay sonu görüşmesinde ekrandaki tabloyu göstermek yerine tek tık yazdırmak için.
window.komEkstreYazdir = function(pdfOtomatik=false) {
  const veri = window._komEkstreAktif;
  if(!veri) return;
  const bugun = (() => { const n=new Date(),p=x=>String(x).padStart(2,'0'); return `${p(n.getDate())}.${p(n.getMonth()+1)}.${n.getFullYear()}`; })();

  let bakiye = 0;
  const satirlar = veri.hareketler.map(h => {
    bakiye += h.tip==='borc' ? h.tutar : (h.tip==='odeme' || h.tip==='mahsup' ? -h.tutar : 0);
    return `<tr>
      <td>${h.tarih||'—'}</td>
      <td>${h.aciklama}</td>
      <td style="text-align:right">${(h.tip==='borc'||h.tip==='beklenen')?fmt(h.tutar)+' ₺':'—'}</td>
      <td style="text-align:right">${h.tip==='odeme'?fmt(h.tutar)+' ₺':'—'}</td>
      <td style="text-align:right;font-weight:700">${fmt(bakiye)} ₺</td>
    </tr>`;
  }).join('');

  const kalanRenk = bakiye > 0.5 ? '#dc2626' : (bakiye < -0.5 ? '#c4a55a' : '#16a34a');
  const kalanEtiket = bakiye > 0.5 ? 'Ödenecek Bakiye' : (bakiye < -0.5 ? 'Fazla Ödeme' : 'Bakiye Kapandı');

  const html = `<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><title>Acenta Rezervasyon ve Kazanç Raporu — ${veri.araciAd}</title>
<style>
@page{size:A4;margin:12mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#111;font-size:12px}
.page{max-width:190mm;margin:0 auto}
.header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #C8102E;padding-bottom:10px;margin-bottom:16px}
.logo{font-size:20px;font-weight:800}
.logo span{color:#C8102E}
.baslik{font-size:16px;font-weight:700;margin-top:4px}
.tarih{font-size:11px;color:#666}
table{width:100%;border-collapse:collapse;margin-bottom:16px}
th,td{border:1px solid #ccc;padding:7px 8px;font-size:11px}
th{background:#f2f3f5;text-align:left;letter-spacing:.5px;text-transform:uppercase;font-size:9px}
.sonuc{border:2px solid ${kalanRenk};background:${kalanRenk}15;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin-top:10px}
.sonuc .etiket{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#555}
.sonuc .tutar{font-size:22px;font-weight:800;color:${kalanRenk}}
.footer{margin-top:30px;font-size:10px;color:#888;border-top:1px solid #ccc;padding-top:8px}
.aksiyon-bar{position:fixed;bottom:0;left:0;right:0;background:#1a1d23;padding:12px;display:flex;justify-content:center;gap:10px}
.aksiyon-bar button{padding:10px 22px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:none;cursor:pointer;background:#C8102E;color:#fff}
@media print{.aksiyon-bar{display:none}}
</style></head>
<body>
<div class="page">
  <div class="header">
    <div><div class="logo"><span>SWISS</span> HOUSE</div><div class="baslik">Acenta Rezervasyon ve Kazanç Raporu</div></div>
    <div class="tarih">Düzenleme Tarihi: ${bugun}</div>
  </div>
  <p style="font-size:13px;margin-bottom:14px"><b>Acenta:</b> ${veri.araciAd}</p>
  <table>
    <thead><tr><th>Tarih</th><th>Rezervasyon / Misafir</th><th style="text-align:right">Kazanç</th><th style="text-align:right">Ödenen</th><th style="text-align:right">Bakiye</th></tr></thead>
    <tbody>${satirlar || '<tr><td colspan="5" style="text-align:center;color:#999">Hareket yok</td></tr>'}</tbody>
  </table>
  <div class="sonuc">
    <span class="etiket">${kalanEtiket}</span>
    <span class="tutar">${fmt(Math.abs(bakiye))} ₺</span>
  </div>
  <div class="footer">Bu ekstre Swiss House Yönetim Sistemi tarafından otomatik oluşturulmuştur.</div>
</div>
<div class="aksiyon-bar"><button onclick="window.print()">🖨 Yazdır</button><button onclick="indirPdf()">⬇ PDF İndir</button></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script>
<script>
function indirPdf(){
  const ad=${JSON.stringify(veri.araciAd)}.replace(/[^a-z0-9çğıöşü_-]+/gi,'_');
  html2pdf().set({margin:[8,8,8,8],filename:'acenta-rezervasyon-kazanc-'+ad+'.pdf',image:{type:'jpeg',quality:.98},html2canvas:{scale:2,useCORS:true},jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}}).from(document.querySelector('.page')).save();
}
${pdfOtomatik?'window.addEventListener("load",()=>setTimeout(indirPdf,400));':''}
<\/script>
</body></html>`;

  const w = window.open('', '_blank');
  if(w) { w.document.write(html); w.document.close(); }
};

window.komEkstrePdfIndir = function() { komEkstreYazdir(true); };


// Ödeme formunu açar — komDetayAc'tan geliniyorsa komisyoncu adı önceden dolu gelir
window.komOdemeModalAc = function(araciAd) {
  document.getElementById('komOdeme_araci').value = araciAd || '';
  document.getElementById('komOdeme_tutar').value = '';
  document.getElementById('komOdeme_tarih').value = today();
  document.getElementById('komOdeme_not').value = '';
  openModal('komOdemeModal');
};

window.komOdemeKaydet = async function() {
  const araciAdYazilan = document.getElementById('komOdeme_araci').value.trim();
  const araciAd = araciKanonikAd(araciAdYazilan);
  const tutar = Number(document.getElementById('komOdeme_tutar').value) || 0;
  const tarih = document.getElementById('komOdeme_tarih').value || today();
  const not_ = document.getElementById('komOdeme_not').value.trim();
  if(!araciAd || tutar <= 0) { toast('Komisyoncu adı ve tutar zorunlu','error'); return; }
  try {
    const komisyoncu = komisyoncuKeyBul(araciAd) || null;
    await addDoc(collection(db,'komisyonOdemeleri'), {
      araciAd, komisyoncu, komisyoncuAd:araciAd, tutar, tarih, not: not_,
      kayitTarih: nowISO()
    });
    closeModal('komOdemeModal');
    toast(`${araciAd} adlı komisyoncuya ${fmt(tutar)} ₺ ödeme kaydedildi ✓`, 'success');
  } catch(e) {
    toast('Ödeme kaydedilemedi: '+(e?.message||'Bilinmeyen hata'), 'error');
  }
};

// Rezervasyon oda select
const revOdaSel = document.getElementById('rev_oda');
for(const i of HOTEL_ODALAR) revOdaSel.innerHTML+=`<option value="${i}">Oda ${i}</option>`;

// Logout
window.doLogout = async function() {
  if(!confirm('Çıkış yapılsın mı?')) return;
  await signOut(auth);
  window.location.href = 'index.html';
};

// ── TAKVİM ──
window.takvimNav = function(dir) {
  if(takvimModu==='ay') takvimTarih.setMonth(takvimTarih.getMonth()+dir);
  else if(takvimModu==='hafta') takvimTarih.setDate(takvimTarih.getDate()+dir*7);
  else takvimTarih.setDate(takvimTarih.getDate()+dir);
  renderTakvim();
};

window.takvimMod = function(mod) {
  takvimModu = mod;
  ['btnAylik','btnHaftalik','btnGunluk'].forEach(id=>document.getElementById(id)?.classList.remove('active'));
  const ids = {ay:'btnAylik',hafta:'btnHaftalik',gun:'btnGunluk'};
  document.getElementById(ids[mod])?.classList.add('active');
  renderTakvim();
};

window.renderTakvim = function() {
  const grid = document.getElementById('takvimGrid'); if(!grid) return;
  const todayStr = today();

  if(takvimModu === 'gun') {
    renderTakvimGunluk(grid, todayStr);
  } else {
    renderTakvimAyHafta(grid, todayStr);
  }
};

function renderTakvimAyHafta(grid, todayStr) {
  let gunler = [], baslik = '';
  const gunAdlari = ['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'];

  if(takvimModu === 'ay') {
    const yil = takvimTarih.getFullYear(), ay = takvimTarih.getMonth();
    const gs  = new Date(yil, ay+1, 0).getDate();
    for(let g=1;g<=gs;g++) gunler.push(`${yil}-${String(ay+1).padStart(2,'0')}-${String(g).padStart(2,'0')}`);
    baslik = takvimTarih.toLocaleDateString('tr-TR',{month:'long',year:'numeric'});
  } else {
    const d = new Date(takvimTarih), gun = d.getDay()||7;
    d.setDate(d.getDate()-gun+1);
    for(let k=0;k<7;k++) {
      const g2 = new Date(d); g2.setDate(d.getDate()+k);
      gunler.push(`${g2.getFullYear()}-${String(g2.getMonth()+1).padStart(2,'0')}-${String(g2.getDate()).padStart(2,'0')}`);
    }
    baslik = `${gunler[0]} – ${gunler[6]}`;
  }
  document.getElementById('takvimBaslik').textContent = baslik;

  let html = `<table class="takvim-table"><thead><tr><th class="oda-col">Oda</th>`;
  gunler.forEach(g => {
    const [yy,mm,dd] = g.split('-');
    const d2 = new Date(+yy, +mm-1, +dd);
    const ad = gunAdlari[d2.getDay()===0?6:d2.getDay()-1];
    const isToday = g===todayStr;
    html += `<th style="${isToday?'color:var(--gold);border-bottom:2px solid var(--gold2)':''}">${ad}<br><span style="font-size:12px;font-weight:700">${d2.getDate()}</span></th>`;
  });
  html += `</tr></thead><tbody>`;

  for(const i of HOTEL_ODALAR) {
    const oda = window._O['oda'+i] || {durum:'bos'};
    html += `<tr><td class="oda-label">Oda ${i}</td>`;
    gunler.forEach((g, gIdx) => {
      const isToday = g === todayStr;
      const rev = window._R.find(r => Number(r.odaNo)===i && (r.giris||'')<=g && (r.cikis||'')>g && rezervasyonOdayiBloklar(r));
      const fiiliDolu = oda.durum==='dolu' && oda.giris && oda.cikis && oda.giris<=g && oda.cikis>g;
      // Güvenlik ağı: durum dolu ama giriş/çıkış eksik VEYA giriş bugünden ileri (veri tutarsızlığı) — bugün için göster
      const bugunDolu = oda.durum==='dolu' && isToday && (!oda.giris || !oda.cikis || oda.giris > todayStr);
      // Temizlik sadece bugün göster, gelecek günlerde boş göster
      const temizlik = oda.durum==='temizlik' && isToday;

      let cls='t-bos', label='', tooltip='', onclick='', bgStyle='';
      if(rev) {
        cls='t-rezerve';
        label=rev.misafir||'Rezervasyon';
        const anahtarRev = (rev.id||'') + '|' + (rev.misafir||'') + '|' + (rev.giris||'');
        // Bu gün ve tüm konaklama bugünden önce kaldıysa (çıkış tarihi de geçmişse) — tamamlanmış/geçmiş olarak işaretle
        const tamamenGecmis = g < todayStr && (rev.cikis||'') <= todayStr;
        bgStyle = `background:${takvimRenkTonu(anahtarRev, tamamenGecmis ? 'gecmis' : 'rezerve')};`;
        tooltip=`title="${(rev.misafir||'').replace(/"/g,"'")} · ${rev.giris}→${rev.cikis}${tamamenGecmis?' · Tamamlandı':''}"`;
        onclick=`onclick="takvimDetay(${JSON.stringify({tip:'rezerv',misafir:rev.misafir,giris:rev.giris,cikis:rev.cikis,odaNo:i,gece:geceSayisi(rev.giris,rev.cikis),fiyat:rev.fiyat,kaynak:rev.kaynak,odemeDurum:rev.odemeDurum||''}).replace(/"/g,'&quot;')})"`;
      }
      else if(fiiliDolu||bugunDolu) {
        cls='t-dolu';
        label=oda.misafir||'Dolu';
        const anahtarDolu = (oda.misafir||'') + '|' + (oda.giris||'') + '|' + i;
        // Bu gün ve oda artık dolu değilse (check-out yapılmış, geçmişte kaldı) — tamamlanmış/geçmiş olarak işaretle
        const tamamenGecmis = g < todayStr && oda.durum !== 'dolu';
        bgStyle = `background:${takvimRenkTonu(anahtarDolu, tamamenGecmis ? 'gecmis' : 'dolu')};`;
        onclick=`onclick="takvimDetay(${JSON.stringify({tip:'dolu',misafir:oda.misafir,giris:oda.giris,cikis:oda.cikis,odaNo:i,gece:geceSayisi(oda.giris,oda.cikis),fiyat:oda.fiyat,kaynak:oda.kaynak,odemeDurum:oda.odemeDurum||''}).replace(/"/g,'&quot;')})"`;
      }
      else if(temizlik) { cls='t-temizlik'; label='Temizlik'; }
      else if(oda.durum==='arizali') {
        // Arızalı: sadece arizaBaslangic ile arizaBitis arasında göster
        const arizaBas = oda.arizaBaslangic || todayStr;
        const arizaBit = oda.arizaBitis || null;
        const arizaliGun = g >= arizaBas && (!arizaBit || g < arizaBit);
        if(arizaliGun) { cls='t-arizali'; label='🔧 Arızalı'; }
      }
      else if(isToday) { cls='t-bugun'; }

      html += `<td class="${cls}" ${tooltip} ${onclick} style="${bgStyle}${onclick?'cursor:pointer':''}">`;

      if(label) {
        const prevG = gIdx>0?gunler[gIdx-1]:'';
        const prevRev = prevG ? window._R.find(r=>Number(r.odaNo)===i&&(r.giris||'')<=prevG&&(r.cikis||'')>prevG&&rezervasyonOdayiBloklar(r)) : null;
        const prevDolu = prevG && oda.durum==='dolu' && oda.giris && oda.giris<=prevG && oda.cikis>prevG;
        const arizaBas2 = oda.arizaBaslangic || todayStr;
        const arizaBit2 = oda.arizaBitis || null;
        const prevArizali = prevG && oda.durum==='arizali' && prevG >= arizaBas2 && (!arizaBit2 || prevG < arizaBit2);
        // Aynı bloğun devamı mı? Sadece dolu/rezerve OLMASI yetmez — AYNI kayıt/misafir olması gerekir.
        const ayniRev = rev && prevRev && (rev.id ? rev.id===prevRev.id : (rev.misafir===prevRev.misafir && rev.giris===prevRev.giris));
        const ayniDolu = (fiiliDolu||bugunDolu) && prevDolu && oda.misafir===(window._O['oda'+i]?.misafir) && prevG>=oda.giris;
        const ayniArizali = oda.durum==='arizali' && prevArizali;
        const devamEdiyor = ayniRev || ayniDolu || ayniArizali;
        if(!devamEdiyor) html += `<div class="takvim-blok">${label}</div>`;
      }
      html += `</td>`;
    });
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  grid.innerHTML = html;
}

function renderTakvimGunluk(grid, todayStr) {
  const d = takvimTarih;
  const gunStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const isToday = gunStr === todayStr;
  const gunAd = d.toLocaleDateString('tr-TR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('takvimBaslik').textContent = gunAd;

  let html = `<table class="takvim-table"><thead><tr><th class="oda-col">Oda</th><th>Durum</th><th>Misafir</th><th>Giriş</th><th>Çıkış</th><th>Kaynak</th><th>Fiyat Tipi</th><th>Gecelik</th></tr></thead><tbody>`;
  for(const i of HOTEL_ODALAR) {
    const oda = window._O['oda'+i] || {durum:'bos'};
    const rev = window._R.find(r=>Number(r.odaNo)===i && (r.giris||'')<=gunStr && (r.cikis||'')>gunStr && rezervasyonOdayiBloklar(r));
    const fiiliDolu = oda.durum==='dolu' && oda.giris && oda.cikis && oda.giris<=gunStr && oda.cikis>gunStr;
    const bugunDolu = oda.durum==='dolu' && isToday && (!oda.giris || !oda.cikis || oda.giris > todayStr);

    let durumBadge, misafir='—', giris='—', cikis='—', kaynak='—', fiyatTipAd='—', gecelik='—';

    if(oda.durum==='dolu' && (fiiliDolu||bugunDolu)) {
      durumBadge = '<span class="badge badge-red">Dolu</span>';
      misafir = oda.misafir||'—'; giris=oda.giris||'—'; cikis=oda.cikis||'—';
      kaynak=oda.kaynak||'—'; fiyatTipAd=getTipAd(oda.fiyatTip||1);
      gecelik=oda.fiyat?(oda.fiyat.toLocaleString('tr-TR')+' ₺'):'—';
    } else if(rev) {
      durumBadge = '<span class="badge badge-blue">Rezerveli</span>';
      misafir=rev.misafir||'—'; giris=rev.giris||'—'; cikis=rev.cikis||'—';
      kaynak=rev.kaynak||'—'; fiyatTipAd=getTipAd(rev.fiyatTip||1);
      gecelik=rev.fiyat?(rev.fiyat.toLocaleString('tr-TR')+' ₺'):'—';
    } else if(oda.durum==='temizlik') {
      durumBadge = '<span class="badge badge-gold">Temizlik</span>';
    } else if(oda.durum==='arizali') {
      durumBadge = '<span class="badge" style="background:#f5ece0;color:#9a5221">🔧 Arızalı</span>';
    } else {
      durumBadge = '<span class="badge badge-green">Boş</span>';
    }

    const rowStyle = oda.durum==='dolu'&&(fiiliDolu||bugunDolu)?'background:#f9fcf9':rev?'background:#f4f0fa':'';
    html += `<tr style="${rowStyle}">
      <td class="oda-label" style="position:static">Oda ${i}</td>
      <td>${durumBadge}</td><td>${misafir}</td><td>${giris}</td>
      <td>${cikis}</td><td>${kaynak?`<span class="badge badge-blue">${kaynak}</span>`:'—'}</td>
      <td>${fiyatTipAd!=='—'?`<span class="badge badge-gold">${fiyatTipAd}</span>`:'—'}</td>
      <td class="${gecelik!=='—'?'amount-pos':''}">${gecelik}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  grid.innerHTML = html;
}

async function loadOdaOzel() {
  try {
    const snap = await getDoc(doc(db,'meta','odaOzellikleri'));
    if(snap.exists()) window._OZ = snap.data();
  } catch(e) {}
}

// ── REFAKATÇİLER ──
window.refakatciEkle = function(listeId = 'refakatciListesi') {
  const liste = document.getElementById(listeId);
  const idx = liste.children.length;
  const div = document.createElement('div');
  div.className = 'ref-row';
  div.style.cssText = 'display:grid;grid-template-columns:1fr 130px 120px 32px;gap:6px;align-items:end';
  div.innerHTML = `
    <div class="form-group" style="margin:0">
      <label>Ad Soyad</label>
      <input type="text" class="ref-ad" placeholder="Ad Soyad">
    </div>
    <div class="form-group" style="margin:0">
      <label>TC / Pasaport No</label>
      <input type="text" class="ref-tc" placeholder="TC veya Pasaport No" maxlength="20" style="text-transform:uppercase">
    </div>
    <div class="form-group" style="margin:0">
      <label>Doğum Tarihi</label>
      <input type="date" class="ref-dt">
    </div>
    <button type="button" onclick="this.parentElement.remove()" style="background:none;border:1px solid var(--border);color:var(--muted);width:32px;height:36px;cursor:pointer;font-size:16px;margin-bottom:0;display:flex;align-items:center;justify-content:center;align-self:end">×</button>`;
  liste.appendChild(div);
};

function getRefakatciler(listeId = 'refakatciListesi') {
  const liste = document.getElementById(listeId);
  const sonuc = [];
  liste.querySelectorAll('.ref-row').forEach(row => {
    const ad = row.querySelector('.ref-ad')?.value.trim();
    const tc = row.querySelector('.ref-tc')?.value.trim();
    const dt = row.querySelector('.ref-dt')?.value;
    if(ad) sonuc.push({ad, tc: tc||'', dt: dt||''});
  });
  return sonuc;
}

function clearRefakatciler(listeId = 'refakatciListesi') {
  document.getElementById(listeId).innerHTML = '';
}

// Sözleşme yazdır (checkout zaten bağımsız olarak aktiftir)
window.sozlesmeYazdir = function() {
  printSozlesme(currentCheckoutOda);
  setTimeout(() => {
    const coBtn = document.getElementById('coz_checkout_btn');
    if(coBtn) { coBtn.disabled=false; coBtn.style.opacity='1'; coBtn.style.cursor='pointer'; coBtn.title=''; }
    const sozBtn = document.getElementById('coz_sozlesme_btn');
    if(sozBtn) { sozBtn.style.borderColor='var(--green)'; sozBtn.style.color='var(--green)'; sozBtn.textContent='✓ Sözleşme Yazdırıldı'; }
  }, 800);
};

// ── SÖZLEŞME YAZDIR ──
window.printSozlesme = function(no) {
  const o  = window._O['oda'+no];
  if(!o || o.durum !== 'dolu') { toast('Sadece dolu odalar için sözleşme oluşturulabilir','error'); return; }
  const oz = window._OZ?.['oda'+no] || {};
  const odaAdi = oz.ad ? `Oda ${no} — ${oz.ad}` : `Oda ${no}`;
  const gece   = geceSayisi(o.giris, o.cikis);
  const sozNo  = `SW-${Date.now().toString().slice(-6)}`;
  const resNo  = `RES-${Date.now().toString().slice(-5)}`;
  const gecelikFiyat = o.sozlesmeFiyat || o.fiyat || 0;
  const toplamFiyat  = gecelikFiyat * gece;
  const fmtTarih = (t) => { if(!t) return '—'; const [y,m,d]=t.split('-'); return `${d}.${m}.${y}`; };
  const odemeDurumMap = {odenmedi:'Ödenmedi',odendi:'Ödendi',depozito:'Depozito Alındı',kismi:'Kısmi Ödeme'};
  let odemeDurum = odemeDurumMap[o.odemeDurum] || odemeDurumMap[o.odemeDurumu] || 'Ödenmedi';
  if((['kismi','depozito'].includes(o.odemeDurum) || ['kismi','depozito'].includes(o.odemeDurumu)) && o.kismiTutar != null) {
    const kalan = Math.max(0, toplamFiyat - Number(o.kismiTutar));
    odemeDurum += ` (${Number(o.kismiTutar).toLocaleString('tr-TR')} ₺ alındı, ${kalan.toLocaleString('tr-TR')} ₺ kalan)`;
  }
  const w = window.open('', '_blank');
  if(!w) { toast('Popup engellendi','error'); return; }
  w.document.write(sozlesmeHtmlOlustur(o, odaAdi, gece, sozNo, resNo, gecelikFiyat, toplamFiyat, odemeDurum, fmtTarih));
  w.document.close();
};

window.sozlesmeHtmlOlustur = function(o, odaAdi, gece, sozNo, resNo, gecelikFiyat, toplamFiyat, odemeDurum, fmtTarih) {
  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<title>Swiss House Sözleşme</title>
<style>
@page{size:A4;margin:8mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#111;background:#fff;font-size:11px}
.page{width:100%;max-width:190mm;margin:0 auto}
.header{text-align:center;margin-bottom:8px}
.logo{font-size:26px;font-weight:800;letter-spacing:1px}
.logo span{color:#c8102e}
.sub{font-size:10px;letter-spacing:3px;margin-top:2px}
h1{font-size:21px;margin:10px 0 6px 0;letter-spacing:.5px}
.red-line{border-top:2px solid #c8102e;margin:8px 0 12px}
.grid4{display:grid;grid-template-columns:1fr 1fr 1fr 1.3fr;gap:8px;margin-bottom:10px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px}
.box{border:1px solid #ccc;padding:8px 10px;min-height:48px}
.label{font-size:9px;letter-spacing:1.3px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:5px}
.value{font-size:14px;font-weight:700}
.section-title{color:#c8102e;font-size:15px;font-weight:800;letter-spacing:1px;margin:12px 0 8px}
table{width:100%;border-collapse:collapse;margin-bottom:8px}
td,th{border:1px solid #ccc;padding:7px 8px;font-size:10.5px}
th{background:#f2f3f5;letter-spacing:1px;text-transform:uppercase}
.rules{display:grid;grid-template-columns:1fr 1fr;gap:10px 28px;font-size:11px;line-height:1.45}
.rule{display:flex;gap:8px;margin-bottom:7px}
.rule b{color:#c8102e;min-width:16px}
.note{border:1px solid #ccc;min-height:45px;padding:8px;font-size:11px}
.signatures{border-top:2px solid #c8102e;margin-top:10px;padding-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:60px;text-align:center}
.sig-title{color:#c8102e;font-weight:800;font-size:11px;letter-spacing:1px}
.sig-name{margin:8px 0 28px;font-weight:700}
.sig-line{border-top:1px solid #999;padding-top:6px;font-size:10px}
.footer{border-top:2px solid #c8102e;margin-top:12px;padding-top:9px;display:flex;justify-content:space-around;font-size:10.5px;margin-bottom:60px}
.aksiyon-bar{position:fixed;bottom:0;left:0;right:0;background:#1a1d23;padding:12px 24px;display:flex;gap:12px;justify-content:center;z-index:999;box-shadow:0 -2px 12px rgba(0,0,0,.3)}
.aksiyon-bar button{padding:10px 22px;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;border:none}
.btn-print{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3)!important}
.btn-pdf{background:#c8102e;color:#fff}
.btn-wa{background:#25D366;color:#fff}
@media print{.aksiyon-bar{display:none}body{font-size:10px}}
</style>
</head>
<body>

<div class="page">
  <div class="header">
    <div class="logo"><span>SWISS</span> HOUSE</div>
    <div class="sub">YÖNETİM SİSTEMİ</div>
    <h1>GEÇİCİ KONUT KİRALAMA SÖZLEŞMESİ</h1>
  </div>
  <div class="red-line"></div>

  <div class="grid4">
    <div class="box"><div class="label">Sözleşme No</div><div class="value">${sozNo}</div></div>
    <div class="box"><div class="label">Düzenleme Tarihi</div><div class="value">${fmtTarih(today())}</div></div>
    <div class="box"><div class="label">Rezervasyon No</div><div class="value">${resNo}</div></div>
    <div class="box"><div class="label">Tesis Adresi</div><div class="value" style="font-size:11px">Hafiziye Mahallesi Telli Sokak No:11/A İpekyolu / VAN</div></div>
  </div>

  <div class="section-title">1. TARAFLAR</div>
  <table>
    <tr><th>Kiraya Veren</th><td><b>Swiss House Yönetimi</b></td></tr>
  </table>
  <table>
    <tr><th>Kişi</th><th>Adı Soyadı</th><th>TC / Pasaport No</th><th>Doğum Tarihi</th></tr>
    <tr><td>Sorumlu</td><td><b>${o.misafir||'—'}</b></td><td><b>${o.tc || o.pasaport || '—'}</b></td><td>${o.dt?fmtTarih(o.dt):'—'}</td></tr>
    ${(()=>{
      // Refakatçıları tekille (aynı ad + tc/pasaport varsa, dolu olanı tut)
      const seen = new Map();
      (o.refakatciler||[]).forEach(r=>{
        const key = (r.ad||'').trim().toLowerCase() + '|' + (r.tc||'').trim().toLowerCase();
        const mevcut = seen.get(key);
        if(!mevcut) seen.set(key, r);
        else {
          // Daha dolu olanı tut (dt veya tc'si olan kazansın)
          if((!mevcut.dt && r.dt) || (!mevcut.tc && r.tc)) seen.set(key, {...mevcut, ...r});
        }
      });
      return [...seen.values()].map(r=>`<tr><td>Yanındaki</td><td>${r.ad||'—'}</td><td>${r.tc||'—'}</td><td>${r.dt?fmtTarih(r.dt):'—'}</td></tr>`).join('');
    })()}
  </table>

  <div class="section-title">2. KİRALAMA BİLGİLERİ</div>
  <div class="grid3" style="margin-bottom:8px">
    <div class="box"><div class="label">Oda No</div><div class="value">${odaAdi}</div></div>
    <div class="box"><div class="label">Giriş Tarihi</div><div class="value">${fmtTarih(o.giris)}</div></div>
    <div class="box"><div class="label">Çıkış Tarihi</div><div class="value">${fmtTarih(o.cikis)}</div></div>
  </div>
  <div class="grid4" style="margin-bottom:8px">
    <div class="box"><div class="label">Konaklama Süresi</div><div class="value">${gece} Gece</div></div>
    <div class="box"><div class="label">Gecelik Ücret</div><div class="value">${gecelikFiyat.toLocaleString('tr-TR')} ₺</div></div>
    <div class="box" style="border-left:3px solid #c8102e"><div class="label">Toplam Tutar</div><div class="value" style="color:#c8102e">${toplamFiyat.toLocaleString('tr-TR')} ₺</div></div>
    <div class="box"><div class="label">Ödeme Durumu</div><div class="value" style="color:#0b3d91">${odemeDurum}</div></div>
  </div>

  <div class="section-title">3. GENEL HÜKÜMLER</div>
  <div class="rules">
    <div>
      <div class="rule"><b>1.</b><span>İşbu sözleşme, taraflar arasında belirtilen konut için geçici kiralama amacıyla düzenlenmiştir.</span></div>
      <div class="rule"><b>2.</b><span>Kiracı, kiralanan konutu özenle kullanmayı ve teslim aldığı hâliyle iade etmeyi kabul eder.</span></div>
      <div class="rule"><b>3.</b><span>Kiracı erken çıkış yaparsa kullanılmayan gecelere ait müşteri sözleşme bedeli iade hesabına alınır; varsa aracı/komisyoncu payı aynı geceler için hakedişten mahsup edilir.</span></div>
      <div class="rule"><b>4.</b><span>Konutun demirbaşlarına verilecek zarar kiracı tarafından tazmin edilecektir.</span></div>
      <div class="rule"><b>5.</b><span>Belirlenen kira bedeli, sözleşme imzalanırken peşin olarak ödenecektir.</span></div>
    </div>
    <div>
      <div class="rule"><b>6.</b><span>Kiracı, konutta sözleşmede belirtilenden fazla kişiyi barındırmamayı kabul eder.</span></div>
      <div class="rule"><b>7.</b><span>Konut içinde ateş yakmak, yüksek sesle müzik çalmak ve komşuları rahatsız etmek yasaktır.</span></div>
      <div class="rule"><b>8.</b><span>Kiracı, konut anahtarını çıkış tarihinde kiraya verene iade etmekle yükümlüdür.</span></div>
      <div class="rule"><b>9.</b><span>Konaklamada giriş (check-in) saati en erken 14:00, çıkış (check-out) saati en geç 11:00'dir.</span></div>
      <div class="rule"><b>10.</b><span>Check-in tarihine 1 gün veya daha az süre kala yapılan oda iptallerinde ücret iadesi yapılmaz.</span></div>
      <div class="rule"><b>11.</b><span>Sözleşmeden doğacak uyuşmazlıklarda yetkili Mahkemeler ve İcra Daireleri yetkilidir.</span></div>
    </div>
  </div>

  <div class="section-title">4. NOT / DETAY</div>
      <div class="note">${String(o.not||'—').replace(/Komisyoncu/gi,'Acenta')}</div>

  <div class="signatures">
    <div>
      <div class="sig-title">KİRAYA VEREN</div>
      <div class="sig-name">Swiss House Yönetimi</div>
      <div class="sig-line">İMZA</div>
    </div>
    <div>
      <div class="sig-title">KİRACI</div>
      <div class="sig-name">${o.misafir||'—'}</div>
      <div class="sig-line">İMZA</div>
    </div>
  </div>

  <div class="footer">
    <div>📍 Hafiziye Mahallesi Telli Sokak No:11/A İpekyolu / VAN</div>
    <div>☎ +90 506 150 83 00</div>
  </div>
</div>

<div class="aksiyon-bar">
  <button class="btn-print" onclick="window.print()">🖨 Yazdır</button>
  <button class="btn-pdf" id="pdfBtn" onclick="indir()">⬇ PDF İndir</button>
  <button class="btn-wa" onclick="whatsapp()">📲 WhatsApp</button>
</div>

\u003Cscript src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js">\u003C/script\u003E
\u003Cscript\u003E
function indir(){
  const btn=document.getElementById('pdfBtn');
  btn.textContent='⏳ Hazırlanıyor...';btn.disabled=true;
  html2pdf().set({
    margin:[8,8,8,8],
    filename:'sozlesme-${sozNo}.pdf',
    image:{type:'jpeg',quality:0.98},
    html2canvas:{scale:2,useCORS:true},
    jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}
  }).from(document.querySelector('.page')).save()
  .then(()=>{btn.textContent='✓ İndirildi';btn.style.background='#16a34a';});
}
function whatsapp(){
  let raw='${o.tel||""}'.replace(/[^0-9]/g,'');
  if(!raw){
    const girilen = prompt('Telefon numarasi girin (0rnek: 05XX XXX XX XX):');
    if(!girilen) return;
    raw = girilen.replace(/[^0-9]/g,'');
  }
  const num=raw.startsWith('0')?('90'+raw.slice(1)):raw.length===10?('90'+raw):raw;
  const txt=encodeURIComponent('Merhaba, Swiss House sözleşmeniz hazır.\\nNo: ${sozNo}\\nGiriş: ${fmtTarih(o.giris)} · Çıkış: ${fmtTarih(o.cikis)}\\nPDF indirip bu pencereden dosya olarak gönderebilirsiniz.');
  window.open('https://wa.me/'+num+'?text='+txt,'_blank');
}
\u003C/script\u003E
</body></html>`;

  return html;
};


async function logAktivite(islem, detay, odaNo='') {
  try {
    await addDoc(collection(db,'aktiviteLog'), {
      islem,          // 'checkin' | 'checkout' | 'rezervasyon' | 'rezervasyon_iptal' | 'masraf' | 'harcama' | 'durum_degisim'
      detay,          // açıklama metni
      odaNo: String(odaNo),
      kim: auth.currentUser?.email || 'resepsiyon',
      zaman: nowISO(),
      tarih: today()
    });
  } catch(e) { /* sessizce geç */ }
}

// ── HARCAMA ──
window.saveHarcama = async function() {
  const tutar    = Number(document.getElementById('harc_tutar').value);
  const aciklama = document.getElementById('harc_aciklama').value.trim();
  const kategori = document.getElementById('harc_kategori').value;
  const odeme    = document.getElementById('harc_odeme').value;
  if(!tutar || !aciklama) { toast('Tutar ve açıklama zorunlu','error'); return; }
  const now = nowISO();

  // Giderler koleksiyonuna yaz (yönetici görebilir)
  await addDoc(collection(db,'giderler'), {
    tarih: today(),
    tutar,
    kategori,
    aciklama: `[Resepsiyon] ${aciklama}`,
    odemeTuru: odeme,
    kim: auth.currentUser?.email || 'resepsiyon',
    kayitTarih: now
  });

  await logAktivite('harcama', `${kategori} · ${aciklama} · ${tutar.toLocaleString('tr-TR')} ₺`);

  closeModal('harcamaModal');
  document.getElementById('harc_tutar').value = '';
  document.getElementById('harc_aciklama').value = '';
  toast(`Harcama kaydedildi ✓ — ${tutar.toLocaleString('tr-TR')} ₺`, 'success');
};

// ── HATIRLATMA SİSTEMİ ──
// Rezervasyonlar değişince banner'ı güncelle
// Bir odanın kalan (ödenmemiş) tutarını hesaplar — check-in anında zaten hesaplanmış
// olan kismiKalan alanı varsa onu kullanır, yoksa (ödenmedi durumunda) sözleşme
// fiyatı × gece üzerinden tam tutarı borç kabul eder. Hem oda kartlarında (renk) hem
// de hatırlatma banner'ında (rozet) kullanılan ortak fonksiyon.
window.odaKalanBorc = function(oda) {
  if(!oda) return 0;
  if(oda.kalanTutar != null) return Math.max(0, Number(oda.kalanTutar) || 0);
  if(oda.odemeDurum === 'odendi') return 0;
  if(oda.kismiKalan != null) return Math.max(0, Number(oda.kismiKalan) || 0);
  const geceSayi = oda.gece || geceSayisi(oda.giris, oda.cikis) || 0;
  const toplam = oda.odemeToplam != null
    ? Number(oda.odemeToplam)||0
    : (Number(oda.sozlesmeFiyat || oda.fiyat) || 0) * geceSayi;
  const tahsil = oda.tahsilEdilen != null ? Number(oda.tahsilEdilen)||0 : (Number(oda.kismiTutar)||0);
  return Math.max(0, toplam - tahsil);
};

window.renderHatirlatma = function renderHatirlatma() {
  const todayStr = today();
  const gun1 = addDays(todayStr, 1);
  const gun2 = addDays(todayStr, 2);
  const gun3 = addDays(todayStr, 3);

  const odaKalanBorc = window.odaKalanBorc;

  // Bugün çıkışı olan dolu odalar — "arandı" işaretlenenler gizlenir
  const bugunCikis = HOTEL_ODALAR.map(no => {
    const oda = window._O?.['oda'+no];
    if(!oda || oda.durum !== 'dolu') return null;
    if(oda.cikis !== todayStr) return null;
    if(oda.cikisArama === 'arandi') return null; // arandıysa listeden düş
    return { _tip:'cikis', odaNo: no, misafir: oda.misafir, cikis: oda.cikis, giris: oda.giris, tel: oda.tel, id:'oda_'+no, aramaDurumu: oda.cikisArama||'', kalanBorc: odaKalanBorc(oda) };
  }).filter(Boolean);

  // Yarın çıkacak ama hâlâ borcu olan odalar — müşteri "son gün öderim" dediğinde
  // gün kalmadan önce erkenden hatırlatıp tahsilatı önceden yapabilmek için.
  const yarinBorclu = HOTEL_ODALAR.map(no => {
    const oda = window._O?.['oda'+no];
    if(!oda || oda.durum !== 'dolu') return null;
    if(oda.cikis !== gun1) return null;
    const kalanBorc = odaKalanBorc(oda);
    if(kalanBorc <= 0) return null;
    if(oda.borcArama === 'arandi') return null;
    return { _tip:'borc_yarin', odaNo: no, misafir: oda.misafir, cikis: oda.cikis, giris: oda.giris, tel: oda.tel, kalanBorc };
  }).filter(Boolean);

  // 3 gün içinde gelen, iptal/noshow/checkin yapılmamış — "arandı" işaretlenenler gizlenir
  const yaklaşan = (window._R || []).filter(r => {
    if(r.durum === 'iptal' || r.durum === 'noshow') return false;
    if(r.giris < todayStr) return false;
    if(r.aramaDurumu === 'arandi') return false; // arandıysa listeden düş
    const oda = window._O?.['oda' + r.odaNo];
    if(oda?.durum === 'dolu' && oda?.giris === r.giris) return false;
    return r.giris === todayStr || r.giris === gun1 || r.giris === gun2 || r.giris === gun3;
  }).map(r => ({...r, _tip:'giris'}));

  const tumListe = [...bugunCikis, ...yarinBorclu, ...yaklaşan];

  const banner = document.getElementById('hatirlatmaBanner');
  if(!tumListe.length) { banner.style.display = 'none'; return; }
  banner.style.display = 'block';

  const etiketler = {
    [todayStr]: {cls:'gun0', txt:'BUGÜN GİRİŞ'},
    [gun1]:     {cls:'gun1', txt:'YARIN GİRİŞ'},
    [gun2]:     {cls:'gun1', txt:'2 GÜN SONRA'},
    [gun3]:     {cls:'gun3', txt:'3 GÜN SONRA'},
  };

  document.getElementById('hatrListe').innerHTML = tumListe.map(r => {
    const oz = window._OZ?.['oda'+r.odaNo] || {};
    const odaLabel = oz.ad ? `Oda ${r.odaNo} — ${oz.ad}` : `Oda ${r.odaNo}`;
    const durumRenk = {arandi:'color:#4caf50', ulasilamadi:'color:var(--gold2)', '':'color:rgba(255,255,255,.3)'};
    const durumTxt  = {arandi:'✓ Arandı', ulasilamadi:'⚠ Ulaşılamadı', '':''};
    const mevcut = r.aramaDurumu || '';

    // Ödenmemiş borç rozeti — çıkış ve "yarın borçlu" kartlarında ortak kullanılır
    const borcRozet = (r.kalanBorc > 0)
      ? `<span class="hatr-durum" style="background:var(--red);color:#fff;font-weight:700">💰 ${r.kalanBorc.toLocaleString('tr-TR')} ₺ ÖDENMEDİ</span>`
      : '';

    // Çıkış uyarısı
    if(r._tip === 'cikis') {
      const saat = new Date().getHours();
      const acil = saat >= 10 && saat < 11;   // 10:00–11:00 arası son çağrı
      const gecikti = saat >= 11;             // 11:00 geçti, hâlâ çıkış yok
      const etiketTxt = gecikti ? '🔴 ÇIKIŞ SAATİ GEÇTİ · 11:00' : acil ? '🔔 SON 1 SAAT — CHECK-OUT 11:00' : '⏰ BUGÜN ÇIKIŞ · 11:00';
      const etiketStil = (acil||gecikti) ? 'background:var(--red);color:#fff' : 'background:var(--gold2);color:#1a1d23';
      // Ödenmemiş borcu olan bir çıkış, saat henüz gelmemiş olsa bile görsel olarak
      // acil (kırmızı) kabul edilir — misafir kapıdan borçlu çıkmasın diye.
      const kenarRenk = (acil||gecikti||r.kalanBorc>0) ? 'var(--red)' : 'var(--gold2)';
      return `
        <div class="hatr-item gun0" style="border-left:3px solid ${kenarRenk}${(acil||gecikti||r.kalanBorc>0)?';background:rgba(200,16,46,.08)':''}">
          <div class="hatr-info">
            <span class="hatr-etiket gun0" style="${etiketStil}">${etiketTxt}</span>
            <span class="hatr-oda">${odaLabel}</span>
            <span class="hatr-misafir">${r.aracirez?'🤝 ':''}${r.misafir||'—'}</span>
            ${r.tel?`<span class="hatr-tel">📞 ${r.tel}</span>`:''}
            <span class="hatr-tarih">${r.giris||'?'} → ${r.cikis} · Check-out bekleniyor</span>
            ${borcRozet}
            ${mevcut?`<span class="hatr-durum" style="${durumRenk[mevcut]||''}">${durumTxt[mevcut]||''}</span>`:''}
          </div>
          <div class="hatr-actions">
            <button class="hatr-btn arandi" onclick="cikisAramaDurum(${r.odaNo},'arandi')">✓ Arandı</button>
            <button class="hatr-btn ulasilamadi" onclick="cikisAramaDurum(${r.odaNo},'ulasilamadi')">Ulaşılamadı</button>
            <button class="btn btn-warning btn-sm" style="margin-left:4px" onclick="openCheckoutMenu(${r.odaNo})">Check-out →</button>
          </div>
        </div>`;
    }

    // Yarın çıkacak, hâlâ borcu olan oda — erkenden tahsilat hatırlatması
    if(r._tip === 'borc_yarin') {
      return `
        <div class="hatr-item gun1" style="border-left:3px solid var(--gold2)">
          <div class="hatr-info">
            <span class="hatr-etiket gun1" style="background:rgba(196,165,90,.15);color:var(--gold2)">📅 YARIN ÇIKIŞ · ÖDEME BEKLENİYOR</span>
            <span class="hatr-oda">${odaLabel}</span>
            <span class="hatr-misafir">${r.misafir||'—'}</span>
            ${r.tel?`<span class="hatr-tel">📞 ${r.tel}</span>`:''}
            <span class="hatr-tarih">${r.giris} → ${r.cikis}</span>
            ${borcRozet}
          </div>
          <div class="hatr-actions">
            <button class="hatr-btn arandi" onclick="borcAramaDurum(${r.odaNo},'arandi')">✓ Hatırlatıldı</button>
          </div>
        </div>`;
    }

    // Giriş uyarısı
    const et = etiketler[r.giris] || {cls:'gun3', txt:r.giris};
    return `
      <div class="hatr-item ${et.cls}">
        <div class="hatr-info">
          <span class="hatr-etiket ${et.cls}">${et.txt}</span>
          <span class="hatr-oda">${odaLabel}</span>
          <span class="hatr-misafir">${r.aracirez?'🤝 ':''}${r.misafir||'—'}</span>
          ${r.tel?`<span class="hatr-tel">📞 ${r.tel}</span>`:''}
          <span class="hatr-tarih">${r.giris} → ${r.cikis} · ${r.gece||geceSayisi(r.giris,r.cikis)} gece</span>
          ${mevcut?`<span class="hatr-durum" style="${durumRenk[mevcut]||''}">${durumTxt[mevcut]||''}</span>`:''}
        </div>
        <div class="hatr-actions">
          <button class="hatr-btn arandi" onclick="hatirlatmaDurum('${r.id}','arandi')">✓ Arandı</button>
          <button class="hatr-btn ulasilamadi" onclick="hatirlatmaDurum('${r.id}','ulasilamadi')">Ulaşılamadı</button>
        </div>
      </div>`;
  }).join('');
}

window.takvimDetay = function(data) {
  if(typeof data === 'string') { try { data = JSON.parse(data); } catch(e) { return; } }
  window._tdOda = data.odaNo;

  const isDolu = data.tip === 'dolu';
  const hdr = document.getElementById('td_header');
  hdr.style.background = isDolu ? 'var(--red)' : 'var(--blue)';

  const oz = window._OZ?.['oda'+data.odaNo] || {};
  document.getElementById('td_baslik').textContent = oz.ad ? `Oda ${data.odaNo} — ${oz.ad}` : `Oda ${data.odaNo}`;
  document.getElementById('td_badge').innerHTML = isDolu
    ? '<span style="background:rgba(255,255,255,.2);color:#fff;padding:2px 8px;font-size:10px;font-weight:700">DOLU</span>'
    : '<span style="background:rgba(255,255,255,.2);color:#fff;padding:2px 8px;font-size:10px;font-weight:700">REZERVELİ</span>';

  const odDurumMap = {odendi:'✓ Ödendi', odenmedi:'Ödenmedi', depozito:'Depozito', kismi:'Kısmi', '':'—'};
  const satırlar = [
    ['Misafir', data.misafir||'—'],
    ['Giriş',   data.giris||'—'],
    ['Çıkış',   data.cikis||'—'],
    ['Gece',    (data.gece||'—') + (data.gece ? ' gece' : '')],
    ['Gecelik', data.fiyat ? data.fiyat.toLocaleString('tr-TR') + ' ₺' : '—'],
    ['Kaynak',  data.kaynak||'—'],
    ['Ödeme',   odDurumMap[data.odemeDurum||''] || '—'],
    ['Toplam',  (data.fiyat && data.gece) ? (data.fiyat * data.gece).toLocaleString('tr-TR') + ' ₺' : '—'],
  ];

  document.getElementById('td_grid').innerHTML = satırlar.map(([k,v]) => `
    <div style="background:var(--parchment);border:1px solid var(--border);padding:8px 12px">
      <div style="font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:3px">${k}</div>
      <div style="font-size:13px;font-weight:600;color:var(--dark)">${v}</div>
    </div>`).join('');

  document.getElementById('td_checkin_btn').style.display  = isDolu ? 'none' : '';
  document.getElementById('td_checkout_btn').style.display = isDolu ? '' : 'none';

  openModal('takvimDetayModal');
};

window.sozlesmeToplam = function(prefix) {
  const fiyatEl  = document.getElementById(prefix + '_sozlesme_fiyat');
  const toplamEl = document.getElementById(prefix + '_sozlesme_toplam');
  const geceEl   = document.getElementById(prefix + '_gece');
  const gercekFiyatEl = document.getElementById(prefix + '_fiyat');
  if(!fiyatEl || !toplamEl || !geceEl) return;

  const sozFiyat = Number(fiyatEl.value) || 0;
  const gece  = parseInt(geceEl.value) || 1;
  const gercekFiyat = Number(gercekFiyatEl?.value) || 0;

  const komEl = document.getElementById(prefix + '_komisyoncu');
  const komisyoncuSecili = komEl && komEl.value && komEl.value !== '__legacy__';
  // Komisyon sadece doğrulanmış bir komisyoncu seçiliyse oluşur.
  const komisyon = komisyoncuSecili && sozFiyat > gercekFiyat && gercekFiyat>0 ? (sozFiyat - gercekFiyat) * gece : 0;
  toplamEl.textContent = fmt(komisyon);
  toplamEl.style.color = (komisyoncuSecili && sozFiyat>0 && gercekFiyat>0 && sozFiyat<gercekFiyat) ? 'var(--red)' : 'var(--gold2)';
  if(komisyoncuSecili && sozFiyat>0 && gercekFiyat>0 && sozFiyat<gercekFiyat) toplamEl.textContent = '⚠ Fiyat ilişkisi hatalı';

  // Kısmi ödeme hesabı sözleşme (komisyonlu) fiyat varsa onun üzerinden yapılır
  const kismiToplam = (sozFiyat > 0 ? sozFiyat : gercekFiyat) * gece;
  kismiKalanGuncelle(prefix, kismiToplam);
};

window.sozlesmeOnaysiziGonder = function(odaNo, revId) {
  // revId verilmişse direkt o rezervasyonu kullan, yoksa en yakın aktif/bekleyen rezervasyonu bul
  let rev;
  if(revId) {
    rev = window._R.find(r => r.id === revId);
  } else {
    const td = today();
    // Önce bugün aktif, sonra gelecekte bekleyen rezervasyonu bul
    rev = window._R.find(r =>
      Number(r.odaNo)===Number(odaNo) && rezervasyonOdayiBloklar(r) && r.cikis>td
    );
  }
  if(!rev) { toast('Rezervasyon bulunamadı','error'); return; }

  const oz = window._OZ?.['oda'+odaNo] || {};
  const odaAdi = oz.ad ? `Oda ${odaNo} — ${oz.ad}` : `Oda ${odaNo}`;
  const gece = geceSayisi(rev.giris, rev.cikis);
  const sozNo = `SW-${Date.now().toString().slice(-6)}`;
  const resNo = `RES-${Date.now().toString().slice(-5)}`;
  const gecelikFiyat = rev.sozlesmeFiyat || rev.fiyat || 0;
  const toplamFiyat  = gecelikFiyat * gece;

  const fmtTarih = (t) => {
    if(!t) return '—';
    const [y,m,d2] = t.split('-');
    return `${d2}.${m}.${y}`;
  };

  const odemeDurumMap = {odenmedi:'Ödenmedi', odendi:'Ödendi', depozito:'Depozito Alındı', kismi:'Kısmi Ödeme'};
  let odemeDurum = odemeDurumMap[rev.odemeDurum] || 'Ödenmedi';
  if(['kismi','depozito'].includes(rev.odemeDurum) && rev.kismiTutar != null) {
    const kalan = Math.max(0, toplamFiyat - Number(rev.kismiTutar));
    odemeDurum += ` (${Number(rev.kismiTutar).toLocaleString('tr-TR')} ₺ alındı, ${kalan.toLocaleString('tr-TR')} ₺ kalan)`;
  }

  // printSozlesme ile aynı şablonu kullan ama rev verisinden
  const fakeO = {
    misafir: rev.misafir, tc: rev.tc, tel: rev.tel, dt: rev.dt,
    giris: rev.giris, cikis: rev.cikis,
    fiyat: rev.fiyat, sozlesmeFiyat: rev.sozlesmeFiyat,
    kaynak: rev.kaynak, not: rev.not,
    odemeDurum: rev.odemeDurum, odemeTuru: rev.odemeTuru,
    refakatciler: rev.refakatciler || [],
  };
  window._O['_onay_oncesi_' + odaNo] = fakeO;
  printSozlesmeFromData(fakeO, odaAdi, gece, sozNo, resNo, gecelikFiyat, toplamFiyat, odemeDurum, fmtTarih);
};

window.printSozlesmeFromData = function(o, odaAdi, gece, sozNo, resNo, gecelikFiyat, toplamFiyat, odemeDurum, fmtTarih) {
  if(!fmtTarih) fmtTarih = (t) => { if(!t) return '—'; const [y,m,d2]=t.split('-'); return `${d2}.${m}.${y}`; };
  const w = window.open('', '_blank');
  if(!w) { toast('Popup engellendi, lütfen izin verin','error'); return; }
  w.document.write(sozlesmeHtmlOlustur(o, odaAdi, gece, sozNo, resNo, gecelikFiyat, toplamFiyat, odemeDurum, fmtTarih));
  w.document.close();
};

// ── REZERVASYON DÜZENLE ──
window.revDuzenleAc = function(rev) {
  document.getElementById('rd_id').value = rev.id;
  window._rdOrijinalOdaNo = rev.odaNo; // çakışma kontrolünde kendi rezervasyonunu hariç tutmak için referans

  // Misafir bilgileri. Eski sürümde aracirez kaydında komisyoncu adı yanlışlıkla
  // misafir alanına yazılmış olabiliyordu; böyle bir kaydı düzenlerken gerçek misafiri tekrar isteriz.
  const rdEskiAraciModeli = !!rev.aracirez && !!rev.araciAd && araciAnahtar(rev.araciAd)===araciAnahtar(rev.misafir||'') && !rev.komisyoncuAd;
  document.getElementById('rd_ad').value = (rev.misafirBilgisiBekleniyor||rdEskiAraciModeli) ? '' : (rev.misafir || '');
  document.getElementById('rd_tc').value = (rev.misafirBilgisiBekleniyor||rdEskiAraciModeli) ? '' : (rev.tc || '');
  document.getElementById('rd_tel').value = rev.tel || '';
  document.getElementById('rd_dt').value = rev.dt || '';

  // Oda seçimi
  const odaSel = document.getElementById('rd_oda');
  odaSel.innerHTML = HOTEL_ODALAR.map(no => `<option value="${no}"${Number(no)===Number(rev.odaNo)?' selected':''}>Oda ${no}</option>`).join('');

  // Konaklama
  document.getElementById('rd_giris').value = rev.giris || today();
  document.getElementById('rd_gece').value = rev.gece || geceSayisi(rev.giris, rev.cikis) || 1;
  document.getElementById('rd_cikis').value = rev.cikis || '';
  document.getElementById('rd_not').value = rev.not || '';
  document.getElementById('rd_odeme_durum').value = rev.odemeDurum || 'odenmedi';
  document.getElementById('rd_odeme_tip').value = rev.odemeTuru || 'nakit';
  document.getElementById('rd_kismi_wrap').style.display = (rev.odemeDurum === 'kismi' || rev.odemeDurum === 'depozito') ? 'block' : 'none';
  document.getElementById('rd_kismi_tutar').value = rev.kismiTutar ?? '';

  const sel = document.getElementById('rd_fiyat_tip');
  sel.innerHTML = '<option value="">— Fiyat tipi seçin —</option>' + [1,2,3,4].map(t=>`<option value="${t}"${t==rev.fiyatTip?' selected':''}>${getTipAd(t)} — ${getOdaFiyat(rev.odaNo,t).toLocaleString('tr-TR')} ₺</option>`).join('');
  document.getElementById('rd_fiyat').value = rev.fiyat || '';

  // Sözleşme fiyatı — sadece gerçek komisyon varsa göster (eşitse boş bırak)
  const sozEl = document.getElementById('rd_sozlesme_fiyat');
  sozEl.value = (rev.sozlesmeFiyat != null && rev.sozlesmeFiyat !== rev.fiyat) ? rev.sozlesmeFiyat : '';
  rezervasyonKomisyoncuSecenekleriniGuncelle('rd_komisyoncu', rev.komisyoncu||'', araciKanonikAd(rev.komisyoncuAd || (!rdEskiAraciModeli ? rev.araciAd : '') || '') || '');
  rdKomisyoncuDegisti();
  odemeDurumAlanGuncelle('rd');

  // Yanında kalanlar
  clearRefakatciler('rdRefakatciListesi');
  (rev.refakatciler || []).forEach(r => {
    refakatciEkle('rdRefakatciListesi');
    const liste = document.getElementById('rdRefakatciListesi');
    const son = liste.lastElementChild;
    if(son) {
      const adEl = son.querySelector('.ref-ad'); if(adEl) adEl.value = r.ad || '';
      const tcEl = son.querySelector('.ref-tc'); if(tcEl) tcEl.value = r.tc || '';
      const dtEl = son.querySelector('.ref-dt'); if(dtEl) dtEl.value = r.dt || '';
    }
  });

  rdGunGuncelle();
  rdFiyatGuncelle();

  openModal('revDuzenleModal');
};

window.rdOdaDegisti = function() {
  const odaNo = document.getElementById('rd_oda').value;
  if(window._O['oda'+odaNo]?.durum === 'arizali') {
    toast(`Oda ${odaNo} arızalı/bakımda — bu odaya rezervasyon taşınamaz.`, 'error');
    document.getElementById('rd_oda').value = window._rdOrijinalOdaNo;
    return;
  }
  const sel = document.getElementById('rd_fiyat_tip');
  const mevcutTip = sel.value || 1;
  sel.innerHTML = '<option value="">— Fiyat tipi seçin —</option>' + [1,2,3,4].map(t=>`<option value="${t}"${t==mevcutTip?' selected':''}>${getTipAd(t)} — ${getOdaFiyat(odaNo,t).toLocaleString('tr-TR')} ₺</option>`).join('');
  rdCarpısmaKontrol();
};

window.rdCarpısmaKontrol = function() {
  const odaNo = document.getElementById('rd_oda').value;
  const giris = document.getElementById('rd_giris').value;
  const cikis = document.getElementById('rd_cikis').value;
  const id = document.getElementById('rd_id').value;
  const carpısmaEl = document.getElementById('rd_carpısma');
  if(!odaNo || !giris || !cikis) { carpısmaEl.style.display = 'none'; return; }
  const kontrol = odaCakismaKontrol(odaNo, giris, cikis, id);
  if(kontrol.cakisma) {
    carpısmaEl.textContent = `⚠ Oda ${odaNo} bu tarihlerde dolu! (${kontrol.tip === 'rezervasyon' ? 'Rezervasyon' : 'Konaklama'}: ${kontrol.detay})`;
    carpısmaEl.style.display = 'block';
  } else {
    carpısmaEl.style.display = 'none';
  }
};

window.rdGunGuncelle = function() {
  const giris = document.getElementById('rd_giris').value;
  const gece  = parseInt(document.getElementById('rd_gece').value)||1;
  if(!giris) return;
  const cikis = addDays(giris, gece);
  document.getElementById('rd_cikis').value = cikis;
  const [y,m,d] = cikis.split('-');
  document.getElementById('rd_cikis_lbl').value = `${d}.${m}.${y} (${gece} gece)`;
  rdFiyatGuncelle();
  rdCarpısmaKontrol();
};

window.rdFiyatGuncelle = function() {
  const gece  = parseInt(document.getElementById('rd_gece').value)||1;
  const fiyat = Number(document.getElementById('rd_fiyat').value)||0;
  const sozFiyat = Number(document.getElementById('rd_sozlesme_fiyat')?.value) || 0;
  const gecelikGosterilen = sozFiyat > 0 ? sozFiyat : fiyat;
  const toplam = gecelikGosterilen*gece;
  document.getElementById('rd_fiyat_toplam').textContent =
    gecelikGosterilen > 0 ? `${gecelikGosterilen.toLocaleString('tr-TR')} ₺ × ${gece} gece = ${fmt(toplam)} (sözleşmede görünecek)` : '';

  // Komisyon canlı hesap
  const komBilgi = document.getElementById('rd_komisyon_bilgi');
  if(sozFiyat > 0 && sozFiyat > fiyat) {
    const komisyon = (sozFiyat - fiyat) * gece;
    komBilgi.innerHTML = `🤝 Komisyon: (${sozFiyat.toLocaleString('tr-TR')} − ${fiyat.toLocaleString('tr-TR')}) × ${gece} gece = <b>${fmt(komisyon)}</b>`;
    komBilgi.style.display = 'block';
  } else {
    komBilgi.style.display = 'none';
  }

  kismiKalanGuncelle('rd', toplam);
};

window.revDuzenleKaydet = async function() {
  const id     = document.getElementById('rd_id').value;
  const odaNo  = document.getElementById('rd_oda').value;
  const ad     = document.getElementById('rd_ad').value.trim();
  const tc     = document.getElementById('rd_tc').value.trim();
  const tel    = document.getElementById('rd_tel').value.trim();
  const dt     = document.getElementById('rd_dt').value;
  const giris  = document.getElementById('rd_giris').value;
  const cikis  = document.getElementById('rd_cikis').value;
  const gece   = parseInt(document.getElementById('rd_gece').value)||1;
  const fiyat  = Number(document.getElementById('rd_fiyat').value)||0;
  const fiyatTipHam = document.getElementById('rd_fiyat_tip').value;
  const fiyatTip = fiyatTipHam ? Number(fiyatTipHam) : 0;
  const sozlesmeFiyatVal = document.getElementById('rd_sozlesme_fiyat')?.value ? Number(document.getElementById('rd_sozlesme_fiyat').value) : null;
  const odemeDurum = document.getElementById('rd_odeme_durum').value;
  const odemeTuruHam = document.getElementById('rd_odeme_tip').value;
  const odemeTuru  = odemeDurum==='odenmedi' ? null : (odemeTuruHam||'nakit');
  const not_  = document.getElementById('rd_not').value;
  const refakatciler = getRefakatciler('rdRefakatciListesi');
  const komisyoncuSecim = document.getElementById('rd_komisyoncu')?.value || '';
  if(komisyoncuSecim === '__legacy__') { toast('Eski komisyoncu kimliğini doğrulayın veya Komisyoncu yok seçin','error'); return; }
  const komisyoncuKey = String(komisyoncuSecim||'');
  const komisyoncuAdi = komisyoncuKey ? (window.KOMISYONCULAR?.[komisyoncuKey]?.ad || '') : '';
  const rdFiyatKontrol = komisyonFiyatDogrula(fiyat, sozlesmeFiyatVal, komisyoncuAdi, komisyoncuKey);
  if(!rdFiyatKontrol.ok) { toast('⚠ '+rdFiyatKontrol.mesaj,'error'); return; }

  if(!odaNo) { toast('Oda seçimi zorunlu','error'); return; }
  if(!ad) { toast('Misafir adı zorunlu','error'); return; }
  if(!giris||!cikis) { toast('Tarih zorunlu','error'); return; }
  if(!fiyatTip) { toast('Fiyat tipi seçimi zorunlu','error'); return; }
  if(!fiyat || fiyat<=0) { toast('Otel net gecelik fiyat 0 olamaz','error'); return; }
  if(komisyoncuKey && (!sozlesmeFiyatVal || sozlesmeFiyatVal<=0)) { toast('Komisyoncu seçiliyse Sözleşme Fiyatı zorunludur','error'); return; }
  if(tc && /^\d{11}$/.test(tc) && !tcDogrula(tc)) { toast('TC Kimlik No geçersiz','error'); return; }
  if(window._O['oda'+odaNo]?.durum === 'arizali') { toast(`Oda ${odaNo} arızalı/bakımda — rezervasyon taşınamaz.`,'error'); return; }

  // ÇAKIŞMA KONTROLÜ — kendi kaydı hariç, SEÇİLEN (yeni) oda üzerinden
  const duzenlenenRev = window._R.find(r => r.id === id);
  const kontrol = odaCakismaKontrol(odaNo, giris, cikis, id);
  if(kontrol.cakisma) {
    toast(`⚠ Oda ${odaNo} bu tarihlerde dolu! (${kontrol.detay})`, 'error');
    return;
  }

  const kismiTutarVal = ['kismi','depozito'].includes(odemeDurum) ? (Number(document.getElementById('rd_kismi_tutar')?.value)||0) : null;
  const kismiToplamBaz = (sozlesmeFiyatVal||fiyat)*gece;
  if(kismiTutarVal != null && (kismiTutarVal <= 0 || kismiTutarVal > kismiToplamBaz)) {
    toast(`Alınan/depozito tutarı 0'dan büyük ve toplamdan (${fmt(kismiToplamBaz)}) fazla olmamalı`,'error'); return;
  }

  const rdKomSnapshot = komisyonSnapshotAl(komisyoncuKey, komisyoncuAdi, duzenlenenRev);
  await updateDoc(doc(db,'rezervasyonlar',id), {
    odaNo: Number(odaNo),
    misafir: ad, tc, tel, dt,
    giris, cikis, gece, fiyat, fiyatTip,
    fiyatTipAd: getTipAd(fiyatTip),
    sozlesmeFiyat: sozlesmeFiyatVal,
    araciAd: komisyoncuAdi || null,
    komisyoncu: komisyoncuKey || duzenlenenRev?.komisyoncu || null,
    komisyoncuAd: komisyoncuAdi || null,
    komisyonTipSnapshot: komisyoncuKey ? rdKomSnapshot.tip : 'manuel',
    komisyonDegerSnapshot: komisyoncuKey ? rdKomSnapshot.deger : 0,
    komisyonSnapshotKaynak: komisyoncuKey ? rdKomSnapshot.kaynak : 'yok',
    refakatciler,
    odemeDurum, odemeTuru, not:not_,
    kismiTutar: kismiTutarVal,
    kismiKalan: kismiTutarVal!=null ? Math.max(0, kismiToplamBaz - kismiTutarVal) : null,
    guncelleme: nowISO()
  });

  // Check-in yapılmış rezervasyon başka odaya/tarihe/fiyata taşındığında bağlı
  // gelir ve komisyon kayıtlarını da yeni konuma taşı.
  try {
    const bagliSnap = await getDocs(query(collection(db,'gelirler'), where('rezervasyonId','==',id)));
    for(const gd of bagliSnap.docs) {
      const gelir = gd.data();
      if(gelir.kaynak === 'no-show') continue;
      const yeniTutar = Math.round(fiyat * gece * 100) / 100;
      const komAdFinal = komisyoncuAdi || '';
      const komKeyFinal = komAdFinal ? (komisyoncuKey || duzenlenenRev?.komisyon || '') : '';
      const yeniKomHesap = komisyonToplamHesapla({
        otelFiyat:fiyat, sozlesmeFiyat:sozlesmeFiyatVal, gece,
        araciAd:komAdFinal, komisyoncuKey:komKeyFinal
      });
      await updateDoc(gd.ref, {
        odaNo:String(odaNo), giris, cikis, tarih:giris, gece, fiyat,
        tutar:yeniTutar, sozlesmeFiyat:sozlesmeFiyatVal,
        komisyonFark:yeniKomHesap.toplam || null,
        araciAd:komAdFinal || null,
        komisyoncu:komKeyFinal || null,
        guncelleme:nowISO()
      });
      const komRef = doc(db,'komisyonlar','komisyon_' + gd.id);
      const komSnap = await getDoc(komRef);
      const kom = komSnap.exists() ? komSnap.data() : {};
      const eskiToplam = Number(kom.toplamKomisyon)||Number(kom.komisyonFark)||0;
      const yeniKomisyon = yeniKomHesap.toplam;
      if(komSnap.exists() || yeniKomisyon > 0) {
        const fark = Math.round((yeniKomisyon-eskiToplam)*100)/100;
        const hareketler = Array.isArray(kom.komisyonHareketleri) && kom.komisyonHareketleri.length
          ? [...kom.komisyonHareketleri]
          : (eskiToplam>0 ? [{tarih:kom.kayitTarih||kom.tarih||nowISO(),tutar:eskiToplam,tip:'hakedis',aciklama:`İlk hakediş · Oda ${kom.odaNo||odaNo}`}]:[]);
        if(Math.abs(fark)>0.009) hareketler.push({
          tarih:nowISO(), tutar:fark, tip:fark<0?'mahsup':'ek_hakedis',
          aciklama:`Rezervasyon fiyat/süre güncellemesi · ${Number(kom.gece)||Number(gelir.gece)||'?'}→${gece} gece`
        });
        await setDoc(komRef, {
          gelirDocId:gd.id, rezervasyonId:id,
          odaNo:String(odaNo), tarih:giris, gece,
          gercekFiyat:fiyat, sozlesmeFiyat:sozlesmeFiyatVal,
          gecelikKomisyon:yeniKomHesap.gecelik, komisyonKaynak:yeniKomHesap.kaynak,
          toplamKomisyon:yeniKomisyon, komisyonFark:yeniKomisyon,
          araciAd:komAdFinal||null, komisyoncu:komKeyFinal||null, komisyoncuAd:komAdFinal||null,
          oncekiToplamKomisyon:eskiToplam, sonKomisyonDuzeltme:fark,
          sonDuzeltmeTarih:Math.abs(fark)>0.009?nowISO():(kom.sonDuzeltmeTarih||null),
          komisyonHareketleri:hareketler,
          guncelleme:nowISO()
        }, {merge:true});
      }
    }
  } catch(e) {
    console.warn('Bağlı gelir/komisyon senkronizasyonu:', e);
    toast('Rezervasyon güncellendi; bağlı mali kayıt kontrolü gerekli: '+e.message,'error');
  }

  // Eğer bu rezervasyon komisyoncu kaynağından geldiyse, değişikliği talep kaydına not olarak ekle
  try {
    const kaynakTalepId = duzenlenenRev?.kaynakTalepId;
    let eslesen = null;

    if(kaynakTalepId) {
      // Direkt ID ile bul — en güvenilir yöntem
      const talepSnap = await getDocs(
        query(collection(db,'rezervasyon_talepleri'), where('__name__','==', kaynakTalepId))
      );
      if(!talepSnap.empty) eslesen = talepSnap.docs[0];
    } else {
      // Eski rezervasyonlar için fallback: misafir adı + kaynak ile eşleştir
      const kaynakTalepSorgu = await getDocs(
        query(collection(db,'rezervasyon_talepleri'),
          where('durum','==','onaylandi'),
          where('kaynak','==','komisyoncu')
        )
      );
      eslesen = kaynakTalepSorgu.docs.find(d => {
        const t = d.data();
        return t.misafir === (duzenlenenRev?.misafir||ad) &&
               Number(t.odaNo) === Number(duzenlenenRev?.odaNo||odaNo);
      }) || null;
    }

    if(eslesen) {
      const eskiNot = eslesen.data().not || '';
      const degisimZamani = new Date().toLocaleString('tr-TR');
      const odaDegisti = duzenlenenRev && Number(duzenlenenRev.odaNo) !== Number(odaNo);
      const degisimOzeti = [
        `[Resepsiyon düzenlemesi — ${degisimZamani}]`,
        odaDegisti ? `Oda: ${duzenlenenRev.odaNo} → ${odaNo}` : null,
        duzenlenenRev?.giris !== giris ? `Giriş: ${duzenlenenRev.giris} → ${giris}` : null,
        duzenlenenRev?.cikis !== cikis ? `Çıkış: ${duzenlenenRev.cikis} → ${cikis}` : null,
        duzenlenenRev?.fiyat !== fiyat ? `Fiyat: ${fmt(duzenlenenRev.fiyat)} → ${fmt(fiyat)} ₺` : null,
      ].filter(Boolean).join(' | ');
      await updateDoc(doc(db,'rezervasyon_talepleri', eslesen.id), {
        not: eskiNot ? eskiNot + '\n' + degisimOzeti : degisimOzeti,
        sonDegisim: nowISO()
      });
    }
  } catch(e) { /* Talep bulunamazsa sessizce geç */ }

  closeModal('revDuzenleModal');
  const odaDegisti = duzenlenenRev && Number(duzenlenenRev.odaNo) !== Number(odaNo);
  toast(odaDegisti ? `Rezervasyon güncellendi — Oda ${duzenlenenRev.odaNo} → Oda ${odaNo} ✓` : 'Rezervasyon güncellendi ✓', 'success');
  await logAktivite('rezervasyon_duzenle', `Oda ${odaNo} · ${giris}→${cikis} · ${gece} gece · ${fmt(fiyat)} ₺${odaDegisti?' (oda değiştirildi: '+duzenlenenRev.odaNo+'→'+odaNo+')':''}`, String(odaNo));
};

// ── SÜRE DEĞİŞTİR ──
window.sureDegistirAc = function(odaNo) {
  const o = window._O['oda'+odaNo];
  if(!o||o.durum!=='dolu') { toast('Oda dolu değil','error'); return; }
  document.getElementById('sure_oda_no').value = odaNo;
  document.getElementById('sure_baslik').textContent = `Oda ${odaNo} — Konaklama Süresini Değiştir`;
  const [y,m,d] = (o.cikis||'').split('-');
  document.getElementById('sure_mevcut_cikis').textContent = o.cikis ? `${d}.${m}.${y}` : '—';
  document.getElementById('sure_yeni_cikis').value = o.cikis || '';
  document.getElementById('sure_yeni_cikis').min = addDays(o.giris||today(), 1);
  sureHesapla();
  openModal('sureDegistirModal');
};

window.sureHesapla = function() {
  const odaNo = document.getElementById('sure_oda_no').value;
  const o = window._O['oda'+odaNo];
  const yeniCikis = document.getElementById('sure_yeni_cikis').value;
  if(!yeniCikis||!o?.giris) return;
  const gece = geceSayisi(o.giris, yeniCikis);
  const eskiGece = geceSayisi(o.giris, o.cikis);
  const fark = gece - eskiGece;
  const eskiFm = konaklamaFiyatModeli(o, eskiGece);
  const yeniFm = konaklamaFiyatModeli(o, gece);
  const oncekiTahsil = misafirTahsilEdilenBul(o, eskiFm);
  const yeniKalan = Math.max(0, Math.round((yeniFm.misafirToplam - oncekiTahsil)*100)/100);
  const iadeBekleyen = Math.max(0, Math.round((oncekiTahsil - yeniFm.misafirToplam)*100)/100);

  document.getElementById('sure_gece_lbl').textContent = gece + ' gece';
  const farkEl = document.getElementById('sure_fark_lbl');
  const mali = document.getElementById('sure_mali_ozet');
  if(fark > 0) {
    farkEl.textContent = `+${fark} gece uzatılıyor · misafir hesabına +${fmt(fark*yeniFm.misafirGecelik)}`;
  } else if(fark < 0) {
    farkEl.textContent = `${Math.abs(fark)} gece kısaltılıyor · müşteri fiyatından ${fmt(Math.abs(fark)*yeniFm.misafirGecelik)} hesap düşümü`;
  } else {
    farkEl.textContent = 'Değişiklik yok';
  }

  if(mali) {
    if(fark === 0) { mali.style.display='none'; mali.innerHTML=''; }
    else {
      mali.style.display='block';
      const misafirFark = Math.round(Math.abs(fark) * yeniFm.misafirGecelik * 100)/100;
      const otelFark = Math.round(Math.abs(fark) * yeniFm.otelGecelik * 100)/100;
      const komFark = Math.round(Math.abs(fark) * yeniFm.komisyonGecelik * 100)/100;
      mali.innerHTML = `
        <div style="font-weight:700;color:var(--dark);margin-bottom:6px">Fiyat Korelasyonu</div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Misafir (${fmt(yeniFm.misafirGecelik)}/gece)</span><strong>${fark>0?'+':'−'}${fmt(misafirFark)}</strong></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Otel net (${fmt(yeniFm.otelGecelik)}/gece)</span><strong>${fark>0?'+':'−'}${fmt(otelFark)}</strong></div>
        ${komFark>0.009?`<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Komisyon (${fmt(yeniFm.komisyonGecelik)}/gece)</span><strong style="color:${fark>0?'var(--gold2)':'var(--red)'}">${fark>0?'+':'−'}${fmt(komFark)}</strong></div>`:''}
        <div style="padding-top:6px;margin-top:6px;border-top:1px solid var(--border);display:flex;justify-content:space-between"><span>${iadeBekleyen>0.009?'Müşteriye iade bekleyen':(yeniKalan>0.009?'Yeni kalan borç':'Hesap durumu')}</span><strong style="color:${iadeBekleyen>0.009?'var(--gold2)':(yeniKalan>0.009?'var(--red)':'var(--green)')}">${iadeBekleyen>0.009?fmt(iadeBekleyen):(yeniKalan>0.009?fmt(yeniKalan):'Ödeme tamam')}</strong></div>`;
    }
  }
};

window.sureDegistirKaydet = async function() {
  const odaNo = document.getElementById('sure_oda_no').value;
  const yeniCikis = document.getElementById('sure_yeni_cikis').value;
  const o = window._O['oda'+odaNo];
  if(!yeniCikis||!o) return;

  const eskiCikis = o.cikis;
  const eskiGece = geceSayisi(o.giris, eskiCikis);
  const yeniGece = geceSayisi(o.giris, yeniCikis);
  const eskiFm = konaklamaFiyatModeli(o, eskiGece);
  const yeniFm = konaklamaFiyatModeli(o, yeniGece);
  const oncekiTahsil = misafirTahsilEdilenBul(o, eskiFm);
  const yeniKalan = Math.max(0, Math.round((yeniFm.misafirToplam-oncekiTahsil)*100)/100);
  const iadeBekleyen = Math.max(0, Math.round((oncekiTahsil-yeniFm.misafirToplam)*100)/100);

  // Mevcut konaklamanın rezervasyon kaydını bul (kontrol dışı tutulacak)
  const rev = o.rezervasyonId
    ? window._R.find(r => r.id === o.rezervasyonId)
    : window._R.find(r => Number(r.odaNo)===Number(odaNo) && r.giris===o.giris && rezervasyonOdayiBloklar(r));

  // ÇAKIŞMA KONTROLÜ — uzatma sonraki rezervasyona çarpmasın
  const carpisanRev = (window._R||[]).find(r =>
    Number(r.odaNo) === Number(odaNo) &&
    rezervasyonOdayiBloklar(r) &&
    r.id !== rev?.id &&
    (r.giris||'') < yeniCikis && (r.cikis||'') > o.giris
  );
  if(carpisanRev) {
    toast(`⚠ Uzatma yapılamaz! ${carpisanRev.giris} tarihinde rezervasyon var (${carpisanRev.misafir||'?'})`, 'error');
    return;
  }

  // Oda kaydı: süre ile birlikte misafir hesabı, kalan borç ve olası iade de aynı
  // anda güncellenir. Böylece süre ekranı ile checkout ekranı farklı rakam üretmez.
  const yeniOdemeDurum = yeniKalan > 0.009 ? (oncekiTahsil>0?'kismi':'odenmedi') : 'odendi';
  const yeniOda = {
    ...o,
    cikis:yeniCikis,
    orijinalCikis:o.orijinalCikis || eskiCikis,
    odemeToplam:yeniFm.misafirToplam,
    tahsilEdilen:oncekiTahsil,
    kalanTutar:yeniKalan,
    kismiKalan:yeniKalan,
    odemeDurum:yeniOdemeDurum,
    iadeBekleyen,
    guncelleme:nowISO()
  };
  window._O['oda'+odaNo] = yeniOda;
  await odaMetaKaydet(odaNo, yeniOda);

  if(rev?.id) {
    await updateDoc(doc(db,'rezervasyonlar',rev.id), {
      cikis: yeniCikis, gece: yeniGece,
      odemeToplam:yeniFm.misafirToplam, kalanTahsilat:yeniKalan, iadeBekleyen,
      guncelleme: nowISO()
    });
    if(rev.kaynakTalepId) {
      try {
        await updateDoc(doc(db,'rezervasyon_talepleri',rev.kaynakTalepId), {
          durum:'aktif', cikis:yeniCikis, gece:yeniGece,
          odemeToplam:yeniFm.misafirToplam, otelNetToplam:yeniFm.otelNetToplam,
          komisyonToplam:yeniFm.komisyonToplam, iadeBekleyen,
          degisiklikNot:`Konaklama süresi resepsiyon tarafından ${eskiCikis} → ${yeniCikis} olarak değiştirildi`,
          degisiklikTarih:nowISO()
        });
      } catch(e) { console.warn('Komisyoncu talebi süre değişimiyle senkronize edilemedi:',e); }
    }
  }

  if(o.gelirDocId) {
    try {
      await updateDoc(doc(db,'gelirler', o.gelirDocId), {
        cikis: yeniCikis, gece: yeniGece,
        tutar: yeniFm.otelNetToplam,
        odemeToplam: yeniFm.misafirToplam,
        tahsilEdilen: oncekiTahsil,
        kalanTahsilat: yeniKalan,
        iadeBekleyen,
        sozlesmeFiyat:yeniFm.misafirGecelik,
        fiyat:yeniFm.otelGecelik,
        guncelleme: nowISO()
      });
    } catch(e) { console.warn('Gelir kaydı güncellenemedi:', e); }
  }

  // Süre kısalırsa komisyoncunun hakedişi de aynı gece farkı kadar düşer;
  // uzarsa eklenir. 2.300 net / 2.700 sözleşme örneğinde 400 ₺/gece fark burada
  // komisyoncu cari hesabına yansır.
  const komSonuc = await komisyonSureGuncelle(o.gelirDocId, yeniGece);

  closeModal('sureDegistirModal');
  let mesaj = `Oda ${odaNo} — Çıkış tarihi ${yeniCikis} olarak güncellendi ✓`;
  if(yeniKalan>0.009) mesaj += ` · Yeni kalan: ${fmt(yeniKalan)}`;
  if(iadeBekleyen>0.009) mesaj += ` · Müşteriye iade bekleyen: ${fmt(iadeBekleyen)}`;
  if(komSonuc) {
    mesaj += komSonuc.silindi
      ? ` · Komisyon hakedişi kaldırıldı (${fmt(komSonuc.eski)} → 0)`
      : ` · Komisyon güncellendi: ${fmt(komSonuc.eski)} → ${fmt(komSonuc.yeni)}`;
  }
  toast(mesaj, 'success');
  await logAktivite('sure_degisim', `${eskiCikis} → ${yeniCikis} · Misafir ${fmt(eskiFm.misafirToplam)}→${fmt(yeniFm.misafirToplam)} · Otel net ${fmt(eskiFm.otelNetToplam)}→${fmt(yeniFm.otelNetToplam)}${komSonuc?' · Komisyon: '+komSonuc.eski+'→'+komSonuc.yeni:''}`, odaNo);
};

// ── OTOMATİK ODA DURUM GEÇİŞLERİ ──
// 11:00 → vadesi gelen gerçek check-in otomatik checkout.
// Check-in yapılmamış rezervasyon otomatik no-show olmaz ve odayı kilitlemez; resepsiyon kararı bekler.
// 14:00 → manuel veya otomatik checkout ile oluşmuş temizlik kaydı "boş" durumuna geçer.
async function otomatikDurumGecisleri() {
  await otomatikBosal();
  if(!window._O || !Object.keys(window._O).length) return;
  const simdi = new Date();
  const saat = simdi.getHours();
  const todayStr = today();

  if(saat < 14) { renderOdalar(); renderHatirlatma(); return; }

  for(const no of HOTEL_ODALAR) {
    const oda = window._O['oda'+no];
    if(!oda || oda.durum !== 'temizlik') continue;

    // Yalnız gerçek bir checkout (manuel veya otomatik vade) ile oluşmuş temizlik kaydı boşalabilir.
    // Elle "temizlik" verilen kayıtlar personel müdahalesi olmadan değiştirilmez.
    if(!oda.manuelCheckout && !oda.otomatikCheckout) continue;
    const temizlikGun = String(oda.temizlikBaslangic || oda.sonCheckoutTarih || '').slice(0,10);
    if(temizlikGun && temizlikGun > todayStr) continue;
    if(oda._otoBos === todayStr) continue;

    const bugunGiris = (window._R||[]).some(r =>
      Number(r.odaNo) === Number(no) && r.giris === todayStr && rezervasyonOdayiBloklar(r)
    );
    const bosKayit = bosOdaKaydi('bos', {_otoBos:todayStr, sonCheckoutTarih:oda.sonCheckoutTarih||todayStr});
    await odaMetaKaydet(no, bosKayit);
    await logAktivite('oto_bos', `Oda ${no} check-out sonrası 14:00 kontrolünde boşaltıldı${bugunGiris?' · bugün giriş bekleniyor':''}`, no);
    toast(bugunGiris ? `Oda ${no} — temizlik süresi bitti, check-in bekleniyor` : `Oda ${no} temizlik sonrası boş duruma geçti`, 'info');
  }
  renderOdalar();
  renderHatirlatma();
}

// Sayfa açıldığında ve her 5 dakikada bir kontrol et
setTimeout(otomatikDurumGecisleri, 8000);
setInterval(otomatikDurumGecisleri, 5 * 60 * 1000);

window.hatirlatmaDurum = async function(id, durum) {
  await updateDoc(doc(db,'rezervasyonlar',id), {aramaDurumu: durum, aramaZamani: nowISO()});
  await logAktivite('hatirlatma', `Rezervasyon arama durumu: ${durum}`, '');
};

window.cikisAramaDurum = async function(odaNo, durum) {
  if(!window._O['oda'+odaNo]) return;
  window._O['oda'+odaNo].cikisArama = durum;
  await odaMetaKaydet(odaNo, window._O['oda'+odaNo]);
  renderHatirlatma();
  toast(`Oda ${odaNo} çıkış arama durumu: ${durum}`, 'success');
};

// "Yarın çıkış · ödeme bekleniyor" kartındaki "Hatırlatıldı" butonu — misafire
// önceden hatırlatıldıktan sonra kartın bugünkü listeden düşmesi için. Not: bu sadece
// erken hatırlatma kartını gizler; borç gerçekten tahsil edilmeden çıkış günündeki
// asıl borç rozeti (💰 ... ÖDENMEDİ) görünmeye devam eder.
window.borcAramaDurum = async function(odaNo, durum) {
  if(!window._O['oda'+odaNo]) return;
  window._O['oda'+odaNo].borcArama = durum;
  await odaMetaKaydet(odaNo, window._O['oda'+odaNo]);
  renderHatirlatma();
  toast(`Oda ${odaNo} ödeme hatırlatması: ${durum}`, 'success');
};

// ── MÜŞTERİ KARTI ──
window.musteriKartiAc = async function(tc) {
  if(!tc) { toast('TC bilgisi yok','error'); return; }
  try {
    const mq = query(collection(db,'musteriler'), where('tc','==',tc));
    const msnap = await getDocs(mq);
    if(msnap.empty) { toast('Müşteri kaydı bulunamadı','error'); return; }
    const m = msnap.docs[0].data();

    document.getElementById('mk_baslik').textContent = `Müşteri Kartı — ${m.ad||'—'}`;
    document.getElementById('mk_ad').textContent = m.ad || '—';
    document.getElementById('mk_tc').textContent = `TC: ${m.tc||'—'}`;
    document.getElementById('mk_tel').textContent = m.tel ? `📞 ${m.tel}` : '';
    document.getElementById('mk_email').textContent = m.email ? `✉ ${m.email}` : '';
    document.getElementById('mk_sayi').textContent = m.konaklamaSayisi || '0';
    document.getElementById('mk_toplam').textContent = fmt(m.toplamHarcama||0);
    document.getElementById('mk_ilk').textContent = m.ilkKonaklama || m.ilkKayit?.slice(0,10) || '—';
    document.getElementById('mk_son').textContent = m.sonKonaklama || '—';

    // Geçmiş konaklamalar
    const gq = query(collection(db,'gelirler'), where('tc','==',tc), orderBy('tarih','desc'));
    const gsnap = await getDocs(gq);
    const gecmis = gelirleriTekillestir(gsnap.docs.map(d=>({id:d.id,...d.data()})));
    document.getElementById('mk_gecmis').innerHTML = gecmis.length
      ? gecmis.map(g=>`<tr>
          <td>${g.tarih||'—'}</td>
          <td>${g.odaNo?'Oda '+g.odaNo:'—'}</td>
          <td>${g.gece||'—'}</td>
          <td><span class="badge badge-blue">${g.odemeTuru||'—'}</span></td>
          <td class="amount-pos">${fmt(g.tutar)}</td>
        </tr>`).join('')
      : '<tr class="empty-row"><td colspan="5">Konaklama kaydı yok</td></tr>';

    openModal('musteriKartiModal');
  } catch(e) { toast('Hata: '+e.message,'error'); }
};

// Başlat
await loadFiyatlar();
await loadKomisyoncular();
await loadKomisyonAyarlar();
await loadOdaOzel();
await initOdalar();
gunlukKontrolKur();
geriyeDonukCheckoutKur();
