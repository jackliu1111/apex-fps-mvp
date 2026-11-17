import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionWindow, createSelectionTimeline } from '../selection-timeline.mjs';
import { createSelectionEvidence } from '../selection-evidence.mjs';
import { getLang, setLang } from '../i18n.js';

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
    addEventListener(type, fn) { this[`on${type}`] = fn; },
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
    querySelector(selector) {
      assert.equal(selector, 'dialog[open], [role="dialog"][aria-modal="true"]:not([hidden])');
      return null;
    },
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
    assert.equal(getNode('player-overview-markers').children.length, 1);
    assert.equal(getNode('player-overview-markers').children[0].dataset.active, 'true');

    // Final frame settles at exact 1/3 local window across selection, markers, and ticks
    const end = rafQueue.shift();
    end.cb(started + 260);
    assert.equal(getNode('selection-player-axis').dataset.transitioning, undefined);
    assert.equal(getNode('selection-overlay').dataset.compact, 'false');
    assert.ok(Math.abs(parseFloat(getNode('selection-overlay').style.width) - 100 / 3) < 0.01);
    assert.ok(Math.abs(parseFloat(getNode('overview-markers').children[0].style.width) - 100 / 3) < 0.01);
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
    assert.ok(Math.abs(parseFloat(getNode('overview-markers').children[0].style.width) - 10) < 0.01);
    timeline.suspend();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCaf;
  }
});

test('selection timeline paints layered group overlays, invalidates waveKey on group score progress, stays invariant on seek, and displays bilingual fallback track notice', () => {
  const nodes = new Map();
  const drawOps = [];
  let clearCount = 0;
  let computedStyleCalls = 0;
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
    clientWidth: 100,
    clientHeight: 68,
    width: 100,
    height: 68,
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
      const ctx = {
        fillStyle: '',
        globalAlpha: 1,
        clearRect() { clearCount++; drawOps.length = 0; },
        fillRect(x, y, w, h) {
          drawOps.push({ x, y, w, h, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha });
        },
      };
      return ctx;
    },
    addEventListener(type, fn) { this[`on${type}`] = fn; },
    querySelector() { return makeNode(); },
    focus() {},
  });
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
  };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevGetComputedStyle = globalThis.getComputedStyle;
  const prevLang = getLang();
  globalThis.document = {
    documentElement: { lang: 'en' },
    title: '',
    getElementById: getNode,
    createElement: (tag) => makeNode(tag),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    activeElement: null,
  };
  globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
  globalThis.getComputedStyle = () => {
    computedStyleCalls++;
    return { getPropertyValue: (name) => name === '--wave-bar' ? '#7b8391' : '' };
  };

  let timeline;
  try {
    const peaks = new Array(200).fill(0.25); // 10s @ 0.05s step
    let source = {
      id: 'src-layered',
      duration: 10,
      canUndo: false,
      canRedo: false,
      analysis: { status: 'analyzing' },
      waveform: { step: 0.05, trackIndex: 1, decodedUntil: 10, peaks },
      clips: [],
      decisions: [],
      review: { selectedClipId: null, position: 0, zoomStart: 0, zoomEnd: 10 },
    };
    let record = {
      id: 'src-layered',
      duration: 10,
      audioDuration: 10,
      audioOffset: 0,
      frameSeconds: 0.04,
      outputAudioTrackIndex: 0,
      audioPolicy: { fallback: true },
      groupCount: 5,
      groupScores: null,
      groupScoreFrames: 0,
      analysisStarted: 1,
    };
    setLang('en');
    timeline = createSelectionTimeline({
      MB: null,
      workspace: { setReview() {} },
      getSource: () => source,
      getRecord: (id) => (id === 'src-layered' ? record : undefined),
      selectRange: () => {},
      seek: () => {},
      pause: () => {},
      isPlayerBusy: () => false,
      report: (err) => { throw err; },
    });

    // 1. Neutral waveform when record has no groupScores yet + fallback track notice (en & zh)
    timeline.render(source);
    assert.equal(clearCount, 1);
    assert.ok(drawOps.length === 100 && drawOps.every((op) => op.fillStyle === '#7b8391' && op.globalAlpha === 1));
    assert.equal(getNode('waveform-status').dataset.trackFallback, 'true');
    assert.match(getNode('waveform-status').textContent, /Track 2/);
    assert.match(getNode('waveform-status').textContent, /Track 1/);
    setLang('zh');
    timeline.render(source);
    assert.match(getNode('waveform-status').textContent, /备用音轨 2/);
    assert.match(getNode('waveform-status').textContent, /音轨 1/);

    // 2. Seeking does NOT repaint #prediction-wave or re-read computed CSS styles
    const computedBeforeSeek = computedStyleCalls;
    source = { ...source, review: { ...source.review, position: 4.5 } };
    timeline.render(source);
    assert.equal(clearCount, 1);
    assert.equal(computedStyleCalls, computedBeforeSeek);

    // 3. Advancing groupScoreFrames while decodedUntil is unchanged invalidates waveKey and draws layered overlays
    const groupScores = new Float32Array(125 * 5);
    groupScores[25 * 5 + 0] = 0.7; // gunshot at 1.0s (column x=10)
    groupScores[25 * 5 + 1] = 0.9; // speech at 1.0s (column x=10)
    record = { ...record, groupScores, groupScoreFrames: 125 };
    timeline.render(source);
    assert.equal(clearCount, 2);
    assert.equal(getNode('prediction-wave').dataset.groupScoreFrames, '125');
    const col10 = drawOps.filter((op) => op.x === 10);
    assert.equal(col10.length, 3); // neutral base, speech bottom-up, gunshot top-down last
    assert.equal(col10[0].globalAlpha, 1);
    assert.equal(col10[1].y, 68 - col10[1].h); // speech bottom-up
    assert.ok(col10[1].globalAlpha < 0.7);
    assert.equal(col10[2].y, col10[0].y); // gunshot top-down from outer top edge
    assert.ok(col10[2].globalAlpha >= 0.9);

    // 4. Undefined record (reviewPreview) renders gracefully as neutral waveform without fallback warning
    record = undefined;
    source = { ...source, id: 'preview-id', waveform: { step: 0.05, trackIndex: 0, decodedUntil: 10, peaks } };
    timeline.render(source);
    assert.equal(clearCount, 3);
    assert.ok(drawOps.every((op) => op.fillStyle === '#7b8391' && op.globalAlpha === 1));
    assert.equal(getNode('waveform-status').dataset.trackFallback, 'false');
  } finally {
    timeline?.suspend();
    setLang(prevLang);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.getComputedStyle = prevGetComputedStyle;
  }
});
