const express = require('express');
const http = require('http');

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception (kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection (kept alive):', reason);
});
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const cheerio = require('cheerio');
const { 
  scrapeTikTokAccount, 
  getTikTokSession, 
  openTikTokLoginWindow, 
  setManualTikTokCookie 
} = require('./tiktok-scraper');
const {
  getInstagramAuthStatus,
  saveInstagramCookieString,
  openInstagramLoginWindow,
  scrapeInstagramAccount
} = require('./instagram-scraper');

// Session cookie cache for TikTok CDN playback
let latestTikTokCookies = '';
const SESSION_FILE = path.join(__dirname, '.tiktok_session.json');
try {
  if (fs.existsSync(SESSION_FILE)) {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (s && s.cookieHeader) {
      latestTikTokCookies = s.cookieHeader;
    }
  }
} catch (e) {}

function saveTikTokCookies(cookieHeader) {
  if (!cookieHeader) return;
  latestTikTokCookies = cookieHeader;
  try {
    let currentData = {};
    if (fs.existsSync(SESSION_FILE)) {
      try {
        currentData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      } catch (e) {}
    }
    currentData.cookieHeader = cookieHeader;
    currentData.updatedAt = new Date().toISOString();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(currentData, null, 2));
  } catch (e) {}
}

// Session cookie cache for Instagram playback
let latestInstagramCookies = '';
const IG_SESSION_FILE = path.join(__dirname, '.instagram_session.json');
try {
  if (fs.existsSync(IG_SESSION_FILE)) {
    const s = JSON.parse(fs.readFileSync(IG_SESSION_FILE, 'utf8'));
    if (s && s.cookieHeader) {
      latestInstagramCookies = s.cookieHeader;
    }
  }
} catch (e) {}

function saveInstagramCookies(cookieHeader) {
  if (!cookieHeader) return;
  latestInstagramCookies = cookieHeader;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Detect local LAN IP address
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// In-Memory Rooms Store
// code -> Room
const rooms = new Map();

// In-Memory Cached Browser Reposts (populated by 1-click Bookmarklet or browser form)
// username (lowercase) -> { user, items, cachedAt }
const cachedBrowserReposts = new Map();

// Helper to generate unique 4-character Room Code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

// Generate unique ID
function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
}

// Clean username from input (handles @username or full URL)
function cleanUsername(raw, platform = 'tiktok') {
  if (!raw) return '';
  let u = raw.trim();
  u = u.replace(/^@+/, '');
  if (u.includes('tiktok.com/@')) {
    const match = u.match(/tiktok\.com\/@([a-zA-Z0-9._-]+)/);
    if (match) return match[1];
  } else if (u.includes('instagram.com/')) {
    const match = u.match(/instagram\.com\/([a-zA-Z0-9._-]+)/);
    if (match) return match[1];
  }
  u = u.replace(/[/?#].*$/, '');
  return u;
}

// Delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== TIKWM QUEUE & RATE LIMITER ====================
// TikWM enforces a strict 1 request per second limit on free API.
// This queue ensures at least 1350ms between any two TikWM requests.
let lastTikwmCallTime = 0;
const TIKWM_MIN_INTERVAL_MS = 1350;

async function queueTikwm(taskFn) {
  const now = Date.now();
  const timeSinceLast = now - lastTikwmCallTime;
  if (timeSinceLast < TIKWM_MIN_INTERVAL_MS) {
    await delay(TIKWM_MIN_INTERVAL_MS - timeSinceLast);
  }
  lastTikwmCallTime = Date.now();
  try {
    return await taskFn();
  } catch (err) {
    console.error('TikWM queue task error:', err.message);
    return null;
  }
}

// Helper to wrap video and cover URLs with local media proxy
function wrapProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  if (rawUrl.startsWith('/api/proxy-media')) return rawUrl;
  let fullUrl = rawUrl;
  if (fullUrl.startsWith('/')) {
    fullUrl = `https://www.tikwm.com${fullUrl}`;
  }
  return `/api/proxy-media?url=${encodeURIComponent(fullUrl)}`;
}

// Safe TikWM video fetcher
async function fetchTikwmVideo(url) {
  return await queueTikwm(async () => {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code === 0 && json.data) {
      return json.data;
    }
    return null;
  });
}

// Safe TikWM feed/list fetcher for fresh viral videos
async function fetchTikwmFeed(region = 'TR', count = 12) {
  return await queueTikwm(async () => {
    const res = await fetch(`https://www.tikwm.com/api/feed/list?region=${region}&count=${count}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
      return json.data;
    }
    return null;
  });
}

// Single URL resolver for TikTok & Instagram
async function resolveSingleMediaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const url = rawUrl.trim();
  if (!url) return null;

  const isTikTok = /tiktok\.com/i.test(url);
  const isInstagram = /instagram\.com/i.test(url);

  if (isTikTok) {
    // 1. Try TikWM for direct non-watermarked .mp4 stream
    const data = await fetchTikwmVideo(url);
    if (data && (data.play || data.wmplay)) {
      const rawPlay = data.play || data.wmplay;
      const rawCover = data.cover || data.origin_cover || '';
      return {
        id: uid('vid'),
        platform: 'tiktok',
        url: url,
        videoUrl: wrapProxyUrl(rawPlay),
        coverUrl: wrapProxyUrl(rawCover),
        caption: data.title || 'TikTok Repost',
        duration: data.duration || 15,
        originalAuthor: {
          username: data.author?.unique_id || 'tiktok_user',
          displayName: data.author?.nickname || data.author?.unique_id || 'TikToker',
          avatar: data.author?.avatar ? wrapProxyUrl(data.author.avatar) : `https://ui-avatars.com/api/?name=${data.author?.unique_id || 'TT'}&background=fe2c55&color=fff`
        },
        embedUrl: `https://www.tiktok.com/embed/v2/${data.id || 'video'}`
      };
    }

    // 2. Fallback: extract video ID from URL
    const match = url.match(/\/video\/(\d+)/);
    const videoId = match ? match[1] : '';
    const authorMatch = url.match(/@([a-zA-Z0-9._-]+)/);
    const authorName = authorMatch ? authorMatch[1] : 'tiktok_creator';

    return {
      id: uid('vid'),
      platform: 'tiktok',
      url: url,
      videoUrl: '', // Will use embedUrl in frontend
      coverUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(authorName)}&background=fe2c55&color=fff&size=512`,
      caption: 'TikTok Repost Videosu',
      duration: 15,
      originalAuthor: {
        username: authorName,
        displayName: `@${authorName}`,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(authorName)}&background=25F4EE&color=000`
      },
      embedUrl: videoId ? `https://www.tiktok.com/embed/v2/${videoId}` : ''
    };
  }

  if (isInstagram) {
    const shortcodeMatch = url.match(/\/(?:reel|p|reels)\/([A-Za-z0-9_-]+)/);
    const shortcode = shortcodeMatch ? shortcodeMatch[1] : '';

    let streamUrl = '';
    let coverUrl = '';
    let authorName = 'instagram_creator';

    if (shortcode) {
      try {
        const ddRes = await fetch(`https://ddinstagram.com/reel/${shortcode}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }
        });
        if (ddRes.ok) {
          const html = await ddRes.text();
          const $ = cheerio.load(html);
          streamUrl = $('meta[property="og:video"]').attr('content') || '';
          coverUrl = $('meta[property="og:image"]').attr('content') || '';
          const title = $('meta[property="og:title"]').attr('content') || '';
          if (title) {
            const m = title.match(/@([a-zA-Z0-9._-]+)/);
            if (m) authorName = m[1];
          }
        }
      } catch (e) {
        // Fallback silently
      }
    }

    return {
      id: uid('vid'),
      platform: 'instagram',
      url: url,
      videoUrl: streamUrl ? wrapProxyUrl(streamUrl) : '',
      coverUrl: coverUrl ? wrapProxyUrl(coverUrl) : `https://ui-avatars.com/api/?name=Reels&background=833ab4&color=fff&size=512`,
      caption: 'Instagram Reel Repostu',
      duration: 15,
      originalAuthor: {
        username: authorName,
        displayName: `@${authorName}`,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(authorName)}&background=e1306c&color=fff`
      },
      embedUrl: shortcode ? `https://www.instagram.com/reel/${shortcode}/embed/captioned/` : ''
    };
  }

  // Direct video link fallback
  if (/\.mp4(\?.*)?$/i.test(url)) {
    return {
      id: uid('vid'),
      platform: 'direct',
      url: url,
      videoUrl: wrapProxyUrl(url),
      coverUrl: '',
      caption: 'Doğrudan Video Yayını',
      duration: 15,
      originalAuthor: {
        username: 'video_host',
        displayName: 'Viral Video',
        avatar: 'https://ui-avatars.com/api/?name=Video&background=00f2fe&color=000'
      },
      embedUrl: ''
    };
  }

  return null;
}

// Fallback high-reliability demo clips in case of network interruptions
const FALLBACK_DEMO_CLIPS = [
  {
    caption: 'Köpeğimle sessiz kalma meydan okuması 😂🐕 #PetsOfTikTok',
    author: { username: 'scout_doggo', nickname: 'Scout & Pets', avatar: 'https://ui-avatars.com/api/?name=Scout&background=fe2c55&color=fff' },
    url: 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    coverUrl: 'https://images.unsplash.com/photo-1543466835-00a7907e9de1?w=600&auto=format&fit=crop&q=80'
  },
  {
    caption: 'Pazartesi sabahı kahvemi içmeden kimse bana dokunmasın 💀',
    author: { username: 'berkcan_vibe', nickname: 'Berkcan', avatar: 'https://ui-avatars.com/api/?name=Berkcan&background=00f2fe&color=000' },
    url: 'https://www.tiktok.com/@funny/video/1',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4',
    coverUrl: 'https://images.unsplash.com/photo-1518717758536-85ae29035b6d?w=600&auto=format&fit=crop&q=80'
  },
  {
    caption: 'Bu kombini pazardan 100 TL\'ye topladım nasıl olmuş? ✨👗',
    author: { username: 'zeynep_style', nickname: 'Zeynep Moda', avatar: 'https://ui-avatars.com/api/?name=Zeynep&background=833ab4&color=fff' },
    url: 'https://www.tiktok.com/@aesthetic/video/2',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    coverUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=600&auto=format&fit=crop&q=80'
  },
  {
    caption: '1v5 Clutch attığım an Discord ses odası patladı 🎧🔥',
    author: { username: 'emre_gaming', nickname: 'Emre Gaming', avatar: 'https://ui-avatars.com/api/?name=Emre&background=00f2fe&color=000' },
    url: 'https://instagram.com/reel/game1',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyBlazes.mp4',
    coverUrl: 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=600&auto=format&fit=crop&q=80'
  }
];

// ==================== REST APIS ====================

// 1. Server info & LAN IP
app.get('/api/server-info', (req, res) => {
  const lanIp = getLanIp();
  const host = req.headers.host || `localhost:${PORT}`;
  const protocol = req.protocol || 'http';
  const lanUrl = `http://${lanIp}:${PORT}`;
  const currentUrl = `${protocol}://${host}`;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(lanUrl)}`;

  res.json({
    port: PORT,
    lanIp,
    currentUrl,
    lanUrl,
    qrCodeUrl
  });
});

// TikTok Auth Status
app.get('/api/tiktok-auth-status', (req, res) => {
  const session = getTikTokSession();
  res.json({
    loggedIn: session.hasAuth,
    cookiesCount: session.cookies?.length || 0
  });
});

// Open visible browser window to log in to TikTok
app.post('/api/tiktok-auth-login', async (req, res) => {
  try {
    const result = await openTikTokLoginWindow();
    if (result.success && result.cookieHeader) {
      saveTikTokCookies(result.cookieHeader);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manually set TikTok session cookie
app.post('/api/tiktok-auth-cookie', (req, res) => {
  const { cookie } = req.body;
  const result = setManualTikTokCookie(cookie);
  if (result.success && result.cookieHeader) {
    saveTikTokCookies(result.cookieHeader);
  }
  res.json(result);
});

// Instagram Auth Status
app.get('/api/instagram-auth-status', (req, res) => {
  const status = getInstagramAuthStatus();
  res.json({
    loggedIn: status.loggedIn,
    cookiesCount: status.cookiesCount
  });
});

// Open visible browser window to log in to Instagram
app.post('/api/instagram-auth-login', async (req, res) => {
  try {
    const result = await openInstagramLoginWindow();
    if (result.success && result.cookieHeader) {
      saveInstagramCookies(result.cookieHeader);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manually set Instagram session cookie
app.post('/api/instagram-auth-cookie', (req, res) => {
  const { cookie } = req.body;
  const result = saveInstagramCookieString(cookie);
  if (result.success && result.cookieHeader) {
    saveInstagramCookies(result.cookieHeader);
  }
  res.json(result);
});

// Form-based browser importer (bypasses browser CSP/CORS seamlessly)
app.post('/api/import-form', (req, res) => {
  try {
    let payload = req.body.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (e) {
        return res.status(400).send('JSON ayrıştırma hatası.');
      }
    }
    if (!payload || !payload.username) {
      return res.status(400).send('Geçersiz payload verisi: username eksik.');
    }

    const platform = payload.platform || 'tiktok';
    const username = cleanUsername(payload.username, platform).toLowerCase();
    const rawItems = Array.isArray(payload.items) ? payload.items : [];

    const processedItems = rawItems.slice(0, 15).map(it => {
      const url = typeof it === 'string' ? it : (it.url || '');
      const playAddr = it.playAddr || it.videoUrl || url;
      const cover = it.cover || it.coverUrl || '';
      return {
        id: it.id || uid('vid'),
        platform,
        url,
        videoUrl: wrapProxyUrl(playAddr),
        coverUrl: cover ? wrapProxyUrl(cover) : '',
        caption: it.desc || it.caption || '',
        duration: it.duration || 15,
        originalAuthor: it.originalAuthor || {
          username: username,
          displayName: `@${username}`,
          avatar: ''
        },
        embedUrl: ''
      };
    });

    cachedBrowserReposts.set(username, {
      user: payload.user || {
        username,
        displayName: `@${username}`,
        avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=fe2c55&color=fff&bold=true&size=200`,
        platform
      },
      items: processedItems,
      cachedAt: Date.now()
    });

    console.log(`[Import-Form] Cached ${processedItems.length} browser reposts for @${username}`);

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Repostlar Aktarıldı!</title>
  <style>
    body {
      background: #0b0e14;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    .box {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(0, 242, 254, 0.4);
      padding: 30px;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0, 242, 254, 0.25);
      max-width: 420px;
    }
    h2 { color: #00f2fe; margin-top: 0; font-size: 1.5rem; }
    p { line-height: 1.5; color: #cbd5e1; }
    .badge {
      display: inline-block;
      background: rgba(0, 242, 254, 0.2);
      color: #00f2fe;
      padding: 4px 12px;
      border-radius: 20px;
      font-weight: bold;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="box">
    <h2>🎉 Repostlar Başarıyla Aktarıldı!</h2>
    <p><strong>@${username}</strong> hesabının <strong>${processedItems.length}</strong> adet repostu hafızaya alındı.</p>
    <div class="badge">r3.poster Hazır!</div>
    <p style="color: #94a3b8; font-size: 0.85rem; margin-top: 15px;">Bu sekme otomatik olarak kapanıyor...</p>
  </div>
  <script>
    setTimeout(() => {
      window.close();
    }, 1500);
  </script>
</body>
</html>`);
  } catch (err) {
    console.error('import-form error:', err);
    res.status(500).send('İçe aktarma hatası: ' + err.message);
  }
});

// 2. Video & Image Proxy Stream (Resolves black screen & CORS/Referer issues)
app.get('/api/proxy-media', async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) {
      return res.status(400).send('URL parametresi eksik.');
    }

    let targetUrl = rawUrl;
    if (targetUrl.startsWith('/')) {
      targetUrl = `https://www.tikwm.com${targetUrl}`;
    }

    // If a TikTok page URL is passed, resolve it to direct stream
    if (targetUrl.includes('tiktok.com/@') && targetUrl.includes('/video/')) {
      const resolved = await fetchTikwmVideo(targetUrl);
      if (resolved && (resolved.play || resolved.wmplay)) {
        targetUrl = resolved.play || resolved.wmplay;
      }
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'
    };

    const isInstagramUrl = targetUrl.includes('instagram.com') || targetUrl.includes('cdninstagram.com') || targetUrl.includes('fbcdn.net');
    const isCdn = targetUrl.includes('cdninstagram.com') || targetUrl.includes('fbcdn.net') || targetUrl.includes('tiktokcdn');

    if (isInstagramUrl) {
      headers['Referer'] = 'https://www.instagram.com/';
      if (latestInstagramCookies && !isCdn) {
        headers['Cookie'] = latestInstagramCookies;
      }
    } else {
      headers['Referer'] = 'https://www.tiktok.com/';
      if (latestTikTokCookies && !isCdn && targetUrl.includes('tiktok.com')) {
        headers['Cookie'] = latestTikTokCookies;
      }
    }

    // Forward Range header if browser requests partial video content
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstreamRes = await fetch(targetUrl, { headers });

    // Set response status code (e.g. 200 or 206 Partial Content)
    res.status(upstreamRes.status);

    const isVideo = targetUrl.includes('.mp4') || (upstreamRes.headers.get('content-type') || '').includes('video');
    const defaultContentType = isVideo ? 'video/mp4' : 'image/jpeg';
    const contentType = upstreamRes.headers.get('content-type') || defaultContentType;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (upstreamRes.headers.has('content-range')) {
      res.setHeader('Content-Range', upstreamRes.headers.get('content-range'));
    }
    if (upstreamRes.headers.has('content-length')) {
      res.setHeader('Content-Length', upstreamRes.headers.get('content-length'));
    }

    if (upstreamRes.body) {
      const stream = Readable.fromWeb(upstreamRes.body);
      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('Proxy pipe error:', err.message);
        if (!res.headersSent) res.status(500).end();
      });
    } else {
      res.end();
    }
  } catch (err) {
    console.error('proxy-media error:', err);
    if (!res.headersSent) {
      res.status(500).send('Medya proxy hatası: ' + err.message);
    }
  }
});

// 3. Fetch User Profile & Automatically Resolve Reposts/Videos
app.post('/api/fetch-user', async (req, res) => {
  try {
    const { platform = 'tiktok', username: rawUsername, rapidApiKey, count = 10 } = req.body;
    const targetCount = Math.max(1, Math.min(30, parseInt(count, 10) || 10));
    const username = cleanUsername(rawUsername, platform);

    if (!username) {
      return res.status(400).json({ success: false, error: 'Geçersiz kullanıcı adı.' });
    }

    // Check in-memory browser cache first
    const cleanUserKey = username.toLowerCase();
    if (cachedBrowserReposts.has(cleanUserKey)) {
      const cached = cachedBrowserReposts.get(cleanUserKey);
      console.log(`[Fetch-User] Serving ${cached.items.length} reposts from memory cache for @${username}`);
      return res.json({
        success: true,
        user: cached.user,
        items: cached.items,
        isReposts: true,
        note: `🎉 @${username} hesabının GERÇEK REPOSTLARINDAN ${cached.items.length} adet video içe aktarıldı!`
      });
    }

    let user = {
      id: uid('susp'),
      username,
      displayName: username,
      avatar: '',
      platform,
      secUid: ''
    };
    let items = [];
    let note = '';

    if (platform === 'tiktok') {
      // Step A: RapidAPI if key provided
      if (rapidApiKey) {
        try {
          const rapidRes = await fetch(`https://tiktok-scraper7.p.rapidapi.com/user/repost?unique_id=${encodeURIComponent(username)}&count=20`, {
            headers: {
              'x-rapidapi-key': rapidApiKey,
              'x-rapidapi-host': 'tiktok-scraper7.p.rapidapi.com'
            }
          });
          if (rapidRes.ok) {
            const rJson = await rapidRes.json();
            if (rJson.data && Array.isArray(rJson.data.videos)) {
              items = rJson.data.videos.map(v => ({
                id: uid('vid'),
                platform: 'tiktok',
                url: v.play || v.wmplay || `https://www.tiktok.com/@${v.author?.unique_id}/video/${v.id}`,
                videoUrl: wrapProxyUrl(v.play || v.wmplay),
                coverUrl: wrapProxyUrl(v.cover || v.origin_cover || ''),
                caption: v.title || '',
                duration: v.duration || 15,
                originalAuthor: {
                  username: v.author?.unique_id || 'creator',
                  displayName: v.author?.nickname || 'Creator',
                  avatar: v.author?.avatar ? wrapProxyUrl(v.author.avatar) : ''
                },
                embedUrl: v.id ? `https://www.tiktok.com/embed/v2/${v.id}` : ''
              }));
            }
          }
        } catch (e) {
          console.error('RapidAPI error:', e.message);
        }
      }

      // Step B: Scrape REAL profile, REAL reposts & REAL videos using headless Edge
      if (items.length === 0) {
        const scrapeRes = await scrapeTikTokAccount(username, targetCount);
        if (scrapeRes.cookieHeader) {
          saveTikTokCookies(scrapeRes.cookieHeader);
        }
        if (scrapeRes.success) {
          user.displayName = scrapeRes.user.displayName || username;
          user.avatar = scrapeRes.user.avatar || '';
          user.secUid = scrapeRes.user.secUid || '';

          if (scrapeRes.items && scrapeRes.items.length > 0) {
            const targetItems = scrapeRes.items.slice(0, targetCount);
            const resolvedList = [];

            for (const it of targetItems) {
              let directPlay = '';
              let coverImg = it.cover;

              // Resolve universal direct playable stream via TikWM
              const resolvedMedia = await fetchTikwmVideo(it.url);
              if (resolvedMedia && (resolvedMedia.play || resolvedMedia.wmplay)) {
                directPlay = resolvedMedia.play || resolvedMedia.wmplay;
                coverImg = resolvedMedia.cover || resolvedMedia.origin_cover || it.cover;
              } else if (it.playAddr) {
                directPlay = it.playAddr;
              }

              resolvedList.push({
                id: uid('vid'),
                platform: 'tiktok',
                url: it.url,
                videoUrl: directPlay ? wrapProxyUrl(directPlay) : '',
                coverUrl: coverImg ? wrapProxyUrl(coverImg) : '',
                caption: it.desc || '',
                duration: it.duration || 15,
                originalAuthor: {
                  username: it.originalAuthor?.username || username,
                  displayName: it.originalAuthor?.displayName || username,
                  avatar: it.originalAuthor?.avatar ? wrapProxyUrl(it.originalAuthor.avatar) : ''
                },
                embedUrl: `https://www.tiktok.com/embed/v2/${it.id}`
              });
            }
            items = resolvedList;
          }
          note = scrapeRes.note;
        }
      }

      // Fallback avatar if empty
      if (!user.avatar) {
        user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=fe2c55&color=fff&bold=true&size=200`;
      }

    } else if (platform === 'both') {
      // Karma Mode: Fetch from BOTH TikTok and Instagram together
      const igUsername = cleanUsername(req.body.instagramUsername || rawUsername, 'instagram') || username;
      const ttShare = Math.ceil(targetCount / 2);
      const igShare = Math.max(1, targetCount - ttShare);

      const [ttRes, igRes] = await Promise.all([
        scrapeTikTokAccount(username, targetCount).catch(() => ({ success: false, items: [] })),
        scrapeInstagramAccount(igUsername, targetCount).catch(() => ({ success: false, items: [] }))
      ]);

      if (ttRes.cookieHeader) saveTikTokCookies(ttRes.cookieHeader);
      if (igRes.cookieHeader) saveInstagramCookies(igRes.cookieHeader);

      user.platform = 'both';
      user.displayName = (ttRes.user && ttRes.user.displayName) || (igRes.user && igRes.user.displayName) || username;
      user.avatar = (ttRes.user && ttRes.user.avatar) || (igRes.user && igRes.user.avatar ? wrapProxyUrl(igRes.user.avatar) : '') || `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=fe2c55&color=fff&bold=true&size=200`;

      const ttProcessed = [];
      if (ttRes.success && Array.isArray(ttRes.items)) {
        for (const it of ttRes.items) {
          let directPlay = '';
          let coverImg = it.cover;
          const resolvedMedia = await fetchTikwmVideo(it.url);
          if (resolvedMedia && (resolvedMedia.play || resolvedMedia.wmplay)) {
            directPlay = resolvedMedia.play || resolvedMedia.wmplay;
            coverImg = resolvedMedia.cover || resolvedMedia.origin_cover || it.cover;
          } else if (it.playAddr) {
            directPlay = it.playAddr;
          }
          if (directPlay) {
            ttProcessed.push({
              id: uid('vid'),
              platform: 'tiktok',
              url: it.url,
              videoUrl: wrapProxyUrl(directPlay),
              coverUrl: coverImg ? wrapProxyUrl(coverImg) : '',
              caption: it.desc || '',
              duration: it.duration || 15,
              originalAuthor: {
                username: it.originalAuthor?.username || username,
                displayName: it.originalAuthor?.displayName || username,
                avatar: it.originalAuthor?.avatar ? wrapProxyUrl(it.originalAuthor.avatar) : ''
              },
              embedUrl: `https://www.tiktok.com/embed/v2/${it.id}`
            });
          }
        }
      }

      const igProcessed = [];
      if (igRes.success && Array.isArray(igRes.items)) {
        for (const it of igRes.items) {
          if (it.playAddr) {
            igProcessed.push({
              id: uid('vid'),
              platform: 'instagram',
              url: it.url,
              videoUrl: wrapProxyUrl(it.playAddr),
              coverUrl: it.cover ? wrapProxyUrl(it.cover) : '',
              caption: it.desc || '',
              duration: it.duration || 15,
              originalAuthor: {
                username: it.originalAuthor?.username || igUsername,
                displayName: it.originalAuthor?.displayName || `@${igUsername}`,
                avatar: it.originalAuthor?.avatar ? wrapProxyUrl(it.originalAuthor.avatar) : ''
              },
              embedUrl: ''
            });
          }
        }
      }

      // Balance TT & IG up to targetCount, filling shortfall from the other if needed
      let pickedTT = ttProcessed.slice(0, ttShare);
      let pickedIG = igProcessed.slice(0, igShare);
      if (pickedTT.length < ttShare && igProcessed.length > pickedIG.length) {
        pickedIG = igProcessed.slice(0, targetCount - pickedTT.length);
      } else if (pickedIG.length < igShare && ttProcessed.length > pickedTT.length) {
        pickedTT = ttProcessed.slice(0, targetCount - pickedIG.length);
      }

      items = [...pickedTT, ...pickedIG].sort(() => Math.random() - 0.5).slice(0, targetCount);
      note = `🔥 Karma Mod (@${username} + @${igUsername}): ${pickedTT.length} TikTok + ${pickedIG.length} Instagram = Toplam ${items.length} rastgele repost eklendi!`;

    } else {
      // Instagram - Scrape REAL profile, REAL reposts & REAL reels using headless Edge
      const igRes = await scrapeInstagramAccount(username, targetCount);
      if (igRes.cookieHeader) {
        saveInstagramCookies(igRes.cookieHeader);
      }
      if (igRes.success && igRes.user) {
        user.displayName = igRes.user.displayName || `@${username}`;
        user.avatar = igRes.user.avatar ? wrapProxyUrl(igRes.user.avatar) : `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=833ab4&color=fff&size=200`;

        if (igRes.items && igRes.items.length > 0) {
          const targetItems = igRes.items.slice(0, targetCount);
          items = targetItems.map(it => {
            let directPlay = it.playAddr || '';
            let coverImg = it.cover || '';
            return {
              id: uid('vid'),
              platform: 'instagram',
              url: it.url,
              videoUrl: directPlay ? wrapProxyUrl(directPlay) : '',
              coverUrl: coverImg ? wrapProxyUrl(coverImg) : '',
              caption: it.desc || '',
              duration: it.duration || 15,
              originalAuthor: {
                username: it.originalAuthor?.username || username,
                displayName: it.originalAuthor?.displayName || `@${username}`,
                avatar: it.originalAuthor?.avatar ? wrapProxyUrl(it.originalAuthor.avatar) : ''
              },
              embedUrl: '' // Leave empty so player never falls back to broken Instagram iframe embed
            };
          });
        }
        note = igRes.note;
      } else {
        user.avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=833ab4&color=fff&bold=true&size=200`;
        user.displayName = `@${username}`;
      }
    }

    if (!note) {
      note = items.length > 0
        ? `✅ @${user.username} eklendi ve ${items.length} adet repost videosu gizli havuza aktarıldı!`
        : `ℹ️ @${user.username} profili eklendi. Arkadaşının video linklerini Gizli Kutu'ya yapıştırabilirsin.`;
    }

    return res.json({
      success: true,
      user,
      items,
      note,
      autoFetchedCount: items.length
    });
  } catch (error) {
    console.error('fetch-user error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Resolve Media URLs
app.post('/api/resolve-url', async (req, res) => {
  try {
    const { url, urls } = req.body;
    let urlList = [];

    if (Array.isArray(urls)) {
      urlList = urls;
    } else if (typeof urls === 'string') {
      urlList = urls.split(/[\n\s,]+/).filter(Boolean);
    } else if (typeof url === 'string') {
      urlList = url.split(/[\n\s,]+/).filter(Boolean);
    }

    if (urlList.length === 0) {
      return res.status(400).json({ success: false, error: 'Lütfen en az bir video URL\'si gönderin.' });
    }

    const resolvedItems = [];
    for (const rawUrl of urlList) {
      const resolved = await resolveSingleMediaUrl(rawUrl);
      if (resolved) {
        resolvedItems.push(resolved);
      }
    }

    res.json({
      success: true,
      count: resolvedItems.length,
      items: resolvedItems
    });
  } catch (err) {
    console.error('resolve-url error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Bookmarklet Script Provider
app.get('/api/bookmarklet-script', (req, res) => {
  const lanIp = getLanIp();
  const host = req.headers.host || `${lanIp}:${PORT}`;
  const serverOrigin = `${req.protocol}://${host}`;

  const scriptCode = `
(function() {
  var serverUrl = '${serverOrigin}';
  var defaultUser = (window.location.pathname.match(/@([a-zA-Z0-9._-]+)/) || [])[1] || '';
  var suspectUsername = prompt('🎮 KIM REPOSTLADI? \\nBu repostlar HANGI ARKADASINA ait? (@kullanici_adi):', defaultUser);
  if (!suspectUsername) return;
  suspectUsername = suspectUsername.replace(/^@/, '').trim();

  var links = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/reel/"]'));
  var urls = Array.from(new Set(links.map(function(a) { return a.href; }))).filter(function(u) {
    return u && (u.includes('tiktok.com') || u.includes('instagram.com'));
  });

  if (urls.length === 0) {
    alert('❌ Sayfada video bağlantısı bulunamadı! Lütfen arkadaşının TikTok "Repostlar" sekmesinde veya profilinde olduğundan emin ol.');
    return;
  }

  var count = Math.min(urls.length, 15);
  var selectedUrls = urls.slice(0, count);

  // Form POST completely bypasses browser CSP / CORS on TikTok & Firefox
  var form = document.createElement('form');
  form.method = 'POST';
  form.action = serverUrl + '/api/import-form';
  form.target = '_blank';

  var input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'payload';
  input.value = JSON.stringify({
    username: suspectUsername,
    platform: window.location.hostname.includes('instagram') ? 'instagram' : 'tiktok',
    items: selectedUrls.map(function(u) { return { url: u }; })
  });

  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  setTimeout(function() { form.remove(); }, 1500);
})();
  `.trim();

  res.setHeader('Content-Type', 'application/javascript');
  res.send(scriptCode);
});

// Extracts a unique canonical key across TikTok & Instagram so duplicate reposts can be detected
function getCanonicalVideoKey(item) {
  if (!item) return '';
  const rawUrl = item.url || item.videoUrl || '';

  // 1. Instagram Reel / Post Shortcode
  const igMatch = rawUrl.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
  if (igMatch) return `ig_${igMatch[1]}`;
  if (item.code) return `ig_${item.code}`;

  // 2. TikTok Video ID
  const ttMatch = rawUrl.match(/\/video\/(\d+)/i);
  if (ttMatch) return `tt_${ttMatch[1]}`;
  if (item.id && /^\d{15,25}$/.test(String(item.id))) return `tt_${item.id}`;

  // 3. Fallback signature
  if (item.id && !item.id.startsWith('vid_')) return `${item.platform || 'media'}_${item.id}`;
  if (rawUrl) return rawUrl.split('?')[0];
  return item.caption ? `${item.caption.trim().toLowerCase().slice(0, 40)}_${item.duration}` : (item.id || uid('vid'));
}

// Adds or merges an item in room.repostPool so shared reposts are tracked under multiple suspectIds
function addOrMergePoolItem(room, item, suspectId, extraProps = {}) {
  const canonicalKey = getCanonicalVideoKey(item);
  let existing = null;
  if (canonicalKey) {
    existing = room.repostPool.find(r => r.canonicalKey && r.canonicalKey === canonicalKey);
  }

  if (existing) {
    if (!Array.isArray(existing.suspectIds)) {
      existing.suspectIds = [existing.suspectId];
    }
    if (!existing.suspectIds.includes(suspectId)) {
      existing.suspectIds.push(suspectId);
    }
    if (!existing.videoUrl && item.videoUrl) {
      existing.videoUrl = wrapProxyUrl(item.videoUrl);
    }
    if (!existing.coverUrl && item.coverUrl) {
      existing.coverUrl = wrapProxyUrl(item.coverUrl);
    }
    return existing;
  } else {
    const newItem = {
      ...item,
      id: item.id || uid('vid'),
      canonicalKey,
      videoUrl: wrapProxyUrl(item.videoUrl),
      coverUrl: wrapProxyUrl(item.coverUrl),
      suspectId: suspectId,
      suspectIds: [suspectId],
      ...extraProps
    };
    room.repostPool.push(newItem);
    return newItem;
  }
}

// Recalculates repost counts for all suspects based on suspectIds
function recalculateSuspectCounts(room) {
  if (!room || !Array.isArray(room.suspects)) return;
  room.suspects.forEach(s => {
    s.repostCount = room.repostPool.filter(r => (r.suspectIds || [r.suspectId]).includes(s.id)).length;
  });
}

// 6. Batch Import API
app.post('/api/import-batch', async (req, res) => {
  try {
    const { roomCode, suspectId, suspectUsername, platform = 'tiktok', urls = [], items = [] } = req.body;
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) {
      return res.status(404).json({ success: false, error: 'Oda bulunamadı.' });
    }

    let targetSuspect = null;
    if (suspectId) {
      targetSuspect = room.suspects.find(s => s.id === suspectId);
    }
    if (!targetSuspect && suspectUsername) {
      const cleanName = cleanUsername(suspectUsername);
      targetSuspect = room.suspects.find(s => s.username.toLowerCase() === cleanName.toLowerCase());
      if (!targetSuspect) {
        targetSuspect = {
          id: uid('susp'),
          username: cleanName,
          displayName: `@${cleanName}`,
          platform,
          avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanName)}&background=fe2c55&color=fff&bold=true`,
          repostCount: 0
        };
        room.suspects.push(targetSuspect);
      }
    }

    if (!targetSuspect) {
      return res.status(400).json({ success: false, error: 'Şüpheli arkadaş belirlenemedi.' });
    }

    let addedCount = 0;

    if (Array.isArray(items) && items.length > 0) {
      for (const it of items) {
        addOrMergePoolItem(room, it, targetSuspect.id, { addedAt: Date.now() });
        addedCount++;
      }
    }

    if (Array.isArray(urls) && urls.length > 0) {
      for (const u of urls) {
        const resolved = await resolveSingleMediaUrl(u);
        if (resolved) {
          addOrMergePoolItem(room, resolved, targetSuspect.id, { addedAt: Date.now() });
          addedCount++;
        }
      }
    }

    recalculateSuspectCounts(room);
    broadcastRoomState(room);

    res.json({
      success: true,
      addedCount,
      totalInPool: room.repostPool.length,
      suspect: targetSuspect
    });
  } catch (err) {
    console.error('import-batch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== MULTIPLAYER SOCKET.IO ====================

function sanitizeRoomForClient(room) {
  return {
    code: room.code,
    hostSocketId: room.hostSocketId,
    status: room.status,
    settings: room.settings,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      streak: p.streak,
      correctCount: p.correctCount,
      isHost: p.socketId === room.hostSocketId,
      linkedSuspectId: p.linkedSuspectId || null
    })),
    suspects: room.suspects.map(s => ({
      id: s.id,
      username: s.username,
      displayName: s.displayName,
      platform: s.platform,
      avatar: s.avatar,
      repostCount: s.repostCount
    })),
    totalRepostsInPool: room.repostPool.length,
    currentRoundIndex: room.currentRoundIndex,
    totalRounds: room.rounds.length,
    votedPlayerIds: Object.keys(room.currentVotes || {})
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room_state', sanitizeRoomForClient(room));
}

// Start a round
function startNextRound(room) {
  if (room.currentRoundIndex >= room.rounds.length) {
    finishGame(room);
    return;
  }

  room.status = 'playing';
  room.currentVotes = {};
  room.roundStartTime = Date.now();

  const currentItem = room.rounds[room.currentRoundIndex];

  // Video object sent to clients - notice suspectId is STRIPPED to prevent cheating
  let cleanCaption = (currentItem.caption || '').trim();
  // Strip any accidental leaks of "repostladı" or suspect names
  if (/repostlad[ıi]|repost/i.test(cleanCaption)) {
    cleanCaption = '';
  }
  // Strip long hashtag walls and excess linebreaks so captions never block the video
  cleanCaption = cleanCaption.replace(/(?:#[\w\u00C0-\u017F]+\s*){3,}/g, '').trim();
  cleanCaption = cleanCaption.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanCaption.length > 90) {
    cleanCaption = cleanCaption.slice(0, 88).trim() + '...';
  }
  if (Array.isArray(room.suspects)) {
    room.suspects.forEach(s => {
      if (s.username && s.username.length >= 3 && cleanCaption.toLowerCase().includes(s.username.toLowerCase())) {
        cleanCaption = '';
      }
      if (s.displayName && s.displayName.length >= 3 && cleanCaption.toLowerCase().includes(s.displayName.toLowerCase())) {
        cleanCaption = '';
      }
    });
  }

  const roundPayload = {
    roundIndex: room.currentRoundIndex + 1,
    totalRounds: room.rounds.length,
    roundTime: room.settings.roundTime,
    video: {
      id: currentItem.id,
      platform: currentItem.platform,
      videoUrl: currentItem.videoUrl,
      embedUrl: currentItem.embedUrl,
      coverUrl: currentItem.coverUrl,
      caption: cleanCaption,
      duration: currentItem.duration,
      originalAuthor: currentItem.originalAuthor
    },
    suspects: room.suspects.map(s => ({
      id: s.id,
      username: s.username,
      displayName: s.displayName,
      platform: s.platform,
      avatar: s.avatar
    }))
  };

  const validSuspectIds = Array.isArray(currentItem.suspectIds) && currentItem.suspectIds.length > 0
    ? currentItem.suspectIds
    : [currentItem.suspectId];

  room.players.forEach(p => {
    const isOwnRepost = !!(p.linkedSuspectId && validSuspectIds.includes(p.linkedSuspectId));
    io.to(p.socketId).emit('round_started', {
      ...roundPayload,
      isOwnRepost,
      totalPlayers: room.players.length
    });
  });
  broadcastRoomState(room);

  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
  }

  room.roundTimer = setTimeout(() => {
    endRound(room);
  }, room.settings.roundTime * 1000);
}

// End round and reveal results
function endRound(room) {
  if (room.status !== 'playing') return;
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  room.status = 'reveal';
  const currentItem = room.rounds[room.currentRoundIndex];
  const validSuspectIds = Array.isArray(currentItem.suspectIds) && currentItem.suspectIds.length > 0 
    ? currentItem.suspectIds 
    : [currentItem.suspectId];

  const matchingSuspects = room.suspects.filter(s => validSuspectIds.includes(s.id));
  const isSharedRepost = matchingSuspects.length > 1;

  let correctSuspect;
  if (isSharedRepost) {
    correctSuspect = {
      id: validSuspectIds.join('_'),
      username: matchingSuspects.map(s => s.username).join(' & @'),
      displayName: matchingSuspects.map(s => s.displayName || ('@' + s.username)).join(' & '),
      avatar: matchingSuspects[0].avatar,
      avatars: matchingSuspects.map(s => s.avatar),
      platform: matchingSuspects[0].platform,
      isShared: true,
      sharedSuspects: matchingSuspects.map(s => ({
        id: s.id,
        username: s.username,
        displayName: s.displayName,
        avatar: s.avatar
      }))
    };
  } else {
    const s = matchingSuspects[0] || room.suspects.find(s => s.id === currentItem.suspectId) || {
      id: currentItem.suspectId,
      username: 'Bilinmeyen Arkadaş',
      displayName: 'Bilinmeyen',
      avatar: 'https://ui-avatars.com/api/?name=Anon&background=333&color=fff'
    };
    correctSuspect = {
      id: s.id,
      username: s.username,
      displayName: s.displayName,
      avatar: s.avatar,
      platform: s.platform,
      isShared: false
    };
  }

  const votesList = room.players.map(p => {
    const isOwnRepost = !!(p.linkedSuspectId && validSuspectIds.includes(p.linkedSuspectId));
    const v = room.currentVotes[p.id];
    const guessedSuspect = v ? room.suspects.find(s => s.id === v.suspectId) : null;
    return {
      player: {
        id: p.id,
        name: p.name,
        avatar: p.avatar
      },
      isOwnRepost,
      hasVoted: !!v,
      isCorrect: isOwnRepost ? null : (v ? v.isCorrect : false),
      pointsEarned: v ? v.pointsEarned : 0,
      timeMs: v ? v.timeMs : null,
      streak: p.streak,
      guessedSuspect: guessedSuspect ? {
        id: guessedSuspect.id,
        username: guessedSuspect.username,
        displayName: guessedSuspect.displayName,
        avatar: guessedSuspect.avatar
      } : null
    };
  });

  const leaderboard = room.players
    .map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      streak: p.streak,
      correctCount: p.correctCount
    }))
    .sort((a, b) => b.score - a.score);

  const isLastRound = room.currentRoundIndex >= room.rounds.length - 1;

  io.to(room.code).emit('round_revealed', {
    roundIndex: room.currentRoundIndex + 1,
    totalRounds: room.rounds.length,
    correctSuspect: {
      id: correctSuspect.id,
      username: correctSuspect.username,
      displayName: correctSuspect.displayName,
      avatar: correctSuspect.avatar,
      platform: correctSuspect.platform
    },
    video: {
      id: currentItem.id,
      caption: currentItem.caption,
      originalAuthor: currentItem.originalAuthor,
      coverUrl: currentItem.coverUrl
    },
    votes: votesList,
    leaderboard,
    isLastRound
  });

  broadcastRoomState(room);
}

// Finish game and present podium & awards
function finishGame(room) {
  room.status = 'finished';
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
  const bestStalker = sortedPlayers[0] || null;

  const suspectStats = {};
  for (const s of room.suspects) {
    suspectStats[s.id] = { suspect: s, correctGuesses: 0, totalRounds: 0 };
  }

  for (const r of room.rounds) {
    if (suspectStats[r.suspectId]) {
      suspectStats[r.suspectId].totalRounds++;
    }
  }

  let mostGuessedSuspect = null;
  let leastGuessedSuspect = null;
  const suspectList = Object.values(suspectStats);
  if (suspectList.length > 0) {
    suspectList.sort((a, b) => b.correctGuesses - a.correctGuesses);
    mostGuessedSuspect = suspectList[0]?.suspect;
    leastGuessedSuspect = suspectList[suspectList.length - 1]?.suspect;
  }

  const payload = {
    leaderboard: sortedPlayers.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      streak: p.streak,
      correctCount: p.correctCount
    })),
    podium: {
      first: sortedPlayers[0] || null,
      second: sortedPlayers[1] || null,
      third: sortedPlayers[2] || null
    },
    awards: {
      bestStalker: bestStalker ? {
        player: bestStalker,
        title: '🕵️ En İyi Stalker',
        desc: `${bestStalker.score} puan ile arkadaşlarının repost zevkini en iyi çözen kişi!`
      } : null,
      openBook: mostGuessedSuspect ? {
        suspect: mostGuessedSuspect,
        title: '📖 Açık Kitap',
        desc: `@${mostGuessedSuspect.username} - Repost zevki o kadar bariz ki herkes şıp diye bildi!`
      } : null,
      secretAgent: leastGuessedSuspect ? {
        suspect: leastGuessedSuspect,
        title: '🥷 Gizli Ajan',
        desc: `@${leastGuessedSuspect.username} - Gizemli zevkleriyle herkesi ters köşeye yatırdı!`
      } : null
    }
  };

  io.to(room.code).emit('game_finished', payload);
  broadcastRoomState(room);
}

// Socket Connection Handler
io.on('connection', (socket) => {
  // 1. Create Room
  socket.on('create_room', ({ playerName, avatar }) => {
    const code = generateRoomCode();
    const playerId = uid('p');

    const newPlayer = {
      id: playerId,
      socketId: socket.id,
      name: playerName || 'Oyuncu',
      avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(playerName || 'Host')}`,
      score: 0,
      streak: 0,
      correctCount: 0,
      isHost: true
    };

    const room = {
      code,
      hostSocketId: socket.id,
      status: 'lobby',
      createdAt: Date.now(),
      settings: {
        roundTime: 25,
        maxRounds: 10
      },
      players: [newPlayer],
      suspects: [],
      repostPool: [],
      rounds: [],
      currentRoundIndex: 0,
      currentVotes: {},
      roundStartTime: 0,
      roundTimer: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    socket.emit('room_created', {
      roomCode: code,
      playerId,
      isHost: true
    });
    broadcastRoomState(room);
  });

  // 2. Join Room
  socket.on('join_room', ({ roomCode, playerName, avatar }) => {
    if (!roomCode) {
      return socket.emit('error_message', 'Oda kodu gereklidir.');
    }
    const cleanCode = roomCode.trim().toUpperCase();
    const room = rooms.get(cleanCode);

    if (!room) {
      return socket.emit('error_message', 'Oda bulunamadı. Lütfen kodu kontrol edin.');
    }

    if (room.status !== 'lobby') {
      return socket.emit('error_message', 'Bu oyunda şu an bir tur devam ediyor.');
    }

    const playerId = uid('p');
    const newPlayer = {
      id: playerId,
      socketId: socket.id,
      name: playerName || `Oyuncu ${room.players.length + 1}`,
      avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(playerName || playerId)}`,
      score: 0,
      streak: 0,
      correctCount: 0,
      isHost: false
    };

    room.players.push(newPlayer);
    socket.join(cleanCode);
    socket.data.roomCode = cleanCode;
    socket.data.playerId = playerId;

    socket.emit('room_joined', {
      roomCode: cleanCode,
      playerId,
      isHost: false
    });
    broadcastRoomState(room);
    io.to(cleanCode).emit('notification', `${newPlayer.name} odaya katıldı! 👋`);
  });

  // 3. Add Suspect (Friend)
  socket.on('add_suspect', ({ roomCode, suspect, items = [] }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;

    const suspectId = suspect.id || uid('susp');
    const existingIndex = room.suspects.findIndex(s => s.id === suspectId || s.username.toLowerCase() === suspect.username.toLowerCase());

    const suspectObj = {
      id: suspectId,
      username: suspect.username,
      displayName: suspect.displayName || suspect.username,
      platform: suspect.platform || 'tiktok',
      avatar: suspect.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(suspect.username)}&background=fe2c55&color=fff`,
      repostCount: 0
    };

    if (existingIndex >= 0) {
      room.suspects[existingIndex] = suspectObj;
    } else {
      room.suspects.push(suspectObj);
    }

    // Insert videos into repostPool with proxy URLs & canonical key merging
    if (Array.isArray(items) && items.length > 0) {
      for (const it of items) {
        addOrMergePoolItem(room, it, suspectObj.id, { addedBy: socket.data.playerId });
      }
    }

    recalculateSuspectCounts(room);

    broadcastRoomState(room);
    io.to(room.code).emit('notification', `@${suspectObj.username} şüpheli havuzuna eklendi (${suspectObj.repostCount} video)! 🎯`);
  });

  // 4. Remove Suspect
  socket.on('remove_suspect', ({ roomCode, suspectId }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;

    room.suspects = room.suspects.filter(s => s.id !== suspectId);
    // Unlink this suspect from any player who claimed it
    room.players.forEach(p => {
      if (p.linkedSuspectId === suspectId) {
        p.linkedSuspectId = null;
      }
    });

    // Remove suspectId from pool items; if an item has no other suspects, remove it from pool
    room.repostPool = room.repostPool.filter(r => {
      if (Array.isArray(r.suspectIds)) {
        r.suspectIds = r.suspectIds.filter(id => id !== suspectId);
        return r.suspectIds.length > 0;
      }
      return r.suspectId !== suspectId;
    });

    recalculateSuspectCounts(room);
    broadcastRoomState(room);
  });

  // 4b. Claim / Unclaim Suspect ("Bu Benim")
  socket.on('claim_suspect', ({ roomCode, suspectId }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;

    if (player.linkedSuspectId === suspectId) {
      // Toggle off (unclaim)
      player.linkedSuspectId = null;
      io.to(room.code).emit('notification', `${player.name} hesap sahipliğini kaldırdı.`);
    } else {
      // Unlink this suspect from any other player who may have had it
      room.players.forEach(p => {
        if (p.id !== player.id && p.linkedSuspectId === suspectId) {
          p.linkedSuspectId = null;
        }
      });
      player.linkedSuspectId = suspectId;
      const suspect = room.suspects.find(s => s.id === suspectId);
      const suspName = suspect ? `@${suspect.username}` : 'hesabı';
      io.to(room.code).emit('notification', `${player.name} ${suspName} hesabını sahiplendi! 🙋‍♂️`);
    }

    broadcastRoomState(room);
  });

  // 5. Add Reposts to Secret Pool
  socket.on('add_reposts', ({ roomCode, suspectId, items = [] }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;

    const suspect = room.suspects.find(s => s.id === suspectId);
    if (!suspect) return;

    for (const it of items) {
      addOrMergePoolItem(room, it, suspect.id, { addedBy: socket.data.playerId });
    }

    recalculateSuspectCounts(room);
    broadcastRoomState(room);
    io.to(room.code).emit('notification', `Gizli Kutu'ya @${suspect.username} için ${items.length} yeni repost eklendi! 🤫`);
  });

  // 6. Load Curated Demo Pack (Real trending TikTok videos via TikWM & reliable streams)
  socket.on('load_demo_pack', async ({ roomCode }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;

    // 4 fun demo suspects
    const demoSuspects = [
      { name: 'Berkcan', username: 'berkcan', platform: 'tiktok', avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80' },
      { name: 'Zeynep', username: 'zeynep.style', platform: 'tiktok', avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80' },
      { name: 'Emre', username: 'emre_gaming', platform: 'instagram', avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80' },
      { name: 'Selin', username: 'selin.vibes', platform: 'tiktok', avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80' }
    ];

    // Try fetching real trending TikTok videos
    let feedVideos = await fetchTikwmFeed('TR', 12);
    if (!feedVideos || feedVideos.length === 0) {
      feedVideos = await fetchTikwmFeed('US', 12);
    }

    const createdSuspects = demoSuspects.map(ds => {
      const sId = uid('susp');
      const obj = {
        id: sId,
        username: ds.username,
        displayName: ds.name,
        platform: ds.platform,
        avatar: ds.avatar,
        repostCount: 0
      };
      room.suspects.push(obj);
      return obj;
    });

    if (feedVideos && feedVideos.length >= 4) {
      feedVideos.forEach((v, idx) => {
        const assignedSuspect = createdSuspects[idx % createdSuspects.length];
        const rawPlay = v.play || v.wmplay;
        const rawCover = v.cover || v.origin_cover || '';

        addOrMergePoolItem(room, {
          platform: 'tiktok',
          url: `https://www.tiktok.com/@${v.author?.unique_id || 'creator'}/video/${v.id || uid('v')}`,
          videoUrl: rawPlay,
          coverUrl: rawCover,
          caption: v.title || '',
          duration: v.duration || 15,
          originalAuthor: {
            username: v.author?.unique_id || 'tiktok_creator',
            displayName: v.author?.nickname || v.author?.unique_id || 'TikToker',
            avatar: v.author?.avatar ? wrapProxyUrl(v.author.avatar) : `https://ui-avatars.com/api/?name=${v.author?.unique_id || 'TT'}&background=fe2c55&color=fff`
          },
          embedUrl: v.id ? `https://www.tiktok.com/embed/v2/${v.id}` : ''
        }, assignedSuspect.id);
      });
    } else {
      // Use fallback clips
      FALLBACK_DEMO_CLIPS.forEach((clip, idx) => {
        const assignedSuspect = createdSuspects[idx % createdSuspects.length];
        addOrMergePoolItem(room, {
          platform: 'tiktok',
          url: clip.url,
          videoUrl: clip.videoUrl,
          coverUrl: clip.coverUrl,
          caption: clip.caption,
          duration: 15,
          originalAuthor: clip.author,
          embedUrl: ''
        }, assignedSuspect.id);
      });
    }

    recalculateSuspectCounts(room);

    broadcastRoomState(room);
    io.to(room.code).emit('notification', `⚡ Örnek Repost Paketi yüklendi (${createdSuspects.length} arkadaş & ${room.repostPool.length} video)! 🚀`);
  });

  // 7. Update Room Settings
  socket.on('update_settings', ({ roomCode, roundTime, maxRounds }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;

    if (roundTime) room.settings.roundTime = Math.max(10, Math.min(60, parseInt(roundTime, 10)));
    if (maxRounds) room.settings.maxRounds = Math.max(3, Math.min(30, parseInt(maxRounds, 10)));

    broadcastRoomState(room);
  });

  // 8. Start Game
  socket.on('start_game', ({ roomCode }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;
    if (socket.id !== room.hostSocketId) {
      return socket.emit('error_message', 'Sadece oda kurucusu oyunu başlatabilir.');
    }

    if (room.suspects.length < 2) {
      return socket.emit('error_message', 'Oyunu başlatmak için en az 2 arkadaş (şüpheli) eklemelisiniz!');
    }

    if (room.repostPool.length < 2) {
      return socket.emit('error_message', 'Havuzda en az 2 gizli repost olmalıdır! ("Örnek Paket Yükle"yi deneyebilirsiniz).');
    }

    // Equal repost distribution across all suspects that have videos
    const usedRoundIds = new Set();
    const perSuspectPools = room.suspects.map(s => {
      const itemsForSuspect = room.repostPool
        .filter(r => (Array.isArray(r.suspectIds) && r.suspectIds.length > 0 ? r.suspectIds : [r.suspectId]).includes(s.id))
        .sort(() => Math.random() - 0.5);
      return { suspect: s, items: itemsForSuspect };
    }).filter(entry => entry.items.length > 0);

    let balancedRounds = [];
    if (perSuspectPools.length > 0) {
      const minAvailable = Math.min(...perSuspectPools.map(p => p.items.length));
      // Pick equal number from each suspect (up to minAvailable)
      for (let roundPick = 0; roundPick < minAvailable; roundPick++) {
        for (const entry of perSuspectPools) {
          const candidate = entry.items.find(it => !usedRoundIds.has(it.id));
          if (candidate) {
            usedRoundIds.add(candidate.id);
            balancedRounds.push(candidate);
          }
        }
      }
    }

    // Fallback if balancedRounds has < 2 (e.g. only 1 suspect had videos or all shared)
    if (balancedRounds.length < 2) {
      balancedRounds = [...room.repostPool].sort(() => Math.random() - 0.5);
    }

    // Shuffle final rounds order so suspects appear randomly
    room.rounds = balancedRounds.sort(() => Math.random() - 0.5);
    room.currentRoundIndex = 0;

    for (const p of room.players) {
      p.score = 0;
      p.streak = 0;
      p.correctCount = 0;
    }

    startNextRound(room);
  });

  // 9. Submit Vote
  socket.on('submit_vote', ({ roomCode, suspectId }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;

    if (room.currentVotes[player.id]) {
      return;
    }

    const currentItem = room.rounds[room.currentRoundIndex];
    if (!currentItem) return;

    const timeMs = Date.now() - room.roundStartTime;
    const roundTimeMs = room.settings.roundTime * 1000;
    const validSuspectIds = Array.isArray(currentItem.suspectIds) && currentItem.suspectIds.length > 0
      ? currentItem.suspectIds
      : [currentItem.suspectId];

    // Prevent self-voting if player has claimed this suspect!
    if (player.linkedSuspectId && validSuspectIds.includes(player.linkedSuspectId)) {
      return socket.emit('error_message', 'Bu sizin kendi repostunuz! Kendi repostunuza oy kullanamazsınız.');
    }

    const isCorrect = validSuspectIds.includes(suspectId);

    let pointsEarned = 0;
    if (isCorrect) {
      player.streak = (player.streak || 0) + 1;
      player.correctCount = (player.correctCount || 0) + 1;

      const basePoints = 1000;
      const speedBonus = Math.max(0, Math.round(500 * (1 - (timeMs / roundTimeMs))));
      const streakBonus = Math.min(500, (player.streak - 1) * 100);

      pointsEarned = basePoints + speedBonus + streakBonus;
      player.score += pointsEarned;
    } else {
      player.streak = 0;
      pointsEarned = 0;
    }

    room.currentVotes[player.id] = {
      suspectId,
      timeMs,
      pointsEarned,
      isCorrect,
      streak: player.streak
    };

    socket.emit('vote_confirmed', {
      suspectId,
      pointsEarned,
      isCorrect
    });

    // Eligible players are those whose linked account is NOT the correct suspect for this round
    const eligiblePlayers = room.players.filter(p => !(p.linkedSuspectId && validSuspectIds.includes(p.linkedSuspectId)));
    const eligibleCount = eligiblePlayers.length;
    const votedCount = Object.keys(room.currentVotes).length;

    io.to(room.code).emit('vote_progress', {
      votedCount,
      totalPlayers: eligibleCount
    });

    if (votedCount >= eligibleCount && eligibleCount > 0) {
      endRound(room);
    }
  });

  // 9b. Skip Own Round (Especially useful when testing or single-player)
  socket.on('skip_own_round', ({ roomCode }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room || room.status !== 'playing') return;
    endRound(room);
  });

  // 10. Next Round
  socket.on('next_round', ({ roomCode }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;
    if (socket.id !== room.hostSocketId) return;

    if (room.currentRoundIndex < room.rounds.length - 1) {
      room.currentRoundIndex++;
      startNextRound(room);
    } else {
      finishGame(room);
    }
  });

  // 11. Reset to Lobby
  socket.on('reset_to_lobby', ({ roomCode }) => {
    const room = rooms.get(roomCode ? roomCode.toUpperCase() : '');
    if (!room) return;

    // Allow host OR any player if room is finished
    const isHost = socket.id === room.hostSocketId;
    const isPlayerInRoom = room.players.some(p => p.socketId === socket.id);
    if (!isHost && !isPlayerInRoom && room.status !== 'finished') {
      return;
    }

    room.status = 'lobby';
    room.currentRoundIndex = 0;
    room.rounds = [];
    room.currentVotes = {};
    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }

    for (const p of room.players) {
      p.score = 0;
      p.streak = 0;
      p.correctCount = 0;
    }

    // Emit dedicated returned_to_lobby event so all players transition back to lobby screen
    io.to(room.code).emit('returned_to_lobby');
    broadcastRoomState(room);
    io.to(room.code).emit('notification', 'Oyun lobiye döndürüldü. Yeni bir maç için hazır mısınız? 🔁');
  });

  // 12. Disconnect Handler
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const leavingPlayer = room.players.find(p => p.socketId === socket.id);
    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (leavingPlayer) {
      io.to(code).emit('notification', `${leavingPlayer.name} ayrıldı.`);
    }

    if (room.players.length === 0) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      rooms.delete(code);
      return;
    }

    if (socket.id === room.hostSocketId) {
      room.hostSocketId = room.players[0].socketId;
      room.players[0].isHost = true;
      io.to(code).emit('notification', `${room.players[0].name} yeni oda kurucusu oldu! 👑`);
    }

    broadcastRoomState(room);

    if (room.status === 'playing') {
      const votedCount = Object.keys(room.currentVotes).filter(pid => 
        room.players.some(p => p.id === pid)
      ).length;
      if (votedCount >= room.players.length) {
        endRound(room);
      }
    }
  });
});

// Start Server on 0.0.0.0
server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`\n=================================================`);
  console.log(`🔥 "r3.poster" Sunucusu Başlatıldı!`);
  console.log(`📡 Yerel URL:      http://localhost:${PORT}`);
  console.log(`🌐 Wi-Fi / LAN URL: http://${lanIp}:${PORT}`);
  console.log(`=================================================\n`);
});
