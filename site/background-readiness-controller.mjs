export function pickFirstReviewableCandidate(sourceSnapshot) {
  const clips = Array.isArray(sourceSnapshot?.clips) ? sourceSnapshot.clips : [];
  let earliest = null;
  for (const clip of clips) {
    if (!clip || clip.provisional || clip.excluded) continue;
    if (!earliest || clip.start < earliest.start) {
      earliest = clip;
    }
  }
  return earliest;
}

export function createBackgroundReadinessController({
  getVisibilityState = () => globalThis.document?.visibilityState || 'visible',
  getActiveSourceId = () => null,
  getCurrentPage = () => 'clipping',
  hasRecording = () => true,
  readyNotifier = null,
  uxController = null,
  openRecording = () => {},
  onPollWatchDirectory = () => {},
  onToastChange = () => {},
} = {}) {
  let activeToast = null;

  function setActiveToast(next) {
    activeToast = next ? Object.freeze({ ...next }) : null;
    onToastChange(activeToast);
  }

  function onRecordingReady({ sourceId, name = '', candidateCount = 0, isCoarse = false } = {}) {
    if (!sourceId) return Object.freeze({ action: 'ignored', sourceId: null });
    const id = String(sourceId);
    const activeId = getActiveSourceId();
    const isHidden = getVisibilityState() === 'hidden';

    if (!isHidden && getCurrentPage() === 'clipping' && activeId && String(activeId) === id) {
      return Object.freeze({ action: 'noop-active', sourceId: id });
    }

    const ready = {
      sourceId: id,
      name: String(name || ''),
      candidateCount: Number(candidateCount) || 0,
      isCoarse: Boolean(isCoarse),
    };
    uxController?.markRecordingNew?.(id, { activeSourceId: activeId });
    readyNotifier?.markReady?.({ ...ready, background: isHidden });
    if (isHidden) return Object.freeze({ action: 'queued-background', sourceId: id });
    setActiveToast(ready);
    return Object.freeze({ action: 'foreground-toast', sourceId: id });
  }

  async function handleVisibilityChange(nextState = getVisibilityState()) {
    if (nextState !== 'visible') {
      return { switched: false, targetId: null };
    }
    const pollPromise = Promise.resolve()
      .then(() => onPollWatchDirectory())
      .catch(() => null);

    return { switched: false, targetId: null, pollPromise };
  }

  async function openToastTarget() {
    if (!activeToast) return false;
    const target = activeToast;
    setActiveToast(null);
    readyNotifier?.markSeen?.(target.sourceId);
    if (!hasRecording(target.sourceId)) return false;
    await openRecording(target.sourceId, { focusFirstCandidate: true });
    return true;
  }

  function dismissToast() {
    if (!activeToast) return false;
    const dismissed = activeToast;
    setActiveToast(null);
    readyNotifier?.markSeen?.(dismissed.sourceId);
    return true;
  }

  function onRecordingOpened(sourceId) {
    if (!sourceId) return;
    const id = String(sourceId);
    readyNotifier?.markSeen?.(id);
    if (activeToast?.sourceId === id) {
      setActiveToast(null);
    }
  }

  function getState() {
    return Object.freeze({
      activeToast,
    });
  }

  return {
    get activeToast() { return activeToast; },
    getState,
    onRecordingReady,
    handleVisibilityChange,
    openToastTarget,
    dismissToast,
    onRecordingOpened,
  };
}
