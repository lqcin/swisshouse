
// Service Worker kaydı — komisyoncu portalı artık kendi PWA kısayoluna sahip
// ve düzeltilmiş sw.js'yi kendisi kaydediyor (önceden hiç kaydetmiyordu; başka bir
// sayfadan tesadüfen kaydedilmiş bir SW varsa onun kapsamına bağımlıydı).
if('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/swisshouse/sw.js').catch(()=>{});
}
