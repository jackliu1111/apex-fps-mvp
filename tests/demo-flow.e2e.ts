import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('load combat demo sample and inspect review workspace', async ({ app, screen, browser }) => {
  await app.open('/');

  // 1. Initial workspace readiness
  await expect(screen.getByRole('heading', { level: 1 })).toContainText('Video Workspace');
  const demoButton = browser.locator('#demo');
  await expect(demoButton).toBeVisible();

  // 2. Click the demo button to load the 1-minute combat sample
  await demoButton.click();

  // 3. Navigation to Clip Review becomes enabled once the video is imported
  const navReview = browser.locator('#nav-review');
  await expect(navReview).toBeEnabled({ timeout: 15_000 });

  // 4. Navigate into Clip Review and verify player frame and timeline mount
  await navReview.click();
  await expect(browser.locator('#review-page')).toBeVisible();
  await expect(browser.locator('#player-frame')).toBeVisible();
  await expect(browser.locator('#selection-player-axis')).toBeVisible();

  // 5. Navigate back to Analysis Queue
  const backBtn = browser.locator('#back-analysis');
  await backBtn.click();
  await expect(browser.locator('#analysis-page')).toBeVisible();
});
