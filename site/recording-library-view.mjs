// Pure view layer for the Recording Library (ADR 0009 + ADR 0010).
// Renders strictly from projected snapshots and emits user intents via callbacks.
// Zero dependencies on audio capture, folder watching, alignment, or media engines.

import { t as defaultTranslate } from './i18n.js';
import {
  formatLiveStatusLabel,
  formatLiveActionLabel,
  formatWatchValueLabel,
} from './session-status-labels.mjs';

function createNode(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function formatStatusLabel(item, translate) {
  switch (item.status) {
    case 'ready':
      return translate('library_status_ready');
    case 'conformed-coarse':
      return translate('library_status_conformed_coarse');
    case 'analyzing':
      return translate('library_status_analyzing', { percent: item.progressPercent ?? 0 });
    case 'unanalyzed':
    default:
      return translate('library_status_unanalyzed');
  }
}

function formatSummaryLabel(item, translate) {
  const candidates = item.candidateCount === 1
    ? translate('library_candidates_one')
    : translate('library_candidates_count', { count: item.candidateCount ?? 0 });
  if (item.exportedCount > 0) {
    return `${candidates}${translate('library_exported_suffix', { count: item.exportedCount })}`;
  }
  return candidates;
}

function formatIdentityMeta(item, { showSize, translate }) {
  const parts = [];
  if (item.recordedTimeText) parts.push(item.recordedTimeText);
  if (item.durationText) {
    parts.push(item.durationText);
  } else if (item.status === 'analyzing') {
    parts.push(translate('status_preparing'));
  }
  if (showSize && item.sizeText) parts.push(item.sizeText);
  return parts.join(' · ');
}

function formatWatchButton(watchDirectory, translate) {
  if (watchDirectory.status === 'needs-permission') return translate('library_watch_restore');
  return watchDirectory.name ? translate('library_watch_change') : translate('library_watch_choose');
}

function formatFooterSummary(counts, translate) {
  if (!counts || counts.total === 0) return translate('queue_summary_empty');
  const readyTotal = (counts.ready || 0) + (counts.coarse || 0);
  if (counts.analyzing > 0) {
    return translate('library_summary_analyzing', {
      analyzing: counts.analyzing,
      ready: readyTotal,
    });
  }
  if (readyTotal > 0) {
    return translate('library_summary_ready', { ready: readyTotal });
  }
  return translate('library_summary_unanalyzed', { unanalyzed: counts.unanalyzed || counts.total });
}

export function createRecordingLibraryView({
  listContainer,
  topbarContainer = null,
  countNode = null,
  summaryNode = null,
  pageNode = null,
  doc = listContainer?.ownerDocument || globalThis.document,
  translate = defaultTranslate,
  showActions = true,
  showSize = true,
  onReview = () => {},
  onReanalyze = () => {},
  onAnalyze = () => {},
  onStop = () => {},
  onSelect = null,
  onToggleLiveMonitor = () => {},
  onChooseWatchDirectory = () => {},
  onRowTransition = null,
  createEmptyGraphic = null,
} = {}) {
  const rowsById = new Map();
  let emptyNode = null;
  let topbarRefs = null;

  function ensureTopbar() {
    if (!topbarContainer || topbarRefs) return;

    const liveSlot = createNode(doc, 'div', 'library-slot library-live-slot');
    liveSlot.dataset.slot = 'live-monitor';
    const liveDot = createNode(doc, 'span', 'library-slot-dot');
    liveDot.setAttribute('aria-hidden', 'true');
    const liveLabel = createNode(doc, 'span', 'library-slot-label');
    const liveValue = createNode(doc, 'span', 'library-slot-value');
    const liveBtn = createNode(doc, 'button', 'quiet library-slot-btn');
    liveBtn.setAttribute('type', 'button');
    liveBtn.dataset.action = 'toggle-live-monitor';
    liveBtn.onclick = (event) => {
      event?.stopPropagation?.();
      onToggleLiveMonitor();
    };
    liveSlot.append(liveDot, liveLabel, liveValue, liveBtn);

    const watchSlot = createNode(doc, 'div', 'library-slot library-watch-slot');
    watchSlot.dataset.slot = 'watch-directory';
    const watchDot = createNode(doc, 'span', 'library-slot-dot');
    watchDot.setAttribute('aria-hidden', 'true');
    const watchLabel = createNode(doc, 'span', 'library-slot-label');
    const watchValue = createNode(doc, 'span', 'library-slot-value');
    const watchBtn = createNode(doc, 'button', 'quiet library-slot-btn');
    watchBtn.setAttribute('type', 'button');
    watchBtn.dataset.action = 'choose-watch-directory';
    watchBtn.onclick = (event) => {
      event?.stopPropagation?.();
      onChooseWatchDirectory();
    };
    watchSlot.append(watchDot, watchLabel, watchValue, watchBtn);

    topbarContainer.replaceChildren(liveSlot, watchSlot);
    topbarRefs = {
      liveSlot,
      liveLabel,
      liveValue,
      liveBtn,
      watchSlot,
      watchLabel,
      watchValue,
      watchBtn,
    };
  }

  function renderTopbar(liveMonitor, watchDirectory) {
    if (!topbarContainer) return;
    ensureTopbar();
    const live = liveMonitor || { status: 'off', active: false, canToggle: true };
    const watch = watchDirectory || { status: 'unset', name: null, canChoose: true };

    topbarRefs.liveSlot.dataset.liveStatus = live.status;
    setText(topbarRefs.liveLabel, translate('library_live_label'));
    setText(topbarRefs.liveValue, formatLiveStatusLabel(live.status, translate));
    setText(topbarRefs.liveBtn, formatLiveActionLabel(live, translate));
    topbarRefs.liveBtn.disabled = !live.canToggle;
    topbarRefs.liveBtn.setAttribute('aria-pressed', String(Boolean(live.active)));

    topbarRefs.watchSlot.dataset.watchStatus = watch.status;
    setText(topbarRefs.watchLabel, translate('library_watch_label'));
    const watchText = formatWatchValueLabel(watch, translate);
    setText(topbarRefs.watchValue, watchText);
    topbarRefs.watchValue.title = watch.name || '';
    setText(topbarRefs.watchBtn, formatWatchButton(watch, translate));
    topbarRefs.watchBtn.disabled = !watch.canChoose;
  }

  function ensureEmptyState() {
    if (!emptyNode) {
      const empty = createNode(doc, 'div', 'empty');
      if (typeof createEmptyGraphic === 'function') {
        const graphic = createEmptyGraphic();
        if (graphic) empty.append(graphic);
      }
      const title = createNode(doc, 'strong', undefined, translate('empty_drop_title'));
      title.dataset.i18n = 'empty_drop_title';
      const desc = createNode(doc, 'span', undefined, translate('empty_drop_desc'));
      desc.dataset.i18n = 'empty_drop_desc';
      const types = createNode(doc, 'small', undefined, translate('empty_drop_types'));
      types.dataset.i18n = 'empty_drop_types';
      empty.append(title, desc, types);
      emptyNode = { root: empty, title, desc, types };
    } else {
      setText(emptyNode.title, translate('empty_drop_title'));
      setText(emptyNode.desc, translate('empty_drop_desc'));
      setText(emptyNode.types, translate('empty_drop_types'));
    }
    return emptyNode.root;
  }

  function createRow(item) {
    const row = createNode(doc, 'div', 'file library-row');
    row.dataset.sourceId = item.id;

    // Block 1: Identity (basename-only filename + recorded time, duration, size)
    const identity = createNode(doc, 'div', 'file-info library-row-identity');
    const titleLine = createNode(doc, 'div', 'library-title-line');
    const filename = createNode(doc, 'strong', 'library-filename');
    const newBadge = createNode(doc, 'span', 'library-new-badge');
    newBadge.hidden = true;
    titleLine.append(filename, newBadge);
    const meta = createNode(doc, 'small', 'library-meta');
    identity.append(titleLine, meta);

    // Block 2: Single Status Badge (one of the 4 merged statuses)
    const statusWrap = createNode(doc, 'div', 'library-row-status');
    const statusBadge = createNode(doc, 'span', 'file-status library-status-badge');
    statusWrap.append(statusBadge);

    // Block 3: Result Summary (N candidates + optional · M exported)
    const summaryWrap = createNode(doc, 'div', 'library-row-summary');
    const summaryText = createNode(doc, 'span', 'library-summary-text');
    summaryWrap.append(summaryText);

    const triggerSelect = () => {
      const current = row._item;
      if (!current) return;
      if (!showActions || current.canReview) {
        (onSelect || onReview)(current.id, current);
      }
    };

    row.onclick = () => triggerSelect();

    let actionsRefs = null;
    let railRefs = null;
    if (showActions) {
      // Block 4: Minimal Action Buttons (1 primary action + secondary reanalyze ONLY for coarse)
      const actionsWrap = createNode(doc, 'div', 'row file-actions library-row-actions');
      actionsWrap.onclick = (event) => event?.stopPropagation?.();

      const reviewBtn = createNode(doc, 'button', 'library-action-btn library-action-primary');
      reviewBtn.setAttribute('type', 'button');
      reviewBtn.dataset.action = 'review';
      reviewBtn.onclick = (event) => {
        event?.stopPropagation?.();
        if (row._item) onReview(row._item.id, row._item);
      };

      const reanalyzeBtn = createNode(doc, 'button', 'quiet library-action-btn library-action-secondary');
      reanalyzeBtn.setAttribute('type', 'button');
      reanalyzeBtn.dataset.action = 'reanalyze';
      reanalyzeBtn.onclick = (event) => {
        event?.stopPropagation?.();
        if (row._item) onReanalyze(row._item.id, row._item);
      };

      const analyzeBtn = createNode(doc, 'button', 'library-action-btn library-action-primary');
      analyzeBtn.setAttribute('type', 'button');
      analyzeBtn.dataset.action = 'analyze';
      analyzeBtn.onclick = (event) => {
        event?.stopPropagation?.();
        if (row._item) onAnalyze(row._item.id, row._item);
      };

      const stopBtn = createNode(doc, 'button', 'quiet library-action-btn library-action-stop');
      stopBtn.setAttribute('type', 'button');
      stopBtn.dataset.action = 'stop';
      stopBtn.onclick = (event) => {
        event?.stopPropagation?.();
        if (row._item) onStop(row._item.id, row._item);
      };

      actionsWrap.append(reviewBtn, reanalyzeBtn, analyzeBtn, stopBtn);
      row.append(identity, statusWrap, summaryWrap, actionsWrap);
      actionsRefs = { actionsWrap, reviewBtn, reanalyzeBtn, analyzeBtn, stopBtn };
    } else {
      row.setAttribute('role', 'option');
      row.setAttribute('tabindex', '0');
      row.onkeydown = (event) => {
        if (event?.key === 'Enter' || (event?.key === ' ' && !row._item?.selected)) {
          event.preventDefault?.();
          triggerSelect();
        }
      };

      const railCell = createNode(doc, 'div', 'library-rail-cell');
      railCell.setAttribute('aria-hidden', 'true');
      const railDot = createNode(doc, 'span', 'library-rail-dot');
      const railTime = createNode(doc, 'span', 'library-rail-time');
      const railNewDot = createNode(doc, 'span', 'library-rail-new-dot');
      railNewDot.hidden = true;
      railCell.append(railDot, railTime, railNewDot);
      railRefs = { railCell, railDot, railTime, railNewDot };

      row.append(identity, statusWrap, summaryWrap, railCell);
    }

    row._refs = {
      identity,
      filename,
      newBadge,
      meta,
      statusBadge,
      summaryText,
      actionsRefs,
      railRefs,
    };
    return row;
  }

  function updateRow(row, item) {
    const prevStatus = row.dataset.status || null;
    row._item = item;
    row.dataset.sourceId = item.id;
    row.dataset.status = item.status;
    row.dataset.reviewable = String(Boolean(item.canReview));
    row.dataset.selected = String(Boolean(item.selected));
    row.dataset.new = String(Boolean(item.isNew));
    row.classList.toggle('is-selected', Boolean(item.selected));
    const statusLabel = formatStatusLabel(item, translate);
    if (!showActions) {
      row.setAttribute('aria-selected', String(Boolean(item.selected)));
      if (row.title !== item.filename) row.title = item.filename;
      const ariaParts = [item.filename, item.recordedTimeText, statusLabel].filter(Boolean);
      row.setAttribute('aria-label', ariaParts.join(' · '));
    }

    const { filename, newBadge, meta, statusBadge, summaryText, actionsRefs, railRefs } = row._refs;

    setText(filename, item.filename);
    if (filename.title !== item.filename) filename.title = item.filename;

    newBadge.hidden = !item.isNew;
    if (item.isNew) setText(newBadge, translate('library_new_badge'));

    setText(meta, formatIdentityMeta(item, { showSize, translate }));

    statusBadge.dataset.status = item.status;
    setText(statusBadge, statusLabel);

    setText(summaryText, formatSummaryLabel(item, translate));

    if (railRefs) {
      railRefs.railDot.dataset.status = item.status;
      setText(railRefs.railTime, item.recordedTimeText || '--:--');
      railRefs.railNewDot.hidden = !item.isNew;
    }

    if (actionsRefs) {
      const { reviewBtn, reanalyzeBtn, analyzeBtn, stopBtn } = actionsRefs;

      const showReview = item.primaryAction === 'review';
      reviewBtn.hidden = !showReview;
      if (showReview) setText(reviewBtn, translate('library_action_review'));

      const showReanalyze = item.secondaryAction === 'reanalyze';
      reanalyzeBtn.hidden = !showReanalyze;
      if (showReanalyze) setText(reanalyzeBtn, translate('library_action_reanalyze'));

      const showAnalyze = item.primaryAction === 'analyze';
      analyzeBtn.hidden = !showAnalyze;
      if (showAnalyze) setText(analyzeBtn, translate('library_action_analyze'));

      const showStop = item.primaryAction === 'stop';
      stopBtn.hidden = !showStop;
      if (showStop) setText(stopBtn, translate('library_action_stop'));
    }

    if (!prevStatus) return 'added';
    if (prevStatus === 'analyzing' && (item.status === 'ready' || item.status === 'conformed-coarse')) {
      return 'completed';
    }
    return null;
  }

  function render(snapshot) {
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const counts = snapshot?.counts || { total: items.length, ready: 0, coarse: 0, analyzing: 0, unanalyzed: 0 };

    if (pageNode?.classList) {
      pageNode.classList.toggle('has-recordings', items.length > 0);
    }

    if (countNode) {
      countNode.dataset.i18nCount = String(items.length);
      setText(countNode, translate('queue_count', { count: items.length }));
    }

    if (summaryNode) {
      setText(summaryNode, formatFooterSummary(counts, translate));
    }

    renderTopbar(snapshot?.liveMonitor, snapshot?.watchDirectory);

    if (!listContainer) return;

    if (items.length === 0) {
      if (!showActions) listContainer.removeAttribute?.('role');
      for (const row of rowsById.values()) row.remove();
      rowsById.clear();
      const empty = ensureEmptyState();
      if (listContainer.children.length !== 1 || listContainer.children[0] !== empty) {
        listContainer.replaceChildren(empty);
      }
      return;
    }

    if (!showActions) {
      listContainer.setAttribute?.('role', 'listbox');
    }

    const nextIds = new Set(items.map((item) => item.id));
    for (const [id, row] of rowsById) {
      if (!nextIds.has(id)) {
        row.remove();
        rowsById.delete(id);
      }
    }

    const transitions = [];
    const orderedRows = items.map((item) => {
      let row = rowsById.get(item.id);
      if (!row) {
        row = createRow(item);
        rowsById.set(item.id, row);
      }
      const kind = updateRow(row, item);
      if (kind) transitions.push([row, kind]);
      return row;
    });

    const needsReorder = listContainer.children.length !== orderedRows.length
      || orderedRows.some((row, index) => listContainer.children[index] !== row);
    if (needsReorder) {
      listContainer.replaceChildren(...orderedRows);
    }

    if (typeof onRowTransition === 'function') {
      for (const [row, kind] of transitions) {
        onRowTransition(row, kind);
      }
    }
  }

  function dispose() {
    for (const row of rowsById.values()) row.remove();
    rowsById.clear();
    emptyNode = null;
    topbarRefs = null;
    if (listContainer) listContainer.replaceChildren();
    if (topbarContainer) topbarContainer.replaceChildren();
  }

  return { render, dispose };
}
