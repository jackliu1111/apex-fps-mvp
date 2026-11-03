const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { chromium } = require('/private/tmp/apex-public-check/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'docs/assets/raw');
const ASSETS_DIR = path.join(ROOT, 'docs/assets');

fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  console.log('启动自动化录屏浏览器 (1280x720)...');
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: RAW_DIR,
      size: { width: 1280, height: 720 }
    }
  });

  const page = await context.newPage();
  const video = page.video();

  console.log('正在加载页面 http://127.0.0.1:8793/ ...');
  await page.goto('http://127.0.0.1:8793/');
  await page.waitForFunction(() => window.reviewApp);

  // 注入录屏光标与字幕横幅
  await page.evaluate(() => {
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.style.cssText = `
      position: fixed;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: rgba(124, 58, 237, 0.7);
      border: 2px solid #ffffff;
      box-shadow: 0 0 10px rgba(124, 58, 237, 0.9);
      pointer-events: none;
      z-index: 9999999;
      transform: translate(-50%, -50%);
      transition: transform 0.15s, background 0.15s;
      left: 640px;
      top: 360px;
    `;
    document.body.appendChild(cursor);

    const toast = document.createElement('div');
    toast.id = 'demo-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(8px);
      color: #f8fafc;
      padding: 9px 24px;
      border-radius: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 15px;
      font-weight: 600;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      z-index: 9999999;
      transition: opacity 0.3s ease, transform 0.3s ease;
      opacity: 0;
      pointer-events: none;
    `;
    document.body.appendChild(toast);

    window.setDemoSubtitle = (text) => {
      if (!text) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(10px)';
      } else {
        toast.textContent = text;
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
      }
    };

    window.setDemoCursorPos = (x, y) => {
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    };

    window.triggerCursorClick = () => {
      cursor.style.transform = 'translate(-50%, -50%) scale(0.65)';
      cursor.style.background = 'rgba(239, 68, 68, 0.9)';
      setTimeout(() => {
        cursor.style.transform = 'translate(-50%, -50%) scale(1)';
        cursor.style.background = 'rgba(124, 58, 237, 0.7)';
      }, 180);
    };
  });

  async function subtitle(text, waitMs = 0) {
    await page.evaluate((t) => window.setDemoSubtitle(t), text);
    if (waitMs > 0) await sleep(waitMs);
  }

  async function moveTo(selectorOrCoord, steps = 16) {
    let targetX, targetY;
    if (typeof selectorOrCoord === 'string') {
      const box = await page.locator(selectorOrCoord).first().boundingBox();
      if (!box) return;
      targetX = box.x + box.width / 2;
      targetY = box.y + box.height / 2;
    } else {
      targetX = selectorOrCoord.x;
      targetY = selectorOrCoord.y;
    }

    const current = await page.evaluate(() => {
      const c = document.getElementById('demo-cursor');
      return { x: parseFloat(c.style.left) || 640, y: parseFloat(c.style.top) || 360 };
    });

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const x = current.x + (targetX - current.x) * ease;
      const y = current.y + (targetY - current.y) * ease;
      await page.evaluate(({ cx, cy }) => window.setDemoCursorPos(cx, cy), { cx: x, cy: y });
      await sleep(15);
    }
    await page.mouse.move(targetX, targetY);
  }

  async function clickTarget(selector) {
    await moveTo(selector);
    await sleep(100);
    await page.evaluate(() => window.triggerCursorClick());
    await page.locator(selector).first().click();
    await sleep(250);
  }

  console.log('执行分镜 1: 首页展示...');
  await subtitle('Apex Local Cut · 100% 浏览器本地运行', 2400);

  console.log('执行分镜 2: 载入交战样本...');
  await subtitle('支持拖入长录像 · 点击体验 1 分钟真实交战', 1000);
  await clickTarget('#demo');
  await subtitle('AI 声音模型后台分析 · 枪声候选随进度逐步浮现…', 1000);

  // 等待分析完成
  await page.waitForFunction(
    () => window.reviewApp.queue.records[0]?.status === 'complete',
    null,
    { timeout: 60000 }
  );
  await sleep(1200);

  console.log('执行分镜 3: 进入片段复核...');
  await subtitle('分析完成，发现交战候选 · 点击进入片段复核', 1000);
  await clickTarget('#queue [data-action="review"]');
  await page.locator('#review-page').waitFor();
  await page.waitForFunction(() => window.reviewApp.player.state.status === 'paused');
  await sleep(1500);

  console.log('执行分镜 4: 播放原片检查...');
  await subtitle('双时间轴联动 · Space 播放原片查看交火经过', 1000);
  await page.keyboard.press('Space'); // 播放
  await sleep(3500); // 连续播放实战交战画面
  await page.keyboard.press('Space'); // 暂停
  await sleep(1000);

  console.log('执行分镜 5: 裁剪微调与试听...');
  await subtitle('拖动手柄裁剪前后范围 · 支持 0.1 秒精确微调', 1200);
  // 微调起止范围
  await page.evaluate(() => {
    const sourceId = reviewApp.activeSourceId;
    reviewApp.workspace.trim(sourceId, 'auto:event-0.000000', { start: 12.0, end: 32.0 });
  });
  await moveTo('#selection-player-axis');
  await sleep(1200);

  await subtitle('按 Shift + Space 仅试听当前选片区间', 1000);
  await page.keyboard.press('Shift+Space');
  await sleep(3000); // 试听 3 秒
  await page.keyboard.press('Space');
  await sleep(1000);

  console.log('执行分镜 6: 提交选片与磁盘导出...');
  await subtitle('确认选片无误 · 一键提交导出至本地磁盘', 1200);

  // 模拟 OPFS 目录
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const targetDir = await root.getDirectoryHandle('Apex_Combat_Clips', { create: true });
    window.showDirectoryPicker = async () => targetDir;
  });

  await page.locator('#export-format').selectOption('webm');
  await clickTarget('#export');
  await subtitle('导出等待分析释放资源后串行流式写入磁盘…', 1500);

  // 等待导出完成
  await page.waitForFunction(
    () => window.reviewApp.workspace.view().batches[0]?.status === 'completed',
    null,
    { timeout: 60000 }
  );

  await clickTarget('#nav-exports');
  await subtitle('✨ 导出成功！成片已直接存入本地指定文件夹', 3200);
  await subtitle('', 600);

  console.log('录屏结束，关闭上下文...');
  await context.close();
  await browser.close();

  const videoFile = await video.path();
  console.log('原始录屏文件就绪:', videoFile);

  // 压制最终产物
  const mp4Out = path.join(ASSETS_DIR, 'demo-walkthrough.mp4');
  const gifOut = path.join(ASSETS_DIR, 'demo-preview.gif');
  const posterOut = path.join(ASSETS_DIR, 'demo-poster.jpg');

  console.log('压制高清 MP4 (H.264, 1280x720, faststart)...');
  execSync(
    `ffmpeg -y -i "${videoFile}" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 22 -movflags +faststart "${mp4Out}"`,
    { stdio: 'inherit' }
  );

  console.log('截取高清封面海报 demo-poster.jpg...');
  execSync(
    `ffmpeg -y -ss 00:00:15 -i "${mp4Out}" -vframes 1 -q:v 2 "${posterOut}"`,
    { stdio: 'inherit' }
  );

  console.log('生成轻量演示动图 demo-preview.gif (800x450)...');
  execSync(
    `ffmpeg -y -ss 00:00:07 -t 13 -i "${mp4Out}" -vf "fps=14,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" "${gifOut}"`,
    { stdio: 'inherit' }
  );

  console.log('====================================');
  console.log('🎉 演示视频制作完成！产物列表：');
  const statMp4 = fs.statSync(mp4Out);
  const statGif = fs.statSync(gifOut);
  const statPoster = fs.statSync(posterOut);
  console.log(`- MP4:    ${mp4Out} (${(statMp4.size / 1048576).toFixed(2)} MB)`);
  console.log(`- GIF:    ${gifOut} (${(statGif.size / 1048576).toFixed(2)} MB)`);
  console.log(`- Poster: ${posterOut} (${(statPoster.size / 1024).toFixed(1)} KB)`);
  console.log('====================================');
})();
