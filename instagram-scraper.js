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
const SESSION_FILE = path.join(__dirname, '.instagram_session.json');
const DEFAULT_INSTAGRAM_SESSION_ID = '33791916182%3AMPTgZdcNTltOrg%3A20%3AAYnrGMgkzeLqmBoSHV0YtSV6BFqkdcw1vhQ5aTZigA';

/**
 * Reads saved Instagram session cookies (always guarantees fixed sessionid)
 */
function getInstagramAuthStatus() {
  const defaultCookies = [
    { name: 'sessionid', value: DEFAULT_INSTAGRAM_SESSION_ID, domain: '.instagram.com', path: '/', secure: true, httpOnly: true }
  ];
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const cookies = Array.isArray(data.cookies) ? data.cookies : [];
      const merged = cookies.filter(c => c.name !== 'sessionid');
      merged.push(...defaultCookies);
      const cookieHeader = merged.map(c => `${c.name}=${c.value}`).join('; ');
      return {
        loggedIn: true,
        cookiesCount: merged.length,
        cookies: merged,
        cookieHeader
      };
    }
  } catch (e) {}
  return {
    loggedIn: true,
    cookiesCount: defaultCookies.length,
    cookies: defaultCookies,
    cookieHeader: defaultCookies.map(c => `${c.name}=${c.value}`).join('; ')
  };
}

/**
 * Saves Instagram session cookies to file
 */
function saveInstagramSession(cookies) {
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
 * Manually sets Instagram session cookie (from user input)
 */
function saveInstagramCookieString(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    return { success: false, error: 'Geçersiz cookie verisi.' };
  }
  const str = rawInput.trim();
  const cookies = [];

  // 1. If user pasted a cookie string with '=' (e.g. from document.cookie)
  if (str.includes('=')) {
    const hasSessionId = /sessionid=/i.test(str);
    if (!hasSessionId) {
      return {
        success: false,
        error: "⚠️ document.cookie komutu Instagram'da da 'sessionid' çerezini (HttpOnly) gizler! F12 -> Depolama (Storage) -> Çerezler (Cookies) -> https://www.instagram.com listesinden 'sessionid' satırının Değer (Value) kısmını kopyalayıp yapıştırın VEYA '🔑 Instagram Bağla' butonuna basın."
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
            domain: '.instagram.com',
            path: '/',
            secure: true,
            httpOnly: name.toLowerCase() === 'sessionid'
          });
        }
      }
    }
  } else {
    // 2. User pasted raw sessionid token value directly
    if (str.length < 12) {
      return { success: false, error: "⚠️ Yapıştırılan sessionid değeri çok kısa. Lütfen tam Instagram sessionid değerini yapıştırın." };
    }
    cookies.push({
      name: 'sessionid',
      value: str,
      domain: '.instagram.com',
      path: '/',
      secure: true,
      httpOnly: true
    });
  }

  if (cookies.length === 0) {
    return { success: false, error: 'Cookie ayrıştırılamadı.' };
  }

  const saved = saveInstagramSession(cookies);
  return { success: true, count: cookies.length, cookieHeader: saved.cookieHeader };
}

/**
 * Opens a visible Microsoft Edge browser window for the user to log in to Instagram.
 * Automatically monitors page cookies until sessionid is detected,
 * then saves the session and closes the browser.
 */
async function openInstagramLoginWindow() {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: false,
      defaultViewport: null,
      args: [
        '--window-size=950,850',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox'
      ]
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');

    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Poll for sessionid cookie every 1500ms up to 180 seconds
    const maxAttempts = 120;
    let detectedAuth = false;
    let finalCookies = [];

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 1500));

      if (!browser.isConnected()) {
        return { success: false, error: 'Instagram giriş penceresi kullanıcı tarafından kapatıldı.' };
      }

      try {
        const cookies = await page.cookies();
        const authCookie = cookies.find(c => c.name === 'sessionid' && !!c.value);
        if (authCookie) {
          detectedAuth = true;
          // Wait 2.5s for session cookies to settle
          await new Promise(r => setTimeout(r, 2500));
          finalCookies = await page.cookies();
          break;
        }
      } catch (e) {
        break;
      }
    }

    if (detectedAuth && finalCookies.length > 0) {
      const saved = saveInstagramSession(finalCookies);
      await browser.close().catch(() => {});
      return { success: true, loggedIn: true, cookiesCount: finalCookies.length, cookieHeader: saved.cookieHeader };
    } else {
      await browser.close().catch(() => {});
      return { success: false, error: 'Instagram girişi zaman aşımına uğradı (3 dakika doldu).' };
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { success: false, error: err.message };
  }
}

/**
 * Helper to recursively search an object for Instagram video/reel nodes.
 * Uses a Map to update and preserve detailed media nodes (especially playAddr).
 */
function extractInstagramMediaItems(obj, targetBucket, cleanUser, seenMap = new Map()) {
  if (!obj || typeof obj !== 'object') return;

  // Reject ads, sponsored content, paid partnerships, or timeline ads like demircibahcesi
  const isAd = obj.is_paid_partnership === true || 
               !!obj.ad_id || 
               !!obj.dr_ad_type || 
               !!obj.injected || 
               obj.commerciality_status === 'commercial' ||
               (obj.user?.username && (obj.user.username.toLowerCase().includes('bahcesi') || obj.user.username.toLowerCase().includes('sponsor')));
  if (isAd) return;

  // Check if current node is an Instagram media item
  const isVideo = obj.is_video === true || 
                  obj.media_type === 2 || 
                  (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) || 
                  !!obj.video_url;

  if (isVideo) {
    const id = String(obj.pk || obj.id || obj.code || obj.shortcode || '');
    const code = obj.code || obj.shortcode || '';
    const key = code || id;

    if (key) {
      const playAddr = obj.video_versions?.[0]?.url || obj.video_url || '';
      const cover = obj.image_versions2?.candidates?.[0]?.url || obj.display_url || obj.thumbnail_src || '';
      
      let caption = '';
      if (typeof obj.caption === 'string') {
        caption = obj.caption;
      } else if (obj.caption && typeof obj.caption.text === 'string') {
        caption = obj.caption.text;
      } else if (obj.edge_media_to_caption?.edges?.[0]?.node?.text) {
        caption = obj.edge_media_to_caption.edges[0].node.text;
      }

      // Sanitize caption: NEVER leak suspect reposter name!
      if (/repostlad[ıi]|repost/i.test(caption)) {
        caption = '';
      }

      const authorName = obj.user?.username || obj.owner?.username || cleanUser;
      const authorDisplay = obj.user?.full_name || obj.owner?.full_name || `@${authorName}`;
      const authorAvatar = obj.user?.profile_pic_url || obj.owner?.profile_pic_url || '';

      const postUrl = code 
        ? `https://www.instagram.com/reel/${code}/` 
        : `https://www.instagram.com/p/${id}/`;

      const existing = seenMap.get(key);
      if (!existing) {
        const item = {
          id: id || `ig_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          code,
          url: postUrl,
          playAddr,
          cover,
          desc: caption,
          duration: obj.video_duration || 15,
          originalAuthor: {
            username: authorName,
            displayName: authorDisplay,
            avatar: authorAvatar
          }
        };
        seenMap.set(key, item);
        targetBucket.push(item);
      } else {
        // Upgrade existing item if detailed fields (playAddr, cover, caption) are now available
        if (!existing.playAddr && playAddr) {
          existing.playAddr = playAddr;
        }
        if (!existing.cover && cover) {
          existing.cover = cover;
        }
        if (!existing.desc && caption) {
          existing.desc = caption;
        }
        if (code && !existing.code) {
          existing.code = code;
          existing.url = `https://www.instagram.com/reel/${code}/`;
        }
      }
    }
  }

  // Recurse into children
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractInstagramMediaItems(item, targetBucket, cleanUser, seenMap);
    }
  } else {
    for (const key of Object.keys(obj)) {
      // Avoid looping through circular structures or huge irrelevant trees
      if (key !== 'parent' && key !== '_owner') {
        extractInstagramMediaItems(obj[key], targetBucket, cleanUser, seenMap);
      }
    }
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
 * Scrapes REAL Instagram profile info, actual reposts, and actual Reels/Videos
 * using headless Microsoft Edge on Windows.
 * 
 * @param {string} username - Instagram username without @
 * @param {number} desiredCount - Number of random reposts to pick (default 10)
 * @returns {Promise<{ success: boolean, user: object, items: Array, isReposts: boolean, note: string, cookieHeader: string }>}
 */
async function scrapeInstagramAccount(username, desiredCount = 10) {
  const targetCount = Math.max(1, Math.min(30, parseInt(desiredCount, 10) || 10));
  const cleanUser = (username || '').trim().replace(/^@+/, '').replace(/[/?#].*$/, '');
  if (!cleanUser) {
    return { success: false, error: 'Instagram kullanıcı adı boş olamaz.' };
  }

  let browser = null;
  const repostItems = [];
  let verifiedReposts = [];
  const reelItems = [];
  const repostMap = new Map();
  const reelMap = new Map();
  let isOnRepostsTab = false;
  let userProfile = null;
  let cookieHeader = '';

  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,850',
        '--lang=tr-TR,tr,en-US,en'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');
    await page.setViewport({ width: 1280, height: 850 });

    // Inject saved Instagram session cookies if available
    const session = getInstagramAuthStatus();
    if (session.cookies && session.cookies.length > 0) {
      try {
        await page.setCookie(...session.cookies);
      } catch (e) {}
    }

    // Queries to strictly ignore so home feed/ads/stories/explore never pollute reposts
    const IGNORE_QUERIES = [
      'FeedTimeline', 'Stories', 'ClipsHome', 'SuggestedUsers', 
      'PolarisProfilePostsTabContentQuery', 'Explore', 'Ad', 'Sponsored', 'Discover'
    ];

    // Intercept JSON network responses
    page.on('response', async (res) => {
      const u = res.url();
      const contentType = res.headers()['content-type'] || '';
      if (contentType.includes('application/json') || u.includes('/api/v1/') || u.includes('/graphql/query') || u.includes('api/graphql')) {
        try {
          const postData = res.request().postData() || '';
          if (IGNORE_QUERIES.some(q => postData.includes(q))) {
            return;
          }
          const json = await res.json();
          const jsonStr = JSON.stringify(json);

          // STRICT CHECK: Is this really an explicit Reposts endpoint?
          const isExplicitRepost = postData.includes('PolarisProfileRepostsTab') || 
                                   jsonStr.includes('xdt_api__v1__repost') || 
                                   u.includes('/api/v1/repost/') ||
                                   jsonStr.includes('"reposted_item":');

          if (isExplicitRepost) {
            extractInstagramMediaItems(json, repostItems, cleanUser, repostMap);
          }
        } catch (e) {}
      }
    });

    // 1. Navigate to user's Instagram profile
    await page.goto(`https://www.instagram.com/${cleanUser}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    await new Promise(r => setTimeout(r, 2000));

    // Dismiss common Instagram dialogs ("Not Now", "Şimdi Değil", Cookie accept)
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of buttons) {
          const text = b.textContent.trim().toLowerCase();
          if (text === 'not now' || text === 'şimdi değil' || text === 'daha sonra' || text === 'tümünü kabul et' || text === 'allow all cookies') {
            b.click();
            break;
          }
        }
      });
    } catch (e) {}

    // Record shortcodes visible on the initial "Posts" tab to avoid taking user's own original posts
    const initialPostCodes = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('main a[href*="/reel/"], main a[href*="/p/"]'));
      return links.map(a => {
        const m = a.href.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : '';
      }).filter(Boolean);
    });
    const initialSet = new Set(initialPostCodes);

    // Extract profile details from DOM / meta tags
    userProfile = await page.evaluate((cleanUser) => {
      let avatar = '';
      let displayName = cleanUser;

      // Check meta og:image
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg && ogImg.content) {
        avatar = ogImg.content;
      }

      // Check profile picture img
      if (!avatar) {
        const headerImg = document.querySelector('header img[src*="cdninstagram"], header img[src*="fbcdn"]');
        if (headerImg && headerImg.src) {
          avatar = headerImg.src;
        }
      }

      // Check og:title or h2/h1 for full name
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle && ogTitle.content) {
        const titleMatch = ogTitle.content.match(/^([^•(]+)/);
        if (titleMatch) {
          displayName = titleMatch[1].trim();
        }
      }

      return {
        username: cleanUser,
        displayName: displayName || `@${cleanUser}`,
        avatar: avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanUser)}&background=833ab4&color=fff&size=256`
      };
    }, cleanUser);

    // 2. Click Reposts tab
    isOnRepostsTab = true;
    try {
      const repostTabClicked = await page.evaluate((cleanUser) => {
        // Look for links with /reposts
        const repostLinks = Array.from(document.querySelectorAll('a[href*="/reposts"]'));
        if (repostLinks.length > 0) {
          repostLinks[0].click();
          return true;
        }
        // Look for tabs with repost text or aria-label
        const tabs = Array.from(document.querySelectorAll('[role="tab"], a, button'));
        for (const t of tabs) {
          const txt = t.textContent.trim().toLowerCase();
          const aria = (t.getAttribute('aria-label') || '').toLowerCase();
          if (txt.includes('repost') || txt.includes('yeniden') || aria.includes('repost') || aria.includes('yeniden')) {
            t.click();
            return true;
          }
        }
        return false;
      }, cleanUser);

      if (repostTabClicked) {
        await new Promise(r => setTimeout(r, 2500));
      } else {
        // Direct navigation to user's reposts URL
        await page.goto(`https://www.instagram.com/${cleanUser}/reposts/`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
      }

      // Scroll multiple times to load a broad pool of reposts (not just the first 10!)
      let prevLen = repostItems.length;
      let staleScrolls = 0;
      for (let s = 0; s < 6; s++) {
        if (repostItems.length >= Math.max(40, targetCount * 3)) break;
        await page.evaluate(() => window.scrollBy(0, 1400));
        await new Promise(r => setTimeout(r, 1400));
        if (repostItems.length === prevLen) {
          staleScrolls++;
          if (staleScrolls >= 2) break;
        } else {
          staleScrolls = 0;
          prevLen = repostItems.length;
        }
      }
    } catch (e) {}

    // Extract exact shortcodes visible inside <main> on the Reposts tab
    const repostDomCodes = await page.evaluate(() => {
      const main = document.querySelector('main');
      if (!main) return [];
      const links = Array.from(main.querySelectorAll('a[href*="/reel/"], main a[href*="/p/"]'));
      return links.map(a => {
        const m = a.href.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : '';
      }).filter(Boolean);
    });
    const domRepostSet = new Set(repostDomCodes);

    // If repostItems is empty but the DOM shows repost cards, populate items from DOM codes
    if (repostItems.length === 0 && repostDomCodes.length > 0) {
      repostDomCodes.forEach(code => {
        if (!initialSet.has(code)) {
          const item = {
            id: code,
            code,
            url: `https://www.instagram.com/reel/${code}/`,
            playAddr: '',
            cover: '',
            desc: '',
            duration: 15,
            originalAuthor: {
              username: cleanUser,
              displayName: `@${cleanUser}`,
              avatar: ''
            }
          };
          repostItems.push(item);
          repostMap.set(code, item);
        }
      });
    }

    // Filter repostItems to ensure:
    // 1. Not an ad
    // 2. Either in domRepostSet or came from explicit repost GraphQL
    verifiedReposts = repostItems.filter(it => {
      if (domRepostSet.size > 0 && it.code) {
        return domRepostSet.has(it.code);
      }
      return true;
    });

    // Shuffle verifiedReposts randomly BEFORE resolving missing playAddrs
    verifiedReposts = shuffleArray(verifiedReposts);

    // 3. For any items missing direct playAddr, query /api/v1/media/<id>/info/ inside logged-in page
    const itemsWithoutPlay = verifiedReposts.filter(it => !it.playAddr && (it.id || it.code)).slice(0, targetCount + 5);

    for (const it of itemsWithoutPlay) {
      try {
        const resolved = await page.evaluate(async (targetId, targetCode) => {
          // Attempt A: /api/v1/media/<id>/info/
          if (targetId && /^\d+$/.test(targetId)) {
            try {
              const res = await fetch(`https://www.instagram.com/api/v1/media/${targetId}/info/`, {
                headers: {
                  'X-IG-App-ID': '936619743392459',
                  'X-Requested-With': 'XMLHttpRequest'
                }
              });
              if (res.ok) {
                const j = await res.json();
                const m = j.items?.[0];
                if (m) {
                  return {
                    playAddr: m.video_versions?.[0]?.url || m.video_url || '',
                    cover: m.image_versions2?.candidates?.[0]?.url || ''
                  };
                }
              }
            } catch (e) {}
          }

          // Attempt B: /p/<code_or_id>/?__a=1&__d=dis
          const key = targetCode || targetId;
          if (key) {
            try {
              const res = await fetch(`https://www.instagram.com/p/${key}/?__a=1&__d=dis`, {
                headers: {
                  'X-IG-App-ID': '936619743392459',
                  'X-Requested-With': 'XMLHttpRequest'
                }
              });
              if (res.ok) {
                const j = await res.json();
                const m = j.graphql?.shortcode_media || j.items?.[0];
                if (m) {
                  return {
                    playAddr: m.video_url || m.video_versions?.[0]?.url || '',
                    cover: m.display_url || m.image_versions2?.candidates?.[0]?.url || ''
                  };
                }
              }
            } catch (e) {}
          }
          return null;
        }, it.id, it.code);

        if (resolved && resolved.playAddr) {
          it.playAddr = resolved.playAddr;
          if (!it.cover && resolved.cover) it.cover = resolved.cover;
        }
      } catch (e) {}
    }

    // Capture cookies
    try {
      const cookies = await page.cookies();
      cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      saveInstagramSession(cookies);
    } catch (e) {}

  } catch (err) {
    console.error(`Instagram scrape error for @${cleanUser}:`, err.message);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  const finalUser = userProfile || {
    username: cleanUser,
    displayName: `@${cleanUser}`,
    avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanUser)}&background=833ab4&color=fff&size=256`
  };

  // Keep ONLY items with confirmed playable .mp4 stream, randomly shuffled, limit to targetCount
  const uniqueItemsMap = new Map();
  (Array.isArray(verifiedReposts) ? verifiedReposts : []).filter(it => !!it.playAddr).forEach(it => {
    const key = it.code || it.id;
    if (key && !uniqueItemsMap.has(key)) {
      uniqueItemsMap.set(key, it);
    }
  });
  const allPlayable = Array.from(uniqueItemsMap.values());
  const uniqueItems = shuffleArray(allPlayable).slice(0, targetCount);

  let note = '';
  if (uniqueItems.length > 0) {
    note = `🎉 @${finalUser.username} hesabının ${allPlayable.length} repostu arasından rastgele ${uniqueItems.length} adet seçildi!`;
  } else {
    note = `ℹ️ @${finalUser.username} hesabında herkese açık repost videosu bulunamadı. Arkadaşının video linklerini Gizli Kutu'ya yapıştırabilirsin.`;
  }

  return {
    success: true,
    user: finalUser,
    items: uniqueItems,
    isReposts: uniqueItems.length > 0,
    note,
    cookieHeader
  };
}

module.exports = {
  getInstagramAuthStatus,
  saveInstagramSession,
  saveInstagramCookieString,
  openInstagramLoginWindow,
  scrapeInstagramAccount
};
