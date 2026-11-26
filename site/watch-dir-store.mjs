// Dedicated IndexedDB persistence for the read-only Watch Folder FileSystemDirectoryHandle (ADR 0009, Ticket #62).
// Strictly isolated from session sources/batches and legacy review IndexedDB stores.

export const WATCH_DIR_DB_NAME = 'apex-watch-dir-v1';
export const WATCH_DIR_STORE_NAME = 'handles';
export const WATCH_DIR_RECORD_KEY = 'watch-directory';

function resolveIndexedDB(provided) {
  if (provided !== undefined) return provided;
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function isValidDirectoryHandle(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.entries === 'function',
  );
}

function openDatabase(idb, dbName, storeName) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(dbName, 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      } catch (err) {
        reject(err);
      }
    };
    req.onerror = () => reject(req.error || new Error('Failed to open watch directory IndexedDB'));
    req.onsuccess = () => resolve(req.result);
  });
}

function runTransaction(db, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    let result;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { db.close?.(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(result);
    };
    try {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = operation(store);
      if (req) {
        req.onsuccess = () => { result = req.result; };
        req.onerror = () => finish(req.error || new Error('IndexedDB request failed'));
      }
      tx.oncomplete = () => finish(null);
      tx.onerror = () => finish(tx.error || req?.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => finish(tx.error || new Error('IndexedDB transaction aborted'));
    } catch (err) {
      finish(err);
    }
  });
}

export function createWatchDirStore({
  indexedDB,
  dbName = WATCH_DIR_DB_NAME,
  storeName = WATCH_DIR_STORE_NAME,
  key = WATCH_DIR_RECORD_KEY,
} = {}) {
  const getIdb = () => resolveIndexedDB(indexedDB);

  async function load() {
    const idb = getIdb();
    if (!idb || typeof idb.open !== 'function') return null;
    try {
      const db = await openDatabase(idb, dbName, storeName);
      const value = await runTransaction(db, storeName, 'readonly', (store) => store.get(key));
      return isValidDirectoryHandle(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function save(handle) {
    if (!handle) return clear();
    const idb = getIdb();
    if (!idb || typeof idb.open !== 'function') return false;
    try {
      const db = await openDatabase(idb, dbName, storeName);
      await runTransaction(db, storeName, 'readwrite', (store) => store.put(handle, key));
      return true;
    } catch {
      return false;
    }
  }

  async function clear() {
    const idb = getIdb();
    if (!idb || typeof idb.open !== 'function') return false;
    try {
      const db = await openDatabase(idb, dbName, storeName);
      await runTransaction(db, storeName, 'readwrite', (store) => store.delete(key));
      return true;
    } catch {
      return false;
    }
  }

  return {
    dbName,
    storeName,
    key,
    load,
    save,
    clear,
  };
}

export async function restorePersistedWatchDirectory({ store, engineBridge } = {}) {
  if (!store || !engineBridge) {
    return { outcome: 'empty', handle: null, state: engineBridge?.watchDirState ?? null };
  }
  const handle = await store.load();
  if (!handle) {
    return { outcome: 'empty', handle: null, state: engineBridge.watchDirState };
  }

  let permission = 'granted';
  if (typeof handle.queryPermission === 'function') {
    try {
      permission = await handle.queryPermission({ mode: 'read' });
    } catch {
      permission = 'prompt';
    }
  }

  if (permission === 'granted') {
    try {
      const state = await engineBridge.activateWatchDirectory(handle, {
        requestPermission: false,
        persist: false,
      });
      return { outcome: 'restored', handle, state };
    } catch (error) {
      const state = engineBridge.setWatchDirectoryRestoreNeeded(handle);
      return { outcome: 'needs-permission', handle, error, state };
    }
  }

  const state = engineBridge.setWatchDirectoryRestoreNeeded(handle);
  return { outcome: 'needs-permission', handle, state };
}
