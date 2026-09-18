import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, open, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identify, verifySource, Cancelled } from '../src/media';
const work = await mkdtemp(join(tmpdir(), 'apex-identity-'));
afterAll(() => rm(work, { recursive: true, force: true }));
test('15 GiB sparse recording uses metadata and accepts legacy identities without hashing', async () => {
  const path = join(work, 'large.mkv'), file = await open(path, 'w');
  try { await file.truncate(15 * 1024 ** 3); } finally { await file.close(); }
  const identity = await identify(path);
  expect(identity.size).toBe(15 * 1024 ** 3);
  expect(identity.sha256).toBeUndefined();
  await verifySource(identity);
  await verifySource({ ...identity, sha256: 'legacy-hash-is-not-read' });
}, 5000);
test('rejects changed metadata, directories, missing files and cancellation', async () => {
  const path = join(work, 'changed.mkv');
  await writeFile(path, 'abc');
  const identity = await identify(path);
  await utimes(path, new Date(), new Date(identity.mtimeMs + 10000));
  await expect(verifySource(identity)).rejects.toThrow('已变更');
  await writeFile(path, 'longer');
  await expect(verifySource(identity)).rejects.toThrow('已变更');
  await expect(identify(work)).rejects.toThrow('录像文件');
  await rm(path);
  await expect(verifySource(identity)).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(identify(work, controller.signal)).rejects.toBeInstanceOf(Cancelled);
});
