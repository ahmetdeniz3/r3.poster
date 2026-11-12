const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

function getBrowserPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}
const EDGE_PATH = getBrowserPath();
const SESSION_FILE = path.join(__dirname, '.tiktok_session.json');
const DEFAULT_TIKTOK_SESSION_ID = 'acd01339e3965a9bc0ceacc648790844';

/**
 * Reads saved TikTok session cookies (always guarantees fixed sessionid)
 */
function getTikTokSession() {
  const defaultCookies = [
    { name: 'sessionid', value: DEFAULT_TIKTOK_SESSION_ID, domain: '.tiktok.com', path: '/', secure: true, httpOnly: true },
    { name: 'sessionid_ss', value: DEFAULT_TIKTOK_SESSION_ID, domain: '.tiktok.com', path: '/', secure: true, httpOnly: true },
    { name: 'sid_tt', value: DEFAULT_TIKTOK_SESSION_ID, domain: '.tiktok.com', path: '/', secure: true, httpOnly: true }
  ];
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const cookies = Array.isArray(data.cookies) ? data.cookies : [];
      const merged = cookies.filter(c => c.name !== 'sessionid' && c.name !== 'sessionid_ss' && c.name !== 'sid_tt');
      merged.push(...defaultCookies);
      const cookieHeader = merged.map(c => `${c.name}=${c.value}`).join('; ');
      return {
        hasAuth: true,
        cookies: merged,
        cookieHeader
      };
    }
  } catch (e) {}
  return {
    hasAuth: true,
    cookies: defaultCookies,
    cookieHeader: defaultCookies.map(c => `${c.name}=${c.value}`).join('; ')
  };
}

/**
 * Saves TikTok session cookies to file
 */
function saveTikTokSession(cookies) {
  if (!Array.isArray(cookies)) return { cookieHeader: '' };
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const payload = {
    cookies,
    cookieHeader,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {}
  return payload;
}

/**
 * Manually sets TikTok session cookie (from user input)
 */
function setManualTikTokCookie(input) {
  if (!input || typeof input !== 'string') {
    return { success: false, error: 'Geçersiz cookie verisi.' };
  }
  const str = input.trim();
  const cookies = [];

  // 1. If user pasted a cookie string with '=' (e.g. from document.cookie)
  if (str.includes('=')) {
    const hasSessionId = /sessionid=|sid_tt=|sessionid_ss=/.test(str);
    if (!hasSessionId) {
      return {
        success: false,
        error: "⚠️ document.cookie komutu güvenlik gereği (HttpOnly) 'sessionid' çerezini gizler! F12 -> Depolama (Storage) -> Çerezler (Cookies) -> tiktok.com listesinden 'sessionid' satırının Değer (Value) kısmını kopyalayıp yapıştırın VEYA '🔑 TikTok Bağla' butonuna basıp açılan pencerede QR okutun."
      };
    }

    // Parse key=value string
    const parts = str.split(';');
    for (const p of parts) {
      const idx = p.indexOf('=');
      if (idx !== -1) {
        const name = p.slice(0, idx).trim();
        const value = p.slice(idx + 1).trim();
        if (name && value) {
          cookies.push({
            name,
            value,
            domain: '.tiktok.com',
            path: '/'
          });
        }
      }
    }
  } else {
    // 2. User pasted raw sessionid token value directly
    if (str.length < 16) {
      return { success: false, error: "⚠️ Yapıştırılan sessionid değeri çok kısa. Lütfen tam çerez değerini yapıştırın." };
    }
    cookies.push({
      name: 'sessionid',
      value: str,
      domain: '.tiktok.com',
      path: '/'
    });
    cookies.push({
      name: 'sessionid_ss',
      value: str,
      domain: '.tiktok.com',
      path: '/'
    });
  }

  if (cookies.length === 0) {
    return { success: false, error: 'Cookie ayrıştırılamadı.' };
  }
  const saved = saveTikTokSession(cookies);
  return { success: true, count: cookies.length, cookieHeader: saved.cookieHeader };
}

/**
 * Opens a visible Microsoft Edge browser window for the user to log in to TikTok.
 * Automatically monitors page cookies until sessionid / sid_tt is detected,
 * then saves the session and closes the browser.
 */
async function openTikTokLoginWindow() {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: false,
      defaultViewport: null,
      args: [
        '--window-size=950,800',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox'
      ]
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');

    await page.goto('https://www.tiktok.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Poll for sessionid or sid_tt cookie every 1500ms up to 180 seconds
    const maxAttempts = 120;
    let detectedAuth = false;
    let finalCookies = [];

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 1500));

      if (!browser.isConnected()) {
        return { success: false, error: 'Giriş penceresi kullanıcı tarafından kapatıldı.' };
      }

      try {
        const cookies = await page.cookies();
        const authCookie = cookies.find(c => (c.name === 'sessionid' || c.name === 'sid_tt' || c.name === 'sessionid_ss') && !!c.value);
        if (authCookie) {
          detectedAuth = true;
          // Wait 2s for all login cookies to settle
          await new Promise(r => setTimeout(r, 2000));
          finalCookies = await page.cookies();
          break;
        }
      } catch (e) {
        break;
      }
    }

    if (detectedAuth && finalCookies.length > 0) {
      const saved = saveTikTokSession(finalCookies);
      await browser.close().catch(() => {});
      return { success: true, loggedIn: true, cookiesCount: finalCookies.length, cookieHeader: saved.cookieHeader };
    } else {
      await browser.close().catch(() => {});
      return { success: false, error: 'Giriş zaman aşımına uğradı (3 dakika doldu).' };
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { success: false, error: err.message };
  }
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Scrapes REAL TikTok profile info, actual reposts, and actual user videos
 * using headless Microsoft Edge on Windows.
 * Strictly excludes any explore, recommend, prefetch, or FYP feeds!
 * 
 * @param {string} username - TikTok username without @
 * @param {number} desiredCount - Number of random reposts to pick (default 10)
 * @returns {Promise<{ success: boolean, user: object, items: Array, isReposts: boolean, note: string, cookieHeader: string }>}
 */
async function scrapeTikTokAccount(username, desiredCount = 10) {
  const targetCount = Math.max(1, Math.min(30, parseInt(desiredCount, 10) || 10));
  const cleanUser = (username || '').trim().replace(/^@+/, '');
  if (!cleanUser) {
    return { success: false, error: 'Kullanıcı adı boş olamaz.' };
  }

  let browser = null;
  const repostItems = [];
  const postItems = [];
  let userProfile = null;
  let cookieHeader = '';

  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--mute-audio',
        '--renderer-process-limit=1',
        '--disable-background-networking',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,850',
        '--lang=en-US,en'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');
    await page.setViewport({ width: 1280, height: 850 });
    await page.setRequestInterception(true);

    // Inject saved TikTok session cookies if available
    const session = getTikTokSession();
    if (session.cookies && session.cookies.length > 0) {
      try {
        await page.setCookie(...session.cookies);
      } catch (e) {}
    }

    // Helper to extract item
    const extractItem = (it, cleanUser) => ({
      id: it.id,
      url: `https://www.tiktok.com/@${it.author?.uniqueId || cleanUser}/video/${it.id}`,
      playAddr: it.video?.playAddr || it.video?.downloadAddr || '',
      cover: it.video?.cover || it.video?.dynamicCover || it.video?.originCover || '',
      desc: it.desc || '',
      duration: it.video?.duration || 15,
      originalAuthor: {
        username: it.author?.uniqueId || cleanUser,
        displayName: it.author?.nickname || it.author?.uniqueId || cleanUser,
        avatar: it.author?.avatarLarger || it.author?.avatarMedium || it.author?.avatarThumb || ''
      }
    });

    let capturedPostUrl = '';
    page.on('request', req => {
      const u = req.url();
      if (u.includes('/api/post/item_list')) {
        capturedPostUrl = u;
      }
      const rType = req.resourceType();
      if (rType === 'image' || rType === 'media' || rType === 'font' || rType === 'stylesheet') {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    // Listen strictly for the user's actual post or repost item lists
    page.on('response', async (res) => {
      const u = res.url();
      const isUnrelatedFeed = u.includes('explore') || 
                              u.includes('recommend') || 
                              u.includes('prefetch') || 
                              u.includes('preload') || 
                              u.includes('story') || 
                              u.includes('feed');

      if (!isUnrelatedFeed && (u.includes('/api/repost/item_list') || u.includes('/api/post/item_list'))) {
        try {
          const json = await res.json();
          const isRepost = u.includes('/repost/');
          if (json.itemList && Array.isArray(json.itemList)) {
            json.itemList.forEach(it => {
              const itemObj = extractItem(it, cleanUser);
              if (isRepost) {
                repostItems.push(itemObj);
              } else {
                postItems.push(itemObj);
              }
            });
          }
        } catch (e) {}
      }
    });

    // Navigate to user profile
    await page.goto(`https://www.tiktok.com/@${cleanUser}`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    // Extract user profile from Universal Data Rehydration
    userProfile = await page.evaluate(() => {
      const s = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!s) return null;
      try {
        const d = JSON.parse(s.textContent);
        const u = d['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo?.user;
        if (!u) return null;
        return {
          username: u.uniqueId,
          displayName: u.nickname || u.uniqueId,
          avatar: u.avatarLarger || u.avatarMedium || u.avatarThumb || '',
          secUid: u.secUid || ''
        };
      } catch (e) {
        return null;
      }
    });

    // Dismiss modal if present
    try {
      const modalClose = await page.$('[data-e2e="modal-close-inner-button"]');
      if (modalClose) {
        await modalClose.click();
        await new Promise(r => setTimeout(r, 600));
      }
    } catch (e) {}

    // Scroll down to trigger video loading
    await page.evaluate(() => window.scrollBy(0, 800));
    await new Promise(r => setTimeout(r, 2500));

    // Look for Repost Tab
    try {
      let tabOpened = false;
      const repostTab = await page.$('[data-e2e="repost-tab"]');
      if (repostTab) {
        await repostTab.click();
        tabOpened = true;
      } else {
        // Fallback: search by text
        tabOpened = await page.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('[role="tab"], p, span, div'));
          for (const el of elements) {
            const t = el.textContent.trim().toLowerCase();
            if ((t === 'reposts' || t === 'repost' || t === 'yeniden paylaşılanlar') && el.children.length === 0) {
              el.click();
              return true;
            }
          }
          return false;
        });
      }

      if (tabOpened) {
        await new Promise(r => setTimeout(r, 1800));
        // Scroll up to 3 times to load a broad pool of reposts quickly
        let prevLen = repostItems.length;
        let staleScrolls = 0;
        for (let s = 0; s < 3; s++) {
          if (repostItems.length >= Math.max(30, targetCount * 2)) break;
          await page.evaluate(() => window.scrollBy(0, 1600));
          await new Promise(r => setTimeout(r, 1100));
          if (repostItems.length === prevLen) {
            staleScrolls++;
            if (staleScrolls >= 2) break;
          } else {
            staleScrolls = 0;
            prevLen = repostItems.length;
          }
        }
      }
    } catch (e) {}

    // In-page direct API fetch for reposts using signed request params
    if (repostItems.length === 0 && capturedPostUrl) {
      try {
        const repostUrl = capturedPostUrl.replace('/api/post/item_list', '/api/repost/item_list');
        const inPageReposts = await page.evaluate(async (u) => {
          try {
            const r = await fetch(u);
            return await r.json();
          } catch (e) {
            return null;
          }
        }, repostUrl);

        if (inPageReposts && Array.isArray(inPageReposts.itemList) && inPageReposts.itemList.length > 0) {
          inPageReposts.itemList.forEach(it => {
            repostItems.push(extractItem(it, cleanUser));
          });
        }
      } catch (e) {}
    }

    // Capture cookies (including tt_chain_token and session cookies)
    try {
      const cookies = await page.cookies();
      cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      // Also update session file with fresh cookies
      saveTikTokSession(cookies);
    } catch (e) {}

    // Fallback: scan DOM video links directly on the profile page
    const domLinks = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      return Array.from(new Set(anchors.map(a => a.href)));
    });

    if (repostItems.length === 0 && postItems.length === 0 && domLinks.length > 0) {
      domLinks.slice(0, 10).forEach(link => {
        const match = link.match(/\/video\/(\d+)/);
        const authorMatch = link.match(/@([a-zA-Z0-9._-]+)/);
        const vidId = match ? match[1] : '';
        const author = authorMatch ? authorMatch[1] : cleanUser;
        postItems.push({
          id: vidId,
          url: link,
          playAddr: '',
          cover: '',
          desc: '',
          duration: 15,
          originalAuthor: {
            username: author,
            displayName: `@${author}`,
            avatar: ''
          }
        });
      });
    }

  } catch (err) {
    console.error(`Scrape error for @${cleanUser}:`, err.message);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  const finalUser = userProfile || {
    username: cleanUser,
    displayName: `@${cleanUser}`,
    avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanUser)}&background=fe2c55&color=fff&bold=true&size=256`,
    secUid: ''
  };

  // Prioritize actual Reposts, fallback to actual Posts
  let chosenItems = [];
  let isReposts = false;

  if (repostItems.length > 0) {
    chosenItems = repostItems;
    isReposts = true;
  } else if (postItems.length > 0) {
    chosenItems = postItems;
    isReposts = false;
  }

  // De-duplicate by ID, shuffle ALL collected items randomly, then pick targetCount!
  const uniqueItemsMap = new Map();
  chosenItems.forEach(it => {
    if (it.id && !uniqueItemsMap.has(it.id)) {
      uniqueItemsMap.set(it.id, it);
    }
  });
  const allUnique = Array.from(uniqueItemsMap.values());
  const uniqueItems = shuffleArray(allUnique).slice(0, targetCount);

  let note = '';
  if (uniqueItems.length > 0) {
    note = isReposts
      ? `🎉 @${finalUser.username} hesabının ${allUnique.length} repostu arasından rastgele ${uniqueItems.length} adet seçildi!`
      : `✅ @${finalUser.username} hesabının ${allUnique.length} videosu arasından rastgele ${uniqueItems.length} adet seçildi!`;
  } else {
    note = `ℹ️ @${finalUser.username} profili bulundu ancak bu hesapta herkese açık video veya repost bulunamadı. Arkadaşının video linklerini Gizli Kutu'ya yapıştırabilir veya Sihirli Toplayıcı'yı (Bookmarklet) kullanabilirsin.`;
  }

  return {
    success: true,
    user: finalUser,
    items: uniqueItems,
    isReposts,
    note,
    cookieHeader
  };
}

module.exports = {
  scrapeTikTokAccount,
  getTikTokSession,
  saveTikTokSession,
  setManualTikTokCookie,
  openTikTokLoginWindow
};
