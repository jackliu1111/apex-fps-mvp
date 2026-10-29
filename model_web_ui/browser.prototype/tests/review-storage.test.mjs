import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexedDBStorage, identifyFile } from '../review-storage.mjs';

test('restoring the same source uses content and metadata rather than its name alone', async () => {
  const first = new File(['original media'], 'same.mkv', { lastModified: 123 });
  const same = new File(['original media'], 'same.mkv', { lastModified: 123 });
  const different = new File(['different data'], 'same.mkv', { lastModified: 123 });
  const identity = await identifyFile(first);
  assert.equal(identity.id, (await identifyFile(same)).id);
  assert.notEqual(identity.id, (await identifyFile(different)).id);
  assert.equal(identity.name, 'same.mkv');
  assert.equal(identity.size, 14);
});

test('IndexedDB storage persists waveforms under per-sourceId keys and reattaches them on load', async () => {
  const entries = new Map();
  const writes = [];
  const fakeIndexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction() {
            const tx = {
              objectStore() {
                return {
                  get(key) {
                    const req = {};
                    queueMicrotask(() => { req.result = entries.get(key); req.onsuccess?.(); });
                    return req;
                  },
                  put(value, key) {
                    writes.push(key);
                    entries.set(key, value);
                    const req = { result: key };
                    queueMicrotask(() => { req.onsuccess?.(); });
                    return req;
                  },
                };
              },
            };
            queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
            return tx;
          },
        };
        request.result = db;
        request.onsuccess?.();
      });
      return request;
    },
  };
  const storage = createIndexedDBStorage({ indexedDB: fakeIndexedDB });
  const wave = { version: 1, step: 0.05, peaks: [0.1, 0.8], decodedUntil: 0.1, trackIndex: 0 };
  await storage.save({ version: 1, sequence: 1, revision: 1, sources: [{ id: 'source:a', duration: 10 }], batches: [] }, { 'source:a': wave });
  assert.deepEqual(writes, ['workspace', 'workspace:waveform:source:a']);
  assert.equal('waveform' in entries.get('workspace').sources[0], false);
  writes.length = 0;
  await storage.save({ version: 1, sequence: 1, revision: 2, sources: [{ id: 'source:a', duration: 10, review: { position: 0.25 } }], batches: [] }, {});
  assert.deepEqual(writes, ['workspace'], 'Position update writes only workspace metadata key');
  const loaded = await storage.load();
  assert.deepEqual(loaded.sources[0].waveform, wave);
  await storage.close();
});
