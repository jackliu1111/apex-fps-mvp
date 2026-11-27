// Pure UI controller for the Recording Library sidebar intake controls (ADR 0011 + ADR 0012):
// Single compact Watch Folder status bar (+ one-click Restore Watch CTA) and unified
// Auto-Intake Settings popover housing Watch Folder management, persistent Auto Offline
// Analysis toggle, subordinate system-audio Live Audio Analysis toggle, and ready notifications.

import { t as defaultTranslate } from './i18n.js';
import {
  formatLiveStatusLabel,
  formatLiveActionLabel,
  formatWatchValueLabel,
} from './session-status-labels.mjs';

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function formatWatchStatusPill(watch, translate) {
  if (watch.status === 'watching') return translate('library_watch_status_watching');
  if (watch.status === 'needs-permission') return translate('library_watch_status_needs_permission');
  if (watch.status === 'error') return translate('library_watch_status_error');
  return translate('library_watch_unset');
}

function formatCompactLivePill(status, translate) {
  if (status === 'listening') return translate('live_pill_listening');
  if (status === 'starting') return translate('library_live_status_starting');
  if (status === 'paused-loopback') return translate('library_live_status_paused_loopback');
  if (status === 'disconnected') return translate('library_live_status_disconnected');
  if (status === 'error') return translate('library_live_status_error');
  return '';
}

export function createLibraryIntakeControls({
  doc = globalThis.document,
  translate = defaultTranslate,
  onToggleLive = () => {},
  onToggleAutoAnalyze = () => {},
  onToggleReadyNotifications = () => {},
  onActivateWatchDir = () => {},
  onChooseWatchDir = null,
  onRestoreWatchDir = null,
  onStopWatchDir = null,
  onPopoverToggle = () => {},
} = {}) {
  const byId = (id) => doc?.getElementById?.(id) || null;

  const topbar = byId('library-topbar');
  const sessionNotice = byId('session-notice');
  const root = byId('sidebar-intake-controls');
  const watchWrap = byId('sidebar-watch-dir');
  const watchBtn = byId('sidebar-watch-btn');
  const watchLabel = byId('sidebar-watch-label');
  const watchValue = byId('sidebar-watch-value');
  const watchAutoPill = byId('sidebar-watch-auto-pill');
  const livePill = byId('sidebar-live-pill');
  const livePillText = byId('sidebar-live-pill-text');
  const liveAlert = byId('sidebar-live-alert');
  const watchRestoreCta = byId('sidebar-watch-restore-cta');
  const settingsBtn = byId('sidebar-intake-settings-btn');
  const popover = byId('sidebar-intake-popover');
  const popWatchStatus = byId('sidebar-popover-watch-status');
  const popWatchName = byId('sidebar-popover-watch-name');
  const popWatchChoose = byId('sidebar-popover-watch-choose');
  const popWatchRestore = byId('sidebar-popover-watch-restore');
  const popWatchStop = byId('sidebar-popover-watch-stop');
  const autoAnalyze = byId('sidebar-auto-analyze');
  const liveSection = byId('sidebar-live-section');
  const popLiveStatus = byId('sidebar-popover-live-status');
  const popNotice = byId('sidebar-popover-notice');
  const liveToggle = byId('sidebar-live-toggle');
  const liveHint = byId('sidebar-live-hint');
  const readyNotify = byId('sidebar-ready-notify');
  const readyNotifyHint = byId('sidebar-ready-notify-hint');

  let popoverOpen = false;
  let currentWatchStatus = 'unset';

  function setPopoverOpen(open) {
    const next = Boolean(open);
    if (next === popoverOpen) return popoverOpen;
    popoverOpen = next;
    if (popover) popover.hidden = !popoverOpen;
    if (settingsBtn) settingsBtn.setAttribute('aria-expanded', String(popoverOpen));
    onPopoverToggle(popoverOpen);
    return popoverOpen;
  }

  function closePopover() {
    return setPopoverOpen(false);
  }

  function openPopover() {
    return setPopoverOpen(true);
  }

  function invokeChoose() {
    if (typeof onChooseWatchDir === 'function') onChooseWatchDir();
    else onActivateWatchDir();
  }

  function invokeRestore() {
    if (typeof onRestoreWatchDir === 'function') onRestoreWatchDir();
    else onActivateWatchDir();
  }

  if (watchBtn) {
    watchBtn.onclick = (event) => {
      event?.stopPropagation?.();
      if (currentWatchStatus === 'watching') {
        setPopoverOpen(!popoverOpen);
      } else {
        invokeChoose();
      }
    };
  }
  if (watchRestoreCta) {
    watchRestoreCta.onclick = (event) => {
      event?.stopPropagation?.();
      invokeRestore();
    };
  }
  if (settingsBtn) {
    settingsBtn.onclick = (event) => {
      event?.stopPropagation?.();
      setPopoverOpen(!popoverOpen);
    };
  }
  if (popWatchChoose) {
    popWatchChoose.onclick = (event) => {
      event?.stopPropagation?.();
      invokeChoose();
    };
  }
  if (popWatchRestore) {
    popWatchRestore.onclick = (event) => {
      event?.stopPropagation?.();
      invokeRestore();
    };
  }
  if (popWatchStop) {
    popWatchStop.onclick = (event) => {
      event?.stopPropagation?.();
      onStopWatchDir?.();
    };
  }
  if (autoAnalyze) {
    autoAnalyze.onchange = () => {
      onToggleAutoAnalyze(Boolean(autoAnalyze.checked));
    };
  }
  if (liveToggle) {
    liveToggle.onclick = (event) => {
      event?.stopPropagation?.();
      onToggleLive();
    };
  }
  if (readyNotify) {
    readyNotify.onchange = () => {
      onToggleReadyNotifications(Boolean(readyNotify.checked));
    };
  }

  const onDocumentClick = (event) => {
    if (!popoverOpen) return;
    if (watchWrap && typeof watchWrap.contains === 'function' && watchWrap.contains(event?.target)) {
      return;
    }
    closePopover();
  };

  const onDocumentKeydown = (event) => {
    if (!popoverOpen) return;
    if (event?.key === 'Escape') {
      event.preventDefault?.();
      closePopover();
    }
  };

  doc?.addEventListener?.('click', onDocumentClick);
  doc?.addEventListener?.('keydown', onDocumentKeydown);

  function render(state = {}, { hidden = false } = {}) {
    if (root) root.hidden = Boolean(hidden);
    if (hidden && popoverOpen) closePopover();

    const watch = state.watchDirectory || { status: 'unset', name: null, canChoose: true, autoAnalyzeUncovered: false };
    const live = state.liveMonitor || { status: 'off', active: false, canToggle: false };

    const watchStatus = watch.status || 'unset';
    currentWatchStatus = watchStatus;
    const isWatching = watchStatus === 'watching';
    const needsRestore = watchStatus === 'needs-permission' && Boolean(watch.name);
    const hasWatchName = Boolean(watch.name);

    const liveStatus = live.status || 'off';
    const liveActive = Boolean(live.active ?? (liveStatus === 'listening' || liveStatus === 'paused-loopback' || liveStatus === 'starting'));
    const canToggleLive = live.canToggle !== undefined ? Boolean(live.canToggle) : (liveActive || isWatching);
    const liveLocked = !isWatching && !liveActive;
    const silenceWarning = Boolean(live.silenceWarning && liveStatus === 'listening');
    const hasAlert = silenceWarning || liveStatus === 'disconnected' || liveStatus === 'error';
    const liveStatusText = formatLiveStatusLabel(liveStatus, translate);

    if (topbar) {
      topbar.dataset.watchStatus = watchStatus;
    }
    if (sessionNotice) {
      setText(sessionNotice, translate(isWatching || needsRestore ? 'session_notice_watching' : 'session_notice'));
    }

    if (watchWrap) {
      watchWrap.dataset.watchStatus = watchStatus;
      watchWrap.dataset.liveStatus = liveStatus;
      watchWrap.dataset.silenceWarning = String(silenceWarning);
    }

    if (watchLabel) {
      watchLabel.hidden = hasWatchName;
    }

    const watchDisplay = formatWatchValueLabel(watch, translate, { inlineNeedsPermission: !watchRestoreCta });
    if (watchValue) {
      setText(watchValue, watchDisplay);
      watchValue.title = watch.name || '';
    }

    const compactPillText = formatCompactLivePill(liveStatus, translate);
    const showLivePill = Boolean(compactPillText) && !needsRestore;
    if (watchAutoPill) {
      watchAutoPill.hidden = !(isWatching && !showLivePill && !needsRestore);
      setText(watchAutoPill, translate('intake_mode_auto_tag'));
    }
    if (livePill) {
      livePill.hidden = !showLivePill;
      livePill.dataset.liveStatus = liveStatus;
      setText(livePillText || livePill, compactPillText);
    }

    if (liveAlert) {
      liveAlert.hidden = !hasAlert;
      liveAlert.title = silenceWarning
        ? translate('note_live_silence_warning')
        : (live.disconnectReason || live.error || '');
    }

    if (watchRestoreCta) {
      watchRestoreCta.hidden = !needsRestore;
      watchRestoreCta.disabled = watch.canChoose === false;
      setText(watchRestoreCta, translate('topbar_watch_restore_cta'));
      watchRestoreCta.title = needsRestore
        ? translate('topbar_watch_restore_title', { name: watch.name })
        : '';
    }

    if (watchBtn) {
      watchBtn.disabled = watch.canChoose === false && !isWatching;
      const baseWatchTitle = isWatching && watch.name
        ? translate('topbar_watch_active_title', { name: watch.name })
        : needsRestore
          ? translate('topbar_watch_restore_title', { name: watch.name })
          : translate('topbar_watch_choose_title');
      const titleParts = [
        baseWatchTitle,
        liveActive || hasAlert ? `${translate('library_live_label')}: ${liveStatusText}` : '',
        silenceWarning ? translate('note_live_silence_warning') : '',
        liveStatus === 'disconnected' && live.disconnectReason ? live.disconnectReason : '',
        liveStatus === 'error' && live.error ? live.error : '',
        watch.error ? watch.error : '',
      ].filter(Boolean);
      const fullWatchTitle = titleParts.join(' · ');
      watchBtn.title = fullWatchTitle;
      watchBtn.setAttribute('aria-label', fullWatchTitle);
    }

    if (popWatchStatus) {
      popWatchStatus.dataset.watchStatus = watchStatus;
      setText(popWatchStatus, formatWatchStatusPill(watch, translate));
    }
    if (popWatchName) {
      setText(popWatchName, watch.name || translate('library_watch_unset'));
      popWatchName.title = watch.name || '';
    }
    if (popWatchChoose) {
      popWatchChoose.disabled = watch.canChoose === false;
      setText(popWatchChoose, hasWatchName ? translate('library_watch_change') : translate('library_watch_choose'));
    }
    if (popWatchRestore) {
      popWatchRestore.hidden = !needsRestore;
      popWatchRestore.disabled = watch.canChoose === false;
      setText(popWatchRestore, translate('topbar_watch_restore_cta'));
    }
    if (popWatchStop) {
      popWatchStop.hidden = !(isWatching || needsRestore);
      setText(popWatchStop, translate('library_watch_stop'));
    }

    if (autoAnalyze) {
      autoAnalyze.checked = Boolean(watch.autoAnalyzeUncovered);
    }

    if (liveSection) {
      liveSection.dataset.disabled = String(liveLocked);
    }
    if (popLiveStatus) {
      popLiveStatus.dataset.liveStatus = liveStatus;
      setText(popLiveStatus, liveStatusText);
    }

    let noticeText = '';
    let noticeTone = 'info';
    if (liveStatus === 'disconnected') {
      noticeText = live.disconnectReason || translate('note_live_disconnected');
      noticeTone = 'error';
    } else if (liveStatus === 'error' && live.error) {
      noticeText = live.error;
      noticeTone = 'error';
    } else if (liveStatus === 'paused-loopback') {
      noticeText = live.gateReason || translate('live_gate_playback_reason');
      noticeTone = 'warning';
    } else if (silenceWarning) {
      noticeText = translate('note_live_silence_warning');
      noticeTone = 'warning';
    }
    if (popNotice) {
      popNotice.hidden = !noticeText;
      popNotice.dataset.tone = noticeTone;
      setText(popNotice, noticeText);
    }

    if (liveToggle) {
      liveToggle.disabled = !canToggleLive || liveLocked;
      liveToggle.setAttribute('aria-pressed', String(liveActive));
      setText(liveToggle, formatLiveActionLabel({ status: liveStatus, active: liveActive }, translate));
    }
    if (liveHint) {
      setText(liveHint, translate(liveLocked ? 'live_requires_watch_dir_hint' : 'live_audio_only_hint'));
    }

    const readyNotif = state.readyNotifications || null;
    if (readyNotify && readyNotif) {
      const perm = readyNotif.permission || 'default';
      readyNotify.disabled = perm === 'unsupported';
      readyNotify.checked = Boolean(readyNotif.enabled && perm === 'granted');
      if (readyNotifyHint) {
        if (perm === 'denied') {
          readyNotifyHint.hidden = false;
          setText(readyNotifyHint, translate('ready_notify_denied_hint'));
        } else if (perm === 'unsupported') {
          readyNotifyHint.hidden = false;
          setText(readyNotifyHint, translate('ready_notify_unsupported_hint'));
        } else {
          readyNotifyHint.hidden = true;
          setText(readyNotifyHint, '');
        }
      }
    }
  }

  function dispose() {
    closePopover();
    doc?.removeEventListener?.('click', onDocumentClick);
    doc?.removeEventListener?.('keydown', onDocumentKeydown);
    if (watchBtn) watchBtn.onclick = null;
    if (watchRestoreCta) watchRestoreCta.onclick = null;
    if (settingsBtn) settingsBtn.onclick = null;
    if (popWatchChoose) popWatchChoose.onclick = null;
    if (popWatchRestore) popWatchRestore.onclick = null;
    if (popWatchStop) popWatchStop.onclick = null;
    if (autoAnalyze) autoAnalyze.onchange = null;
    if (liveToggle) liveToggle.onclick = null;
    if (readyNotify) readyNotify.onchange = null;
  }

  return {
    render,
    openPopover,
    closePopover,
    isPopoverOpen: () => popoverOpen,
    dispose,
  };
}
