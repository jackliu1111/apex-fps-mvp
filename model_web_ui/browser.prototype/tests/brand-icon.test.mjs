import test from 'node:test';
import assert from 'node:assert/strict';
import { syncBrandIcon } from '../../../scripts/sync-brand-icon.mjs';
import { BRAND_ICON_PATH, buildFaviconSvg, svgToDataUrl } from '../../../site/brand-icon.mjs';
import { buildFaviconSvgDataUrl } from '../../../site/ready-notifier.mjs';

test('static brand icon copies in site/*.html match site/brand-icon.mjs', () => {
  assert.deepEqual(syncBrandIcon({ check: true }), [], 'run: node scripts/sync-brand-icon.mjs');
});

test('ready-notifier favicon is built from the shared brand icon', () => {
  assert.equal(buildFaviconSvgDataUrl(0), svgToDataUrl(buildFaviconSvg()));
  assert.ok(decodeURIComponent(buildFaviconSvgDataUrl(3)).includes(BRAND_ICON_PATH));
});
