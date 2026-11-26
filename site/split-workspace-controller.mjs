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

export async function dispatchReviewPrimaryAction({ item, record, queue, autoIntake = null, action = null } = {}) {
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
    const ok = typeof autoIntake?.reanalyze === 'function'
      ? await autoIntake.reanalyze(record.id)
      : await queue.retry(record.id);
    return { dispatched: ok !== false, kind: 'reanalyze' };
  }
  if (resolved.kind === 'analyze') {
    const ok = typeof autoIntake?.startAnalysis === 'function'
      ? await autoIntake.startAnalysis(record.id)
      : await queue.retry(record.id);
    return { dispatched: ok !== false, kind: 'analyze' };
  }
  return { dispatched: false, kind: null };
}

export function resolveClippingLayout({
  page = 'clipping',
  itemCount = 0,
  forceStandaloneLibrary = false,
} = {}) {
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

export const LIBRARY_SIDEBAR_COLLAPSED_KEY = 'apex_local_cut_library_collapsed';
export const NARROW_WORKSPACE_BREAKPOINT_PX = 900;

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch (_) {
    return null;
  }
}

export function loadSidebarCollapsed(storage) {
  const store = resolveStorage(storage);
  if (!store || typeof store.getItem !== 'function') return false;
  try {
    const raw = store.getItem(LIBRARY_SIDEBAR_COLLAPSED_KEY);
    return raw === '1' || raw === 'true';
  } catch (_) {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed, storage) {
  const store = resolveStorage(storage);
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    store.setItem(LIBRARY_SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    return true;
  } catch (_) {
    return false;
  }
}

export function isNarrowWorkspaceViewport(viewportWidth) {
  return Number.isFinite(viewportWidth) && viewportWidth <= NARROW_WORKSPACE_BREAKPOINT_PX;
}

export function createWorkspaceUxController({
  storage,
  onChange = () => {},
} = {}) {
  let sidebarCollapsed = loadSidebarCollapsed(storage);
  let drawerOpen = false;
  const newIds = new Set();

  function snapshot() {
    return Object.freeze({
      sidebarCollapsed,
      drawerOpen,
      newIds: new Set(newIds),
      newCount: newIds.size,
    });
  }

  function emit() {
    onChange(snapshot());
  }

  function setSidebarCollapsed(collapsed) {
    const next = Boolean(collapsed);
    saveSidebarCollapsed(next, storage);
    if (next === sidebarCollapsed) return sidebarCollapsed;
    sidebarCollapsed = next;
    emit();
    return sidebarCollapsed;
  }

  function toggleSidebarCollapsed() {
    return setSidebarCollapsed(!sidebarCollapsed);
  }

  function setDrawerOpen(open) {
    const next = Boolean(open);
    if (next === drawerOpen) return drawerOpen;
    drawerOpen = next;
    emit();
    return drawerOpen;
  }

  function openDrawer() {
    return setDrawerOpen(true);
  }

  function closeDrawer() {
    return setDrawerOpen(false);
  }

  function toggleDrawer() {
    return setDrawerOpen(!drawerOpen);
  }

  function handleViewportResize(viewportWidth) {
    if (!isNarrowWorkspaceViewport(viewportWidth) && drawerOpen) {
      closeDrawer();
    }
    return drawerOpen;
  }

  function handleLayoutChange(layout) {
    if (layout !== 'split' && drawerOpen) {
      closeDrawer();
    }
    return drawerOpen;
  }

  function markRecordingNew(id, { activeSourceId = null, force = false } = {}) {
    if (!id) return false;
    const key = String(id);
    if (!force && activeSourceId && key === String(activeSourceId)) {
      return false;
    }
    if (newIds.has(key)) return false;
    newIds.add(key);
    emit();
    return true;
  }

  function clearRecordingNew(id) {
    if (!id) return false;
    const key = String(id);
    if (!newIds.delete(key)) return false;
    emit();
    return true;
  }

  function promoteRecordingNew(fromId, toId, { activeSourceId = null } = {}) {
    if (!fromId || !toId) return false;
    const fromKey = String(fromId);
    const toKey = String(toId);
    if (!newIds.has(fromKey)) return false;
    newIds.delete(fromKey);
    const isActive = activeSourceId && toKey === String(activeSourceId);
    if (!isActive) newIds.add(toKey);
    emit();
    return !isActive;
  }

  function pruneNewIds(validIds) {
    const allowed = new Set(Array.from(validIds || [], (id) => String(id)));
    let changed = false;
    for (const id of [...newIds]) {
      if (!allowed.has(id)) {
        newIds.delete(id);
        changed = true;
      }
    }
    if (changed) emit();
    return changed;
  }

  function onRecordingOpened(id) {
    let changed = false;
    if (id && newIds.delete(String(id))) changed = true;
    if (drawerOpen) {
      drawerOpen = false;
      changed = true;
    }
    if (changed) emit();
    return changed;
  }

  function recordAddedRecordings({
    wasEmpty = false,
    addedIds = [],
    activeSourceId = null,
  } = {}) {
    const ids = Array.from(addedIds || [], (id) => (id ? String(id) : '')).filter(Boolean);
    if (ids.length === 0) {
      return Object.freeze({
        shouldSwitch: false,
        nextActiveSourceId: activeSourceId,
        markedNewIds: Object.freeze([]),
      });
    }

    let changed = false;
    const markedNewIds = [];
    if (wasEmpty) {
      const firstId = ids[0];
      if (newIds.delete(firstId)) changed = true;
      for (const extraId of ids.slice(1)) {
        if (extraId !== firstId && !newIds.has(extraId)) {
          newIds.add(extraId);
          markedNewIds.push(extraId);
          changed = true;
        }
      }
      if (changed) emit();
      return Object.freeze({
        shouldSwitch: true,
        nextActiveSourceId: firstId,
        markedNewIds: Object.freeze(markedNewIds),
      });
    }

    const activeKey = activeSourceId ? String(activeSourceId) : null;
    for (const addedId of ids) {
      if (activeKey && addedId === activeKey) continue;
      if (!newIds.has(addedId)) {
        newIds.add(addedId);
        markedNewIds.push(addedId);
        changed = true;
      }
    }
    if (changed) emit();
    return Object.freeze({
      shouldSwitch: false,
      nextActiveSourceId: activeSourceId,
      markedNewIds: Object.freeze(markedNewIds),
    });
  }

  return {
    get sidebarCollapsed() { return sidebarCollapsed; },
    get drawerOpen() { return drawerOpen; },
    get newCount() { return newIds.size; },
    snapshot,
    setSidebarCollapsed,
    toggleSidebarCollapsed,
    setDrawerOpen,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    handleViewportResize,
    handleLayoutChange,
    markRecordingNew,
    clearRecordingNew,
    promoteRecordingNew,
    pruneNewIds,
    onRecordingOpened,
    recordAddedRecordings,
    isRecordingNew(id) { return Boolean(id && newIds.has(String(id))); },
    getNewRecordingIds() { return [...newIds]; },
  };
}

const EDITABLE_SELECTOR = 'input,select,textarea,[contenteditable]:not([contenteditable="false"])';

export function isEditableShortcutTarget(target, hasOpenDialog = false) {
  if (hasOpenDialog) return true;
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (typeof target.closest === 'function' && target.closest(EDITABLE_SELECTOR)) return true;
  return false;
}

export function resolveRecordingShortcutTarget({
  event,
  items = [],
  activeSourceId = null,
  layout = 'split',
  hasOpenDialog = false,
} = {}) {
  const noOp = Object.freeze({ handled: false, direction: 0, targetId: null });
  if (!event || event.defaultPrevented || event.isComposing) return noOp;
  if (layout !== 'split') return noOp;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return noOp;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return noOp;
  if (isEditableShortcutTarget(event.target, hasOpenDialog)) return noOp;

  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return noOp;

  const direction = event.key === 'ArrowUp' ? -1 : 1;
  const currentIndex = activeSourceId ? list.findIndex((item) => item?.id === activeSourceId) : -1;
  if (currentIndex < 0) {
    const fallback = direction > 0 ? list[0] : list[list.length - 1];
    return Object.freeze({
      handled: true,
      direction,
      targetId: fallback?.id ?? null,
    });
  }
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= list.length) {
    return Object.freeze({ handled: true, direction, targetId: null });
  }
  const nextItem = list[nextIndex];
  return Object.freeze({
    handled: true,
    direction,
    targetId: nextItem?.id && nextItem.id !== activeSourceId ? nextItem.id : null,
  });
}

export function resolveDrawerEscape({
  event,
  drawerOpen = false,
  layout = 'split',
  hasOpenDialog = false,
} = {}) {
  if (
    !drawerOpen
    || layout !== 'split'
    || hasOpenDialog
    || !event
    || event.defaultPrevented
    || event.isComposing
    || event.key !== 'Escape'
  ) {
    return Object.freeze({ handled: false, shouldClose: false });
  }
  return Object.freeze({ handled: true, shouldClose: true });
}

export function canAcceptWorkspaceDrop({
  page = 'clipping',
  hasFiles = false,
} = {}) {
  return Boolean(hasFiles) && page === 'clipping';
}
