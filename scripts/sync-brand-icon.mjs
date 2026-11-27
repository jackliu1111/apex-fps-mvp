#!/usr/bin/env node
// Regenerates every static copy of the brand mark in site/*.html from site/brand-icon.mjs.
//   node scripts/sync-brand-icon.mjs          # rewrite files
//   node scripts/sync-brand-icon.mjs --check  # exit 1 if any file is out of sync
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRAND_ICON_GLOW,
  BRAND_ICON_PATH,
  BRAND_ICON_VIEWBOX,
  buildFaviconSvg,
  svgToDataUrl,
} from '../site/brand-icon.mjs';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site');

const faviconHref = svgToDataUrl(buildFaviconSvg());
const lensMarkup = BRAND_ICON_GLOW
  .map(({ tag, attrs }) => `<${tag} class="brand-lens" ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
  .join('');

// Each rule: [regex matching the managed element, replacement markup].
const RULES = {
  'index.html': [
    [/<link id="app-favicon"[^>]*>/, `<link id="app-favicon" rel="icon" type="image/svg+xml" href="${faviconHref}">`],
    [/<svg class="brand-defs"[\s\S]*?<\/svg>/, `<svg class="brand-defs" aria-hidden="true" focusable="false"><defs><g id="brand-icon-path"><path fill-rule="evenodd" d="${BRAND_ICON_PATH}"/></g></defs></svg>`],
    [/<svg class="brand-mark"[\s\S]*?<\/svg>/, `<svg class="brand-mark" viewBox="${BRAND_ICON_VIEWBOX}" aria-hidden="true"><use href="#brand-icon-path"/></svg>`],
    [/<svg class="welcome-mark"[\s\S]*?<\/svg>/, `<svg class="welcome-mark" viewBox="${BRAND_ICON_VIEWBOX}" aria-hidden="true">${lensMarkup}<use class="brand-body" href="#brand-icon-path"/></svg>`],
  ],
  'landing.html': [
    [/<link id="landing-favicon"[^>]*>/, `<link id="landing-favicon" rel="icon" type="image/svg+xml" href="${faviconHref}">`],
    [/<span class="brand-mark" aria-hidden="true">[\s\S]*?<\/span>/, `<span class="brand-mark" aria-hidden="true"><svg viewBox="${BRAND_ICON_VIEWBOX}" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${BRAND_ICON_PATH}"/></svg></span>`],
  ],
};

export function syncBrandIcon({ check = false } = {}) {
  const stale = [];
  for (const [file, rules] of Object.entries(RULES)) {
    const filePath = path.join(siteDir, file);
    const before = readFileSync(filePath, 'utf8');
    let after = before;
    for (const [pattern, replacement] of rules) {
      if (!pattern.test(after)) throw new Error(`${file}: managed element not found for ${pattern}`);
      after = after.replace(pattern, () => replacement);
    }
    if (after !== before) {
      stale.push(file);
      if (!check) writeFileSync(filePath, after);
    }
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = syncBrandIcon({ check });
  if (check && stale.length) {
    console.error(`Brand icon out of sync in: ${stale.join(', ')}. Run: node scripts/sync-brand-icon.mjs`);
    process.exit(1);
  }
  console.log(stale.length ? `${check ? 'Stale' : 'Updated'}: ${stale.join(', ')}` : 'Brand icon already in sync.');
}
