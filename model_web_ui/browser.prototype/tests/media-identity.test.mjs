import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyFile } from '../media-identity.mjs';

test('deduplicating the same source uses content and metadata rather than its name alone', async () => {
  const first = new File(['original media'], 'same.mkv', { lastModified: 123 });
  const same = new File(['original media'], 'same.mkv', { lastModified: 123 });
  const different = new File(['different data'], 'same.mkv', { lastModified: 123 });
  const identity = await identifyFile(first);
  assert.equal(identity.id, (await identifyFile(same)).id);
  assert.notEqual(identity.id, (await identifyFile(different)).id);
  assert.equal(identity.name, 'same.mkv');
  assert.equal(identity.size, 14);
});
