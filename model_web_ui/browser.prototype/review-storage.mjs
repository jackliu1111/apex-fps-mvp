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
  const transact = async (mode, operation) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('workspaces', mode);
      const request = operation(transaction.objectStore('workspaces'));
      let result;
      request.onsuccess = () => { result = request.result; };
      // A successful put request is not sufficient: acknowledge the commit.
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || request.error || new Error('复核记录未保存'));
      transaction.onerror = () => reject(transaction.error || request.error || new Error('复核记录操作失败'));
    });
  };
  return {
    load: () => transact('readonly', (store) => store.get(key)),
    save: (snapshot) => transact('readwrite', (store) => store.put(snapshot, key)),
    async close() { if (databasePromise) (await databasePromise).close(); databasePromise = null; },
  };
}
