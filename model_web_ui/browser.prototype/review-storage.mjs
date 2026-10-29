// Identity is intentionally bounded: hash metadata and three 64 KiB samples.
// It detects same-name replacements without scanning a multi-gigabyte recording.
// It is not a whole-file checksum: modifications outside samples with identical
// metadata cannot be detected. Never use this as a media-integrity guarantee.
export async function identifyFile(file) {
  const size = file.size;
  const sampleSize = 64 * 1024;
  const offsets = [...new Set([0, Math.max(0, Math.floor(size / 2) - sampleSize / 2), Math.max(0, size - sampleSize)])];
  const descriptor = { name: file.name, size, lastModified: file.lastModified };
  const header = new TextEncoder().encode(JSON.stringify({ version: 1, ...descriptor, offsets }));
  const samples = await Promise.all(offsets.map((offset) => file.slice(offset, Math.min(size, offset + sampleSize)).arrayBuffer()));
  const bytes = new Uint8Array(header.length + samples.reduce((sum, sample) => sum + sample.byteLength, 0));
  bytes.set(header);
  let position = header.length;
  for (const sample of samples) { bytes.set(new Uint8Array(sample), position); position += sample.byteLength; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const fingerprint = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { id: `source:${fingerprint}`, ...descriptor, fingerprint, fingerprintVersion: 'metadata-and-three-samples-v1' };
}

// Only the workspace metadata is saved. Callers retain runtime File/Input and
// generated Blob objects separately, so reload requires re-associating a file.
export function createIndexedDBStorage({ databaseName = 'apex-review-v1', key = 'workspace', indexedDB = globalThis.indexedDB } = {}) {
  let databasePromise;
  const database = () => {
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('浏览器不支持保存复核记录')); return; }
      const request = indexedDB.open(databaseName, 1);
      let rejected = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('workspaces')) request.result.createObjectStore('workspaces');
      };
      request.onerror = () => { rejected = true; reject(request.error || new Error('无法打开复核记录')); };
      request.onblocked = () => { rejected = true; reject(new Error('复核记录正在被其他页面占用，请关闭旧页面后重试')); };
      request.onsuccess = () => {
        const db = request.result;
        if (rejected) { db.close(); return; }
        db.onversionchange = () => { db.close(); databasePromise = null; };
        resolve(db);
      };
    }).catch((error) => { databasePromise = null; throw error; });
    return databasePromise;
  };
  const waveformKey = (sourceId) => `${key}:waveform:${sourceId}`;
  const transact = async (mode, operation) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('workspaces', mode);
      const store = transaction.objectStore('workspaces');
      let result;
      const done = (value) => { result = value; };
      const request = operation(store, done);
      if (request && 'onsuccess' in request && !request.onsuccess) {
        request.onsuccess = () => { result = request.result; };
      }
      // A successful put request is not sufficient: acknowledge the commit.
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || request?.error || new Error('复核记录未保存'));
      transaction.onerror = () => reject(transaction.error || request?.error || new Error('复核记录操作失败'));
    });
  };
  return {
    separatedWaveforms: true,
    load: () => transact('readonly', (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const snapshot = request.result;
        if (!snapshot || !Array.isArray(snapshot.sources)) { done(snapshot); return; }
        for (const source of snapshot.sources) {
          if (!source?.id || source.waveform !== undefined) continue;
          const waveRequest = store.get(waveformKey(source.id));
          waveRequest.onsuccess = () => {
            if (waveRequest.result !== undefined) source.waveform = waveRequest.result;
          };
        }
        done(snapshot);
      };
      return request;
    }),
    save: (snapshot, waveforms = {}) => transact('readwrite', (store) => {
      const request = store.put(snapshot, key);
      for (const [sourceId, waveform] of Object.entries(waveforms)) {
        store.put(waveform, waveformKey(sourceId));
      }
      return request;
    }),
    loadWaveform: (sourceId) => transact('readonly', (store) => store.get(waveformKey(sourceId))),
    saveWaveform: (sourceId, waveform) => transact('readwrite', (store) => store.put(waveform, waveformKey(sourceId))),
    async close() { if (databasePromise) (await databasePromise).close(); databasePromise = null; },
  };
}
