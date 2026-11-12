const puppeteer = require('puppeteer-core');

async function test() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800', '--lang=en-US,en']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0');

  page.on('response', async res => {
    const u = res.url();
    if (u.includes('/api/post/item_list')) {
      try {
        const text = await res.text();
        const j = JSON.parse(text);
        console.log('mcfreakery post items count:', j.itemList?.length);
        (j.itemList || []).forEach((it, i) => {
          console.log(`Video [${i+1}]: id=${it.id}, desc="${it.desc}", author=${it.author?.uniqueId}`);
        });
      } catch(e) {}
    }
  });

  await page.goto('https://www.tiktok.com/@mcfreakery', { waitUntil: 'load', timeout: 20000 });
  await page.evaluate(() => window.scrollBy(0, 600));
  await new Promise(r => setTimeout(r, 4000));
  await browser.close();
}
test();
