// Silent ready notifications for completed / conformed recordings (ADR 0009, Ticket #62):
// Updates document.title prefix "(N) <baseTitle>", dynamic SVG <link rel="icon"> badge,
// and optional user-opted browser Notification without ever stealing window focus.

export const READY_NOTIFY_PREF_KEY = 'apex_local_cut_ready_notifications';

export function buildFaviconSvgDataUrl(count = 0) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const badge = n > 0
    ? (() => {
        const label = n > 9 ? '9+' : String(n);
        const fontSize = label.length > 1 ? 10 : 11.5;
        return `<circle cx="24" cy="8" r="8" fill="#16a34a" stroke="#ffffff" stroke-width="1.5"/>`
          + `<text x="24" y="11.6" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${label}</text>`;
      })()
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<rect width="32" height="32" rx="8" fill="#18181b"/>`
    + `<path d="M5 25 15 6h2.8l-5.6 11h6.5L15 25H5Zm15.6-11.2L27 25h-7.4l3.6-7.2-2.6-4Z" fill="#ffffff"/>`
    + badge
    + `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function loadNotifyPref(storage) {
  const store = resolveStorage(storage);
  if (!store || typeof store.getItem !== 'function') return false;
  try {
    const raw = store.getItem(READY_NOTIFY_PREF_KEY);
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

function saveNotifyPref(enabled, storage) {
  const store = resolveStorage(storage);
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    store.setItem(READY_NOTIFY_PREF_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

function stripTitleCountPrefix(title) {
  return String(title || '').replace(/^\(\d+\+?\)\s+/, '');
}

export function createReadyNotifier({
  doc = globalThis.document ?? null,
  Notification: NotificationCtor = globalThis.Notification ?? null,
  storage,
  getBaseTitle = null,
  formatNotification = null,
  onNotificationClick = null,
  onChange = () => {},
} = {}) {
  const unseenIds = new Set();
  const capturedInitialTitle = stripTitleCountPrefix(doc?.title || 'Apex Local Cut');
  const defaultIconHref = buildFaviconSvgDataUrl(0);

  let iconLink = doc?.querySelector?.('link[rel~="icon"]') || null;
  const originalIconHref = iconLink?.getAttribute?.('href') || iconLink?.href || defaultIconHref;
  let notificationsEnabled = loadNotifyPref(storage) && NotificationCtor?.permission === 'granted';
  let disposed = false;

  function resolveBaseTitle() {
    if (typeof getBaseTitle === 'function') {
      const next = stripTitleCountPrefix(getBaseTitle());
      if (next) return next;
    }
    return capturedInitialTitle;
  }

  function resolvePermission() {
    if (!NotificationCtor) return 'unsupported';
    return NotificationCtor.permission || 'default';
  }

  function ensureIconLink() {
    if (!doc) return null;
    if (!iconLink) {
      iconLink = doc.querySelector?.('link[rel~="icon"]') || null;
    }
    if (!iconLink && doc.head && typeof doc.createElement === 'function') {
      const link = doc.createElement('link');
      link.setAttribute('rel', 'icon');
      link.setAttribute('type', 'image/svg+xml');
      link.setAttribute('href', originalIconHref);
      if (typeof doc.head.appendChild === 'function') doc.head.appendChild(link);
      else if (typeof doc.head.append === 'function') doc.head.append(link);
      iconLink = link;
    }
    return iconLink;
  }

  function applyIndicators() {
    const count = unseenIds.size;
    const base = resolveBaseTitle();
    const nextTitle = count > 0 ? `(${count}) ${base}` : base;
    if (doc) {
      doc.title = nextTitle;
      const link = ensureIconLink();
      if (link) {
        const nextHref = count > 0 ? buildFaviconSvgDataUrl(count) : originalIconHref;
        link.setAttribute('href', nextHref);
      }
    }
  }

  function snapshot() {
    const permission = resolvePermission();
    const enabled = Boolean(notificationsEnabled && permission === 'granted');
    const link = iconLink || doc?.querySelector?.('link[rel~="icon"]') || null;
    return Object.freeze({
      unseenCount: unseenIds.size,
      unseenIds: Object.freeze([...unseenIds]),
      notificationsEnabled: enabled,
      notificationPermission: permission,
      title: doc?.title ?? resolveBaseTitle(),
      faviconHref: link?.getAttribute?.('href') || link?.href || originalIconHref,
    });
  }

  function emit() {
    if (!disposed) onChange(snapshot());
  }

  function sendSystemNotification(payload) {
    if (!notificationsEnabled || resolvePermission() !== 'granted' || typeof NotificationCtor !== 'function') {
      return null;
    }
    try {
      const formatted = typeof formatNotification === 'function'
        ? formatNotification(payload)
        : {
            title: 'Recording ready · Apex Local Cut',
            body: payload.name || 'Recording ready for review',
          };
      const alert = new NotificationCtor(formatted.title, {
        body: formatted.body,
        tag: `apex-ready:${payload.sourceId}`,
        silent: true,
      });
      if (typeof onNotificationClick === 'function') {
        alert.onclick = () => {
          onNotificationClick(payload);
        };
      }
      return alert;
    } catch {
      return null;
    }
  }

  function markReady({ sourceId, name = '', candidateCount = 0, isCoarse = false, background = false } = {}) {
    if (disposed || !sourceId) return snapshot();
    const key = String(sourceId);
    const added = !unseenIds.has(key);
    unseenIds.add(key);
    applyIndicators();
    if (added) {
      sendSystemNotification({ sourceId: key, name, candidateCount, isCoarse, background });
    }
    emit();
    return snapshot();
  }

  function markSeen(sourceId) {
    if (disposed || !sourceId) return snapshot();
    if (unseenIds.delete(String(sourceId))) {
      applyIndicators();
      emit();
    }
    return snapshot();
  }

  function clearAll() {
    if (disposed) return snapshot();
    if (unseenIds.size > 0) {
      unseenIds.clear();
      applyIndicators();
      emit();
    }
    return snapshot();
  }

  function prune(validIds) {
    if (disposed) return snapshot();
    const allowed = new Set(Array.from(validIds || [], (id) => String(id)));
    let changed = false;
    for (const id of [...unseenIds]) {
      if (!allowed.has(id)) {
        unseenIds.delete(id);
        changed = true;
      }
    }
    if (changed) {
      applyIndicators();
      emit();
    }
    return snapshot();
  }

  function syncTitle() {
    if (disposed) return snapshot();
    applyIndicators();
    return snapshot();
  }

  async function setNotificationsEnabled(enabled) {
    if (disposed) return { enabled: false, permission: resolvePermission() };
    const want = Boolean(enabled);
    if (!want) {
      notificationsEnabled = false;
      saveNotifyPref(false, storage);
      emit();
      return { enabled: false, permission: resolvePermission() };
    }

    if (!NotificationCtor) {
      notificationsEnabled = false;
      saveNotifyPref(false, storage);
      emit();
      return { enabled: false, permission: 'unsupported' };
    }

    let permission = resolvePermission();
    if (permission === 'default' && typeof NotificationCtor.requestPermission === 'function') {
      try {
        permission = await NotificationCtor.requestPermission();
      } catch {
        permission = resolvePermission();
      }
    }

    notificationsEnabled = permission === 'granted';
    saveNotifyPref(notificationsEnabled, storage);
    emit();
    return { enabled: notificationsEnabled, permission };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unseenIds.clear();
    if (doc) {
      doc.title = resolveBaseTitle();
      if (iconLink) iconLink.setAttribute('href', originalIconHref);
    }
  }

  return {
    get unseenCount() { return unseenIds.size; },
    get unseenIds() { return [...unseenIds]; },
    get notificationsEnabled() { return Boolean(notificationsEnabled && resolvePermission() === 'granted'); },
    get notificationPermission() { return resolvePermission(); },
    getState: snapshot,
    markReady,
    markSeen,
    clearAll,
    prune,
    syncTitle,
    setNotificationsEnabled,
    dispose,
  };
}
