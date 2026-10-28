import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewWorkspace } from '../review-workspace.mjs';
import { createExportQueue } from '../export-queue.mjs';

test('background playback positions persist without hiding edits or storage errors', async () => {
  let stored, fail = false;
  const workspace = createReviewWorkspace({ storage: { save: async snapshot => {
    if (fail) throw new Error('disk full');
    stored = snapshot;
  } } });
  workspace.addSource({ id: 'source', name: 'test.webm', duration: 60 });
  await workspace.flush();
  workspace.setReview('source', { position: 1 }, { background: true });
  assert.equal(workspace.view().save.reviewStatus, 'saved');
  await workspace.flush();
  assert.equal(stored.sources[0].review.position, 1);
  workspace.addManual('source', { start: 10, end: 20 });
  workspace.setReview('source', { position: 2 }, { background: true });
  assert.equal(workspace.view().save.reviewStatus, 'unsaved');
  await workspace.flush();
  fail = true;
  workspace.setReview('source', { position: 3 }, { background: true });
  assert.equal(await workspace.flush(), false);
  assert.equal(workspace.view().save.reviewStatus, 'error');
  workspace.setReview('source', { position: 4 }, { background: true });
  assert.equal(workspace.view().save.reviewStatus, 'error');
  fail = false;
  await workspace.retrySave();
  assert.equal(stored.sources[0].review.position, 4);
});

test('export queue progress persists without changing the saved review indicator', async () => {
  const feedback = [];
  let stored;
  const workspace = createReviewWorkspace({
    storage: { save: async (snapshot) => { stored = snapshot; } },
    onChange: ({ save }) => feedback.push(save.reviewStatus ?? save.status),
  });
  workspace.addSource({ id: 'source', name: 'test.webm', duration: 60 });
  workspace.addManual('source', { start: 10, end: 20 });
  const batch = workspace.submitBatch('source');
  await workspace.flush();
  feedback.length = 0;
  const queue = createExportQueue({
    onChange: ({ id, status, outputs, error, progress, clipResults }) => workspace.updateBatch(id, { status, outputs, error, progress, clipResults }),
    convert: async ({ onProgress }) => {
      for (const progress of [0.1, 0.4, 0.8]) { onProgress(progress); await workspace.flush(); }
      return { saved: true, name: 'test.webm', bytes: 100 };
    },
  });
  queue.enqueue(batch, { file: {}, directoryHandle: {} });
  await queue.whenIdle();
  await workspace.flush();
  assert.equal(stored.batches[0].status, 'completed');
  assert.equal(stored.batches[0].progress, 1);
  assert.deepEqual([...new Set(feedback)], ['saved']);
});

test('background export updates cannot hide an unsaved review edit or a storage failure', async () => {
  let fail = false;
  const workspace = createReviewWorkspace({ storage: { save: async () => { if (fail) throw new Error('disk full'); } } });
  workspace.addSource({ id: 'source', name: 'test.webm', duration: 60 });
  workspace.addManual('source', { start: 10, end: 20 });
  const batch = workspace.submitBatch('source');
  await workspace.flush();
  workspace.setReview('source', { position: 12 });
  workspace.updateBatch(batch.id, { progress: 0.2 });
  assert.equal(workspace.view().save.reviewStatus ?? workspace.view().save.status, 'unsaved');
  await workspace.flush();
  fail = true;
  workspace.updateBatch(batch.id, { progress: 0.4 });
  assert.equal(await workspace.flush(), false);
  assert.equal(workspace.view().save.reviewStatus ?? workspace.view().save.status, 'error');
  workspace.updateBatch(batch.id, { progress: 0.6 });
  assert.equal(workspace.view().save.reviewStatus ?? workspace.view().save.status, 'error');
  fail = false;
  assert.equal(await workspace.retrySave(), true);
  assert.equal(workspace.view().save.reviewStatus ?? workspace.view().save.status, 'saved');
});
