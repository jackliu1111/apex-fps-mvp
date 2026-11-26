// Pure UI controller for the Global Topbar session controls (ADR 0010, Ticket #61):
// Compact Live Monitoring pill + floating audio source/device/bypass popover, and
// read-only Watch Folder pill — visible on both Clipping and Exports pages while
// keeping .header-inner strictly single-row (54px) on desktop viewports.

import { t as defaultTranslate } from './i18n.js';

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function formatLiveStatusLabel(status, translate) {
  const keyMap = {
    off: 'library_live_status_off',
    starting: 'library_live_status_starting',
    listening: 'library_live_status_listening',
    'paused-loopback': 'library_live_status_paused_loopback',
    disconnected: 'library_live_status_disconnected',
    error: 'library_live_status_error',
    unavailable: 'library_live_status_unavailable',
  };
  return translate(keyMap[status] || 'library_live_status_off');
}

function formatLiveActionLabel(live, translate) {
  if (live.status === 'disconnected' || live.status === 'error') {
    return translate('library_live_restart');
  }
  return live.active ? translate('library_live_stop') : translate('library_live_start');
}

function formatWatchValueLabel(watch, translate, hasRestoreCta) {
  if (!watch.name) return translate('library_watch_unset');
  if (watch.status === 'needs-permission' && !hasRestoreCta) {
    return translate('library_watch_needs_permission', { name: watch.name });
  }
  return watch.name;
}

export function createGlobalTopbarControls({
  doc = globalThis.document,
  translate = defaultTranslate,
  onToggleLive = () => {},
  onSelectSourceKind = () => {},
  onSelectDevice = () => {},
  onRefreshDevices = () => {},
  onToggleGateBypass = () => {},
  onToggleReadyNotifications = () => {},
  onActivateWatchDir = () => {},
  onPopoverToggle = () => {},
} = {}) {
  const byId = (id) => doc?.getElementById?.(id) || null;

  const root = byId('global-session-controls');
  const liveWrap = byId('topbar-live-monitor');
  const liveToggle = byId('topbar-live-toggle');
  const liveStatus = byId('topbar-live-status');
  const liveAlert = byId('topbar-live-alert');
  const liveSettingsBtn = byId('topbar-live-settings-btn');
  const popover = byId('topbar-live-popover');
  const popStatus = byId('topbar-popover-status');
  const popNotice = byId('topbar-popover-notice');
  const srcSystem = byId('topbar-source-system');
  const srcDevice = byId('topbar-source-device');
  const devGroup = byId('topbar-device-group');
  const devSelect = byId('topbar-device-select');
  const devRefresh = byId('topbar-device-refresh');
  const gateBypass = byId('topbar-gate-bypass');
  const readyNotify = byId('topbar-ready-notify');
  const readyNotifyHint = byId('topbar-ready-notify-hint');
  const popToggle = byId('topbar-popover-toggle');
  const watchWrap = byId('topbar-watch-dir');
  const watchBtn = byId('topbar-watch-btn');
  const watchValue = byId('topbar-watch-value');
  const watchRestoreCta = byId('topbar-watch-restore-cta');

  let popoverOpen = false;
  let lastDevicesKey = null;

  function setPopoverOpen(open) {
    const next = Boolean(open);
    if (next === popoverOpen) return popoverOpen;
    popoverOpen = next;
    if (popover) popover.hidden = !popoverOpen;
    if (liveSettingsBtn) liveSettingsBtn.setAttribute('aria-expanded', String(popoverOpen));
    onPopoverToggle(popoverOpen);
    if (popoverOpen) {
      Promise.resolve(onRefreshDevices()).catch(() => {});
    }
    return popoverOpen;
  }

  function closePopover() {
    return setPopoverOpen(false);
  }

  function openPopover() {
    return setPopoverOpen(true);
  }

  if (liveToggle) {
    liveToggle.onclick = (event) => {
      event?.stopPropagation?.();
      onToggleLive();
    };
  }
  if (liveSettingsBtn) {
    liveSettingsBtn.onclick = (event) => {
      event?.stopPropagation?.();
      setPopoverOpen(!popoverOpen);
    };
  }
  if (popToggle) {
    popToggle.onclick = (event) => {
      event?.stopPropagation?.();
      onToggleLive();
    };
  }
  if (srcSystem) {
    srcSystem.onclick = (event) => {
      event?.stopPropagation?.();
      onSelectSourceKind('system');
    };
  }
  if (srcDevice) {
    srcDevice.onclick = (event) => {
      event?.stopPropagation?.();
      onSelectSourceKind('device');
    };
  }
  if (devRefresh) {
    devRefresh.onclick = (event) => {
      event?.stopPropagation?.();
      onRefreshDevices();
    };
  }
  if (devSelect) {
    devSelect.onchange = () => {
      onSelectDevice(devSelect.value || null);
    };
  }
  if (gateBypass) {
    gateBypass.onchange = () => {
      onToggleGateBypass(Boolean(gateBypass.checked));
    };
  }
  if (readyNotify) {
    readyNotify.onchange = () => {
      onToggleReadyNotifications(Boolean(readyNotify.checked));
    };
  }
  if (watchBtn) {
    watchBtn.onclick = (event) => {
      event?.stopPropagation?.();
      onActivateWatchDir();
    };
  }

  const onDocumentClick = (event) => {
    if (!popoverOpen) return;
    if (liveWrap && typeof liveWrap.contains === 'function' && liveWrap.contains(event?.target)) {
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

  function renderDeviceOptions(devices, selectedId) {
    if (!devSelect || !doc?.createElement) return;
    const list = Array.isArray(devices) ? devices : [];
    const key = JSON.stringify(list.map((d) => [d.deviceId, d.label])) + `|${selectedId || ''}`;
    if (key === lastDevicesKey && devSelect.children.length > 0) return;
    lastDevicesKey = key;

    if (list.length === 0) {
      const opt = doc.createElement('option');
      opt.value = '';
      opt.textContent = translate('live_device_default');
      devSelect.replaceChildren(opt);
      devSelect.value = '';
      return;
    }

    const options = list.map((device, idx) => {
      const opt = doc.createElement('option');
      opt.value = device.deviceId || '';
      opt.textContent = device.label || translate('live_device_fallback', { index: idx + 1 });
      if (selectedId && device.deviceId === selectedId) {
        opt.selected = true;
      }
      return opt;
    });
    devSelect.replaceChildren(...options);
    devSelect.value = selectedId && list.some((d) => d.deviceId === selectedId)
      ? selectedId
      : (list[0]?.deviceId || '');
  }

  function render(state = {}, { hidden = false } = {}) {
    if (root) root.hidden = Boolean(hidden);
    if (hidden && popoverOpen) closePopover();

    const live = state.liveMonitor || { status: 'off', active: false, canToggle: true };
    const watch = state.watchDirectory || { status: 'unset', name: null, canChoose: true };

    const status = live.status || 'off';
    const active = Boolean(live.active ?? (status === 'listening' || status === 'paused-loopback' || status === 'starting'));
    const silenceWarning = Boolean(live.silenceWarning && status === 'listening');
    const hasAlert = silenceWarning || status === 'disconnected' || status === 'error';
    const statusText = formatLiveStatusLabel(status, translate);
    const effectiveSource = live.effectiveSourceKind || live.sourceKind || live.preferredSourceKind || 'system';
    const isDevice = effectiveSource === 'device';

    if (liveWrap) {
      liveWrap.dataset.liveStatus = status;
      liveWrap.dataset.silenceWarning = String(silenceWarning);
      liveWrap.dataset.sourceKind = effectiveSource;
    }
    if (liveStatus) setText(liveStatus, statusText);
    if (liveAlert) {
      liveAlert.hidden = !hasAlert;
      liveAlert.title = silenceWarning
        ? translate('note_live_silence_warning')
        : (live.disconnectReason || live.error || '');
    }
    if (liveToggle) {
      liveToggle.disabled = live.canToggle === false;
      liveToggle.setAttribute('aria-pressed', String(active));
      const parts = [
        `${translate('library_live_label')}: ${statusText}`,
        live.audioLabel ? `(${live.audioLabel})` : '',
        silenceWarning ? `· ${translate('note_live_silence_warning')}` : '',
        status === 'disconnected' && live.disconnectReason ? `· ${live.disconnectReason}` : '',
        status === 'error' && live.error ? `· ${live.error}` : '',
      ].filter(Boolean);
      liveToggle.title = parts.join(' ');
    }

    if (popStatus) {
      popStatus.dataset.liveStatus = status;
      setText(popStatus, statusText);
    }

    let noticeText = '';
    let noticeTone = 'info';
    if (status === 'disconnected') {
      noticeText = live.disconnectReason || translate('note_live_disconnected');
      noticeTone = 'error';
    } else if (status === 'error' && live.error) {
      noticeText = live.error;
      noticeTone = 'error';
    } else if (status === 'paused-loopback') {
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

    if (srcSystem) srcSystem.setAttribute('aria-checked', String(!isDevice));
    if (srcDevice) srcDevice.setAttribute('aria-checked', String(isDevice));
    if (devGroup) devGroup.hidden = !isDevice;
    if (isDevice) {
      renderDeviceOptions(live.audioDevices, live.deviceId || live.preferredDeviceId);
    }
    if (gateBypass) {
      gateBypass.disabled = !isDevice;
      gateBypass.checked = isDevice && Boolean(live.allowGateBypass);
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
    if (popToggle) {
      popToggle.disabled = live.canToggle === false;
      setText(popToggle, formatLiveActionLabel({ status, active }, translate));
    }

    if (watchWrap) {
      watchWrap.dataset.watchStatus = watch.status || 'unset';
    }
    const needsRestore = watch.status === 'needs-permission' && Boolean(watch.name);
    const watchDisplay = formatWatchValueLabel(watch, translate, Boolean(watchRestoreCta));
    if (watchValue) {
      setText(watchValue, watchDisplay);
      watchValue.title = watch.name || '';
    }
    if (watchRestoreCta) {
      watchRestoreCta.hidden = !needsRestore;
      setText(watchRestoreCta, translate('topbar_watch_restore_cta'));
    }
    if (watchBtn) {
      watchBtn.disabled = watch.canChoose === false;
      const watchTitle = needsRestore
        ? translate('topbar_watch_restore_title', { name: watch.name })
        : watch.name
          ? translate('topbar_watch_active_title', { name: watch.name })
          : translate('topbar_watch_choose_title');
      watchBtn.title = watch.error ? `${watchTitle} · ${watch.error}` : watchTitle;
    }
  }

  function dispose() {
    closePopover();
    doc?.removeEventListener?.('click', onDocumentClick);
    doc?.removeEventListener?.('keydown', onDocumentKeydown);
    if (liveToggle) liveToggle.onclick = null;
    if (liveSettingsBtn) liveSettingsBtn.onclick = null;
    if (popToggle) popToggle.onclick = null;
    if (srcSystem) srcSystem.onclick = null;
    if (srcDevice) srcDevice.onclick = null;
    if (devRefresh) devRefresh.onclick = null;
    if (devSelect) devSelect.onchange = null;
    if (gateBypass) gateBypass.onchange = null;
    if (readyNotify) readyNotify.onchange = null;
    if (watchBtn) watchBtn.onclick = null;
  }

  return {
    render,
    openPopover,
    closePopover,
    isPopoverOpen: () => popoverOpen,
    dispose,
  };
}
