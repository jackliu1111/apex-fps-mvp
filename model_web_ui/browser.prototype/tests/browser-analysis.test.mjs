import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatesFromScores, chooseAudioTracks } from '../browser-analysis.mjs';

test('window scores obey five-second grouping and publish final tail only at EOF', () => {
  const record = { duration: 60, windowScores: [
    { start: 10, end: 20, scores: [0.8, 0] },
    { start: 25, end: 35, scores: [0.7, 0] },
    { start: 42, end: 47, scores: [0.9, 0] },
  ] };
  assert.deepEqual(candidatesFromScores(record, 0.2, 40).map(({ start, end, provisional }) => ({ start, end, provisional })), [
    { start: 5, end: 40, provisional: true }, { start: 37, end: 52, provisional: true },
  ]);
  assert.deepEqual(candidatesFromScores(record, 0.2, Infinity).map(({ start, end, provisional }) => ({ start, end, provisional })), [
    { start: 5, end: 40, provisional: false }, { start: 37, end: 52, provisional: false },
  ]);
});

test('automatic analysis uses the source primary track and preserves its output identity', async () => {
  const tracks = [{ id: 1, canDecode: async () => true }, { id: 2, canDecode: async () => true }];
  const choice = await chooseAudioTracks({ getPrimaryAudioTrack: async () => tracks[1] }, tracks);
  assert.equal(choice.selected, 1);
  assert.equal(choice.outputAudioTrackIndex, 1);
});

test('a decoder capability failure can use another track without changing source output sound', async () => {
  const tracks = [{ id: 1, codec: 'aac', canDecode: async () => { throw new Error('codec probe failed'); } }, { id: 2, codec: 'opus', canDecode: async () => true }];
  const choice = await chooseAudioTracks({ getPrimaryAudioTrack: async () => tracks[0] }, tracks);
  assert.equal(choice.selected, 1);
  assert.equal(choice.outputAudioTrackIndex, 0);
  assert.equal(choice.audioPolicy.fallback, true);
});
