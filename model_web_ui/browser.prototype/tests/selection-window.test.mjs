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
  let computedStyleCalls = 0;
  const makeNode = (id = '') => {
    const node = {
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
      clientHeight: id === 'player-overview-distribution' ? 16 : 68,
      width: 100,
      height: id === 'player-overview-distribution' ? 16 : 68,
      clearCount: 0,
      drawOps: [],
      get firstElementChild() { return this.children[0] || null; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k]; },
      replaceChildren(...items) {
        this.children = items;
        this.textContent = items.map((item) => item.textContent || '').join('');
      },
      insertBefore(nodeToInsert, ref) {
        const existing = this.children.indexOf(nodeToInsert);
        if (existing >= 0) this.children.splice(existing, 1);
        const index = ref ? this.children.indexOf(ref) : -1;
        if (index >= 0) this.children.splice(index, 0, nodeToInsert);
        else this.children.push(nodeToInsert);
        nodeToInsert.nextElementSibling = this.children[this.children.indexOf(nodeToInsert) + 1] || null;
      },
      getContext() {
        if (!node._ctx) {
          node._ctx = {
            fillStyle: '',
            globalAlpha: 1,
            clearRect() { node.clearCount++; node.drawOps.length = 0; },
            fillRect(x, y, w, h) {
              node.drawOps.push({ x, y, w, h, fillStyle: node._ctx.fillStyle, globalAlpha: node._ctx.globalAlpha });
            },
          };
        }
        return node._ctx;
      },
      addEventListener(type, fn) { this[`on${type}`] = fn; },
      querySelector() { return makeNode(); },
      focus() {},
    };
    return node;
  };
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
    const waveCanvas = getNode('prediction-wave');
    const overviewCanvas = getNode('player-overview-distribution');
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
    assert.equal(waveCanvas.clearCount, 1);
    assert.equal(overviewCanvas.clearCount, 1);
    assert.ok(waveCanvas.drawOps.length === 100 && waveCanvas.drawOps.every((op) => op.fillStyle === '#7b8391' && op.globalAlpha === 1));
    assert.equal(getNode('waveform-status').dataset.trackFallback, 'true');
    assert.match(getNode('waveform-status').textContent, /Track 2/);
    assert.match(getNode('waveform-status').textContent, /Track 1/);
    setLang('zh');
    timeline.render(source);
    assert.match(getNode('waveform-status').textContent, /备用音轨 2/);
    assert.match(getNode('waveform-status').textContent, /音轨 1/);

    // 2. Seeking does NOT repaint #prediction-wave, #player-overview-distribution, or re-read computed CSS styles
    const computedBeforeSeek = computedStyleCalls;
    source = { ...source, review: { ...source.review, position: 4.5 } };
    timeline.render(source);
    assert.equal(waveCanvas.clearCount, 1);
    assert.equal(overviewCanvas.clearCount, 1);
    assert.equal(waveCanvas.dataset.paintCount, '1');
    assert.equal(overviewCanvas.dataset.paintCount, '1');
    assert.equal(computedStyleCalls, computedBeforeSeek);

    // 3. Advancing groupScoreFrames while decodedUntil is unchanged invalidates waveKey and draws layered overlays & overview gunshot spike
    const groupScores = new Float32Array(125 * 5);
    groupScores[25 * 5 + 0] = 0.7; // gunshot at 1.0s (column x=10)
    groupScores[25 * 5 + 1] = 0.9; // speech at 1.0s (column x=10)
    record = { ...record, groupScores, groupScoreFrames: 125 };
    timeline.render(source);
    assert.equal(waveCanvas.clearCount, 2);
    assert.equal(overviewCanvas.clearCount, 2);
    assert.equal(waveCanvas.dataset.paintCount, '2');
    assert.equal(overviewCanvas.dataset.paintCount, '2');
    assert.equal(waveCanvas.dataset.groupScoreFrames, '125');
    const col10 = waveCanvas.drawOps.filter((op) => op.x === 10);
    assert.equal(col10.length, 3); // neutral base, speech bottom-up, gunshot top-down last
    assert.equal(col10[0].globalAlpha, 1);
    assert.equal(col10[1].y, 68 - col10[1].h); // speech bottom-up
    assert.ok(col10[1].globalAlpha < 0.7);
    assert.equal(col10[2].y, col10[0].y); // gunshot top-down from outer top edge
    assert.ok(col10[2].globalAlpha >= 0.9);
    const overviewGunshotCol10 = overviewCanvas.drawOps.filter((op) => op.x === 10 && op.fillStyle !== '#7b8391');
    assert.equal(overviewGunshotCol10.length, 1);

    // 4. Undefined record (reviewPreview) renders gracefully as neutral waveform without fallback warning
    record = undefined;
    source = { ...source, id: 'preview-id', waveform: { step: 0.05, trackIndex: 0, decodedUntil: 10, peaks } };
    timeline.render(source);
    assert.equal(waveCanvas.clearCount, 3);
    assert.equal(overviewCanvas.clearCount, 3);
    assert.ok(waveCanvas.drawOps.every((op) => op.fillStyle === '#7b8391' && op.globalAlpha === 1));
    assert.equal(getNode('waveform-status').dataset.trackFallback, 'false');
  } finally {
    timeline?.suspend();
    setLang(prevLang);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.getComputedStyle = prevGetComputedStyle;
  }
});

test('selection timeline zooms down to 40ms frame detail, aligns overview distribution with audioOffset/unanalyzed tail, and isolates playback/zoom from overview repaints', () => {
  const nodes = new Map();
  const makeNode = (id = '') => {
    const node = {
      id,
      dataset: {},
      style: {},
      attributes: {},
      children: [],
      textContent: '',
      hidden: false,
      disabled: false,
      checked: false,
      clientWidth: 1000,
      clientHeight: id === 'player-overview-distribution' ? 16 : 68,
      width: 1000,
      height: id === 'player-overview-distribution' ? 16 : 68,
      clearCount: 0,
      drawOps: [],
      get firstElementChild() { return this.children[0] || null; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k]; },
      getBoundingClientRect: () => ({ left: 0, x: 0, width: 1000, height: 68 }),
      replaceChildren(...items) {
        this.children = items;
        this.textContent = items.map((item) => item.textContent || '').join('');
      },
      insertBefore(nodeToInsert, ref) {
        const existing = this.children.indexOf(nodeToInsert);
        if (existing >= 0) this.children.splice(existing, 1);
        const index = ref ? this.children.indexOf(ref) : -1;
        if (index >= 0) this.children.splice(index, 0, nodeToInsert);
        else this.children.push(nodeToInsert);
        nodeToInsert.nextElementSibling = this.children[this.children.indexOf(nodeToInsert) + 1] || null;
      },
      getContext() {
        if (!node._ctx) {
          node._ctx = {
            fillStyle: '',
            globalAlpha: 1,
            clearRect() { node.clearCount++; node.drawOps.length = 0; },
            fillRect(x, y, w, h) {
              node.drawOps.push({ x, y, w, h, fillStyle: node._ctx.fillStyle, globalAlpha: node._ctx.globalAlpha });
            },
          };
        }
        return node._ctx;
      },
      addEventListener(type, fn) { this[`on${type}`] = fn; },
      querySelector() { return makeNode(); },
      focus() {},
    };
    return node;
  };
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
  };
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevGetComputedStyle = globalThis.getComputedStyle;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  let rafQueue = [];
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
  globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => name === '--wave-bar' ? '#7b8391' : '' });
  globalThis.requestAnimationFrame = (cb) => {
    const id = rafQueue.length + 1;
    rafQueue.push({ id, cb });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafQueue = rafQueue.filter((item) => item.id !== id);
  };

  let timeline;
  try {
    const duration = 2000; // 33m20s
    const waveCanvas = getNode('prediction-wave');
    const overviewCanvas = getNode('player-overview-distribution');
    const step = 0.05;
    const peaks = new Array(Math.ceil(duration / step)).fill(null);
    // Analyzed audio covers [100s, 1100s) -> [0, 100) before +100s offset & [1100, 2000) unanalyzed tail
    for (let i = 100 / step; i < 1100 / step; i++) peaks[i] = 0.09;
    const frameSeconds = 0.04;
    const groupScoreFrames = 1000 / frameSeconds; // 25,000 frames
    const groupScores = new Float32Array(groupScoreFrames * 5);
    // 0.16s gunshot burst at audio 400.00..400.16s -> video 500.00..500.16s (column 250 in 1000px overview)
    for (let f = 400 / frameSeconds; f < 400 / frameSeconds + 4; f++) groupScores[f * 5 + 0] = 0.90;

    let source = {
      id: 'src-40ms',
      duration,
      canUndo: false,
      canRedo: false,
      analysis: { status: 'analyzing' },
      waveform: { step, trackIndex: 0, decodedUntil: 1100, peaks },
      clips: [],
      decisions: [],
      review: { selectedClipId: null, position: 0, zoomStart: 0, zoomEnd: duration },
    };
    const record = {
      id: 'src-40ms',
      duration,
      audioDuration: 1000,
      audioOffset: 100,
      frameSeconds,
      groupCount: 5,
      groupScores,
      groupScoreFrames,
      analysisStarted: 1,
    };

    timeline = createSelectionTimeline({
      MB: null,
      workspace: {
        setReview(_id, patch) {
          source = { ...source, review: { ...source.review, ...patch } };
          timeline.render(source);
        },
      },
      getSource: () => source,
      getRecord: () => record,
      selectRange: () => {},
      seek: () => {},
      pause: () => {},
      isPlayerBusy: () => false,
      report: (err) => { throw err; },
    });

    timeline.render(source);
    assert.equal(waveCanvas.clearCount, 1);
    assert.equal(overviewCanvas.clearCount, 1);
    // Overview aligns [0, 100s) blank (cols 0..49), spike at video 500s (col 250), tail [1100s, 2000s) blank (cols 550..999)
    assert.equal(overviewCanvas.drawOps.some((op) => op.x < 50), false);
    assert.equal(overviewCanvas.drawOps.some((op) => op.x >= 550), false);
    assert.ok(overviewCanvas.drawOps.some((op) => op.x === 250 && op.fillStyle !== '#7b8391'));

    // Playback ticks never repaint #prediction-wave or #player-overview-distribution
    for (const pos of [100, 250, 500, 750]) {
      source = { ...source, review: { ...source.review, position: pos } };
      timeline.render(source);
    }
    assert.equal(waveCanvas.clearCount, 1);
    assert.equal(overviewCanvas.clearCount, 1);

    // Wheel zoom centered at x=250 (video 500s) zooms down to 40ms frame detail without repainting overview
    const axis = getNode('source-axis');
    for (let i = 0; i < 40; i++) {
      axis.onwheel({
        clientX: 250,
        deltaX: 0,
        deltaY: -250,
        shiftKey: false,
        preventDefault() {},
      });
      while (rafQueue.length) rafQueue.shift().cb(performance.now() + 300);
    }
    const spanAfterZoom = source.review.zoomEnd - source.review.zoomStart;
    assert.ok(spanAfterZoom <= 0.041 && spanAfterZoom >= 0.039, `Expected 40ms min zoom span, got ${spanAfterZoom}`);
    assert.equal(getNode('prediction-zoom').disabled, true);
    // Millisecond precision ticks when zoomed to 40ms detail
    assert.match(getNode('source-ticks').children[0].textContent, /\.\d{3}$/);
    // Overview canvas NEVER repainted during all 40 zoom/pan steps
    assert.equal(overviewCanvas.clearCount, 1);
    assert.equal(overviewCanvas.dataset.paintCount, '1');
  } finally {
    timeline?.suspend();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.getComputedStyle = prevGetComputedStyle;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCaf;
  }
});
