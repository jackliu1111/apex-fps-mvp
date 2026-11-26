// Pure controller helpers for the split-pane Local Clipping Workspace (ADR 0010).
// Zero DOM dependencies and zero imports from media/capture/queue implementations.

export function resolveReviewPrimaryAction(item) {
  if (!item || typeof item.status !== 'string') return null;
  if (item.status === 'unanalyzed') {
    return Object.freeze({
      kind: 'analyze',
      labelKey: 'library_action_analyze',
      disabled: item.canAnalyze === false,
      tone: 'primary',
    });
  }
  if (item.status === 'analyzing') {
    return Object.freeze({
      kind: 'stop',
      labelKey: 'library_action_stop',
      disabled: item.canStop === false,
      tone: 'quiet',
    });
  }
  if (item.status === 'conformed-coarse') {
    return Object.freeze({
      kind: 'reanalyze',
      labelKey: 'review_action_reanalyze_offline',
      disabled: item.canReanalyze === false,
      tone: 'warning',
    });
  }
  return null;
}

export async function dispatchReviewPrimaryAction({ item, record, queue, action = null } = {}) {
  const resolved = action || resolveReviewPrimaryAction(item);
  if (!resolved) return { dispatched: false, kind: null };
  if (resolved.disabled || !record || !queue) {
    return { dispatched: false, kind: resolved.kind };
  }
  if (resolved.kind === 'stop') {
    const ok = await queue.stop(record.id);
    return { dispatched: ok !== false, kind: 'stop' };
  }
  if (resolved.kind === 'reanalyze') {
    record.alignment = null;
    const ok = await queue.retry(record.id);
    return { dispatched: ok !== false, kind: 'reanalyze' };
  }
  if (resolved.kind === 'analyze') {
    const ok = await queue.retry(record.id);
    return { dispatched: ok !== false, kind: 'analyze' };
  }
  return { dispatched: false, kind: null };
}

export function resolveClippingLayout({
  page = 'clipping',
  workspaceMode = 'offline',
  itemCount = 0,
  forceStandaloneLibrary = false,
} = {}) {
  if (workspaceMode === 'live') return 'live';
  if (page === 'exports') return 'exports';
  if (forceStandaloneLibrary) return 'standalone-library';
  return itemCount > 0 ? 'split' : 'empty';
}

export function reconcileSplitSelection({
  items = [],
  activeSourceId = null,
  activeRecordId = null,
  requestedSourceId = null,
  loadedSourceId = null,
  loadedFile = null,
  getFileForId = () => null,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return Object.freeze({
      activeSourceId: null,
      activeRecordId: null,
      activeItem: null,
      changed: activeSourceId !== null,
      shouldReloadPlayer: false,
      shouldDisposePlayer: loadedSourceId !== null,
    });
  }

  let selectedItem = null;
  if (requestedSourceId) {
    selectedItem = list.find((item) => item.id === requestedSourceId) || null;
  }
  if (!selectedItem && activeSourceId) {
    selectedItem = list.find((item) => item.id === activeSourceId) || null;
  }
  if (!selectedItem && activeRecordId) {
    selectedItem = list.find((item) => item.recordId && item.recordId === activeRecordId) || null;
  }
  if (!selectedItem) {
    selectedItem = list[0];
  }

  const nextSourceId = selectedItem.id;
  const nextRecordId = selectedItem.recordId ?? null;
  const nextFile = getFileForId(nextSourceId) ?? null;

  const sameLoadedSource = nextSourceId === loadedSourceId && nextFile === loadedFile;
  const shouldReloadPlayer = !sameLoadedSource && nextFile !== null;
  const shouldDisposePlayer = !sameLoadedSource && nextFile === null && loadedSourceId !== null;

  return Object.freeze({
    activeSourceId: nextSourceId,
    activeRecordId: nextRecordId,
    activeItem: selectedItem,
    changed: nextSourceId !== activeSourceId,
    shouldReloadPlayer,
    shouldDisposePlayer,
  });
}
