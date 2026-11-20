import { DISPLAY_GROUPS } from './lab-display-groups.mjs';
import {
  DEFAULT_DISPLAY_THRESHOLD,
  groupScoresAtTime,
  layeredWaveColumns,
  overviewDistributionColumns,
  resolveWaveBarLayout,
} from './waveform-layers.mjs';
import { getLang, t } from './i18n.js';

export function ensureCanvasSize(canvas, fallbackWidth, fallbackHeight) {
  const dpr = Math.max(1, Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 3));
  const rawCssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
  const cssWidth = Math.max(1, Math.round(rawCssWidth || fallbackWidth));
  const cssHeight = Math.max(1, Math.round(canvas.clientHeight || fallbackHeight));
  const pixelWidth = rawCssWidth > 0 ? Math.max(1, Math.round(cssWidth * dpr)) : Math.max(canvas.width || 0, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  return { dpr, pixelWidth, pixelHeight };
}

export function resolveWaveColor(canvas, fallback = '#7b8391') {
  if (typeof getComputedStyle === 'function' && canvas) {
    return getComputedStyle(canvas).getPropertyValue('--wave-bar').trim() || fallback;
  }
  return fallback;
}

/**
 * Shared overview gunshot distribution renderer (used by both offline player overview bar
 * and live DVR progress bar).
 */
export function paintOverviewDistribution({
  canvas,
  context,
  dpr = 1,
  wave = null,
  scoreTimeline = null,
  duration,
  waveColor = '#7b8391',
  enabledGroups = null,
  threshold = DEFAULT_DISPLAY_THRESHOLD,
  padCss = 2,
}) {
  if (!canvas || !context || !(duration > 0)) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const pad = Math.round(padCss * dpr);
  const minBar = Math.max(1, Math.round(dpr));
  const layout = resolveWaveBarLayout(canvas.width, dpr, { cssStride: 2, cssBarWidth: 1, minBars: 60 });
  const columns = overviewDistributionColumns({
    wave,
    scoreTimeline,
    duration,
    width: layout.barCount,
    canvasHeight: canvas.height,
    pad,
    minBar,
    threshold,
    enabledGroups,
    smooth: layout.barStride > 1,
  });

  context.fillStyle = waveColor;
  context.globalAlpha = 0.35;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const x = i * layout.barStride;
    const w = Math.min(layout.barWidth, canvas.width - x);
    if (col.waveHeight > 0 && w > 0) context.fillRect(x, col.waveTop, w, col.waveHeight);
  }

  const gunshot = DISPLAY_GROUPS[0];
  context.fillStyle = gunshot.color;
  context.globalAlpha = 0.92;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const x = i * layout.barStride;
    const w = Math.min(layout.barWidth, canvas.width - x);
    if (col.gunshotHeight > 0 && w > 0) context.fillRect(x, col.gunshotY, w, col.gunshotHeight);
  }
  context.globalAlpha = 1;
}

/**
 * Shared layered waveform + multi-group sound event renderer (used by both offline review timeline
 * and live companion growing timeline).
 */
export function paintLayeredWaveform({
  canvas,
  context,
  dpr = 1,
  wave = null,
  scoreTimeline = null,
  start,
  end,
  waveColor = '#7b8391',
  enabledGroups = null,
  threshold = DEFAULT_DISPLAY_THRESHOLD,
  padCss = 10,
}) {
  if (!canvas || !context || !(end > start)) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const pad = Math.round(padCss * dpr);
  const minBar = Math.max(1, Math.round(dpr));
  const layout = resolveWaveBarLayout(canvas.width, dpr, { cssStride: 4, cssBarWidth: 2, minBars: 60 });
  const columns = layeredWaveColumns({
    wave,
    scoreTimeline,
    start,
    end,
    width: layout.barCount,
    canvasHeight: canvas.height,
    pad,
    minBar,
    threshold,
    enabledGroups,
    smooth: layout.barStride > 1,
  });

  // Base opaque neutral waveform contour first.
  context.globalAlpha = 1;
  context.fillStyle = waveColor;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col.state === 'unanalyzed') continue;
    const x = i * layout.barStride;
    const w = Math.min(layout.barWidth, canvas.width - x);
    if (w > 0) context.fillRect(x, col.waveTop, w, col.waveHeight);
  }

  // Non-gunshot bottom-up translucent layers first, gunshot top-down high-contrast foreground last.
  for (let pass = 1; pass <= DISPLAY_GROUPS.length; pass++) {
    const group = DISPLAY_GROUPS[pass === DISPLAY_GROUPS.length ? 0 : pass];
    let styleSet = false;
    for (let i = 0; i < columns.length; i++) {
      const layer = columns[i].layers.find((item) => item.id === group.id);
      if (!layer) continue;
      const x = i * layout.barStride;
      const w = Math.min(layout.barWidth, canvas.width - x);
      if (!(w > 0)) continue;
      if (!styleSet) {
        context.globalAlpha = layer.alpha;
        context.fillStyle = layer.color;
        styleSet = true;
      }
      context.fillRect(x, layer.y, w, layer.height);
    }
  }
  context.globalAlpha = 1;
}

/**
 * Shared DISPLAY_GROUPS layer toggle bar controller (gunshot / speech / music / impact).
 */
export function createGroupToggleBar({ host, enabledGroups, onToggle = () => {} }) {
  const buttons = new Map();
  let lastLang = null;

  function sync() {
    if (!host) return;
    if (host.getAttribute('role') !== 'group') host.setAttribute('role', 'group');
    const lang = getLang();
    const aria = t('group_toggles_aria');
    if (host.getAttribute('aria-label') !== aria) host.setAttribute('aria-label', aria);

    if (buttons.size === 0 || host.children.length !== DISPLAY_GROUPS.length) {
      buttons.clear();
      const nodes = DISPLAY_GROUPS.map((group) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'group-toggle';
        button.dataset.groupId = group.id;
        const swatch = document.createElement('span');
        swatch.className = 'group-swatch';
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.backgroundColor = group.color;
        const label = document.createElement('span');
        label.className = 'group-toggle-label';
        button.replaceChildren(swatch, label);
        button.onclick = () => {
          if (enabledGroups.has(group.id)) enabledGroups.delete(group.id);
          else enabledGroups.add(group.id);
          sync();
          onToggle(group.id);
        };
        buttons.set(group.id, { button, label });
        return button;
      });
      host.replaceChildren(...nodes);
      lastLang = null;
    }

    const langChanged = lastLang !== lang;
    lastLang = lang;
    for (const group of DISPLAY_GROUPS) {
      const entry = buttons.get(group.id);
      if (!entry) continue;
      const pressed = String(enabledGroups.has(group.id));
      if (entry.button.getAttribute('aria-pressed') !== pressed) {
        entry.button.setAttribute('aria-pressed', pressed);
      }
      if (langChanged || !entry.label.textContent) {
        const name = t(group.i18nKey);
        entry.label.textContent = name;
        entry.button.title = t('group_toggle_title', { group: name });
      }
    }
  }

  return { sync };
}

/**
 * Format raw 4-group prediction scores at a timeline timestamp for hover inspection.
 */
export function formatHoverGroupScores(scoreTimeline, time) {
  const probe = groupScoresAtTime(scoreTimeline, time);
  if (probe.status !== 'ok' || !probe.scores) return null;
  return DISPLAY_GROUPS.map((group, idx) => ({
    id: group.id,
    name: t(group.i18nKey),
    color: group.color,
    score: probe.scores[idx] || 0,
  }));
}
