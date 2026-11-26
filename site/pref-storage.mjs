// Safe boolean preference helpers for non-session UI preferences (e.g. sidebar collapse, ready notifications).

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readBoolPref(key, storage) {
  const store = resolveStorage(storage);
  if (!store || typeof store.getItem !== 'function') return false;
  try {
    const raw = store.getItem(key);
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

export function writeBoolPref(key, value, storage) {
  const store = resolveStorage(storage);
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    store.setItem(key, value ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
