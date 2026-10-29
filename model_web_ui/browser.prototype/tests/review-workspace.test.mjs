import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewWorkspace } from '../review-workspace.mjs';

const source = { id: 'recording-a', name: 'A.mkv', size: 1000, lastModified: 1, fingerprint: 'a', duration: 3000 };
const setup = (options) => {
  const workspace = createReviewWorkspace(options);
  workspace.addSource(source);
  return workspace;
};

test('saved automatic ranges can merge without changing manual decisions or submitted exports', async () => {
  let stored;
  const workspace = setup({ storage: { save: async snapshot => { stored = snapshot; } } });
  workspace.publishCandidates(source.id, [{ key: 'one', start: 395, end: 425 }, { key: 'two', start: 425, end: 445 }, { key: 'three', start: 450, end: 495 }]);
  workspace.trim(source.id, 'auto:one', { start: 400, end: 420 });
  workspace.choose(source.id, 'auto:three', false);
  workspace.setReview(source.id, { selectedClipId: 'auto:two', position: 430 });
  const batch = workspace.submitBatch(source.id);
  const before = workspace.getSource(source.id);
  await workspace.flush();
  workspace.mergeCandidates(source.id);
  const after = workspace.getSource(source.id);
  assert.deepEqual(after.candidates.map(({ start, end }) => [start, end]), [[395, 495]]);
  assert.deepEqual(after.decisions, before.decisions);
  assert.deepEqual(workspace.view().batches[0], batch);
  assert.deepEqual(after.clips.filter(clip => clip.selected).map(({ start, end }) => [start, end]), [[400, 420]]);
  assert.equal(after.review.position, 430);
  assert.equal(after.review.selectedClipId, 'auto:one');
  assert.equal(workspace.view().save.reviewStatus, 'saved');
  await workspace.flush();
  assert.deepEqual(stored.sources[0].candidates, after.candidates);
});

test('an unopened destination dialog restores as actionable waiting rather than a cancelled encode', async () => {
  let snapshot;
  const workspace = setup({ storage: { save: async value => { snapshot = value; } } });
  workspace.addManual(source.id, { start: 10, end: 20 });
  const legacy = workspace.submitBatch(source.id);
  workspace.updateBatch(legacy.id, { status: 'cancelled', error: '已取消输出目录选择，本批未开始导出。' });
  const waiting = workspace.submitBatch(source.id);
  workspace.updateBatch(waiting.id, { status: 'awaiting-destination' });
  const cancelled = workspace.submitBatch(source.id);
  workspace.updateBatch(cancelled.id, { status: 'cancelled', error: '已取消本批导出。' });
  await workspace.flush();
  const restored = createReviewWorkspace({ storage: { load: async () => snapshot } });
  await restored.restore();
  assert.deepEqual(restored.view().batches.map(batch => batch.status), ['awaiting-destination', 'awaiting-destination', 'cancelled']);
  assert.deepEqual(restored.view().batches[0].clips, legacy.clips);
});

test('a trimmed selection keeps its exact range when candidates move, split or disappear', () => {
  const workspace = setup();
  workspace.publishCandidates(source.id, [{ key: 'old', start: 600, end: 630 }]);
  const candidate = workspace.getSource(source.id).clips[0];
  assert.equal(candidate.selected, true);
  workspace.trim(source.id, candidate.id, { start: 604, end: 622 });
  workspace.publishCandidates(source.id, [{ key: 'new', start: 598, end: 635 }]);
  const clips = workspace.getSource(source.id).clips;
  assert.deepEqual(clips.filter((clip) => clip.selected).map(({ start, end }) => [start, end]), [[604, 622]]);
  assert.equal(clips.find((clip) => !clip.manual).supplemental, true);
  workspace.publishCandidates(source.id, [{ start: 600, end: 610 }, { start: 615, end: 630 }]);
  assert.equal(workspace.getSource(source.id).clips.filter((clip) => clip.selected).length, 1);
  workspace.publishCandidates(source.id, []);
  assert.deepEqual(workspace.getSource(source.id).clips.map(({ start, end }) => [start, end]), [[604, 622]]);
});

test('excluded ranges stay hidden when identical and overlapping new suggestions require explicit selection', () => {
  const workspace = setup();
  workspace.publishCandidates(source.id, [{ start: 1200, end: 1220 }, { start: 1800, end: 1815 }]);
  let clips = workspace.getSource(source.id).clips;
  workspace.choose(source.id, clips[0].id, false);
  workspace.choose(source.id, clips[1].id, true);
  workspace.publishCandidates(source.id, [{ start: 1200, end: 1220 }, { start: 1195, end: 1235 }, { start: 1795, end: 1840 }]);
  clips = workspace.getSource(source.id).clips;
  assert.deepEqual(clips.map(({ start, end, selected }) => [start, end, selected]), [[1195, 1235, false], [1795, 1840, false], [1800, 1815, true]]);
  workspace.choose(source.id, clips[0].id, true);
  workspace.publishCandidates(source.id, [{ start: 1195, end: 1235 }]);
  assert.equal(workspace.getSource(source.id).clips.filter((clip) => clip.selected).length, 2);
  assert.deepEqual(workspace.getSource(source.id).decisions.find((decision) => decision.kind === 'exclude').range, { start: 1200, end: 1220 });
  workspace.resetDecisions(source.id);
  assert.deepEqual(workspace.getSource(source.id).clips.map(({ start, end, selected }) => [start, end, selected]), [[1195, 1235, true]]);
});

test('manual ranges are source-specific and incomplete automatic candidates cannot become human decisions', () => {
  const workspace = setup();
  workspace.addSource({ ...source, id: 'recording-b' });
  const manualId = workspace.addManual(source.id, { start: 30, end: 40 });
  workspace.publishCandidates(source.id, [{ start: 50, end: 60, provisional: true }]);
  assert.equal(workspace.getSource(source.id).clips.find((clip) => clip.id === manualId).selected, true);
  assert.equal(workspace.getSource('recording-b').clips.length, 0);
  const provisional = workspace.getSource(source.id).clips.find((clip) => clip.provisional);
  assert.throws(() => workspace.choose(source.id, provisional.id, true));
  assert.throws(() => workspace.addManual(source.id, { start: 20, end: 10 }));
});

test('submitted exports freeze selected stable ranges, source and settings while current edits continue', () => {
  const workspace = setup();
  workspace.publishCandidates(source.id, [{ start: 80, end: 100 }, { start: 200, end: 220, provisional: true }]);
  const settings = { audio: { mode: 'all', trackIds: [1, 2] }, output: { format: 'webm', width: 1280 } };
  const batch = workspace.submitBatch(source.id, settings);
  assert.deepEqual(batch.clips.map(({ start, end }) => [start, end]), [[80, 100]]);
  assert.equal(workspace.getSource(source.id).hasUnexportedChanges, false);
  settings.audio.trackIds.length = 0;
  const candidate = workspace.getSource(source.id).clips[0];
  workspace.trim(source.id, candidate.id, { start: 83, end: 97 });
  workspace.updateBatch(batch.id, { status: 'running', progress: 0.5 });
  assert.equal(workspace.getSource(source.id).hasUnexportedChanges, true);
  const currentBatch = workspace.view().batches[0];
  assert.deepEqual(currentBatch.clips.map(({ start, end }) => [start, end]), [[80, 100]]);
  assert.deepEqual(currentBatch.audio.trackIds, [1, 2]);
  assert.throws(() => { batch.clips[0].start = 0; }, TypeError);
  assert.throws(() => workspace.updateBatch(batch.id, { clips: [] }));
  workspace.resetDecisions(source.id);
  assert.deepEqual(workspace.view().batches[0].clips.map(({ start, end }) => [start, end]), [[80, 100]]);
});

const memoryStorage = () => {
  let value;
  return { load: async () => structuredClone(value), save: async (snapshot) => { value = structuredClone(snapshot); } };
};

test('saved human work restores before a source is rebound and running tasks are marked interrupted', async () => {
  const storage = memoryStorage();
  const workspace = setup({ storage });
  workspace.publishCandidates(source.id, [{ start: 1200, end: 1220 }]);
  workspace.choose(source.id, workspace.getSource(source.id).clips[0].id, false);
  const manualId = workspace.addManual(source.id, { start: 604, end: 622 });
  workspace.setReview(source.id, { position: 910, selectedClipId: manualId, zoomStart: 580, zoomEnd: 660 });
  workspace.updateAnalysis(source.id, { status: 'analyzing', processedUntil: 900 });
  const batch = workspace.submitBatch(source.id, { audio: { mode: 'all' } });
  workspace.updateBatch(batch.id, { status: 'running' });
  assert.equal(await workspace.flush(), true);
  assert.equal(workspace.view().save.status, 'saved');
  const reopened = createReviewWorkspace({ storage });
  assert.equal(await reopened.restore(), true);
  assert.deepEqual(reopened.getSource(source.id).review, { position: 910, selectedClipId: manualId, zoomStart: 580, zoomEnd: 660 });
  assert.equal(reopened.getSource(source.id).analysis.status, 'interrupted');
  assert.equal(reopened.view().batches[0].status, 'interrupted');
  reopened.addSource(source);
  reopened.publishCandidates(source.id, [{ start: 1200, end: 1220 }, { start: 1195, end: 1235 }]);
  assert.deepEqual(reopened.getSource(source.id).clips.map(({ start, end, selected }) => [start, end, selected]), [[604, 622, true], [1195, 1235, false]]);
});

test('an older save completing cannot claim that newer edits have already been saved', async () => {
  const writes = [];
  const storage = {
    load: async () => null,
    save: (snapshot) => new Promise((resolve) => writes.push({ snapshot, resolve })),
  };
  const workspace = setup({ storage, saveDelayMs: 10000 });
  const id = workspace.addManual(source.id, { start: 10, end: 20 });
  const saving = workspace.flush();
  await new Promise(setImmediate);
  workspace.trim(source.id, id, { start: 11, end: 19 });
  writes[0].resolve();
  await new Promise(setImmediate);
  assert.equal(workspace.view().save.status, 'saving');
  assert.ok(workspace.view().save.savedRevision < workspace.view().save.revision);
  writes[1].resolve();
  assert.equal(await saving, true);
  assert.equal(workspace.view().save.status, 'saved');
  const reopened = createReviewWorkspace({ storage: { load: async () => writes[1].snapshot } });
  await reopened.restore();
  assert.deepEqual(reopened.getSource(source.id).clips.map(({ start, end }) => [start, end]), [[11, 19]]);
});

test('a synchronous persistence failure retains the draft and retry really writes it', async () => {
  let fail = true;
  const storage = memoryStorage();
  const save = storage.save;
  storage.save = (snapshot) => {
    if (fail) throw new Error('disk full');
    return save(snapshot);
  };
  const workspace = setup({ storage });
  workspace.addManual(source.id, { start: 40, end: 60 });
  assert.equal(await workspace.flush(), false);
  assert.equal(workspace.view().save.status, 'error');
  assert.equal(workspace.getSource(source.id).clips.length, 1);
  fail = false;
  assert.equal(await workspace.retrySave(), true);
  const reopened = createReviewWorkspace({ storage });
  await reopened.restore();
  assert.deepEqual(reopened.getSource(source.id).clips.map(({ start, end }) => [start, end]), [[40, 60]]);
});

test('editing the active range preserves its identity, playback position and zoom through candidate updates', () => {
  const workspace = setup();
  workspace.publishCandidates(source.id, [{ key: 'one', start: 10, end: 30 }]);
  const original = workspace.getSource(source.id).clips[0];
  workspace.setReview(source.id, { position: 100, selectedClipId: original.id, zoomStart: 0, zoomEnd: 60 });
  const retainedId = workspace.trim(source.id, original.id, { start: 12, end: 28 });
  workspace.publishCandidates(source.id, [{ key: 'one', start: 10, end: 30 }, { key: 'two', start: 80, end: 90 }]);
  assert.equal(workspace.getSource(source.id).review.selectedClipId, retainedId);
  assert.equal(workspace.getSource(source.id).clips.find((clip) => clip.id === retainedId).start, 12);
  assert.deepEqual(workspace.getSource(source.id).review, { position: 100, selectedClipId: retainedId, zoomStart: 0, zoomEnd: 60 });
});

test('source attachment persists only identity metadata and rejects a conflicting identity', async () => {
  const storage = memoryStorage();
  const workspace = createReviewWorkspace({ storage });
  workspace.addSource({ ...source, file: new File(['do not persist'], 'A.mkv'), input: { transient: true } });
  workspace.addManual(source.id, { start: 10, end: 20 });
  assert.throws(() => workspace.addSource({ ...source, fingerprint: 'different' }));
  await workspace.flush();
  const reopened = createReviewWorkspace({ storage });
  await reopened.restore();
  assert.equal('file' in reopened.getSource(source.id).identity, false);
  assert.equal('input' in reopened.getSource(source.id).identity, false);
});

test('continuous progress updates cannot indefinitely postpone saving human work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workspace = setup({ storage: memoryStorage(), saveDelayMs: 20 });
  workspace.addManual(source.id, { start: 10, end: 20 });
  t.mock.timers.tick(10);
  workspace.updateAnalysis(source.id, { processedUntil: 1 });
  t.mock.timers.tick(10);
  await new Promise(setImmediate);
  assert.equal(workspace.view().save.status, 'saved');
});

test('a failed initial restore cannot overwrite existing saved work and can be retried', async () => {
  const durable = memoryStorage();
  const previous = setup({ storage: durable });
  previous.addManual(source.id, { start: 8, end: 16 });
  await previous.flush();
  let unavailable = true;
  const workspace = createReviewWorkspace({ storage: {
    load: () => { if (unavailable) throw new Error('storage temporarily unavailable'); return durable.load(); },
    save: durable.save,
  } });
  assert.equal(await workspace.restore(), false);
  assert.throws(() => workspace.addSource({ ...source, id: 'new' }));
  unavailable = false;
  assert.equal(await workspace.retrySave(), true);
  assert.deepEqual(workspace.getSource(source.id).clips.map(({ start, end }) => [start, end]), [[8, 16]]);
});

test('bulk choices preserve existing decisions, skip provisional suggestions and never duplicate retained ranges', () => {
  const workspace = setup();
  const manual = workspace.addManual(source.id, { start: 10, end: 20 });
  assert.equal(workspace.addManual(source.id, { start: 10, end: 20 }), manual, 'Adding an identical human range selects the existing range');
  workspace.publishCandidates(source.id, [{ key: 'exclude', start: 30, end: 40 }, { key: 'normal', start: 50, end: 60 }, { key: 'pending', start: 70, end: 80, provisional: true }]);
  workspace.choose(source.id, 'auto:exclude', false);
  workspace.publishCandidates(source.id, [{ key: 'overlap', start: 28, end: 42 }, { key: 'normal', start: 50, end: 60 }, { key: 'pending', start: 70, end: 80, provisional: true }]);
  workspace.chooseAll(source.id, true);
  workspace.chooseAll(source.id, true);
  const retained = workspace.getSource(source.id);
  assert.deepEqual(retained.clips.filter((clip) => clip.manual).map(({ start, end }) => [start, end]), [[10, 20], [28, 42], [50, 60]]);
  assert.ok(retained.decisions.some((decision) => decision.kind === 'exclude' && decision.range.start === 30));
  assert.equal(retained.decisions.some((decision) => decision.range.start === 70), false);
  workspace.chooseAll(source.id, false);
  assert.equal(workspace.getSource(source.id).clips.filter((clip) => clip.selected && !clip.provisional).length, 0);
  workspace.publishCandidates(source.id, [{ start: 8, end: 22 }, { start: 48, end: 62 }]);
  assert.ok(workspace.getSource(source.id).clips.every((clip) => clip.supplemental && !clip.selected));
});

import { createExportQueue } from '../export-queue.mjs';

test('partial export outcomes persist through restore while expired download URLs stay unavailable', async () => {
  const storage = memoryStorage(), workspace = setup({ storage });
  for (const start of [10, 20, 30]) workspace.addManual(source.id, { start, end: start + 5 });
  const batch = workspace.submitBatch(source.id, { output: { width: 640, height: 360, videoBitrate: 2000000 } });
  const queue = createExportQueue({
    onChange: ({ id, waitingReason, ...patch }) => workspace.updateBatch(id, patch),
    convert: async ({ clip }) => {
      if (clip.start === 20) throw new Error('unsupported frame');
      return { blob: new Blob(['video']), start: clip.start, end: clip.end, name: 'completed.webm' };
    },
  });
  queue.enqueue(batch, { file: new Blob(['source']) }); await queue.whenIdle();
  await workspace.flush();
  const reopened = createReviewWorkspace({ storage }); await reopened.restore();
  const restored = reopened.view().batches[0];
  assert.deepEqual(restored.clipResults.map((clip) => clip.status), ['completed', 'failed', 'not-started']);
  assert.equal(restored.clipResults[1].error, 'unsupported frame');
  assert.equal(restored.outputs[0].available, false);
  assert.equal(restored.outputs[0].url, undefined);
  await queue.dispose(); await workspace.flush();
});

test('restore marks an active clip interrupted without claiming that it completed or never started', async () => {
  const storage = memoryStorage(), workspace = setup({ storage });
  for (const start of [10, 20]) workspace.addManual(source.id, { start, end: start + 5 });
  const batch = workspace.submitBatch(source.id);
  const clipResults = batch.clips.map((clip, index) => ({ ...clip, status: index ? 'not-started' : 'running', error: null }));
  workspace.updateBatch(batch.id, { status: 'running', clipResults }); await workspace.flush();
  const reopened = createReviewWorkspace({ storage }); await reopened.restore();
  assert.equal(reopened.view().batches[0].status, 'interrupted');
  assert.deepEqual(reopened.view().batches[0].clipResults.map((clip) => clip.status), ['interrupted', 'not-started']);
});

test('undo persists and affects only human decisions while analysis, view and exports advance', async () => {
  const storage = memoryStorage(), workspace = setup({ storage });
  workspace.publishCandidates(source.id, [{ id: 'one', start: 10, end: 30 }]);
  workspace.setReview(source.id, { selectedClipId: 'auto:one' });
  const manual = workspace.trim(source.id, 'auto:one', { start: 12, end: 28 });
  const batch = workspace.submitBatch(source.id);
  workspace.choose(source.id, manual, false);
  workspace.publishCandidates(source.id, [{ id: 'one', start: 10, end: 30 }, { id: 'two', start: 40, end: 50 }]);
  workspace.setReview(source.id, { position: 100, zoomStart: 5, zoomEnd: 60 });
  await workspace.flush();
  const reopened = createReviewWorkspace({ storage }); await reopened.restore();
  assert.equal(reopened.undo(source.id), true);
  const restored = reopened.getSource(source.id);
  assert.equal(restored.review.selectedClipId, manual);
  assert.equal(restored.review.position, 100);
  assert.equal(restored.review.zoomStart, 5);
  assert.ok(restored.clips.some(c => c.id === 'auto:two'));
  assert.deepEqual(reopened.view().batches[0].clips, batch.clips);
  reopened.redo(source.id);
  assert.equal(reopened.getSource(source.id).review.selectedClipId, null);
  assert.equal(reopened.getSource(source.id).clips.some(c => c.id === 'auto:one'), false);
  reopened.restoreExcluded(source.id, manual);
  assert.equal(reopened.getSource(source.id).clips.find(c => c.id === manual).start, 12);
  assert.equal(reopened.getSource(source.id).canRedo, false);
  await reopened.flush();
});

test('new edits clear redo only for their source; history is bounded and no-op trims are not recorded', () => {
  const workspace = setup(); workspace.addSource({ ...source, id: 'b' });
  const id = workspace.addManual(source.id, { start: 10, end: 50 });
  const revision = workspace.view().save.revision;
  workspace.trim(source.id, id, { start: 10, end: 50 });
  assert.equal(workspace.view().save.revision, revision);
  for (let i = 0; i < 110; i++) workspace.trim(source.id, id, { start: 11 + i / 10, end: 50 });
  workspace.undo(source.id); workspace.addManual('b', { start: 1, end: 2 });
  assert.equal(workspace.getSource(source.id).canRedo, true);
  workspace.redo(source.id);
  let count = 0; while (workspace.undo(source.id)) count++;
  assert.equal(count, 100);
  assert.equal(workspace.getSource('b').clips.length, 1);
});

test('progressive waveform survives refresh and human edits without dirtying review state', async () => {
  let snapshot;
  const storage = { save: async value => { snapshot = value; }, load: async () => snapshot };
  const workspace = setup({ storage });
  await workspace.flush();
  const wave = { version: 1, step: .05, peaks: [0, .5, null], decodedUntil: .1, trackIndex: 0 };
  workspace.updateWaveform(source.id, wave);
  wave.peaks[1] = 1;
  assert.equal(workspace.getSource(source.id).waveform.peaks[1], .5);
  assert.equal(workspace.view().save.reviewStatus, 'saved');
  workspace.addManual(source.id, { start: 10, end: 20 });
  await workspace.flush();
  const restored = createReviewWorkspace({ storage });
  await restored.restore();
  assert.deepEqual(restored.getSource(source.id).waveform, { ...wave, peaks: [0, .5, null] });
  assert.equal(restored.getSource(source.id).clips.length, 1);
});
