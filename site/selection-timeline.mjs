import { createSelectionEvidence } from './selection-evidence.mjs';
import { DISPLAY_GROUPS } from './lab-display-groups.mjs';
import { DEFAULT_DISPLAY_THRESHOLD, groupScoresAtTime, layeredWaveColumns, overviewDistributionColumns, resolveWaveBarLayout } from './waveform-layers.mjs';
import { getLang, t } from './i18n.js';

export function selectionWindow(duration, { start, end }) {
  const length = Math.min(duration, (end - start) * 3);
  const zoomStart = Math.max(0, Math.min(duration - length, (start + end - length) / 2));
  return { zoomStart, zoomEnd: zoomStart + length };
}

export function createSelectionTimeline({ MB, workspace, getSource, getRecord, selectRange, seek, pause, isPlayerBusy, report,
  isActive = () => true, playPause, playRange, toggleMute, toggleFullscreen }) {
  const $ = (id) => document.getElementById(id);
  const axis = $('source-axis'), predictions = $('overview-markers');
  const stamp = (t, decimals = 1) => `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toFixed(decimals).padStart(decimals + 3, '0')}`;
  const spanDecimals = (span) => (span < 0.5 ? 3 : span < 5 ? 2 : 1);
  const ZOOM_TRANSITION_MS = 220;
  const MIN_ZOOM_SPAN = 0.04;
  let sourceId, evidenceKey, waveKey, overviewWaveKey, cachedWaveColor = null, overviewMarkerKey, markerRenderKey, frames = [], drag, overviewDrag;
  let wavePaintCount = 0, overviewPaintCount = 0;
  let overviewTarget = null;
  let displayLow = 0, displayHigh = 1, targetLow = 0, targetHigh = 1, transition = null;
  let latestEvidenceStatus = '', evidenceProvisional = false;
  const enabledGroups = new Set(DISPLAY_GROUPS.map((group) => group.id));
  const groupButtons = new Map();
  let groupToggleLang = null;
  const hoverScoreRows = new Map();
  let hoverStatusNode = null;
  let hoverScoresLang = null;
  const enabledGroupsKey = () => DISPLAY_GROUPS.map((group) => (enabledGroups.has(group.id) ? '1' : '0')).join('');
  const syncGroupToggles = () => {
    const host = $('waveform-group-toggles');
    if (!host) return;
    if (host.getAttribute('role') !== 'group') host.setAttribute('role', 'group');
    const lang = getLang();
    const aria = t('group_toggles_aria');
    if (host.getAttribute('aria-label') !== aria) host.setAttribute('aria-label', aria);
    if (groupButtons.size === 0 || host.children.length !== DISPLAY_GROUPS.length) {
      groupButtons.clear();
      const buttons = DISPLAY_GROUPS.map((group) => {
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
          syncGroupToggles();
          const current = getSource();
          if (current) {
            const [low, high] = visibleBounds(current);
            paintOverviewDistribution(current);
            paintWaveform(current, low, high);
          }
        };
        groupButtons.set(group.id, { button, label });
        return button;
      });
      host.replaceChildren(...buttons);
      groupToggleLang = null;
    }
    const langChanged = groupToggleLang !== lang;
    groupToggleLang = lang;
    for (const group of DISPLAY_GROUPS) {
      const entry = groupButtons.get(group.id);
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
  };
  const resolveWaveColor = (canvas) => {
    if (cachedWaveColor) return cachedWaveColor;
    cachedWaveColor = typeof getComputedStyle === 'function' && canvas
      ? (getComputedStyle(canvas).getPropertyValue('--wave-bar').trim() || '#7b8391')
      : '#7b8391';
    return cachedWaveColor;
  };
  const clipFor = (source) => source.clips.find((clip) => clip.id === source.review.selectedClipId && !clip.provisional && !clip.excluded);
  const windowFor = (source) => [source.review.zoomStart, source.review.zoomEnd];
  const visibleBounds = (source) => {
    const [canonicalLow, canonicalHigh] = windowFor(source);
    return transition ? [displayLow, displayHigh] : [canonicalLow, canonicalHigh];
  };
  const ticks = (node, low, high) => {
    if (!node) return;
    const decimals = spanDecimals(high - low);
    const value = [0, 0.5, 1].map((ratio) => stamp(low + ratio * (high - low), decimals));
    if (node.textContent === value.join('')) return;
    node.replaceChildren(...value.map((text) => { const span = document.createElement('span'); span.textContent = text; return span; }));
  };
  function syncEvidenceStatus() {
    const strip = $('source-filmstrip');
    if (strip) strip.dataset.provisional = String(!!(evidenceProvisional || transition));
    $('selection-player-axis').dataset.evidenceStatus = latestEvidenceStatus;
  }
  function ensureCanvasSize(canvas, fallbackWidth, fallbackHeight) {
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const rawCssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
    const cssWidth = Math.max(1, Math.round(rawCssWidth || fallbackWidth));
    const cssHeight = Math.max(1, Math.round(canvas.clientHeight || fallbackHeight));
    const pixelWidth = rawCssWidth > 0 ? Math.max(1, Math.round(cssWidth * dpr)) : Math.max(canvas.width || 0, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    return { dpr, pixelWidth, pixelHeight };
  }
  function prepareCanvasRender(source, { canvasId, fallbackWidth, fallbackHeight, colorCanvas = null, extraKey }) {
    const canvas = $(canvasId);
    const context = canvas?.getContext?.('2d');
    if (!canvas || !context) return null;
    const { dpr, pixelWidth, pixelHeight } = ensureCanvasSize(canvas, fallbackWidth, fallbackHeight);
    const waveColor = resolveWaveColor(colorCanvas || canvas);
    const wave = source.waveform;
    const record = getRecord(source.id);
    const scoreTimeline = record?.scoreTimeline || null;
    const groupFrames = scoreTimeline?.groupScoreFrames ?? 0;
    const audioOffset = scoreTimeline?.audioOffset ?? 0;
    const analysisStarted = record?.analysisStarted ?? 0;
    const renderKey = `${source.id}:${wave?.decodedUntil ?? 0}:${wave?.trackIndex ?? -1}:${groupFrames}:${audioOffset}:${analysisStarted}:${extraKey}:${pixelWidth}:${pixelHeight}:${waveColor}`;
    return {
      canvas,
      context,
      dpr,
      waveColor,
      wave,
      scoreTimeline,
      renderKey,
      syncDataset() {
        canvas.dataset.decodedUntil = String(wave?.decodedUntil ?? 0);
        canvas.dataset.groupScoreFrames = String(groupFrames);
      },
    };
  }
  function paintOverviewDistribution(source) {
    if (!source || !(source.duration > 0)) return;
    const gunshotEnabled = enabledGroups.has(DISPLAY_GROUPS[0].id);
    const state = prepareCanvasRender(source, {
      canvasId: 'player-overview-distribution',
      fallbackWidth: 1200,
      fallbackHeight: 16,
      colorCanvas: $('prediction-wave'),
      extraKey: `${source.duration}:${gunshotEnabled}`,
    });
    if (!state) return;
    const { canvas, context, dpr, waveColor, wave, scoreTimeline, renderKey, syncDataset } = state;
    if (overviewWaveKey !== renderKey) {
      overviewWaveKey = renderKey;
      context.clearRect(0, 0, canvas.width, canvas.height);
      const pad = Math.round(2 * dpr), minBar = Math.max(1, Math.round(dpr));
      const layout = resolveWaveBarLayout(canvas.width, dpr, { cssStride: 2, cssBarWidth: 1, minBars: 60 });
      const columns = overviewDistributionColumns({
        wave,
        scoreTimeline,
        duration: source.duration,
        width: layout.barCount,
        canvasHeight: canvas.height,
        pad,
        minBar,
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
      canvas.dataset.paintCount = String(++overviewPaintCount);
    }
    syncDataset();
  }
  function paintWaveform(source, low, high) {
    if (!source) return;
    const state = prepareCanvasRender(source, {
      canvasId: 'prediction-wave',
      fallbackWidth: 1200,
      fallbackHeight: 68,
      extraKey: `${enabledGroupsKey()}:${low}:${high}`,
    });
    if (!state) return;
    const { canvas, context, dpr, waveColor, wave, scoreTimeline, renderKey, syncDataset } = state;
    if (waveKey !== renderKey) {
      waveKey = renderKey;
      context.clearRect(0, 0, canvas.width, canvas.height);
      const pad = Math.round(10 * dpr), minBar = Math.max(1, Math.round(dpr));
      const layout = resolveWaveBarLayout(canvas.width, dpr, { cssStride: 4, cssBarWidth: 2, minBars: 60 });
      const columns = layeredWaveColumns({
        wave,
        scoreTimeline,
        start: low,
        end: high,
        width: layout.barCount,
        canvasHeight: canvas.height,
        pad,
        minBar,
        enabledGroups,
        smooth: layout.barStride > 1,
      });
      // Base opaque neutral waveform contour first so unanalyzed gaps stay blank and amplitude silhouette stays intact.
      context.globalAlpha = 1;
      context.fillStyle = waveColor;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (col.state === 'unanalyzed') continue;
        const x = i * layout.barStride;
        const w = Math.min(layout.barWidth, canvas.width - x);
        if (w > 0) context.fillRect(x, col.waveTop, w, col.waveHeight);
      }
      // Draw non-gunshot bottom-up translucent layers first, then gunshot top-down high-contrast foreground last.
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
      canvas.dataset.paintCount = String(++wavePaintCount);
    }
    syncDataset();
  }
  function paintMarkers(source, low, high) {
    if (!predictions || !source) return;
    const isZh = getLang() === 'zh';
    const showExcluded = !!$('show-excluded')?.checked;
    let number = 0;
    const items = source.clips
      .map((clip) => ({ ...clip, label: clip.excluded ? (isZh ? '恢复' : 'Restore') : String(++number) }))
      .filter((clip) => !clip.excluded || showExcluded);
    const visible = items.filter((item) => item.start < high && item.end > low);
    const axisWidth = predictions.clientWidth || 0;
    const effectiveAxisWidth = axisWidth > 0 ? axisWidth : 960;
    const nextMarkerKey = `${source.id}:${low}:${high}:${Math.round(axisWidth)}:${showExcluded}:${isZh}:${source.review.selectedClipId}:${items.length}:${visible.map((item) => `${item.id}:${item.start}:${item.end}:${item.excluded}:${item.provisional}:${item.supplemental}:${item.selected}:${item.label}`).join(',')}:${source.decisions.map((d) => `${d.id}:${d.kind}:${d.range.start}:${d.range.end}`).join(',')}`;
    if (markerRenderKey === nextMarkerKey) return;
    markerRenderKey = nextMarkerKey;
    const span = Math.max(1e-6, high - low);
    const groups = [];
    for (const item of visible) {
      const start = Math.max(item.start, low), end = Math.min(item.end, high);
      const leftPx = (start - low) / span * effectiveAxisWidth;
      const endPx = (end - low) / span * effectiveAxisWidth;
      const prev = groups.at(-1);
      if (prev && !prev.excluded && !item.excluded && (leftPx - prev.endPx < 11)) {
        prev.members.push(item);
        prev.end = Math.max(prev.end, end);
        prev.endPx = Math.max(prev.endPx, endPx);
        prev.rawEnd = Math.max(prev.rawEnd, item.end);
        prev.provisional = prev.provisional && !!item.provisional;
        prev.selected = prev.selected || !!item.selected;
        prev.supplemental = prev.supplemental && !!item.supplemental;
      } else {
        groups.push({
          id: item.id,
          members: [item],
          start,
          end,
          rawStart: item.start,
          rawEnd: item.end,
          leftPx,
          endPx,
          excluded: !!item.excluded,
          provisional: !!item.provisional,
          selected: !!item.selected,
          supplemental: !!item.supplemental,
        });
      }
    }
    const ids = new Set(groups.map((g) => g.id));
    for (const node of [...predictions.children]) {
      if (!ids.has(node.dataset.clipId)) {
        if (node === document.activeElement) $('selection-player-axis').focus({ preventScroll: true });
        node.remove();
      }
    }
    let previous = null;
    groups.forEach((group) => {
      let node = [...predictions.children].find((candidate) => candidate.dataset.clipId === group.id);
      if (!node) { node = document.createElement('button'); node.dataset.clipId = group.id; }
      const nextSibling = previous ? previous.nextElementSibling : predictions.firstElementChild;
      if (nextSibling !== node) predictions.insertBefore(node, nextSibling);
      previous = node;
      const leftPct = (group.start - low) / span * 100;
      const widthPct = (group.end - group.start) / span * 100;
      const widthPx = group.endPx - group.leftPx;
      const isMerged = group.members.length > 1;
      const first = group.members[0], last = group.members.at(-1);
      const displayLabel = isMerged ? `${first.label}–${last.label}` : first.label;
      node.style.left = `${leftPct}%`;
      node.style.width = `${widthPct}%`;
      node.className = [group.excluded ? 'excluded' : group.provisional ? 'provisional' : group.supplemental ? 'supplemental' : '', !group.selected && !group.excluded ? 'unselected' : ''].filter(Boolean).join(' ');
      if (widthPx < 14) node.dataset.compact = 'true';
      else delete node.dataset.compact;
      if (isMerged) node.dataset.merged = 'true';
      else delete node.dataset.merged;
      delete node.dataset.labelHidden;
      let labelEl = node.firstElementChild;
      if (!labelEl) {
        labelEl = document.createElement('span');
        labelEl.className = 'marker-label';
        node.replaceChildren(labelEl);
      }
      labelEl.style.left = '';
      if (labelEl.textContent !== displayLabel) labelEl.textContent = displayLabel;
      if (isMerged) {
        node.title = isZh
          ? `合并显示 ${group.members.length} 段候选（#${first.label}–#${last.label}）· ${stamp(group.rawStart)} — ${stamp(group.rawEnd)} · 点击定位展开`
          : `Merged ${group.members.length} candidates (#${first.label}–#${last.label}) · ${stamp(group.rawStart)} — ${stamp(group.rawEnd)} · Click to zoom`;
      } else {
        const decision = source.decisions.find((d) => d.id === first.id);
        const adjusted = decision && (decision.originRange.start !== first.start || decision.originRange.end !== first.end);
        node.title = `${first.excluded ? (isZh ? '已排除 · 点击恢复 · ' : 'Excluded · Click to restore · ') : first.selected ? '' : (isZh ? '未勾选导出 · ' : 'Unchecked for export · ')}${stamp(first.start)} — ${stamp(first.end)}${adjusted ? (isZh ? ` · 已调整，原预测 ${stamp(decision.originRange.start)} — ${stamp(decision.originRange.end)}` : ` · Adjusted from ${stamp(decision.originRange.start)} — ${stamp(decision.originRange.end)}`) : ''}`;
      }
      node.setAttribute('aria-label', node.title);
      node.setAttribute('aria-pressed', group.members.some((m) => m.id === source.review.selectedClipId));
      node.disabled = !!group.provisional;
      node.onclick = () => run(() => {
        if (group.excluded) return workspace.restoreExcluded(source.id, first.id);
        const currentIdx = group.members.findIndex((m) => m.id === getSource().review.selectedClipId);
        const targetMember = currentIdx >= 0 && currentIdx + 1 < group.members.length ? group.members[currentIdx + 1] : first;
        return selectRange(getSource().clips.find((clip) => clip.id === targetMember.id));
      });
    });
    if ($('prediction-empty')) {
      $('prediction-empty').textContent = !items.length
        ? source.clips.some((clip) => clip.excluded)
          ? (isZh ? '片段已排除，勾选“显示已排除”可查看并恢复。' : 'Clips are excluded. Check "Show excluded" to view and restore.')
          : (isZh ? '候选将随分析逐步出现，也可从当前位置添加选片。' : 'Candidates will appear as analysis proceeds; you can also add clips manually.')
        : !visible.length
          ? (isZh ? '当前视野无候选，可点击「全片」查看。' : 'No candidates in this view; fit all to inspect.')
          : '';
    }
  }
  function paintSelection(source) {
    const clip = drag?.kind !== 'head' && drag?.sourceId === source.id ? drag.range : clipFor(source);
    const [canonicalLow, canonicalHigh] = windowFor(source);
    const [low, high] = visibleBounds(source);
    const spanWindow = Math.max(1e-6, high - low);
    const percent = (t) => (t - low) / spanWindow * 100;
    const targetZoomed = canonicalLow > 1e-5 || canonicalHigh < source.duration - 1e-5;
    const isZh = getLang() === 'zh';
    const decimals = spanDecimals(high - low);
    const scopeLabel = targetZoomed
      ? (isZh ? `局部 ${stamp(low, decimals)}—${stamp(high, decimals)}` : `${stamp(low, decimals)}—${stamp(high, decimals)}`)
      : (isZh ? '全片视野' : 'Full view');
    const canonicalScopeLabel = targetZoomed
      ? `局部视野 · ${stamp(low, decimals)} — ${stamp(high, decimals)}`
      : '全片视野';
    $('selection-player-axis').dataset.zoomed = String(targetZoomed);
    $('selection-player-axis').dataset.scopeLabel = canonicalScopeLabel;
    if ($('scope-pill')) $('scope-pill').textContent = scopeLabel;
    $('selection-overlay').hidden = !clip;
    if (clip) {
      const leftPct = Math.max(0, percent(clip.start));
      const rightPct = Math.min(100, percent(clip.end));
      const widthPct = Math.max(0, rightPct - leftPct);
      $('selection-overlay').style.left = `${leftPct}%`;
      $('selection-overlay').style.width = `${widthPct}%`;
      $('selection-overlay').dataset.compact = String(!targetZoomed || widthPct < 12);
      for (const key of ['left', 'right']) {
        const node = $(`selection-${key}`), value = clip[key === 'left' ? 'start' : 'end'];
        node.hidden = value < low || value > high;
        node.setAttribute('role', 'slider');
        node.setAttribute('aria-valuemin', canonicalLow);
        node.setAttribute('aria-valuemax', canonicalHigh);
        node.setAttribute('aria-valuenow', value);
        node.setAttribute('aria-valuetext', `${stamp(value)} 秒`);
      }
    } else {
      delete $('selection-overlay').dataset.compact;
    }
    $('selection-readout').textContent = clip
      ? `${stamp(clip.start)}—${stamp(clip.end)} · ${(clip.end - clip.start).toFixed(1)}s`
      : (isZh ? '点击候选开始调整' : 'Select candidate');
    $('selection-readout').dataset.active = String(!!clip);
    const position = drag?.kind === 'head' ? drag.position : source.review.position;
    $('source-head').hidden = position < low || position > high;
    $('source-head').style.left = `${percent(position)}%`;
    $('source-head').setAttribute('aria-valuemin', canonicalLow);
    $('source-head').setAttribute('aria-valuemax', canonicalHigh);
    $('source-head').setAttribute('aria-valuenow', position);
    $('source-head').setAttribute('aria-valuetext', `${position.toFixed(2)} 秒`);
    const overviewPosition = overviewTarget ?? position;
    $('overview').max = source.duration;
    $('overview').value = overviewPosition;
    $('overview').setAttribute('aria-valuetext', `${overviewPosition.toFixed(2)} 秒 / ${source.duration.toFixed(2)} 秒`);
    if ($('overview-position')) $('overview-position').textContent = `${stamp(overviewPosition)} / ${stamp(source.duration)}`;
    const overviewSpan = Math.max(1e-6, source.duration);
    if ($('player-overview-progress')) $('player-overview-progress').style.width = `${Math.max(0, Math.min(100, overviewPosition / overviewSpan * 100))}%`;
    const zoomed = (targetZoomed || !!transition) && source.duration > 0;
    $('prediction-source-window').hidden = !zoomed;
    if (zoomed) {
      const winStart = Math.max(0, low), winEnd = Math.min(source.duration, high);
      $('prediction-source-window').style.left = `${winStart / overviewSpan * 100}%`;
      $('prediction-source-window').style.width = `${Math.max(0, winEnd - winStart) / overviewSpan * 100}%`;
      $('prediction-source-window').dataset.windowLabel = `局部视野 · ${stamp(winStart)} — ${stamp(winEnd)}`;
    }
    const headVisible = source.duration > 0 && overviewPosition >= 0 && overviewPosition <= source.duration;
    $('prediction-playhead').hidden = !headVisible;
    if (headVisible) $('prediction-playhead').style.left = `${overviewPosition / overviewSpan * 100}%`;
    if ($('player-overview-markers')) {
      const overviewItems = source.clips.filter((item) => !item.excluded && !item.provisional);
      const nextMarkerKey = `${source.id}:${overviewSpan}:${source.review.selectedClipId}:${overviewItems.map((item) => `${item.id}:${item.start}:${item.end}`).join(',')}`;
      if (overviewMarkerKey !== nextMarkerKey) {
        overviewMarkerKey = nextMarkerKey;
        $('player-overview-markers').replaceChildren(...overviewItems.map((item) => {
          const spanEl = document.createElement('span');
          spanEl.style.left = `${Math.max(0, item.start / overviewSpan * 100)}%`;
          spanEl.style.width = `${Math.max(0.6, (item.end - item.start) / overviewSpan * 100)}%`;
          spanEl.dataset.active = String(item.id === source.review.selectedClipId);
          return spanEl;
        }));
      }
    }
  }
  function paintTrack(source) {
    const [low, high] = visibleBounds(source);
    paintSelection(source);
    paintOverviewDistribution(source);
    paintWaveform(source, low, high);
    paintMarkers(source, low, high);
    ticks($('source-ticks'), low, high);
  }
  function stopTransition(snapToTarget = true) {
    if (transition?.raf) cancelAnimationFrame(transition.raf);
    if (snapToTarget) {
      displayLow = targetLow;
      displayHigh = targetHigh;
    }
    transition = null;
    delete $('selection-player-axis').dataset.transitioning;
    delete axis.dataset.transitioning;
    delete $('prediction-source-window').dataset.transitioning;
    const source = getSource();
    if (snapToTarget && source && source.id === sourceId) paintTrack(source);
    syncEvidenceStatus();
  }
  function startTransition(fromLow, fromHigh, toLow, toHigh) {
    if (transition?.raf) cancelAnimationFrame(transition.raf);
    const beforeSpan = Math.max(1e-6, fromHigh - fromLow);
    const afterSpan = Math.max(1e-6, toHigh - toLow);
    const mode = afterSpan < beforeSpan - 0.05 ? 'zoom-in' : afterSpan > beforeSpan + 0.05 ? 'zoom-out' : 'pan';
    const startedAt = performance.now();
    transition = { fromLow, fromHigh, toLow, toHigh, mode, startedAt, duration: ZOOM_TRANSITION_MS, raf: 0 };
    $('selection-player-axis').dataset.transitioning = mode;
    axis.dataset.transitioning = mode;
    $('prediction-source-window').dataset.transitioning = mode;
    syncEvidenceStatus();
    const step = (now) => {
      if (!transition) return;
      const source = getSource();
      if (!source || source.id !== sourceId) { stopTransition(true); return; }
      const elapsed = Math.max(0, now - transition.startedAt);
      const progress = Math.min(1, elapsed / transition.duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      displayLow = transition.fromLow + (transition.toLow - transition.fromLow) * eased;
      displayHigh = transition.fromHigh + (transition.toHigh - transition.fromHigh) * eased;
      if (progress >= 1) {
        stopTransition(true);
        return;
      }
      paintTrack(source);
      transition.raf = requestAnimationFrame(step);
    };
    transition.raf = requestAnimationFrame(step);
  }
  const evidence = createSelectionEvidence({ MB, isBusy: isPlayerBusy, onResult(result) {
    latestEvidenceStatus = result.status;
    evidenceProvisional = !!result.provisional;
    if (result.frames.length || (!result.provisional && !$('source-filmstrip')?.dataset.previewFrames)) {
      frames = result.frames;
      if ($('source-filmstrip')) {
        delete $('source-filmstrip').dataset.previewFrames;
        $('source-filmstrip').replaceChildren(...frames.map((frame) => {
          const image = document.createElement('img');
          image.src = frame.image;
          image.dataset.time = String(frame.time);
          image.alt = '原片参考画面';
          return image;
        }));
      }
    }
    syncEvidenceStatus();
  } });
  const run = (fn) => { try { Promise.resolve(fn()).catch(report); } catch (error) { report(error); } };
  function render(source) {
    syncGroupToggles();
    if (!source) return;
    const [low, high] = windowFor(source);
    if (sourceId !== source.id) {
      stopTransition(false);
      drag = null; overviewDrag = null; overviewTarget = null; overviewMarkerKey = null; markerRenderKey = null; sourceId = source.id;
      frames = [];
      if ($('source-filmstrip') && !$('source-filmstrip').dataset.previewFrames) $('source-filmstrip').replaceChildren();
      displayLow = targetLow = low; displayHigh = targetHigh = high;
    } else if (Math.abs(low - targetLow) > 1e-5 || Math.abs(high - targetHigh) > 1e-5) {
      const fromLow = transition ? displayLow : targetLow;
      const fromHigh = transition ? displayHigh : targetHigh;
      targetLow = low; targetHigh = high;
      if (drag) stopTransition(true);
      else startTransition(fromLow, fromHigh, low, high);
    }
    paintTrack(source);
    const record = getRecord(source.id);
    const wave = source.waveform;
    const isFallbackTrack = Boolean(wave && (record?.audioPolicy?.fallback || (Number.isInteger(record?.outputAudioTrackIndex) && wave.trackIndex !== record.outputAudioTrackIndex)));
    const statusNode = $('waveform-status');
    if (statusNode) {
      const trackNumber = wave ? wave.trackIndex + 1 : 1;
      const outputTrackNumber = (Number.isInteger(record?.outputAudioTrackIndex) ? record.outputAudioTrackIndex : (wave?.trackIndex ?? 0)) + 1;
      statusNode.dataset.trackFallback = String(isFallbackTrack);
      if (wave) statusNode.dataset.trackIndex = String(wave.trackIndex);
      else delete statusNode.dataset.trackIndex;
      statusNode.textContent = wave?.decodedUntil > 0
        ? t(isFallbackTrack ? 'wave_status_fallback' : 'wave_status_track', {
            track: trackNumber,
            outputTrack: outputTrackNumber,
            current: stamp(wave.decodedUntil),
            total: stamp(source.duration),
          })
        : source.analysis.status === 'completed'
          ? t('wave_status_empty')
          : isFallbackTrack
            ? t('wave_status_fallback_loading', { track: trackNumber, outputTrack: outputTrackNumber })
            : t('wave_status_loading');
    }
    const fullView = low <= 1e-5 && high >= source.duration - 1e-5;
    if ($('source-fit')) $('source-fit').disabled = fullView;
    if ($('prediction-zoom-out')) $('prediction-zoom-out').disabled = fullView;
    if ($('prediction-zoom')) $('prediction-zoom').disabled = high - low <= Math.min(source.duration, MIN_ZOOM_SPAN) + 1e-6;
    const key = `${source.id}:${!!record}:${low}:${high}`;
    if (evidenceKey !== key) { evidenceKey = key; evidence.request(record, low, high); }
    if ($('exclude-selection')) $('exclude-selection').disabled = !clipFor(source);
    if ($('undo-selection')) $('undo-selection').disabled = !source.canUndo;
    if ($('redo-selection')) $('redo-selection').disabled = !source.canRedo;
  }
  const exit = () => { const source = getSource(); if (source) workspace.setReview(source.id, { zoomStart: 0, zoomEnd: source.duration }); };
  if ($('source-fit')) $('source-fit').onclick = () => run(exit);
  const zoomBy = (factor) => {
    const source = getSource();
    if (!source) return;
    const [low, high] = windowFor(source);
    const minSpan = Math.min(source.duration, MIN_ZOOM_SPAN);
    const newSpan = Math.max(minSpan, Math.min(source.duration, (high - low) * factor));
    const clip = clipFor(source);
    const center = clip ? (clip.start + clip.end) / 2 : (low + high) / 2;
    const zoomStart = Math.max(0, Math.min(source.duration - newSpan, center - newSpan / 2));
    workspace.setReview(source.id, { zoomStart, zoomEnd: zoomStart + newSpan });
  };
  if ($('prediction-zoom')) $('prediction-zoom').onclick = () => run(() => zoomBy(0.5));
  if ($('prediction-zoom-out')) $('prediction-zoom-out').onclick = () => run(() => zoomBy(2));
  const overviewBar = $('player-overview-bar');
  const commitOverviewSeek = (position) => run(() => {
    const source = getSource();
    if (!source) return;
    overviewTarget = null;
    const [low, high] = windowFor(source);
    if (position < low || position > high) {
      const length = high - low, zoomStart = Math.max(0, Math.min(source.duration - length, position - length / 2));
      workspace.setReview(source.id, { zoomStart, zoomEnd: zoomStart + length });
    }
    return seek(position);
  });
  const overviewTime = (event, source) => {
    const box = overviewBar.getBoundingClientRect();
    const ratio = box.width > 0 ? Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) : 0;
    return ratio * source.duration;
  };
  if (overviewBar) {
    overviewBar.onpointerdown = (event) => run(() => {
      if (event.button !== 0 || overviewDrag) return;
      const source = getSource();
      if (!source) return;
      pause();
      const target = overviewTime(event, source);
      overviewDrag = { sourceId: source.id, pointer: event.pointerId, position: target };
      overviewTarget = target;
      overviewBar.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      paintSelection(source);
      $('selection-player-axis').focus({ preventScroll: true });
    });
    overviewBar.onpointermove = (event) => {
      if (!overviewDrag || overviewDrag.pointer !== event.pointerId) return;
      const source = getSource();
      if (!source) return;
      overviewDrag.position = overviewTime(event, source);
      overviewTarget = overviewDrag.position;
      paintSelection(source);
    };
    const endOverviewDrag = (cancel = false) => {
      if (!overviewDrag) return;
      const ended = overviewDrag;
      overviewDrag = null;
      if (overviewBar.hasPointerCapture?.(ended.pointer)) overviewBar.releasePointerCapture(ended.pointer);
      overviewTarget = null;
      const source = getSource();
      if (!cancel && source?.id === ended.sourceId) commitOverviewSeek(ended.position);
      else if (source) paintSelection(source);
    };
    overviewBar.onpointerup = () => endOverviewDrag(false);
    overviewBar.onpointercancel = () => endOverviewDrag(true);
    overviewBar.onlostpointercapture = () => endOverviewDrag(true);
  }
  $('overview').oninput = () => {
    overviewTarget = Number($('overview').value);
    pause();
    paintSelection(getSource());
  };
  $('overview').onchange = () => commitOverviewSeek(Number($('overview').value));
  $('overview').onpointercancel = () => { overviewTarget = null; paintSelection(getSource()); };
  const exclude = () => {
    const source = getSource(), clip = clipFor(source);
    if (clip) {
      workspace.exclude(source.id, clip.id);
      $('selection-player-axis').focus({ preventScroll: true });
    }
  };
  const xTime = (event, source) => {
    const box = axis.getBoundingClientRect(), [low, high] = windowFor(source);
    const left = box.x ?? box.left ?? 0;
    const width = box.width > 0 ? box.width : 1;
    return low + Math.max(0, Math.min(1, (event.clientX - left) / width)) * (high - low);
  };
  const bounded = (clip, key, value) => key === 'start'
    ? Math.max(0, Math.min(clip.end - 0.1, value))
    : Math.min(getSource().duration, Math.max(clip.start + 0.1, value));
  const hoverFrames = () => {
    if (frames.length) return frames;
    const strip = $('source-filmstrip');
    if (!strip) return [];
    return [...strip.children].map((img) => ({ time: Number(img.dataset?.time || 0), image: img.src })).filter((item) => item.image);
  };
  const updateHoverScores = (scoreInfo) => {
    const container = $('source-hover-scores');
    if (!container) return;
    if (hoverScoreRows.size === 0 || !container.children.length) {
      hoverScoreRows.clear();
      const rows = DISPLAY_GROUPS.map((group) => {
        const row = document.createElement('div');
        row.className = 'hover-score-row';
        row.dataset.groupId = group.id;
        const swatch = document.createElement('i');
        swatch.className = 'hover-score-swatch';
        swatch.setAttribute('aria-hidden', 'true');
        swatch.style.backgroundColor = group.color;
        const name = document.createElement('b');
        name.className = 'hover-score-name';
        const val = document.createElement('data');
        val.className = 'hover-score-value';
        row.replaceChildren(swatch, name, val);
        hoverScoreRows.set(group.id, { row, name, val });
        return row;
      });
      hoverStatusNode = document.createElement('div');
      hoverStatusNode.className = 'hover-score-status';
      container.replaceChildren(...rows, hoverStatusNode);
      hoverScoresLang = null;
    }
    const lang = getLang();
    const langChanged = hoverScoresLang !== lang;
    hoverScoresLang = lang;
    const ok = scoreInfo.status === 'ok' && scoreInfo.scores;
    DISPLAY_GROUPS.forEach((group, idx) => {
      const entry = hoverScoreRows.get(group.id);
      if (!entry) return;
      if (langChanged || !entry.name.textContent) entry.name.textContent = t(group.i18nKey);
      entry.row.dataset.enabled = String(enabledGroups.has(group.id));
      if (ok) {
        const raw = scoreInfo.scores[idx] ?? 0;
        entry.row.dataset.active = String(raw >= DEFAULT_DISPLAY_THRESHOLD);
        entry.val.value = raw.toFixed(4);
        entry.val.textContent = raw.toFixed(2);
      } else {
        entry.row.dataset.active = 'false';
        entry.val.value = '';
        entry.val.textContent = '—';
      }
    });
    if (hoverStatusNode) {
      hoverStatusNode.textContent = ok
        ? ''
        : t(scoreInfo.status === 'out-of-range' ? 'hover_scores_out_of_range' : 'hover_scores_unanalyzed');
    }
  };
  axis.onpointerdown = (event) => run(() => {
    if (event.button !== 0 || drag) return;
    if (event.target.closest?.('#overview-markers button')) return;
    const source = getSource(), clip = clipFor(source);
    if (transition) {
      stopTransition(true);
      paintTrack(source);
    }
    const key = event.target.id === 'selection-left' ? 'start' : event.target.id === 'selection-right' ? 'end' : null;
    if (key && !clip) return;
    pause(); $('source-hover').hidden = true;
    drag = { sourceId: source.id, pointer: event.pointerId, kind: key || 'head', clipId: clip?.id, range: clip ? { start: clip.start, end: clip.end } : null, position: xTime(event, source) };
    axis.setPointerCapture(event.pointerId); event.preventDefault();
    paintSelection(source);
    (key ? event.target : $('source-head')).focus({ preventScroll: true });
  });
  axis.onpointermove = (event) => {
    const source = getSource(); if (!source) return;
    if (drag) {
      $('source-hover').hidden = true;
      if (drag.pointer !== event.pointerId) return;
      const value = xTime(event, source);
      if (drag.kind === 'head') drag.position = value;
      else {
        drag.range[drag.kind] = bounded(drag.range, drag.kind, value);
      }
      paintSelection(source); return;
    }
    if (overviewDrag || !(source.duration > 0)) {
      $('source-hover').hidden = true;
      return;
    }
    const axisBox = axis.getBoundingClientRect?.();
    if (!axisBox || !(axisBox.width > 0)) return;
    const target = xTime(event, source);
    const [low, high] = windowFor(source);
    const decimals = spanDecimals(high - low);
    const availableFrames = hoverFrames();
    const frame = availableFrames.length
      ? availableFrames.reduce((best, next) => Math.abs(next.time - target) < Math.abs(best.time - target) ? next : best)
      : null;
    const hover = $('source-hover');
    const hostBox = $('selection-player-axis').getBoundingClientRect?.() || axisBox;
    const hostLeft = hostBox.left ?? hostBox.x ?? 0;
    const hoverWidth = hover.offsetWidth || 204;
    const hoverLeft = Math.max(16, Math.min(Math.max(16, hostBox.width - hoverWidth - 16), event.clientX - hostLeft - hoverWidth / 2));
    hover.style.left = `${hoverLeft}px`;
    hover.style.right = 'auto';
    hover.hidden = false;
    hover.dataset.time = target.toFixed(3);
    const hoverImg = $('source-hover-img') || hover.querySelector('img');
    if (hoverImg) {
      if (frame) {
        hoverImg.hidden = false;
        hoverImg.src = frame.image;
        hoverImg.alt = t('hover_sample_alt');
      } else {
        hoverImg.hidden = true;
        hoverImg.removeAttribute?.('src');
      }
    }
    const hoverLabel = $('source-hover-label') || hover.querySelector('span');
    if (hoverLabel) {
      hoverLabel.textContent = `${stamp(target, decimals)} · ${frame ? t('hover_sample_text') : t('hover_no_frame')}`;
    }
    const lookupTime = target >= source.duration ? Math.max(0, source.duration - 1e-6) : target;
    const scoreInfo = groupScoresAtTime(getRecord(source.id)?.scoreTimeline || null, lookupTime);
    hover.dataset.scoreStatus = scoreInfo.status;
    updateHoverScores(scoreInfo);
  };
  axis.onpointerleave = () => { $('source-hover').hidden = true; };
  function finish(cancel = false) {
    if (!drag) return;
    const ended = drag; drag = null;
    if (axis.hasPointerCapture(ended.pointer)) axis.releasePointerCapture(ended.pointer);
    const source = getSource(); if (source?.id !== ended.sourceId) return;
    if (!cancel) {
      if (ended.kind === 'head') run(() => seek(ended.position));
      else run(() => { workspace.trim(source.id, ended.clipId, ended.range); return seek(ended.range[ended.kind]); });
    }
    paintSelection(getSource());
  }
  axis.onpointerup = () => finish(); axis.onpointercancel = () => finish(true); axis.onlostpointercapture = () => finish(true);
  for (const [id, action] of Object.entries({ 'exclude-selection': exclude, 'undo-selection': () => workspace.undo(getSource().id), 'redo-selection': () => workspace.redo(getSource().id) })) if ($(id)) $(id).onclick = () => run(action);
  if ($('show-excluded')) $('show-excluded').onchange = () => render(getSource());
  const handleWheelGesture = ({ event, element, low, high, duration, onUpdate }) => {
    if (!isActive() || !duration) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const span = high - low;
    const anchorTime = low + ratio * span;
    const isHorizontalPan = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);

    if (isHorizontalPan) {
      event.preventDefault();
      const delta = event.shiftKey ? (event.deltaY || event.deltaX) : event.deltaX;
      if (!delta) return;
      const timeDelta = (delta / rect.width) * span;
      const newLow = Math.max(0, Math.min(duration - span, low + timeDelta));
      onUpdate(newLow, newLow + span);
    } else {
      event.preventDefault();
      if (!event.deltaY) return;
      const factor = Math.max(0.5, Math.min(2.0, 1 + event.deltaY * 0.002));
      const minSpan = Math.min(duration, MIN_ZOOM_SPAN);
      const newSpan = Math.max(minSpan, Math.min(duration, span * factor));
      const newLow = Math.max(0, Math.min(duration - newSpan, anchorTime - ratio * newSpan));
      onUpdate(newLow, newLow + newSpan);
    }
  };
  const bindWheel = (element, getBounds, onUpdate) => {
    if (!element) return;
    const handler = (event) => {
      const source = getSource(); if (!source) return;
      const [low, high] = getBounds(source);
      handleWheelGesture({
        event,
        element,
        low,
        high,
        duration: source.duration,
        onUpdate,
      });
    };
    if (typeof element.addEventListener === 'function') element.addEventListener('wheel', handler, { passive: false });
    else element.onwheel = handler;
  };
  bindWheel(axis, (source) => windowFor(source), (start, end) => workspace.setReview(getSource().id, { zoomStart: start, zoomEnd: end }));
  const keydown = (event) => {
    if (!isActive() || event.defaultPrevented || event.isComposing || !(event.target instanceof Element)) return;
    if (event.target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]:not([hidden])')) return;
    const source = getSource(); if (!source) return;
    const command = event.metaKey || event.ctrlKey;
    if (event.altKey || (command && event.key.toLowerCase() !== 'z')) return;
    if (event.key === 'Escape') {
      if (drag) { event.preventDefault(); finish(true); return; }
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        const [low, high] = windowFor(source);
        if (low > 1e-5 || high < source.duration - 1e-5) {
          event.preventDefault();
          if (!event.repeat) run(exit);
          return;
        }
      }
    }
    if (drag) return;
    const shortcutButtons = { i: 'quick-set-start', o: 'quick-set-end', k: 'toggle-current-clip', n: 'quick-manual' };
    if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); if (!event.repeat) run(() => workspace[event.shiftKey ? 'redo' : 'undo'](source.id)); }
    else if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); if (!event.repeat) run(exclude); }
    else if (event.code === 'Space') {
      event.preventDefault();
      const action = event.shiftKey ? playRange : playPause;
      if (!event.repeat && action) run(action);
    }
    else if (event.key.toLowerCase() === 'm') {
      event.preventDefault(); if (!event.repeat && toggleMute) run(toggleMute);
    }
    else if (event.key.toLowerCase() === 'f') {
      event.preventDefault(); if (!event.repeat && toggleFullscreen) run(toggleFullscreen);
    }
    else if (shortcutButtons[event.key.toLowerCase()]) {
      const btn = $(shortcutButtons[event.key.toLowerCase()]);
      if (btn && !btn.disabled) { event.preventDefault(); if (!event.repeat) btn.click(); }
    }
    else if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      const button = $(event.key === '[' ? 'prev-candidate' : 'next-candidate');
      if (!event.repeat && button && !button.disabled) button.click();
    }
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && ['selection-left', 'selection-right'].includes(event.target.id)) {
      event.preventDefault(); const clip = clipFor(source); if (!clip) return;
      const key = event.target.id === 'selection-left' ? 'start' : 'end', value = bounded(clip, key, clip[key] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1));
      run(() => { pause(); workspace.trim(source.id, clip.id, { start: clip.start, end: clip.end, [key]: value }); return seek(value); });
    }
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key) || (['source-head', 'selection-player-axis'].includes(event.target.id) && ['Home', 'End'].includes(event.key))) {
      event.preventDefault();
      const [low, high] = windowFor(source);
      run(() => {
        const position = pause()?.position ?? source.review.position;
        const target = event.key === 'Home' ? low : event.key === 'End' ? high : position + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1);
        return seek(Math.max(0, Math.min(source.duration, Math.round(target * 100) / 100)));
      });
    }
  };
  syncGroupToggles();
  window.addEventListener('keydown', keydown);
  window.addEventListener('resize', () => { cachedWaveColor = null; const current = getSource(); if (current) render(current); });
  return { render, suspend() { stopTransition(true); finish(true); overviewDrag = null; overviewTarget = null; overviewMarkerKey = null; markerRenderKey = null; evidence.cancel(); evidenceKey = null; waveKey = null; overviewWaveKey = null; cachedWaveColor = null; $('source-hover').hidden = true; } };
}
