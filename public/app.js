/* ============================================================
   KİM REPOSTLADI? - CLIENT APPLICATION JAVASCRIPT
   Socket.IO + Dynamic Media Resolver + Real-time Multiplayer
   ============================================================ */

const socket = io();

// State
let myPlayerId = '';
let myPlayerName = '';
let myAvatarUrl = '';
let isHost = false;
let currentRoomCode = '';
let currentSuspectPlatform = 'tiktok';
let soundMuted = true; // Start muted to comply with browser autoplay policies
let hasVotedCurrentRound = false;
let isCurrentRoundOwnRepost = false;
let roundTimerInterval = null;
let serverInfo = null;

// UI Elements
const screens = {
  home: document.getElementById('screen-home'),
  lobby: document.getElementById('screen-lobby'),
  gameplay: document.getElementById('screen-gameplay'),
  reveal: document.getElementById('screen-reveal'),
  podium: document.getElementById('screen-podium')
};

// ==================== SCREEN SWITCHING ====================
function showScreen(screenKey) {
  Object.values(screens).forEach(s => {
    if (s) s.classList.remove('active');
  });
  if (screens[screenKey]) {
    screens[screenKey].classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ==================== AVATAR GENERATOR ====================
function generateRandomAvatarSeed() {
  const seeds = ['Nova', 'Apex', 'Viper', 'Cyber', 'Echo', 'Neon', 'Pixel', 'Sonic', 'Astro', 'Blaze', 'Cosmo', 'Titan'];
  const rand = seeds[Math.floor(Math.random() * seeds.length)] + Math.floor(Math.random() * 999);
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${rand}`;
}

// ==================== INITIALIZATION ====================
window.addEventListener('DOMContentLoaded', async () => {
  // 1. Initial Avatar Setup
  myAvatarUrl = generateRandomAvatarSeed();
  const avatarPreview = document.getElementById('my-avatar-preview');
  if (avatarPreview) avatarPreview.src = myAvatarUrl;

  document.getElementById('btn-random-avatar')?.addEventListener('click', () => {
    myAvatarUrl = generateRandomAvatarSeed();
    if (avatarPreview) avatarPreview.src = myAvatarUrl;
  });

  // 2. Fetch Server Info for QR & Wi-Fi
  try {
    const res = await fetch('/api/server-info');
    if (res.ok) {
      serverInfo = await res.json();
    }
  } catch (e) {
    console.warn('Could not fetch server-info:', e);
  }

  // 3. Check URL query for ?room=ABCD
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    const joinInput = document.getElementById('join-code-input');
    if (joinInput) joinInput.value = roomParam.toUpperCase();
    switchTab('tab-join');
  }

  setupEventListeners();
});

// ==================== TAB SWITCHING ====================
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === tabId);
  });
}

// ==================== EVENT LISTENERS ====================
function setupEventListeners() {
  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  // Create Room
  document.getElementById('btn-create-room')?.addEventListener('click', () => {
    const nameInput = document.getElementById('player-name-input');
    const name = (nameInput?.value || '').trim() || 'Host';
    myPlayerName = name;
    socket.emit('create_room', {
      playerName: name,
      avatar: myAvatarUrl
    });
  });

  // Join Room
  document.getElementById('btn-join-room')?.addEventListener('click', () => {
    const nameInput = document.getElementById('player-name-input');
    const codeInput = document.getElementById('join-code-input');
    const name = (nameInput?.value || '').trim() || 'Misafir';
    const code = (codeInput?.value || '').trim().toUpperCase();

    if (!code) {
      showToast('⚠️ Lütfen 4 haneli oda kodunu girin!');
      return;
    }
    myPlayerName = name;
    socket.emit('join_room', {
      roomCode: code,
      playerName: name,
      avatar: myAvatarUrl
    });
  });

  // Copy Room Code
  document.getElementById('btn-copy-code')?.addEventListener('click', () => {
    copyToClipboard(currentRoomCode, 'Oda Kodu kopyalandı! 📋');
  });
  document.getElementById('lobby-room-code')?.addEventListener('click', () => {
    copyToClipboard(currentRoomCode, 'Oda Kodu kopyalandı! 📋');
  });

  // Platform Toggle for Suspects
  document.querySelectorAll('.plat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.plat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSuspectPlatform = btn.getAttribute('data-platform');
      const input = document.getElementById('suspect-username-input');
      const igInput = document.getElementById('suspect-ig-username-input');
      if (input) {
        if (currentSuspectPlatform === 'tiktok') {
          input.placeholder = '@tiktok_kullanici veya profil linki';
        } else if (currentSuspectPlatform === 'instagram') {
          input.placeholder = '@instagram_kullanici veya profil linki';
        } else {
          input.placeholder = '🎵 TikTok @kullanici_adi';
        }
      }
      if (igInput) {
        igInput.style.display = currentSuspectPlatform === 'both' ? 'block' : 'none';
      }

      // Keep auth banners hidden since fixed session IDs are active
      const ttBanner = document.getElementById('tiktok-auth-banner');
      const igBanner = document.getElementById('instagram-auth-banner');
      if (ttBanner) ttBanner.style.display = 'none';
      if (igBanner) igBanner.style.display = 'none';
    });
  });

  // Add Suspect (Fetch from TikTok/IG)
  document.getElementById('btn-fetch-suspect')?.addEventListener('click', handleAddSuspect);
  document.getElementById('suspect-username-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddSuspect();
  });

  // Resolve and Add Repost URLs
  document.getElementById('btn-resolve-and-add')?.addEventListener('click', handleResolveReposts);

  // Load Demo Pack
  document.getElementById('btn-load-demo-pack')?.addEventListener('click', () => {
    if (!currentRoomCode) return;
    const btn = document.getElementById('btn-load-demo-pack');
    if (btn) btn.innerHTML = '<span>⏳ Yükleniyor...</span>';
    socket.emit('load_demo_pack', { roomCode: currentRoomCode });
    setTimeout(() => {
      if (btn) btn.innerHTML = '<span>⚡ Örnek Repost Paketi Yükle</span>';
    }, 2000);
  });

  // Host Settings Change
  document.getElementById('setting-round-time')?.addEventListener('change', handleSettingsChange);
  document.getElementById('setting-max-rounds')?.addEventListener('change', handleSettingsChange);

  // Host Start Game
  document.getElementById('btn-start-game')?.addEventListener('click', () => {
    if (!currentRoomCode) return;
    socket.emit('start_game', { roomCode: currentRoomCode });
  });

  // Host Next Round
  document.getElementById('btn-next-round')?.addEventListener('click', () => {
    if (!currentRoomCode) return;
    socket.emit('next_round', { roomCode: currentRoomCode });
  });

  // Play Again (Return to Lobby)
  document.getElementById('btn-play-again')?.addEventListener('click', () => {
    if (!currentRoomCode) {
      showScreen('lobby');
      return;
    }
    socket.emit('reset_to_lobby', { roomCode: currentRoomCode });
    showScreen('lobby');
  });

  // Toggle caption expand/collapse on click
  document.getElementById('overlay-video-caption')?.addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('expanded');
  });

  // Sound Toggle on Video
  document.getElementById('btn-toggle-sound')?.addEventListener('click', toggleVideoSound);

  // Share Modal
  document.getElementById('btn-open-share-modal')?.addEventListener('click', openShareModal);
  document.getElementById('btn-close-share-modal')?.addEventListener('click', () => {
    document.getElementById('modal-share')?.classList.remove('active');
  });

  // Bookmarklet Modal
  document.getElementById('btn-open-bookmarklet-modal')?.addEventListener('click', openBookmarkletModal);
  document.getElementById('btn-close-bm-modal')?.addEventListener('click', () => {
    document.getElementById('modal-bookmarklet')?.classList.remove('active');
  });
  document.getElementById('btn-copy-bm-code')?.addEventListener('click', () => {
    const area = document.getElementById('bookmarklet-code-area');
    if (area) copyToClipboard(area.value, 'Sihirli Toplayıcı kodu kopyalandı! ✨');
  });

  // Copy Share Link
  document.getElementById('btn-copy-share-url')?.addEventListener('click', () => {
    const input = document.getElementById('share-url-input');
    if (input) copyToClipboard(input.value, 'Davet linki kopyalandı! 🔗');
  });

  // TikTok Auth Connect
  document.getElementById('btn-tiktok-login')?.addEventListener('click', handleTikTokLogin);
  document.getElementById('btn-toggle-manual-cookie')?.addEventListener('click', () => {
    const box = document.getElementById('manual-cookie-box');
    if (box) box.style.display = box.style.display === 'none' ? 'flex' : 'none';
  });
  document.getElementById('btn-save-manual-cookie')?.addEventListener('click', handleManualCookieSave);

  // Instagram Auth Connect
  document.getElementById('btn-instagram-login')?.addEventListener('click', handleInstagramLogin);
  document.getElementById('btn-toggle-manual-ig-cookie')?.addEventListener('click', () => {
    const box = document.getElementById('manual-ig-cookie-box');
    if (box) box.style.display = box.style.display === 'none' ? 'flex' : 'none';
  });
  document.getElementById('btn-save-manual-ig-cookie')?.addEventListener('click', handleManualIgCookieSave);

  // Check TikTok & Instagram auth status on load
  checkTikTokAuthStatus();
  checkInstagramAuthStatus();
}

// ==================== TIKTOK AUTHENTICATION ====================
async function checkTikTokAuthStatus() {
  try {
    const res = await fetch('/api/tiktok-auth-status');
    const data = await res.json();
    const banner = document.getElementById('tiktok-auth-banner');
    const icon = document.getElementById('auth-banner-icon');
    const title = document.getElementById('auth-banner-title');
    const desc = document.getElementById('auth-banner-desc');
    const btnText = document.getElementById('btn-tiktok-login-text');

    if (data.loggedIn) {
      if (banner) {
        banner.className = 'tiktok-auth-banner connected';
      }
      if (icon) icon.textContent = '✅';
      if (title) title.textContent = 'TikTok Bağlandı!';
      if (desc) desc.textContent = 'Yazdığın her hesabın son 10 REPOSTU otomatik çekilecek. Hazırsın!';
      if (btnText) btnText.textContent = '🔄 Hesabı Değiştir';
    } else {
      if (banner) {
        banner.className = 'tiktok-auth-banner disconnected';
      }
      if (icon) icon.textContent = '⚠️';
      if (title) title.textContent = 'TikTok "Repostlar" Sekmesi Korumalı';
      if (desc) desc.textContent = 'TikTok misafirlere repostları gizler. Tek tıkla TikTok bağlayarak yazdığın tüm hesapların son 10 repostunu anında açabilirsin.';
      if (btnText) btnText.textContent = '🔑 TikTok Bağla (Repostları Aç)';
    }
  } catch (e) {}
}

async function handleTikTokLogin() {
  const btn = document.getElementById('btn-tiktok-login');
  const btnText = document.getElementById('btn-tiktok-login-text');
  if (btnText) btnText.textContent = '⏳ TikTok Açılıyor...';
  if (btn) btn.disabled = true;

  showToast('🌐 Edge penceresi açılıyor. Lütfen TikTok hesabına giriş yap!');

  try {
    const res = await fetch('/api/tiktok-auth-login', { method: 'POST' });
    const data = await res.json();
    if (data.success && data.loggedIn) {
      showToast('🎉 TikTok başarıyla bağlandı! Artık tüm hesapların gerçek repostları çekilecek.');
      checkTikTokAuthStatus();
    } else {
      showToast(`❌ ${data.error || 'Giriş tamamlanamadı.'}`);
    }
  } catch (err) {
    showToast(`❌ Bağlantı hatası: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
    checkTikTokAuthStatus();
  }
}

async function handleManualCookieSave() {
  const input = document.getElementById('manual-cookie-input');
  const val = (input?.value || '').trim();
  if (!val) {
    showToast('⚠️ Lütfen sessionid değerini yapıştırın.');
    return;
  }

  try {
    const res = await fetch('/api/tiktok-auth-cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: val })
    });
    const data = await res.json();
    if (data.success) {
      showToast('🎉 TikTok cookie kaydedildi! Repostlar açıldı.');
      if (input) input.value = '';
      const box = document.getElementById('manual-cookie-box');
      if (box) box.style.display = 'none';
      checkTikTokAuthStatus();
    } else {
      showToast(`❌ ${data.error || 'Cookie kaydedilemedi.'}`);
    }
  } catch (e) {
    showToast(`❌ Hata: ${e.message}`);
  }
}

// ==================== INSTAGRAM AUTHENTICATION ====================
async function checkInstagramAuthStatus() {
  try {
    const res = await fetch('/api/instagram-auth-status');
    const data = await res.json();
    const banner = document.getElementById('instagram-auth-banner');
    const icon = document.getElementById('ig-auth-banner-icon');
    const title = document.getElementById('ig-auth-banner-title');
    const desc = document.getElementById('ig-auth-banner-desc');
    const btnText = document.getElementById('btn-instagram-login-text');

    if (data.loggedIn) {
      if (banner) {
        banner.className = 'instagram-auth-banner connected';
      }
      if (icon) icon.textContent = '✅';
      if (title) title.textContent = 'Instagram Bağlandı!';
      if (desc) desc.textContent = 'Yazdığın hesapların Reels ve Repost videoları sorunsuz çekilecek. Hazırsın!';
      if (btnText) btnText.textContent = '🔄 Hesabı Değiştir';
    } else {
      if (banner) {
        banner.className = 'instagram-auth-banner disconnected';
      }
      if (icon) icon.textContent = '⚠️';
      if (title) title.textContent = 'Instagram "Repostlar / Reels" Korumalı';
      if (desc) desc.textContent = 'Instagram giriş yapmayanlara Reels ve Repostları kısıtlar. Tek tıkla Instagram bağlayarak profillerin tüm videolarını açabilirsin.';
      if (btnText) btnText.textContent = '🔑 Instagram Bağla';
    }
  } catch (e) {}
}

async function handleInstagramLogin() {
  const btn = document.getElementById('btn-instagram-login');
  const btnText = document.getElementById('btn-instagram-login-text');
  if (btnText) btnText.textContent = '⏳ Instagram Açılıyor...';
  if (btn) btn.disabled = true;

  showToast('🌐 Edge penceresi açılıyor. Lütfen Instagram hesabına giriş yap!');

  try {
    const res = await fetch('/api/instagram-auth-login', { method: 'POST' });
    const data = await res.json();
    if (data.success && data.loggedIn) {
      showToast('🎉 Instagram başarıyla bağlandı! Artık tüm hesapların videoları çekilecek.');
      checkInstagramAuthStatus();
    } else {
      showToast(`❌ ${data.error || 'Giriş tamamlanamadı.'}`);
    }
  } catch (err) {
    showToast(`❌ Bağlantı hatası: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
    checkInstagramAuthStatus();
  }
}

async function handleManualIgCookieSave() {
  const input = document.getElementById('manual-ig-cookie-input');
  const val = (input?.value || '').trim();
  if (!val) {
    showToast('⚠️ Lütfen sessionid değerini yapıştırın.');
    return;
  }

  try {
    const res = await fetch('/api/instagram-auth-cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: val })
    });
    const data = await res.json();
    if (data.success) {
      showToast('🎉 Instagram cookie kaydedildi! Videolar açıldı.');
      if (input) input.value = '';
      const box = document.getElementById('manual-ig-cookie-box');
      if (box) box.style.display = 'none';
      checkInstagramAuthStatus();
    } else {
      showToast(`❌ ${data.error || 'Cookie kaydedilemedi.'}`);
    }
  } catch (e) {
    showToast(`❌ Hata: ${e.message}`);
  }
}

// ==================== SUSPECTS & REPOST HANDLING ====================

// Add Suspect via API
async function handleAddSuspect() {
  const input = document.getElementById('suspect-username-input');
  const igInput = document.getElementById('suspect-ig-username-input');
  const feedback = document.getElementById('fetch-feedback');
  const btnLabel = document.getElementById('fetch-btn-label');
  const rawUsername = (input?.value || '').trim();
  const rawIgUsername = (igInput?.value || '').trim();
  const desiredCount = parseInt(document.getElementById('repost-count-select')?.value || '10', 10);

  if (!rawUsername) {
    if (feedback) {
      feedback.textContent = 'Lütfen bir kullanıcı adı girin.';
      feedback.className = 'feedback-msg error';
    }
    return;
  }

  if (btnLabel) btnLabel.textContent = '⏳ Çekiliyor...';
  if (feedback) {
    feedback.textContent = currentSuspectPlatform === 'both'
      ? `🔥 Karma Mod: @${rawUsername} (TikTok) + @${rawIgUsername || rawUsername} (Instagram) taranıyor...`
      : `@${rawUsername} profilinin tüm repostları taranıp rastgele ${desiredCount} tanesi seçiliyor...`;
    feedback.className = 'feedback-msg info';
  }

  // Use WebSocket to bypass Render's 30s HTTP proxy timeout
  socket.emit('fetch_and_add_suspect', {
    roomCode: currentRoomCode,
    platform: currentSuspectPlatform,
    username: rawUsername,
    instagramUsername: rawIgUsername || rawUsername,
    count: desiredCount
  });
}

// Listen for WebSocket fetch result
socket.on('fetch_user_result', (data) => {
  const input = document.getElementById('suspect-username-input');
  const igInput = document.getElementById('suspect-ig-username-input');
  const feedback = document.getElementById('fetch-feedback');
  const btnLabel = document.getElementById('fetch-btn-label');

  if (btnLabel) btnLabel.textContent = '➕ Hesabı Ekle';

  if (data && data.success && data.user) {
    if (input) input.value = '';
    if (igInput) igInput.value = '';
    if (feedback) {
      feedback.textContent = data.note || `✅ @${data.user.username} eklendi!`;
      feedback.className = 'feedback-msg success';
    }
  } else {
    if (feedback) {
      feedback.textContent = `❌ ${(data && data.error) || 'Profil eklenemedi.'}`;
      feedback.className = 'feedback-msg error';
    }
  }
});

// Resolve and Add Repost URLs to Pool
async function handleResolveReposts() {
  const suspectSelect = document.getElementById('select-suspect-for-video');
  const textarea = document.getElementById('repost-urls-textarea');
  const feedback = document.getElementById('repost-feedback');
  const btnLabel = document.getElementById('resolve-btn-label');

  const suspectId = suspectSelect?.value;
  const urlsText = (textarea?.value || '').trim();

  if (!suspectId) {
    if (feedback) {
      feedback.textContent = 'Lütfen bu videoların kime ait olduğunu seçin.';
      feedback.className = 'feedback-msg error';
    }
    return;
  }

  if (!urlsText) {
    if (feedback) {
      feedback.textContent = 'Lütfen en az bir TikTok veya Instagram Reel linki yapıştırın.';
      feedback.className = 'feedback-msg error';
    }
    return;
  }

  if (btnLabel) btnLabel.textContent = '⏳ Videolar Çözümleniyor...';
  if (feedback) {
    feedback.textContent = 'Videolar indirilebilir akış ve kapak olarak analiz ediliyor...';
    feedback.className = 'feedback-msg info';
  }

  try {
    const res = await fetch('/api/resolve-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: urlsText })
    });

    const data = await res.json();
    if (data.success && data.items?.length > 0) {
      socket.emit('add_reposts', {
        roomCode: currentRoomCode,
        suspectId,
        items: data.items
      });

      textarea.value = '';
      if (feedback) {
        feedback.textContent = `🎉 ${data.items.length} adet video çözümlendi ve Gizli Repost Kutusu'na atıldı!`;
        feedback.className = 'feedback-msg success';
      }
    } else {
      if (feedback) {
        feedback.textContent = '❌ Hiçbir video çözümlenemedi. Linklerin geçerli TikTok veya Instagram Reels linki olduğundan emin olun.';
        feedback.className = 'feedback-msg error';
      }
    }
  } catch (err) {
    if (feedback) {
      feedback.textContent = `❌ Hata: ${err.message}`;
      feedback.className = 'feedback-msg error';
    }
  } finally {
    if (btnLabel) btnLabel.textContent = '📥 Çözümle & Gizli Kutuya At';
  }
}

function handleSettingsChange() {
  if (!isHost || !currentRoomCode) return;
  const roundTime = document.getElementById('setting-round-time')?.value;
  const maxRounds = document.getElementById('setting-max-rounds')?.value;
  socket.emit('update_settings', {
    roomCode: currentRoomCode,
    roundTime,
    maxRounds
  });
}

// ==================== SOUND & VIDEO ====================
function updateSoundButtonUI(isMuted) {
  const soundIcon = document.getElementById('sound-icon');
  const soundText = document.getElementById('sound-text');
  if (soundIcon) soundIcon.textContent = isMuted ? '🔇' : '🔊';
  if (soundText) soundText.textContent = isMuted ? 'Sesi Aç' : 'Sustur';
}

function toggleVideoSound() {
  const video = document.getElementById('game-video-player');
  if (!video) return;
  soundMuted = !soundMuted;
  video.muted = soundMuted;
  updateSoundButtonUI(soundMuted);
  if (!soundMuted) {
    video.volume = 1.0;
  }
}

// ==================== MODALS & HELPERS ====================
function openShareModal() {
  const modal = document.getElementById('modal-share');
  const qrImg = document.getElementById('share-qr-image');
  const urlInput = document.getElementById('share-url-input');

  const baseOrigin = serverInfo?.lanUrl || window.location.origin;
  const shareUrl = `${baseOrigin}/?room=${currentRoomCode}`;

  if (urlInput) urlInput.value = shareUrl;
  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(shareUrl)}`;
  }
  modal?.classList.add('active');
}

async function openBookmarkletModal() {
  const modal = document.getElementById('modal-bookmarklet');
  const codeArea = document.getElementById('bookmarklet-code-area');

  try {
    const res = await fetch('/api/bookmarklet-script');
    if (res.ok) {
      const scriptCode = await res.text();
      const minified = `javascript:${encodeURIComponent(scriptCode)}`;
      if (codeArea) codeArea.value = minified;
    }
  } catch (e) {
    console.error('Bookmarklet fetch error:', e);
  }

  modal?.classList.add('active');
}

function copyToClipboard(text, successMsg = 'Kopyalandı!') {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast(`📋 ${successMsg}`));
  } else {
    const tempInput = document.createElement('input');
    tempInput.value = text;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    tempInput.remove();
    showToast(`📋 ${successMsg}`);
  }
}

// ==================== SOCKET EVENT HANDLERS ====================

// Room Created
socket.on('room_created', (data) => {
  currentRoomCode = data.roomCode;
  myPlayerId = data.playerId;
  isHost = true;

  document.getElementById('lobby-room-code').textContent = currentRoomCode;
  document.getElementById('host-controls-card').style.display = 'flex';
  document.getElementById('guest-waiting-card').style.display = 'none';

  showScreen('lobby');
  showToast(`🎉 Oda ${currentRoomCode} oluşturuldu!`);
});

// Room Joined
socket.on('room_joined', (data) => {
  currentRoomCode = data.roomCode;
  myPlayerId = data.playerId;
  isHost = data.isHost;

  document.getElementById('lobby-room-code').textContent = currentRoomCode;
  document.getElementById('host-controls-card').style.display = isHost ? 'flex' : 'none';
  document.getElementById('guest-waiting-card').style.display = isHost ? 'none' : 'flex';

  showScreen('lobby');
  showToast(`🚀 ${currentRoomCode} odasına katıldınız!`);
});

// Returned to Lobby Event
socket.on('returned_to_lobby', () => {
  showScreen('lobby');
  showToast('🔁 Lobiye dönüldü! Yeni bir oyun için hazırsınız.');
});

// Room State Broadcast
socket.on('room_state', (room) => {
  if (!room) return;
  isHost = room.players.some(p => p.id === myPlayerId && p.isHost);

  // If room status is reset to lobby and client is still on podium, switch to lobby
  if (room.status === 'lobby' && screens.podium?.classList.contains('active')) {
    showScreen('lobby');
  }

  // Update Host visibility
  const hostCard = document.getElementById('host-controls-card');
  const guestCard = document.getElementById('guest-waiting-card');
  if (hostCard) hostCard.style.display = isHost ? 'flex' : 'none';
  if (guestCard) guestCard.style.display = isHost ? 'none' : 'flex';

  // Update Lobby Room Code
  const codeEl = document.getElementById('lobby-room-code');
  if (codeEl) codeEl.textContent = room.code;

  // Update Players Grid
  const playersGrid = document.getElementById('lobby-players-grid');
  const countEl = document.getElementById('player-count');
  if (countEl) countEl.textContent = room.players.length;

  if (playersGrid) {
    playersGrid.innerHTML = '';
    room.players.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'player-chip';
      chip.innerHTML = `
        <img class="player-chip-avatar" src="${p.avatar}" alt="${p.name}">
        <span class="player-chip-name">${p.name}</span>
        ${p.isHost ? '<span class="player-chip-crown" title="Oda Kurucusu">👑</span>' : ''}
      `;
      playersGrid.appendChild(chip);
    });
  }

  // Update Suspects Grid in Lobby
  const suspectsGrid = document.getElementById('suspects-list-grid');
  const suspectSelect = document.getElementById('select-suspect-for-video');

  if (suspectSelect) {
    const currentVal = suspectSelect.value;
    suspectSelect.innerHTML = '<option value="">Bir arkadaş seçin...</option>';
    room.suspects.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.displayName} (@${s.username})`;
      suspectSelect.appendChild(opt);
    });
    if (currentVal) suspectSelect.value = currentVal;
  }

  if (suspectsGrid) {
    if (room.suspects.length === 0) {
      suspectsGrid.innerHTML = `<div class="empty-state">Henüz şüpheli arkadaş eklenmedi. Yukarıdan ekleyebilir veya Örnek Paket'i yükleyebilirsiniz.</div>`;
    } else {
      suspectsGrid.innerHTML = '';
      const me = room.players.find(p => p.id === myPlayerId);

      room.suspects.forEach(s => {
        const isClaimedByMe = me && me.linkedSuspectId === s.id;
        const claimedByOther = room.players.find(p => p.id !== myPlayerId && p.linkedSuspectId === s.id);

        let claimActionHtml = '';
        if (isClaimedByMe) {
          claimActionHtml = `<button type="button" class="btn-claim-suspect claimed-by-me" data-id="${s.id}" title="Hesap sahipliğini kaldır">✅ Benim Hesabım (İptal)</button>`;
        } else if (claimedByOther) {
          claimActionHtml = `<div class="suspect-claimed-badge" title="${claimedByOther.name} bu hesabı seçti">👤 ${claimedByOther.name}</div>`;
        } else {
          claimActionHtml = `<button type="button" class="btn-claim-suspect" data-id="${s.id}" title="Bu hesabın sana ait olduğunu belirt">🙋‍♂️ Bu Benim</button>`;
        }

        const card = document.createElement('div');
        card.className = 'suspect-card';
        card.innerHTML = `
          ${isHost ? `<button type="button" class="btn-remove-suspect" data-id="${s.id}" title="Kaldır">✕</button>` : ''}
          <img class="suspect-avatar ${s.platform === 'instagram' ? 'ig' : ''}" src="${s.avatar}" alt="${s.displayName}">
          <div class="suspect-username">@${s.username}</div>
          <div class="suspect-count-badge">📦 ${s.repostCount || 0} video</div>
          ${claimActionHtml}
        `;
        suspectsGrid.appendChild(card);
      });

      // Claim suspect buttons
      suspectsGrid.querySelectorAll('.btn-claim-suspect').forEach(b => {
        b.addEventListener('click', (e) => {
          const suspId = e.currentTarget.getAttribute('data-id');
          if (suspId && currentRoomCode) {
            socket.emit('claim_suspect', { roomCode: currentRoomCode, suspectId: suspId });
          }
        });
      });

      // Remove suspect buttons
      suspectsGrid.querySelectorAll('.btn-remove-suspect').forEach(b => {
        b.addEventListener('click', (e) => {
          const suspId = e.target.getAttribute('data-id');
          if (suspId) socket.emit('remove_suspect', { roomCode: currentRoomCode, suspectId: suspId });
        });
      });
    }
  }

  // Update Total Videos in Pool
  const poolBadge = document.getElementById('total-pool-count');
  if (poolBadge) poolBadge.textContent = room.totalRepostsInPool || 0;

  // Validate Host Start Game requirements
  const startBtn = document.getElementById('btn-start-game');
  const hostNotice = document.getElementById('host-notice');
  const canStart = room.suspects.length >= 2 && (room.totalRepostsInPool || 0) >= 2;

  if (startBtn) {
    startBtn.disabled = !canStart;
    startBtn.style.opacity = canStart ? '1' : '0.5';
  }
  if (hostNotice) {
    hostNotice.textContent = canStart 
      ? '✅ Oyun başlatılmaya hazır!' 
      : 'Oyunu başlatmak için en az 2 arkadaş ve 2 video gereklidir.';
    hostNotice.style.color = canStart ? 'var(--success)' : 'var(--text-dim)';
  }

  // Update My HUD Score if playing
  const myPlayer = room.players.find(p => p.id === myPlayerId);
  if (myPlayer) {
    const scoreVal = document.getElementById('hud-my-score');
    const streakBadge = document.getElementById('hud-my-streak');
    if (scoreVal) scoreVal.textContent = myPlayer.score;
    if (streakBadge) {
      if (myPlayer.streak > 1) {
        streakBadge.style.display = 'inline-block';
        streakBadge.textContent = `🔥 ${myPlayer.streak}x Seri`;
      } else {
        streakBadge.style.display = 'none';
      }
    }
  }
});

// Round Started
socket.on('round_started', (data) => {
  isCurrentRoundOwnRepost = !!data.isOwnRepost;
  hasVotedCurrentRound = isCurrentRoundOwnRepost;
  showScreen('gameplay');

  // Update HUD
  const roundEl = document.getElementById('hud-round-number');
  if (roundEl) roundEl.textContent = `${data.roundIndex}/${data.totalRounds}`;

  // Reset & Start Timer
  startRoundTimer(data.roundTime || 25);

  // Setup Video Player
  const videoPlayer = document.getElementById('game-video-player');
  const embedIframe = document.getElementById('game-embed-iframe');
  const authorAvatar = document.getElementById('overlay-author-avatar');
  const authorHandle = document.getElementById('overlay-author-handle');
  const videoCaption = document.getElementById('overlay-video-caption');
  const statusInd = document.getElementById('voting-status-indicator');
  const ownBanner = document.getElementById('own-repost-banner');
  const btnSkipOwn = document.getElementById('btn-skip-own-round');
  const voteGrid = document.getElementById('suspects-voting-grid');

  if (isCurrentRoundOwnRepost) {
    if (statusInd) statusInd.textContent = '🤫 Kendi repostun! Arkadaşlarının tahmini bekleniyor...';
    if (voteGrid) voteGrid.style.display = 'none';
    if (ownBanner) ownBanner.style.display = 'flex';
    if (btnSkipOwn) {
      if (data.totalPlayers === 1) {
        btnSkipOwn.style.display = 'inline-block';
        btnSkipOwn.onclick = () => {
          socket.emit('skip_own_round', { roomCode: currentRoomCode });
        };
      } else {
        btnSkipOwn.style.display = 'none';
      }
    }
  } else {
    if (statusInd) statusInd.textContent = 'Arkadaşını seç ve oyunu kilitle!';
    if (voteGrid) voteGrid.style.display = 'grid';
    if (ownBanner) ownBanner.style.display = 'none';
  }

  if (data.video) {
    // Overlay details
    if (authorHandle) authorHandle.textContent = `@${data.video.originalAuthor?.username || 'creator'}`;
    if (authorAvatar) authorAvatar.src = data.video.originalAuthor?.avatar || 'https://ui-avatars.com/api/?name=TT';
    if (videoCaption) {
      const rawCap = (data.video.caption || '').trim();
      if (!rawCap || /repostlad[ıi]|repost/i.test(rawCap)) {
        videoCaption.textContent = '';
        videoCaption.style.display = 'none';
      } else {
        // Strip walls of hashtags and excess whitespace/newlines so it never blocks the video
        let cleanCap = rawCap.replace(/(?:#[\w\u00C0-\u017F]+\s*){3,}/g, '').trim();
        cleanCap = cleanCap.replace(/\n\s*\n+/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanCap.length > 90) {
          cleanCap = cleanCap.slice(0, 88).trim() + '...';
        }
        videoCaption.textContent = cleanCap;
        videoCaption.title = rawCap;
        videoCaption.classList.remove('expanded');
        videoCaption.style.display = 'block';
      }
    }

    // Direct Video Playback with Resilient Autoplay & Poster
    if (data.video.videoUrl) {
      if (videoPlayer) {
        videoPlayer.style.display = 'block';
        if (embedIframe) {
          embedIframe.style.display = 'none';
          embedIframe.src = '';
        }

        // Set poster image immediately so the screen is NEVER blank/black
        if (data.video.coverUrl) {
          videoPlayer.poster = data.video.coverUrl;
        }

        videoPlayer.src = data.video.videoUrl;
        videoPlayer.muted = soundMuted;
        updateSoundButtonUI(soundMuted);
        videoPlayer.load();

        const playPromise = videoPlayer.play();
        if (playPromise !== undefined) {
          playPromise.catch(err => {
            console.warn('Autoplay unmuted blocked by browser policy, falling back to muted playback:', err);
            // Fall back to muted playback so the video ALWAYS plays visibly
            videoPlayer.muted = true;
            soundMuted = true;
            updateSoundButtonUI(true);
            videoPlayer.play().catch(e => console.error('Muted autoplay also failed:', e));
          });
        }

        // Fallback error listener
        videoPlayer.onerror = () => {
          console.warn('Video failed to stream, checking embed fallback...');
          // DO NOT switch to embed iframe for Instagram (since Instagram embeds only say 'Watch on Instagram')
          if (data.video.platform !== 'instagram' && data.video.embedUrl && embedIframe) {
            videoPlayer.style.display = 'none';
            embedIframe.style.display = 'block';
            embedIframe.src = data.video.embedUrl;
          }
        };
      }
    } else if (data.video.embedUrl && data.video.platform !== 'instagram') {
      if (videoPlayer) {
        videoPlayer.pause();
        videoPlayer.style.display = 'none';
      }
      if (embedIframe) {
        embedIframe.style.display = 'block';
        embedIframe.src = data.video.embedUrl;
      }
    }
  }

  // Populate Suspects Voting Grid
  if (voteGrid) {
    voteGrid.innerHTML = '';
    data.suspects.forEach(s => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-vote-candidate';
      btn.innerHTML = `
        <img class="vote-candidate-avatar" src="${s.avatar}" alt="${s.displayName}">
        <div class="vote-candidate-info">
          <span class="vote-candidate-name">${s.displayName}</span>
          <span class="vote-candidate-handle">@${s.username}</span>
        </div>
      `;
      btn.addEventListener('click', () => {
        if (hasVotedCurrentRound) return;
        submitVote(s.id, btn);
      });
      voteGrid.appendChild(btn);
    });
  }
});

// Submit Vote
function submitVote(suspectId, clickedBtn) {
  if (hasVotedCurrentRound) return;
  hasVotedCurrentRound = true;

  document.querySelectorAll('.btn-vote-candidate').forEach(b => {
    b.disabled = true;
    b.classList.remove('selected');
  });
  if (clickedBtn) clickedBtn.classList.add('selected');

  const statusInd = document.getElementById('voting-status-indicator');
  if (statusInd) statusInd.textContent = '🔒 Tahminin kilitlendi! Diğer oyuncular bekleniyor...';

  socket.emit('submit_vote', {
    roomCode: currentRoomCode,
    suspectId
  });
}

// Vote Progress Notification
socket.on('vote_progress', ({ votedCount, totalPlayers }) => {
  const statusInd = document.getElementById('voting-status-indicator');
  if (statusInd) {
    if (isCurrentRoundOwnRepost) {
      statusInd.textContent = `🤫 Kendi repostun! (${votedCount}/${totalPlayers} kişi oy verdi)`;
    } else if (hasVotedCurrentRound) {
      statusInd.textContent = `🔒 Tahminin kilitlendi! (${votedCount}/${totalPlayers} kişi oy verdi)`;
    }
  }
});

// Round Revealed
socket.on('round_revealed', (data) => {
  clearInterval(roundTimerInterval);
  showScreen('reveal');

  // Pause video
  const videoPlayer = document.getElementById('game-video-player');
  if (videoPlayer) videoPlayer.pause();

  // Correct Suspect Spotlight
  const corAvatar = document.getElementById('reveal-correct-avatar');
  const corUser = document.getElementById('reveal-correct-username');
  const corName = document.getElementById('reveal-correct-name');
  const platBadge = document.getElementById('reveal-platform-badge');

  if (corAvatar) corAvatar.src = data.correctSuspect?.avatar || '';
  if (corUser) corUser.textContent = `@${data.correctSuspect?.username || 'Bilinmeyen'}`;
  if (data.correctSuspect?.isShared) {
    if (corName) {
      corName.innerHTML = `🤝 ${data.correctSuspect.displayName} <br><span style="font-size: 0.82rem; color: #10b981; font-weight: 800;">(Ortak Repost! Bu videoyu ikisi de repostladı)</span>`;
    }
    showToast(`🤝 Ortak Repost! @${data.correctSuspect.username} bu videoyu birlikte paylaştı. İkisinden birini seçen herkes doğru bildi! 🎉`, 5000);
  } else {
    if (corName) corName.textContent = data.correctSuspect?.displayName || '';
  }
  if (platBadge) platBadge.textContent = data.correctSuspect?.platform === 'both' ? '🔥' : (data.correctSuspect?.platform === 'instagram' ? '📸' : '🎵');

  // Votes List
  const votesList = document.getElementById('reveal-votes-list');
  if (votesList) {
    votesList.innerHTML = '';
    data.votes.forEach(v => {
      const row = document.createElement('div');
      const isOwn = !!v.isOwnRepost;
      const rowClass = isOwn ? 'own' : (v.isCorrect ? 'correct' : 'wrong');
      row.className = `vote-result-row ${rowClass}`;
      
      let outcomeText = '';
      if (isOwn) {
        outcomeText = `<span class="guess-outcome own">🤫 Kendi Repostu (Oy Kullanmadı)</span>`;
      } else if (!v.hasVoted) {
        outcomeText = `<span class="guess-outcome wrong">Oy vermedi (0p)</span>`;
      } else if (v.isCorrect) {
        outcomeText = `<span class="guess-outcome correct">✅ Bildi! (+${v.pointsEarned}p)</span>`;
      } else {
        const guessedName = v.guessedSuspect?.displayName || `@${v.guessedSuspect?.username}` || 'Biri';
        outcomeText = `<span class="guess-outcome wrong">❌ "${guessedName}" dedi (0p)</span>`;
      }

      row.innerHTML = `
        <div class="player-voter-info">
          <img class="player-voter-avatar" src="${v.player.avatar}" alt="${v.player.name}">
          <span class="player-voter-name">${v.player.name}</span>
        </div>
        ${outcomeText}
      `;
      votesList.appendChild(row);
    });
  }

  // Mini Leaderboard
  const miniLb = document.getElementById('reveal-mini-leaderboard');
  if (miniLb) {
    miniLb.innerHTML = '';
    data.leaderboard.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'lb-row';
      row.innerHTML = `
        <span class="lb-rank">#${idx + 1}</span>
        <div class="lb-player">
          <img class="lb-avatar" src="${p.avatar}" alt="${p.name}">
          <span class="lb-name">${p.name} ${p.streak > 1 ? `🔥${p.streak}` : ''}</span>
        </div>
        <span class="lb-score">${p.score}p</span>
      `;
      miniLb.appendChild(row);
    });
  }

  // Next Round Button / Guest Wait Text
  const hostAction = document.getElementById('reveal-host-actions');
  const guestNotice = document.getElementById('reveal-guest-notice');
  const nextBtnLabel = document.getElementById('btn-next-round-label');

  if (hostAction) hostAction.style.display = isHost ? 'block' : 'none';
  if (guestNotice) guestNotice.style.display = isHost ? 'none' : 'block';
  if (nextBtnLabel) {
    nextBtnLabel.textContent = data.isLastRound ? '🏆 Sonuçları Gör' : 'Sıradaki Video ➡️';
  }
});

// Game Finished (Podium & Awards)
socket.on('game_finished', (data) => {
  showScreen('podium');

  if (typeof confetti === 'function') {
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 }
    });
    setTimeout(() => {
      confetti({
        particleCount: 50,
        angle: 60,
        spread: 55,
        origin: { x: 0 }
      });
      confetti({
        particleCount: 50,
        angle: 120,
        spread: 55,
        origin: { x: 1 }
      });
    }, 400);
  }

  // Top 3 Podium
  const p1 = data.podium.first;
  const p2 = data.podium.second;
  const p3 = data.podium.third;

  if (p1) {
    document.getElementById('podium-first-name').textContent = p1.name;
    document.getElementById('podium-first-score').textContent = `${p1.score}p`;
    document.getElementById('podium-first-avatar').src = p1.avatar;
  }
  if (p2) {
    document.getElementById('podium-second-name').textContent = p2.name;
    document.getElementById('podium-second-score').textContent = `${p2.score}p`;
    document.getElementById('podium-second-avatar').src = p2.avatar;
  }
  if (p3) {
    document.getElementById('podium-third-name').textContent = p3.name;
    document.getElementById('podium-third-score').textContent = `${p3.score}p`;
    document.getElementById('podium-third-avatar').src = p3.avatar;
  }

  // Fun Awards
  const awardsGrid = document.getElementById('awards-grid');
  if (awardsGrid) {
    awardsGrid.innerHTML = '';
    const awards = [data.awards.bestStalker, data.awards.openBook, data.awards.secretAgent].filter(Boolean);
    awards.forEach(aw => {
      const card = document.createElement('div');
      card.className = 'award-card';
      card.innerHTML = `
        <div class="award-title">${aw.title}</div>
        <div class="award-desc">${aw.desc}</div>
      `;
      awardsGrid.appendChild(card);
    });
  }

  // Full Leaderboard
  const fullLb = document.getElementById('full-leaderboard-list');
  if (fullLb) {
    fullLb.innerHTML = '';
    data.leaderboard.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'lb-row';
      row.innerHTML = `
        <span class="lb-rank">#${idx + 1}</span>
        <div class="lb-player">
          <img class="lb-avatar" src="${p.avatar}" alt="${p.name}">
          <span class="lb-name">${p.name} (${p.correctCount || 0} doğru)</span>
        </div>
        <span class="lb-score">${p.score}p</span>
      `;
      fullLb.appendChild(row);
    });
  }
});

// Toast / Notification
socket.on('notification', (msg) => {
  showToast(msg);
});

// Error Message
socket.on('error_message', (msg) => {
  showToast(`⚠️ ${msg}`);
});

// ==================== TIMER UTILITIES ====================
function startRoundTimer(seconds) {
  if (roundTimerInterval) clearInterval(roundTimerInterval);

  let remaining = seconds;
  const bar = document.getElementById('hud-timer-bar');
  const secText = document.getElementById('hud-timer-seconds');

  if (bar) bar.style.width = '100%';
  if (secText) secText.textContent = `${remaining}s`;

  roundTimerInterval = setInterval(() => {
    remaining -= 0.1;
    if (remaining <= 0) {
      remaining = 0;
      clearInterval(roundTimerInterval);
    }

    const pct = Math.max(0, (remaining / seconds) * 100);
    if (bar) bar.style.width = `${pct}%`;
    if (secText) secText.textContent = `${Math.ceil(remaining)}s`;
  }, 100);
}
