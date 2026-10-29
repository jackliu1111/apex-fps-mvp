import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewWorkspace } from '../review-workspace.mjs';

const source = { id: 'recording-a', name: 'A.mkv', size: 1000, lastModified: 1, fingerprint: 'a', duration: 3000 };
const setup = (options) => {
  const workspace = createReviewWorkspace(options);
  workspace.addSource(source);
  return workspace;
};

test('automatic ranges can merge without changing manual decisions or submitted exports', async () => {
  const workspace = setup();
  workspace.publishCandidates(source.id, [{ key: 'one', start: 395, end: 425 }, { key: 'two', start: 425, end: 445 }, { key: 'three', start: 450, end: 495 }]);
  workspace.trim(source.id, 'auto:one', { start: 400, end: 420 });
  workspace.choose(source.id, 'auto:three', false);
  workspace.setReview(source.id, { selectedClipId: 'auto:two', position: 430 });
  const batch = workspace.submitBatch(source.id);
  const before = workspace.getSource(source.id);
  workspace.mergeCandidates(source.id);
  const after = workspace.getSource(source.id);
  assert.deepEqual(after.candidates.map(({ start, end }) => [start, end]), [[395, 495]]);
  assert.deepEqual(after.decisions, before.decisions);
  assert.deepEqual(workspace.view().batches[0], batch);
  assert.deepEqual(after.clips.filter(clip => clip.selected).map(({ start, end }) => [start, end]), [[400, 420]]);
  assert.equal(after.review.position, 430);
  assert.equal(after.review.selectedClipId, 'auto:one');
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

test('source attachment exposes only identity metadata and rejects a conflicting identity', async () => {
  const workspace = createReviewWorkspace();
  workspace.addSource({ ...source, file: new File(['do not persist'], 'A.mkv'), input: { transient: true } });
  workspace.addManual(source.id, { start: 10, end: 20 });
  assert.throws(() => workspace.addSource({ ...source, fingerprint: 'different' }));
  assert.equal('file' in workspace.getSource(source.id).identity, false);
  assert.equal('input' in workspace.getSource(source.id).identity, false);
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

test('partial export outcomes and downloads remain available during the session', async () => {
  const workspace = setup();
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
  const restored = workspace.view().batches[0];
  assert.deepEqual(restored.clipResults.map((clip) => clip.status), ['completed', 'failed', 'not-started']);
  assert.equal(restored.clipResults[1].error, 'unsupported frame');
  assert.equal(restored.outputs[0].available, true);
  assert.match(restored.outputs[0].url, /^blob:/);
  await queue.dispose();
});

test('undo affects only human decisions while analysis, view and exports advance', async () => {
  const workspace = setup();
  workspace.publishCandidates(source.id, [{ id: 'one', start: 10, end: 30 }]);
  workspace.setReview(source.id, { selectedClipId: 'auto:one' });
  const manual = workspace.trim(source.id, 'auto:one', { start: 12, end: 28 });
  const batch = workspace.submitBatch(source.id);
  workspace.choose(source.id, manual, false);
  workspace.publishCandidates(source.id, [{ id: 'one', start: 10, end: 30 }, { id: 'two', start: 40, end: 50 }]);
  workspace.setReview(source.id, { position: 100, zoomStart: 5, zoomEnd: 60 });
  assert.equal(workspace.undo(source.id), true);
  const restored = workspace.getSource(source.id);
  assert.equal(restored.review.selectedClipId, manual);
  assert.equal(restored.review.position, 100);
  assert.equal(restored.review.zoomStart, 5);
  assert.ok(restored.clips.some(c => c.id === 'auto:two'));
  assert.deepEqual(workspace.view().batches[0].clips, batch.clips);
  workspace.redo(source.id);
  assert.equal(workspace.getSource(source.id).review.selectedClipId, null);
  assert.equal(workspace.getSource(source.id).clips.some(c => c.id === 'auto:one'), false);
  workspace.restoreExcluded(source.id, manual);
  assert.equal(workspace.getSource(source.id).clips.find(c => c.id === manual).start, 12);
  assert.equal(workspace.getSource(source.id).canRedo, false);
});

test('new edits clear redo only for their source; history is bounded and no-op trims are not recorded', () => {
  const workspace = setup(); workspace.addSource({ ...source, id: 'b' });
  const id = workspace.addManual(source.id, { start: 10, end: 50 });
  const revision = workspace.view().revision;
  workspace.trim(source.id, id, { start: 10, end: 50 });
  assert.equal(workspace.view().revision, revision);
  for (let i = 0; i < 110; i++) workspace.trim(source.id, id, { start: 11 + i / 10, end: 50 });
  workspace.undo(source.id); workspace.addManual('b', { start: 1, end: 2 });
  assert.equal(workspace.getSource(source.id).canRedo, true);
  workspace.redo(source.id);
  let count = 0; while (workspace.undo(source.id)) count++;
  assert.equal(count, 100);
  assert.equal(workspace.getSource('b').clips.length, 1);
});

test('waveforms stay immutable during edits and a new workspace starts empty', () => {
  const workspace = setup();
  const wave = { version: 1, step: .05, peaks: [0, .5, null], decodedUntil: .1, trackIndex: 0 };
  workspace.updateWaveform(source.id, wave);
  wave.peaks[1] = 1;
  const evidence = workspace.getSource(source.id).waveform;
  workspace.addManual(source.id, { start: 10, end: 20 });
  workspace.setReview(source.id, { position: 12 });
  workspace.undo(source.id);
  assert.equal(workspace.getSource(source.id).waveform, evidence);
  assert.equal(evidence.peaks[1], .5);
  assert.throws(() => { evidence.peaks[1] = 0; }, TypeError);
  const fresh = createReviewWorkspace();
  assert.deepEqual(fresh.view().sources, []);
  assert.deepEqual(fresh.view().batches, []);
});
