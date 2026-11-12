const puppeteer = require('puppeteer-core');

async function inspectItem() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = await puppeteer.launch({
    executablePath: edgePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800', '--lang=en-US,en']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');

  let sampleItem = null;
  let source = '';

  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/api/repost/item_list') || u.includes('/api/post/item_list')) {
      try {
        const json = await res.json();
        if (json.itemList && json.itemList.length > 0 && !sampleItem) {
          sampleItem = json.itemList[0];
          source = u.includes('/repost/') ? 'REPOST API' : 'POST API';
          console.log(`\n🎉 CAPTURED ITEM FROM ${source}!`);
          console.log(`ID: ${sampleItem.id}`);
          console.log(`Description: ${sampleItem.desc}`);
          console.log(`Author: ${sampleItem.author?.uniqueId} (${sampleItem.author?.nickname})`);
          console.log(`PlayAddr: ${sampleItem.video?.playAddr}`);
          console.log(`DownloadAddr: ${sampleItem.video?.downloadAddr}`);
          console.log(`Cover: ${sampleItem.video?.cover}`);
          console.log(`Duration: ${sampleItem.video?.duration}`);
        }
      } catch (e) {}
    }
  });

  try {
    await page.goto('https://www.tiktok.com/@scout2015', { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Wait for network requests
    for (let i = 0; i < 8; i++) {
      if (sampleItem) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    console.log('Navigation note:', e.message);
  } finally {
    await browser.close();
    console.log('Done inspecting.');
  }
}

inspectItem();
