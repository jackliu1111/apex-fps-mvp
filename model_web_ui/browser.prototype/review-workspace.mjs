// Human review decisions survive replacement of automatic suggestions.
import { mergeCandidateRanges } from './candidate-ranges.mjs';
const copy = (value) => structuredClone(value);
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const sameRange = (a, b) => a.start === b.start && a.end === b.end;
const ordered = (clips) => clips.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export function createReviewWorkspace({ onChange = () => {} } = {}) {
  const sources = new Map();
  const batches = [];
  let editing = false;
  const decisionState = (source) => copy({ decisions: source.decisions, selectedClipId: source.review.selectedClipId });
  const historyFor = (source) => source.history ||= { undo: [], redo: [] };
  let sequence = 0, revision = 0;
  const requireSource = (id) => {
    const source = sources.get(id);
    if (!source) throw new Error('找不到录像的复核记录');
    return source;
  };
  const validRange = (source, range) => {
    const { start, end } = range;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > source.duration || start >= end) throw new Error('选片范围须在录像内，且终点晚于起点');
    return { start, end };
  };
  const clipsFor = (source) => {
    const retained = source.decisions.filter((decision) => decision.kind === 'retain');
    const excluded = source.decisions.filter((decision) => decision.kind === 'exclude');
    const manual = retained.map((decision) => ({ id: decision.id, ...decision.range, selected: true, manual: true, supplemental: false, provisional: false }));
    const automatic = source.candidates.flatMap((candidate) => {
      if (excluded.some((decision) => sameRange(decision.range, candidate) || sameRange(decision.originRange, candidate))) return [];
      if (retained.some((decision) => sameRange(decision.range, candidate) || sameRange(decision.originRange, candidate))) return [];
      const supplemental = excluded.some((decision) => overlaps(decision.range, candidate)) || retained.some((decision) => overlaps(decision.range, candidate) || overlaps(decision.originRange, candidate));
      return [{ ...candidate, selected: !supplemental, manual: false, supplemental }];
    });
    return ordered([...manual, ...automatic]);
  };
  const selectedClips = (source) => clipsFor(source).filter((clip) => clip.selected && !clip.provisional);
  const signature = (clips) => JSON.stringify(clips.map(({ start, end }) => [start, end]));
  const getSource = (id) => {
    const source = requireSource(id);
    const { history, waveform, ...visible } = source;
    const cloned = copy({ ...visible, canUndo: !!history?.undo.length, canRedo: !!history?.redo.length, clips: clipsFor(source), hasUnexportedChanges: signature(selectedClips(source)) !== (source.lastSubmittedSelection ?? '[]') });
    if (waveform !== undefined) cloned.waveform = waveform;
    return freeze(cloned);
  };
  const view = () => freeze({ sources: [...sources.keys()].map(getSource), batches: copy(batches), revision });
  const changed = () => {
    if (editing) return;
    revision++;
    onChange(view());
  };
  function setChoice(source, clip, selected) {
    let decision = source.decisions.find((item) => item.id === clip.id || sameRange(item.range, clip));
    if (decision) decision.kind = selected ? 'retain' : 'exclude';
    else {
      decision = { id: `manual:${++sequence}`, kind: selected ? 'retain' : 'exclude', range: { start: clip.start, end: clip.end }, originRange: { start: clip.start, end: clip.end } };
      source.decisions.push(decision);
    }
    if (source.review.selectedClipId === clip.id) source.review.selectedClipId = selected ? decision.id : null;
    return decision.id;
  }
  const workspace = {
    getSource,
    view,
    addSource(identity) {
        if (typeof identity.id !== 'string' || !identity.id || !Number.isFinite(identity.duration) || !(identity.duration > 0)) throw new Error('录像身份与时长无效');
      const { id, name, size, lastModified, fingerprint, fingerprintVersion, duration } = identity;
      const descriptor = { id, name, size, lastModified, fingerprint, fingerprintVersion };
      if (sources.has(id)) {
        const existing = sources.get(id);
        if (JSON.stringify(existing.identity) !== JSON.stringify(descriptor) || existing.duration !== duration) throw new Error('当前页面已有同一标识的不同录像');
        return id;
      }
      sources.set(identity.id, { id: identity.id, identity: copy(descriptor), duration, candidates: [], decisions: [], review: { position: 0, selectedClipId: null, zoomStart: 0, zoomEnd: duration }, analysis: { status: 'queued', processedUntil: 0, error: null } });
      changed();
      return identity.id;
    },
    setReview(id, patch) {
      const source = requireSource(id);
      if (Object.keys(patch).some((key) => !['position', 'selectedClipId', 'zoomStart', 'zoomEnd'].includes(key))) throw new Error('复核位置字段无效');
      const next = { ...source.review, ...patch };
      if (!Number.isFinite(next.position) || next.position < 0 || next.position > source.duration) throw new Error('播放位置须在录像内');
      validRange(source, { start: next.zoomStart, end: next.zoomEnd });
      if (JSON.stringify(next) === JSON.stringify(source.review)) return;
      source.review = copy(next);
      changed();
    },
    updateWaveform(id, waveform) {
      const source = requireSource(id);
      source.waveform = freeze(copy(waveform));
      changed();
    },
    updateAnalysis(id, patch) {
      const source = requireSource(id);
      if (Object.keys(patch).some((key) => !['status', 'processedUntil', 'error'].includes(key))) throw new Error('分析状态字段无效');
      if (patch.status && !['preparing', 'queued', 'analyzing', 'completed', 'stopped', 'failed', 'interrupted'].includes(patch.status)) throw new Error('分析状态无效');
      if (patch.processedUntil !== undefined && (!Number.isFinite(patch.processedUntil) || patch.processedUntil < 0 || patch.processedUntil > source.duration)) throw new Error('分析进度须在录像内');
      Object.assign(source.analysis, copy(patch));
      changed();
    },
    publishCandidates(id, incoming) {
      const source = requireSource(id);
      source.candidates = incoming.map((candidate) => ({ id: `auto:${candidate.id ?? candidate.key ?? `${candidate.start}:${candidate.end}`}`, ...validRange(source, candidate), provisional: !!candidate.provisional }));
      changed();
    },
    mergeCandidates(id) {
      const source = requireSource(id), before = source.candidates;
      const merged = mergeCandidateRanges(before);
      if (JSON.stringify(before) === JSON.stringify(merged)) return;
      const selected = before.find((candidate) => candidate.id === source.review.selectedClipId);
      source.candidates = merged;
      if (selected && !merged.some((candidate) => candidate.id === selected.id)) {
        source.review.selectedClipId = merged.find((candidate) => candidate.start <= selected.start && candidate.end >= selected.end)?.id ?? null;
      }
      changed();
    },
    submitBatch(id, { audio = {}, output = {} } = {}) {
      const source = requireSource(id);
      const clips = selectedClips(source).map(({ id, start, end }) => ({ id, start, end }));
      if (!clips.length) throw new Error('没有范围已确定且已选中的片段');
      const batch = { id: `batch:${++sequence}`, sourceId: id, source: copy(source.identity), clips, audio: copy(audio), output: copy(output), status: 'queued', createdAt: new Date().toISOString(), progress: 0, outputs: [], clipResults: clips.map((clip) => ({ ...clip, status: 'not-started', error: null })) };
      batches.push(batch);
      source.lastSubmittedSelection = signature(clips);
      changed();
      return freeze(copy(batch));
    },
    updateBatch(id, patch) {
      const batch = batches.find((item) => item.id === id);
      if (!batch) throw new Error('找不到导出批次');
      if (Object.keys(patch).some((key) => !['status', 'outputs', 'error', 'progress', 'clipResults', 'destination'].includes(key))) throw new Error('已提交批次的范围和设置不可更改');
      const statuses = ['awaiting-destination', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
      if (patch.status && !statuses.includes(patch.status)) throw new Error('导出状态无效');
      if (patch.progress !== undefined && (!Number.isFinite(patch.progress) || patch.progress < 0 || patch.progress > 1)) throw new Error('导出进度无效');
      if (patch.clipResults && (!Array.isArray(patch.clipResults) || patch.clipResults.length !== batch.clips.length || patch.clipResults.some((result, index) => !sameRange(result, batch.clips[index]) || !['not-started', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(result.status)))) throw new Error('片段导出状态与已提交范围不一致');
      Object.assign(batch, copy(patch));
      changed();
    },
    choose(id, clipId, selected) {
      const source = requireSource(id);
      const clip = clipsFor(source).find((item) => item.id === clipId);
      if (!clip || clip.provisional) throw new Error('只能处理范围已确定的选片');
      const decisionId = setChoice(source, clip, selected);
      changed();
      return decisionId;
    },
    chooseAll(id, selected) {
      const source = requireSource(id);
      const clips = clipsFor(source).filter((clip) => !clip.provisional);
      if (!clips.length) return;
      for (const clip of clips) setChoice(source, clip, selected);
      changed();
    },
    addManual(id, range) {
      const source = requireSource(id);
      const valid = validRange(source, range);
      const existing = source.decisions.find((decision) => sameRange(decision.range, valid));
      if (existing) {
        if (existing.kind !== 'retain') { existing.kind = 'retain'; changed(); }
        return existing.id;
      }
      const decision = { id: `manual:${++sequence}`, kind: 'retain', range: valid, originRange: valid };
      source.decisions.push(decision);
      changed();
      return decision.id;
    },
    resetDecisions(id) {
      const source = requireSource(id);
      source.decisions = [];
      if (!source.candidates.some((clip) => clip.id === source.review.selectedClipId)) source.review.selectedClipId = null;
      changed();
    },
    trim(id, clipId, range) {
      const source = requireSource(id);
      const clip = clipsFor(source).find((item) => item.id === clipId);
      if (!clip || clip.provisional) throw new Error('只能调整范围已确定的选片');
      const adjusted = validRange(source, range);
      let decision = source.decisions.find((item) => item.id === clipId);
      if (decision) decision.range = adjusted;
      else {
        decision = { id: `manual:${++sequence}`, kind: 'retain', range: adjusted, originRange: { start: clip.start, end: clip.end } };
        source.decisions.push(decision);
      }
      if (source.review.selectedClipId === clipId) source.review.selectedClipId = decision.id;
      changed();
      return decision.id;
    },
  };
  const applyDecisionState = (source, state) => {
    source.decisions = copy(state.decisions);
    source.review.selectedClipId = clipsFor(source).some((clip) => clip.id === state.selectedClipId) ? state.selectedClipId : null;
  };
  const recordEdit = (source, before) => {
    const after = decisionState(source);
    if (JSON.stringify(before.decisions) === JSON.stringify(after.decisions)) return false;
    const history = historyFor(source);
    history.undo.push({ before, after });
    history.undo = history.undo.slice(-100);
    history.redo = [];
    return true;
  };
  // Only human decisions participate: analysis, playback and submitted batches
  // are live independent objects and must never be rolled back by undo.
  for (const name of ['choose', 'chooseAll', 'addManual', 'trim', 'resetDecisions']) {
    const mutate = workspace[name];
    workspace[name] = (id, ...args) => {
      const source = requireSource(id), before = decisionState(source);
      let result;
      editing = true;
      try { result = mutate(id, ...args); }
      finally { editing = false; }
      if (recordEdit(source, before) || JSON.stringify(before) !== JSON.stringify(decisionState(source))) changed();
      return result;
    };
  }
  for (const direction of ['undo', 'redo']) workspace[direction] = (id) => {
    const source = requireSource(id);
    const history = historyFor(source), entry = history[direction].pop();
    if (!entry) return false;
    applyDecisionState(source, entry[direction === 'undo' ? 'before' : 'after']);
    history[direction === 'undo' ? 'redo' : 'undo'].push(entry);
    changed();
    return true;
  };
  workspace.restoreExcluded = (id, decisionId) => {
    const source = requireSource(id);
    const decision = source.decisions.find((item) => item.id === decisionId && item.kind === 'exclude');
    if (!decision) throw new Error('找不到已排除片段');
    return workspace.addManual(id, decision.range);
  };
  return workspace;
}
