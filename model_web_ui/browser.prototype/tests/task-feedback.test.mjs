import test from 'node:test';
import assert from 'node:assert/strict';
import { batchSummary, justCompleted } from '../task-feedback.mjs';

test('partial export summary counts actual outcomes even when progress reaches one', () => {
  const batch = { clips: [{}, {}, {}], progress: 1, status: 'failed', clipResults: [{ status: 'completed' }, { status: 'failed' }, { status: 'not-started' }] };
  assert.deepEqual(batchSummary(batch), { text: '已完成 1 / 3 段 · 1 段失败', failed: 1 });
});

test('legacy batches without outcome records do not claim all files completed', () => {
  assert.equal(batchSummary({ clips: [{}, {}], status: 'completed', outputs: [{}] }).text, '2 段 · 完成明细未记录');
});

test('restoration and repeated renders never replay completion; a completed retry can', () => {
  assert.equal(justCompleted(undefined, 'completed'), false);
  assert.equal(justCompleted('completed', 'completed'), false);
  assert.equal(justCompleted('complete', 'completed'), false);
  assert.equal(justCompleted('running', 'failed'), false);
  assert.equal(justCompleted('analyzing', 'complete'), true);
  assert.equal(justCompleted('running', 'completed'), true);
});
