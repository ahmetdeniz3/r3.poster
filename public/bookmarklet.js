/**
 * Kim Repostladı? - 1-Click Browser Bookmarklet Extractor
 * Run this snippet in your browser console (F12) while on TikTok or Instagram
 * to immediately send visible videos into your active game room!
 */
(function () {
  const defaultUser = (window.location.pathname.match(/@([a-zA-Z0-9._-]+)/) || [])[1] || '';
  const suspectName = prompt('🎮 KIM REPOSTLADI?\nBu repostlar HANGİ ARKADAŞINA ait? (@kullanici_adi):', defaultUser)?.trim().replace(/^@/, '');
  if (!suspectName) return;

  // Extract video URLs from TikTok or Instagram DOM
  const anchors = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/reel/"]'));
  const links = Array.from(new Set(anchors.map(a => a.href))).filter(u => u && (u.includes('tiktok.com') || u.includes('instagram.com')));

  if (links.length === 0) {
    alert('❌ Sayfada video bulunamadı! Arkadaşının TikTok "Repostlar" sekmesinde veya profilinde olduğundan emin ol.');
    return;
  }

  const selected = links.slice(0, 15);
  const serverUrl = window.__KIM_REPOSTLADI_SERVER__ || 'http://localhost:3000';

  console.log(`[Kim Repostladı] ${selected.length} video aktarılıyor:`, selected);

  // Form submission seamlessly bypasses CSP (Content Security Policy) on TikTok & Firefox
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${serverUrl}/api/import-form`;
  form.target = '_blank';

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'payload';
  input.value = JSON.stringify({
    username: suspectName,
    platform: window.location.hostname.includes('instagram') ? 'instagram' : 'tiktok',
    items: selected.map(url => ({ url }))
  });

  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  setTimeout(() => form.remove(), 1000);
})();
