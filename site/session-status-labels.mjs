// Pure presentation label formatters shared by the Global Topbar controls
// and standalone Recording Library preview slots (zero DOM or engine dependencies).

const LIVE_STATUS_KEY_MAP = Object.freeze({
  off: 'library_live_status_off',
  starting: 'library_live_status_starting',
  listening: 'library_live_status_listening',
  'paused-loopback': 'library_live_status_paused_loopback',
  disconnected: 'library_live_status_disconnected',
  error: 'library_live_status_error',
  unavailable: 'library_live_status_unavailable',
});

export function formatLiveStatusLabel(status, translate) {
  return translate(LIVE_STATUS_KEY_MAP[status] || 'library_live_status_off');
}

export function formatLiveActionLabel(live, translate) {
  if (live?.status === 'disconnected' || live?.status === 'error') {
    return translate('library_live_restart');
  }
  return live?.active ? translate('library_live_stop') : translate('library_live_start');
}

export function formatWatchValueLabel(watch, translate, { inlineNeedsPermission = true } = {}) {
  if (!watch?.name) return translate('library_watch_unset');
  if (watch.status === 'needs-permission' && inlineNeedsPermission) {
    return translate('library_watch_needs_permission', { name: watch.name });
  }
  return watch.name;
}
