const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: process.env.REVIEW_IGNORE_HTTPS_ERRORS === '1' });
    const url = process.env.REVIEW_URL || 'http://127.0.0.1:8792/';
    let releaseVendor;
    const vendorGate = new Promise(resolve => { releaseVendor = resolve; });
    await page.route('**/assets/vendor/mediabunny.mjs', async route => {
      await vendorGate;
      await route.continue();
    });

    await page.goto(url, { waitUntil: 'commit' });
    const nav = page.locator('.app-header .navigation');
    await nav.waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.header-inner')).display === 'flex');
    for (const width of [1440, 1280, 1201, 1200, 1024, 900, 851, 768, 540, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await nav.evaluate(node => {
        const wrapped = [...node.children].filter(item => {
          const range = document.createRange();
          range.selectNodeContents(item);
          return new Set([...range.getClientRects()].map(rect => rect.top)).size > 1;
        }).map(item => item.textContent);
        const header = node.parentElement;
        return {
          wrapped,
          overflow: header.scrollWidth > header.clientWidth,
          headerHeight: header.getBoundingClientRect().height,
        };
      });
      assert.deepEqual(layout.wrapped, [], `Navigation labels should fit at ${width}px`);
      assert.equal(layout.overflow, false, `Header should fit at ${width}px`);
      if (width > 850) assert.equal(layout.headerHeight, 54, `Desktop header should stay on one row at ${width}px`);
    }

    const toggle = page.getByRole('button', { name: 'Switch language to Chinese' });
    await toggle.click({ timeout: 3000 });
    assert.equal(await page.evaluate(() => Boolean(window.reviewApp)), false);
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), '录像库');
    assert.equal(await nav.locator('#nav-analysis').textContent(), '录像库');
    assert.equal(await page.locator('#queue-count').textContent(), '0 份录像');

    releaseVendor();
    await page.waitForFunction(() => Boolean(window.reviewApp));
    assert.equal(await page.locator('#queue-count').textContent(), '0 份录像');

    await page.reload();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await page.getByRole('button', { name: /Switch language to English/ }).click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('#queue-count').textContent(), '0 recordings');
    console.log('PASS: cold-load language switch, saved locale, and responsive English header');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
