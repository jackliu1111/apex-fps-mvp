import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionWindow } from '../selection-timeline.mjs';

test('a candidate occupies one third of the source window with context on both sides', () => {
  assert.deepEqual(selectionWindow(300, { start: 100, end: 130 }), { zoomStart: 70, zoomEnd: 160 });
});
test('source boundaries shift context to the other side without reducing its span', () => {
  assert.deepEqual(selectionWindow(300, { start: 5, end: 35 }), { zoomStart: 0, zoomEnd: 90 });
  assert.deepEqual(selectionWindow(300, { start: 265, end: 295 }), { zoomStart: 210, zoomEnd: 300 });
});
test('short sources cap the window at the whole recording', () => {
  assert.deepEqual(selectionWindow(60, { start: 10, end: 40 }), { zoomStart: 0, zoomEnd: 60 });
  assert.deepEqual(selectionWindow(0.2, { start: 0, end: 0.2 }), { zoomStart: 0, zoomEnd: 0.2 });
});
