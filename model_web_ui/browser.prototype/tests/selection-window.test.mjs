import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionWindow, createSelectionTimeline } from '../selection-timeline.mjs';
import { createSelectionEvidence } from '../selection-evidence.mjs';

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

test('selection evidence projects cached preview frames immediately during transition without blanking the filmstrip', async () => {
  const results = [];
  let busy = false;
  const MB = {
    ALL_FORMATS: [],
    StreamSource: class { constructor(options) { this.options = options; } },
    Input: class {
      async getPrimaryVideoTrack() {
        return { getFirstTimestamp: async () => 0 };
      }
      dispose() {}
    },
    CanvasSink: class {
      async getCanvas(timestamp) {
        return { timestamp, canvas: { toDataURL: () => `data:image/jpeg;base64,frame-${timestamp}` } };
      }
    },
    EncodedPacketSink: class {
      async getKeyPacket(target) {
        return { type: 'key', timestamp: Math.floor(target / 2) * 2 };
      }
      async getFirstPacket() {
        return { type: 'key', timestamp: 0 };
      }
    },
  };
  const evidence = createSelectionEvidence({
    MB,
    isBusy: () => busy,
    onResult(result) { results.push(result); },
  });
  const file = new Blob(['video']);
  await new Promise((resolve) => {
    evidence.request({ file, origin: 0 }, 0, 60);
    const check = setInterval(() => {
      if (results.at(-1)?.status === '原片参考画面') {
        clearInterval(check);
        resolve();
      }
    }, 15);
  });
  assert.equal(results.at(-1).frames.length, 10);
  assert.equal(results.at(-1).provisional, false);

  results.length = 0;
  busy = true;
  setTimeout(() => { busy = false; }, 40);
  evidence.request({ file, origin: 0 }, 12, 21);
  // Immediately upon requesting a local window, cached preview frames are projected instead of an empty [] flash
  assert.equal(results[0].provisional, true);
  assert.equal(results[0].frames.length, 10);
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (results.at(-1)?.status === '原片参考画面') {
        clearInterval(check);
        resolve();
      }
    }, 15);
  });
  assert.equal(results.at(-1).provisional, false);
  assert.equal(results.at(-1).frames.length, 10);
  evidence.cancel();
});

test('selection timeline animates local zoom transitions and switches to compact handles in full-source view', () => {
  const nodes = new Map();
  const makeNode = (id = '') => ({
    id,
    dataset: {},
    style: {},
    attributes: {},
    children: [],
    textContent: '',
    hidden: false,
    disabled: false,
    checked: false,
    clientWidth: 900,
    clientHeight: 64,
    width: 900,
    height: 64,
    get firstElementChild() { return this.children[0] || null; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    replaceChildren(...items) {
      this.children = items;
      this.textContent = items.map((item) => item.textContent || '').join('');
    },
    insertBefore(node, ref) {
      const existing = this.children.indexOf(node);
      if (existing >= 0) this.children.splice(existing, 1);
      const index = ref ? this.children.indexOf(ref) : -1;
      if (index >= 0) this.children.splice(index, 0, node);
      else this.children.push(node);
      node.nextElementSibling = this.children[this.children.indexOf(node) + 1] || null;
    },
    getContext() {
      return { clearRect() {}, fillRect() {} };
    },
    querySelector() { return makeNode(); },
    focus() {},
  });
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
  };
  let rafQueue = [];
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  globalThis.document = {
    getElementById: getNode,
    createElement: (tag) => makeNode(tag),
    activeElement: null,
  };
  globalThis.window = {
    devicePixelRatio: 1,
    addEventListener() {},
  };
  globalThis.requestAnimationFrame = (cb) => {
    const id = rafQueue.length + 1;
    rafQueue.push({ id, cb });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafQueue = rafQueue.filter((item) => item.id !== id);
  };
  try {
    let source = {
      id: 'src-1',
      duration: 300,
      canUndo: false,
      canRedo: false,
      analysis: { status: 'completed' },
      waveform: { trackIndex: 0, decodedUntil: 300, peaks: [0.4, 0.7] },
      clips: [{ id: 'clip-1', start: 100, end: 130 }],
      decisions: [],
      review: { selectedClipId: null, position: 0, zoomStart: 0, zoomEnd: 300 },
    };
    const timeline = createSelectionTimeline({
      MB: null,
      workspace: {
        setReview(_id, patch) {
          source = { ...source, review: { ...source.review, ...patch } };
          timeline.render(source);
        },
      },
      getSource: () => source,
      getRecord: () => null,
      selectRange: () => {},
      seek: () => {},
      pause: () => {},
      isPlayerBusy: () => false,
      report: (err) => { throw err; },
    });

    // Initial full-source render
    timeline.render(source);
    assert.equal(getNode('selection-player-axis').dataset.scopeLabel, '全片视野');

    // Select prediction interval -> animates from [0, 300] to [70, 160]
    source = {
      ...source,
      review: { selectedClipId: 'clip-1', position: 100, zoomStart: 70, zoomEnd: 160 },
    };
    timeline.render(source);
    assert.equal(getNode('selection-player-axis').dataset.transitioning, 'zoom-in');
    // At t=0 of zoom-in from full view, width is 10% (<12%), so handles start compact and expand once width >= 12%
    assert.equal(getNode('selection-overlay').dataset.compact, 'true');

    // Mid-transition frame interpolates smoothly between full view and local view
    const started = performance.now();
    const mid = rafQueue.shift();
    mid.cb(started + 110);
    const midWidth = parseFloat(getNode('selection-overlay').style.width);
    assert.ok(midWidth > 12 && midWidth < 33.3, `Expected intermediate width between 12% and 33.3%, got ${midWidth}%`);
    assert.equal(getNode('selection-overlay').dataset.compact, 'false');
    assert.equal(getNode('prediction-source-window').hidden, false);

    // Final frame settles at exact 1/3 local window
    const end = rafQueue.shift();
    end.cb(started + 260);
    assert.equal(getNode('selection-player-axis').dataset.transitioning, undefined);
    assert.equal(getNode('selection-overlay').dataset.compact, 'false');
    assert.ok(Math.abs(parseFloat(getNode('selection-overlay').style.width) - 100 / 3) < 0.01);
    assert.match(getNode('selection-player-axis').dataset.scopeLabel, /^局部视野/);

    // Clicking "全片" (#source-fit) keeps selection active, animates zoom-out, and enables compact handles
    getNode('source-fit').onclick();
    assert.equal(getNode('selection-player-axis').dataset.transitioning, 'zoom-out');
    assert.equal(getNode('selection-overlay').dataset.compact, 'true');
    const fitEnd = rafQueue.shift();
    fitEnd.cb(performance.now() + 300);
    assert.equal(getNode('selection-player-axis').dataset.scopeLabel, '全片视野');
    assert.equal(getNode('selection-overlay').dataset.compact, 'true');
    assert.ok(Math.abs(parseFloat(getNode('selection-overlay').style.width) - 10) < 0.01);
    timeline.suspend();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCaf;
  }
});
