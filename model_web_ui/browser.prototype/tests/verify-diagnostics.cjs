const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, headless: true });
  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const url = process.env.REVIEW_URL || 'http://127.0.0.1:18812/';
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.reviewApp));
    await page.evaluate(() => window.reviewApp.ready);

    // Inject a path-containing error and ensure diagnostics sanitize it.
    await page.evaluate(() => {
      window.reviewApp.diagnosticLog.record('export', 'Failed writing C:\\Users\\Gamer\\Videos\\secret_match.mp4');
    });

    assert.equal(await page.locator('#mode-live').count(), 0, 'Legacy live mode switcher must be removed');
    assert.equal(await page.locator('#mode-offline').count(), 0, 'Legacy offline mode switcher must be removed');
    assert.equal(await page.locator('#live-workspace').count(), 0, 'Legacy live workspace container must be removed');

    const diagBtn = page.locator('#copy-diagnostics');
    assert.equal(await diagBtn.isVisible(), true, 'Diagnostics button should be visible on Clipping workspace');
    await diagBtn.click();

    await page.waitForFunction(() => document.querySelector('#copy-diagnostics')?.dataset.copied === 'true');
    const copiedText = await page.evaluate(() => navigator.clipboard.readText());
    const report = JSON.parse(copiedText);

    assert.equal(report.schemaVersion, 1);
    assert.equal('mode' in report.app, false, 'Legacy app.mode must be removed');
    assert.equal('liveCompanion' in report, false, 'Legacy liveCompanion report section must be removed');
    assert.equal(report.app.isLocalhost, true);
    assert.equal(report.securityAndCapabilities.isSecureContext, true);
    assert.equal(report.securityAndCapabilities.crossOriginIsolated, true);
    assert.equal(report.securityAndCapabilities.wasmSimd, true);
    assert.equal(report.securityAndCapabilities.webCodecs.videoDecoder, true);
    assert.equal(report.securityAndCapabilities.webCodecs.videoEncoder, true);
    assert.equal(typeof report.codecs.videoDecode.h264_1080p.supported, 'boolean');
    assert.equal(typeof report.codecs.videoEncode.h264_1080p60.supported, 'boolean');
    assert.equal(typeof report.codecs.audioEncode.aac.supported, 'boolean');
    assert.equal(report.liveMonitor.status, 'off');
    assert.equal(report.liveMonitor.active, false);
    assert.equal(report.autoIntake.status, 'unset');
    assert.equal(report.autoIntake.watching, false);
    assert.equal(report.recentErrors.length >= 1, true);
    assert.doesNotMatch(copiedText, /Gamer|secret_match\.mp4/);
    assert.match(copiedText, /<win-path>/);

    // Switch to Exports tab and verify diagnostics button stays visible and reports page='exports'.
    await page.locator('#nav-exports').click();
    assert.equal(await diagBtn.isVisible(), true, 'Diagnostics button should remain visible on Exports tab');
    const exportsReport = await page.evaluate(() => window.reviewApp.collectDiagnostics());
    assert.equal(exportsReport.app.page, 'exports');
    assert.equal(typeof exportsReport.liveMonitor.active, 'boolean');
    assert.equal(typeof exportsReport.autoIntake.watching, 'boolean');
    await page.locator('#nav-analysis').click();

    // Switch language to Chinese and verify translated label and status toast.
    await page.getByRole('button', { name: /Switch language to Chinese/ }).click();
    await page.waitForFunction(() => document.querySelector('#copy-diagnostics')?.dataset.copied !== 'true', null, { timeout: 5000 });
    assert.equal(await page.locator('#copy-diagnostics .diag-label').textContent(), '诊断');
    await diagBtn.click();
    await page.waitForFunction(() => /已复制脱敏诊断信息/.test(document.querySelector('#status')?.textContent || ''));

    assert.deepEqual(errors, []);
    console.log('PASS: diagnostics copy, sanitization, WebCodecs/WASM telemetry, and bilingual UI');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
