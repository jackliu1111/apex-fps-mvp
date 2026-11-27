import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translations } from '../../../site/i18n.js';
import {
  resolveClippingLayout,
  canAcceptWorkspaceDrop,
} from '../../../site/split-workspace-controller.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(testDir, '../../../site');

const DELETED_SITE_FILES = [
  'live-companion-ui.mjs',
  'live-proxy-buffer.mjs',
  'live-companion.css',
  'live-session.mjs',
  'live-resource-monitor.mjs',
  'global-topbar-controls.mjs',
];

const DELETED_TEST_FILES = [
  'live-session.test.mjs',
  'live-resource-monitor.test.mjs',
  'verify-live-demo.cjs',
];

function collectSiteTextFiles() {
  return fs.readdirSync(siteDir)
    .filter((name) => /\.(?:js|mjs|html|css)$/.test(name))
    .map((name) => ({
      name,
      content: fs.readFileSync(path.join(siteDir, name), 'utf8'),
    }));
}

test('obsolete live-companion, proxy-buffer, live-session, and live-resource-monitor files are deleted', () => {
  for (const name of DELETED_SITE_FILES) {
    assert.equal(
      fs.existsSync(path.join(siteDir, name)),
      false,
      `site/${name} must be deleted`,
    );
  }
  for (const name of DELETED_TEST_FILES) {
    assert.equal(
      fs.existsSync(path.join(testDir, name)),
      false,
      `tests/${name} must be deleted`,
    );
  }
});

test('site/ has zero remaining dead references to legacy live-companion, proxy, mode-switcher, or removed nav controls', () => {
  const forbiddenPatterns = [
    /live-companion-ui\.mjs/,
    /live-proxy-buffer\.mjs/,
    /live-companion\.css/,
    /live-session\.mjs/,
    /live-resource-monitor\.mjs/,
    /\bmode-switcher\b/,
    /\bmode-offline\b/,
    /\bmode-live\b/,
    /\bmode-live-dot\b/,
    /\blive-workspace\b/,
    /\bswitchWorkspaceMode\b/,
    /\bworkspaceMode\b/,
    /\bliveCompanion\b/,
    /\bsummarizeLiveCompanion\b/,
    /\bimportLiveMaster\b/,
    /#nav-review\b|id="nav-review"/,
    /#back-analysis\b|id="back-analysis"/,
    /#source-select\b|id="source-select"/,
    /\bliveDecisions\b/,
    /分析队列/,
    /\bprobeMediaRecorder\b/,
    /\bMediaRecorder\b/,
  ];

  const files = collectSiteTextFiles();
  assert.ok(files.length > 0);
  for (const { name, content } of files) {
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(content),
        false,
        `site/${name} must not match forbidden legacy pattern ${pattern}`,
      );
    }
  }
});

test('index.html exposes a single Local Clipping Workspace with strictly 2 workspace nav tabs and valid i18n bindings', () => {
  const html = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');

  // Top nav contains strictly 2 workspace buttons (#nav-analysis and #nav-exports)
  const navMatch = html.match(/<nav\b[^>]*id="offline-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(navMatch, 'index.html must contain #offline-nav');
  const navButtons = [...navMatch[1].matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(navButtons.length, 2, `Expected strictly 2 workspace nav buttons, got ${navButtons.length}`);
  assert.match(navButtons[0], /\bid="nav-analysis"/);
  assert.match(navButtons[1], /\bid="nav-exports"/);

  // Sidebar intake controls live inside Recording Library sidebar; removed global topbar pills & full-page empty onboarding stay absent
  assert.match(html, /id="sidebar-intake-controls"/);
  assert.match(html, /id="clipping-workspace"/);
  assert.equal(/id="global-session-controls"/.test(html), false, 'superseded #global-session-controls must be removed from app header');
  assert.equal(/id="empty-onboarding"/.test(html), false, 'superseded full-page #empty-onboarding must be removed from index.html');
  assert.equal(/id="library-topbar-slots"/.test(html), false, 'superseded static #library-topbar-slots must be removed from index.html');

  // Every data-i18n / data-i18n-title / data-i18n-aria key resolves in both en and zh
  const attrPattern = /\bdata-i18n(?:-(?:title|aria))?="([^"]+)"/g;
  const boundKeys = new Set();
  for (const match of html.matchAll(attrPattern)) {
    boundKeys.add(match[1]);
  }
  assert.ok(boundKeys.size > 40, 'Expected substantial i18n bindings in index.html');
  for (const key of boundKeys) {
    assert.equal(typeof translations.en[key], 'string', `Missing translations.en.${key}`);
    assert.ok(translations.en[key].trim().length > 0, `Empty translations.en.${key}`);
    assert.equal(typeof translations.zh[key], 'string', `Missing translations.zh.${key}`);
    assert.ok(translations.zh[key].trim().length > 0, `Empty translations.zh.${key}`);
  }

  // en and zh dictionaries stay strictly in sync, free of deleted legacy keys and forbidden terms
  const enKeys = Object.keys(translations.en).sort();
  const zhKeys = Object.keys(translations.zh).sort();
  assert.deepEqual(enKeys, zhKeys, 'translations.en and translations.zh keys must match');

  const removedLegacyKeys = [
    'mode_offline',
    'mode_live',
    'brand_secondary',
    'back_to_analysis',
    'select_recording_aria',
    'library_slot_live_placeholder',
    'library_slot_watch_placeholder',
  ];
  for (const key of removedLegacyKeys) {
    assert.equal(Object.hasOwn(translations.en, key), false, `Legacy key en.${key} must be removed`);
    assert.equal(Object.hasOwn(translations.zh, key), false, `Legacy key zh.${key} must be removed`);
  }

  const forbiddenTerms = /分析队列|analysis queue|录像库页|复核页|实时伴随模式|实时伴随代理|内置录屏器|实时模式\(demo\)|Live \(demo\)/i;
  for (const [lang, dict] of Object.entries(translations)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(forbiddenTerms.test(value), false, `${lang}.${key} contains forbidden term: ${value}`);
    }
  }
});

test('single-workspace layout and drop guards have no legacy live workspace mode', () => {
  assert.equal(resolveClippingLayout({ page: 'clipping', itemCount: 0 }), 'split');
  assert.equal(resolveClippingLayout({ page: 'clipping', itemCount: 2 }), 'split');
  assert.equal(resolveClippingLayout({ page: 'exports', itemCount: 2 }), 'exports');
  assert.equal(resolveClippingLayout({ page: 'clipping', itemCount: 2, forceStandaloneLibrary: true }), 'standalone-library');
  // Even if a caller passes legacy workspaceMode: 'live', single workspace never switches to a 'live' layout
  assert.equal(resolveClippingLayout({ page: 'clipping', workspaceMode: 'live', itemCount: 2 }), 'split');

  assert.equal(canAcceptWorkspaceDrop({ page: 'clipping', hasFiles: true }), true);
  assert.equal(canAcceptWorkspaceDrop({ page: 'clipping', hasFiles: false }), false);
  assert.equal(canAcceptWorkspaceDrop({ page: 'exports', hasFiles: true }), false);
});

test('browser verification scripts contain zero active references to deleted live mode or legacy nav controls', () => {
  const verifyFiles = fs.readdirSync(testDir)
    .filter((name) => /^verify-.*\.cjs$/.test(name))
    .sort();
  assert.ok(verifyFiles.length > 0);

  const forbiddenActivePatterns = [
    /locator\(['"]#mode-live['"]\)\.(?!count\()/,
    /locator\(['"]#mode-offline['"]\)\.(?!count\()/,
    /locator\(['"]#live-workspace['"]\)\.(?!count\()/,
    /\.liveCompanion\b/,
    /switchWorkspaceMode\b/,
    /locator\(['"]#nav-review['"]\)\.(?!count\()/,
    /locator\(['"]#back-analysis['"]\)\.(?!count\()/,
    /#source-select['"]\s*\]/,
    /#queue \[data-action=["']?review["']?\]/,
  ];

  for (const name of verifyFiles) {
    const content = fs.readFileSync(path.join(testDir, name), 'utf8');
    for (const pattern of forbiddenActivePatterns) {
      assert.equal(
        pattern.test(content),
        false,
        `tests/${name} still uses removed legacy UI selector/API ${pattern}`,
      );
    }
  }
});
