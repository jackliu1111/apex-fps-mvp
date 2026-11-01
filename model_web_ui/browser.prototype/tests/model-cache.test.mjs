import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadCachedModel } from '../model-cache.mjs';

async function fixture() {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha256 = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const entries = new Map();
  const cache = {
    match: async key => entries.get(key)?.clone(),
    put: async (key, response) => entries.set(key, response),
    delete: async key => entries.delete(key),
  };
  let downloads = 0;
  const args = { url: 'https://example.test/model.onnx', manifest: { sha256, bytes: bytes.length },
    crypto: webcrypto, storage: { open: async () => cache },
    download: async () => { downloads++; return bytes; } };
  return { args, cache, entries, bytes, downloads: () => downloads };
}

test('a new loader reuses verified saved bytes without a second download', async () => {
  const f = await fixture();
  await loadCachedModel(f.args);
  assert.deepEqual(await loadCachedModel({ ...f.args }), f.bytes);
  assert.equal(f.downloads(), 1);
});

test('corrupt cached bytes trigger a fresh verified download', async () => {
  const f = await fixture();
  await loadCachedModel(f.args);
  f.entries.set([...f.entries.keys()][0], new Response(new Uint8Array([9, 9, 9, 9])));
  assert.deepEqual(await loadCachedModel(f.args), f.bytes);
  assert.equal(f.downloads(), 2);
});

test('a changed model hash never reuses the previous model', async () => {
  const f = await fixture();
  await loadCachedModel(f.args);
  const updated = new Uint8Array([5, 6]);
  const sha256 = Buffer.from(await webcrypto.subtle.digest('SHA-256', updated)).toString('hex');
  assert.deepEqual(await loadCachedModel({ ...f.args, manifest: { sha256, bytes: 2 }, download: async () => updated }), updated);
  assert.equal(f.entries.size, 2);
});

test('failed downloads and invalid content are not saved', async () => {
  const f = await fixture();
  await assert.rejects(loadCachedModel({ ...f.args, download: async () => { throw new Error('offline'); } }), /offline/);
  await assert.rejects(loadCachedModel({ ...f.args, download: async () => new Uint8Array([9, 9, 9, 9]) }), /校验失败/);
  assert.equal(f.entries.size, 0);
});

test('unavailable storage and exhausted quota do not prevent inference', async () => {
  const f = await fixture();
  assert.deepEqual(await loadCachedModel({ ...f.args, storage: { open: async () => { throw new Error('denied'); } } }), f.bytes);
  f.cache.put = async () => { throw new Error('quota'); };
  assert.deepEqual(await loadCachedModel(f.args), f.bytes);
});
