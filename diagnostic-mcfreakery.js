const puppeteer = require('puppeteer-core');
const fs = require('fs');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

(async () => {
  console.log('=== STARTING MCVE DIAGNOSTIC FOR @mcfreakery ===');
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,900',
        '--lang=en-US,en'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');
    await page.setViewport({ width: 1280, height: 900 });

    const interceptedApis = [];
    const itemLists = [];

    page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('/api/')) {
        interceptedApis.push({ url: u, status: res.status() });
      }
      if (u.includes('item_list')) {
        try {
          const body = await res.json();
          itemLists.push({ url: u, status: res.status(), body });
        } catch (e) {
          itemLists.push({ url: u, status: res.status(), error: e.message });
        }
      }
    });

    console.log('Navigating to https://www.tiktok.com/@mcfreakery ...');
    await page.goto('https://www.tiktok.com/@mcfreakery', {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    await new Promise(r => setTimeout(r, 4000));

    // 1. Log all data-e2e elements on page
    const dataE2EList = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-e2e]')).map(e => e.getAttribute('data-e2e'));
    });
    console.log('\n--- DATA-E2E ELEMENTS FOUND (count: ' + dataE2EList.length + ') ---');
    console.log(JSON.stringify(Array.from(new Set(dataE2EList)), null, 2));

    // 2. Check for login modal or close button
    const modalCloseSelector = '[data-e2e="modal-close-inner-button"]';
    const hasModalClose = await page.$(modalCloseSelector);
    console.log('\nHas login modal close button?', !!hasModalClose);
    if (hasModalClose) {
      console.log('Clicking modal close button...');
      await page.click(modalCloseSelector);
      await new Promise(r => setTimeout(r, 1000));
    }

    // 3. Inspect tabs specifically
    const tabsInfo = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"], [data-e2e*="tab"]'));
      return tabs.map(t => ({
        tag: t.tagName,
        dataE2e: t.getAttribute('data-e2e'),
        role: t.getAttribute('role'),
        text: t.textContent.trim(),
        ariaSelected: t.getAttribute('aria-selected')
      }));
    });
    console.log('\n--- TABS ON PROFILE ---');
    console.log(JSON.stringify(tabsInfo, null, 2));

    // 4. Try native click on [data-e2e="repost-tab"] or element with text "Reposts"
    const repostTab = await page.$('[data-e2e="repost-tab"]');
    console.log('\nDoes [data-e2e="repost-tab"] exist?', !!repostTab);

    if (repostTab) {
      console.log('Attempting native page.click on [data-e2e="repost-tab"] ...');
      await repostTab.click();
      await new Promise(r => setTimeout(r, 4000));
      // Scroll to trigger fetch if needed
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log('Searching for any repost button/tab by text...');
      const clickedText = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('*'));
        for (const el of els) {
          const t = el.textContent.trim().toLowerCase();
          if ((t === 'reposts' || t === 'repost' || t === 'yeniden paylaşılanlar') && el.children.length === 0) {
            el.click();
            return { found: true, tag: el.tagName, text: el.textContent };
          }
        }
        return { found: false };
      });
      console.log('Text click result:', clickedText);
      await new Promise(r => setTimeout(r, 4000));
    }

    console.log('\n--- ITEM_LIST APIS TRIGGERED ---');
    itemLists.forEach((it, idx) => {
      console.log(`\n[${idx + 1}] URL: ${it.url}`);
      console.log(`Status: ${it.status}`);
      if (it.body) {
        console.log(`Items count: ${it.body.itemList?.length || 0}`);
        console.log(`hasMore: ${it.body.hasMore}`);
        if (it.body.itemList && it.body.itemList.length > 0) {
          const sample = it.body.itemList[0];
          console.log(`Sample item id: ${sample.id}`);
          console.log(`Sample playAddr: ${sample.video?.playAddr?.slice(0, 80)}...`);
          console.log(`Sample author: ${sample.author?.uniqueId}`);
        } else {
          console.log(`Empty itemList or status code: ${it.body.statusCode}`);
        }
      }
    });

    // 5. Check cookies
    const cookies = await page.cookies();
    console.log('\n--- COOKIES CAPTURED (count: ' + cookies.length + ') ---');
    const cookieNames = cookies.map(c => c.name);
    console.log('Cookie names:', cookieNames);
    const ttChainToken = cookies.find(c => c.name === 'tt_chain_token');
    console.log('tt_chain_token present?', !!ttChainToken);
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // 6. Test playAddr streaming directly and with cookies
    if (itemLists.length > 0) {
      let testPlayAddr = null;
      for (const il of itemLists) {
        if (il.body?.itemList?.[0]?.video?.playAddr) {
          testPlayAddr = il.body.itemList[0].video.playAddr;
          break;
        }
      }

      if (testPlayAddr) {
        console.log('\n--- TESTING PLAYADDR STREAMING ---');
        console.log('Testing URL:', testPlayAddr.slice(0, 100) + '...');

        // Test without cookie
        try {
          const r1 = await fetch(testPlayAddr, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
              'Referer': 'https://www.tiktok.com/'
            }
          });
          console.log(`Fetch WITHOUT Cookie: Status ${r1.status} ${r1.statusText}, Content-Type: ${r1.headers.get('content-type')}, Length: ${r1.headers.get('content-length')}`);
        } catch (e) {
          console.log('Fetch WITHOUT Cookie error:', e.message);
        }

        // Test WITH cookie
        try {
          const r2 = await fetch(testPlayAddr, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
              'Referer': 'https://www.tiktok.com/',
              'Cookie': cookieHeader
            }
          });
          console.log(`Fetch WITH Cookie: Status ${r2.status} ${r2.statusText}, Content-Type: ${r2.headers.get('content-type')}, Length: ${r2.headers.get('content-length')}`);
        } catch (e) {
          console.log('Fetch WITH Cookie error:', e.message);
        }
      }
    }

  } catch (err) {
    console.error('Diagnostic error:', err);
  } finally {
    if (browser) await browser.close().catch(() => {});
    console.log('=== DIAGNOSTIC FINISHED ===');
  }
})();
