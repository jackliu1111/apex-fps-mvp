import { createSelectionEvidence } from './selection-evidence.mjs';

export function selectionWindow(duration, { start, end }) {
  const length = Math.min(duration, (end - start) * 3);
  const zoomStart = Math.max(0, Math.min(duration - length, (start + end - length) / 2));
  return { zoomStart, zoomEnd: zoomStart + length };
}

export function createSelectionTimeline({ MB, workspace, getSource, getRecord, selectRange, seek, pause, report }) {
  const $ = (id) => document.getElementById(id);
  const axis = $('source-axis'), predictions = $('overview-markers');
  const stamp = (t) => `${Math.floor(t / 60).toString().padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  let sourceId, predictionStart = 0, predictionEnd = 1, evidenceKey, frames = [], drag;
  let overviewTarget = null;
  const evidence = createSelectionEvidence({ MB, onResult(result) {
    frames = result.frames;
    $('source-filmstrip').replaceChildren(...frames.map((frame) => {
      const image = document.createElement('img'); image.src = frame.image; image.alt = '原片参考画面'; return image;
    }));
    const canvas = $('source-wave'), context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#b4b4b4';
    result.peaks?.forEach((peak, i) => { const h = Math.min(1, peak) * 38; context.fillRect(i * 2, (40 - h) / 2, 1, h); });
    $('evidence-status').textContent = result.status;
  } });
  const run = (fn) => { try { Promise.resolve(fn()).catch(report); } catch (error) { report(error); } };
  const clipFor = (source) => source.clips.find((clip) => clip.id === source.review.selectedClipId && !clip.provisional);
  const windowFor = (source) => [source.review.zoomStart, source.review.zoomEnd];
  const ticks = (node, low, high) => {
    const value = [0, 0.5, 1].map((ratio) => stamp(low + ratio * (high - low)));
    if (node.textContent === value.join('')) return;
    node.replaceChildren(...value.map((text) => { const span = document.createElement('span'); span.textContent = text; return span; }));
  };
  function paintSelection(source) {
    const clip = drag?.kind !== 'head' && drag?.sourceId === source.id ? drag.range : clipFor(source);
    const [low, high] = windowFor(source), percent = (t) => (t - low) / (high - low) * 100;
    $('selection-overlay').hidden = !clip;
    if (clip) {
      $('selection-overlay').style.left = `${Math.max(0, percent(clip.start))}%`;
      $('selection-overlay').style.width = `${Math.max(0, Math.min(100, percent(clip.end)) - Math.max(0, percent(clip.start)))}%`;
      for (const key of ['left', 'right']) {
        const node = $(`selection-${key}`), value = clip[key === 'left' ? 'start' : 'end'];
        node.hidden = value < low || value > high;
        node.setAttribute('role', 'slider'); node.setAttribute('aria-valuemin', low); node.setAttribute('aria-valuemax', high); node.setAttribute('aria-valuenow', value); node.setAttribute('aria-valuetext', `${stamp(value)} 秒`);
      }
    }
    $('selection-readout').textContent = clip ? `${stamp(clip.start)} — ${stamp(clip.end)} · ${(clip.end - clip.start).toFixed(1)} 秒` : '点击下方预测范围开始调整';
    $('selection-readout').dataset.active = String(!!clip);
    const position = drag?.kind === 'head' ? drag.position : source.review.position;
    $('source-head').hidden = position < low || position > high;
    $('source-head').style.left = `${percent(position)}%`;
    $('source-head').setAttribute('aria-valuemin', low);
    $('source-head').setAttribute('aria-valuemax', high);
    $('source-head').setAttribute('aria-valuenow', position);
    $('source-head').setAttribute('aria-valuetext', `${position.toFixed(2)} 秒`);
    const overviewPosition = overviewTarget ?? position;
    $('overview').max = source.duration;
    $('overview').value = overviewPosition;
    $('overview').setAttribute('aria-valuetext', `${overviewPosition.toFixed(2)} 秒 / ${source.duration.toFixed(2)} 秒`);
    $('overview-position').textContent = `${stamp(overviewPosition)} / ${stamp(source.duration)}`;
  }
  function render(source) {
    if (!source) return;
    if (sourceId !== source.id) { drag = null; overviewTarget = null; sourceId = source.id; predictionStart = 0; predictionEnd = source.duration; }
    paintSelection(source);
    const [low, high] = windowFor(source);
    $('source-fit').disabled = low === 0 && high === source.duration;
    ticks($('source-ticks'), low, high); ticks($('prediction-ticks'), predictionStart, predictionEnd);
    const record = getRecord(source.id), key = `${source.id}:${!!record}:${low}:${high}`;
    if (evidenceKey !== key) { evidenceKey = key; evidence.request(record, low, high); }
    $('exit-selection').disabled = !clipFor(source);
    $('exclude-selection').disabled = !clipFor(source);
    $('undo-selection').disabled = !source.canUndo; $('redo-selection').disabled = !source.canRedo;
    const items = source.clips.map((clip, index) => ({ ...clip, label: String(index + 1) }));
    if ($('show-excluded').checked) source.decisions.filter((d) => d.kind === 'exclude').forEach((d) => items.push({ id: d.id, ...d.range, excluded: true, label: '恢复' }));
    const visible = items.filter((item) => item.start < predictionEnd && item.end > predictionStart);
    const ids = new Set(visible.map((item) => item.id));
    for (const node of [...predictions.children]) if (!ids.has(node.dataset.clipId)) {
      if (node === document.activeElement) $('prediction-workspace').focus({ preventScroll: true });
      node.remove();
    }
    visible.forEach((item) => {
      let node = [...predictions.children].find((node) => node.dataset.clipId === item.id);
      if (!node) { node = document.createElement('button'); node.dataset.clipId = item.id; predictions.append(node); }
      const start = Math.max(item.start, predictionStart), end = Math.min(item.end, predictionEnd);
      node.style.left = `${(start - predictionStart) / (predictionEnd - predictionStart) * 100}%`;
      node.style.width = `${(end - start) / (predictionEnd - predictionStart) * 100}%`;
      node.className = item.excluded ? 'excluded' : item.provisional ? 'provisional' : item.supplemental ? 'supplemental' : '';
      node.textContent = item.label;
      const decision = source.decisions.find((d) => d.id === item.id);
      const adjusted = decision && (decision.originRange.start !== item.start || decision.originRange.end !== item.end);
      node.title = `${item.excluded ? '点击恢复 · ' : ''}${stamp(item.start)} — ${stamp(item.end)}${adjusted ? ` · 已调整，原预测 ${stamp(decision.originRange.start)} — ${stamp(decision.originRange.end)}` : ''}`;
      node.setAttribute('aria-label', node.title); node.setAttribute('aria-pressed', item.id === source.review.selectedClipId); node.disabled = !!item.provisional;
      node.onclick = () => run(() => item.excluded ? workspace.restoreExcluded(source.id, item.id) : selectRange(getSource().clips.find((clip) => clip.id === item.id)));
    });
    $('prediction-empty').textContent = !items.length ? '候选将随分析逐步出现，也可从当前位置添加选片。' : !visible.length ? '此视野没有候选，可适配全片查看。' : '';
  }
  const exit = () => { const source = getSource(); workspace.setReview(source.id, { selectedClipId: null, zoomStart: 0, zoomEnd: source.duration }); };
  $('source-fit').onclick = () => run(() => { const source = getSource(); workspace.setReview(source.id, { zoomStart: 0, zoomEnd: source.duration }); });
  $('overview').oninput = () => {
    overviewTarget = Number($('overview').value);
    pause();
    paintSelection(getSource());
  };
  $('overview').onchange = () => run(() => {
    const source = getSource(), position = Number($('overview').value);
    overviewTarget = null;
    const [low, high] = windowFor(source);
    if (position < low || position > high) {
      const length = high - low, zoomStart = Math.max(0, Math.min(source.duration - length, position - length / 2));
      workspace.setReview(source.id, { zoomStart, zoomEnd: zoomStart + length });
    }
    return seek(position);
  });
  $('overview').onpointercancel = () => { overviewTarget = null; paintSelection(getSource()); };
  const exclude = () => { const source = getSource(), clip = clipFor(source); if (clip) { workspace.choose(source.id, clip.id, false); $('prediction-workspace').focus({ preventScroll: true }); } };
  const xTime = (event, source) => { const box = axis.getBoundingClientRect(), [low, high] = windowFor(source); return low + Math.max(0, Math.min(1, (event.clientX - box.x) / box.width)) * (high - low); };
  const bounded = (clip, key, value) => key === 'start' ? Math.max(0, Math.min(clip.end - 0.1, value)) : Math.min(getSource().duration, Math.max(clip.start + 0.1, value));
  axis.onpointerdown = (event) => run(() => {
    if (event.button !== 0 || drag) return;
    const source = getSource(), clip = clipFor(source);
    const key = event.target.id === 'selection-left' ? 'start' : event.target.id === 'selection-right' ? 'end' : null;
    if (key && !clip) return;
    pause(); $('source-hover').hidden = true;
    drag = { sourceId: source.id, pointer: event.pointerId, kind: key || 'head', clipId: clip?.id, range: clip ? { start: clip.start, end: clip.end } : null, position: xTime(event, source) };
    axis.setPointerCapture(event.pointerId); event.preventDefault();
    paintSelection(source);
    (key ? event.target : $('source-head')).focus({ preventScroll: true });
  });
  axis.onpointermove = (event) => {
    const source = getSource(); if (!source) return;
    if (drag) {
      if (drag.pointer !== event.pointerId) return;
      const value = xTime(event, source);
      if (drag.kind === 'head') drag.position = value;
      else drag.range[drag.kind] = bounded(drag.range, drag.kind, value);
      paintSelection(source); return;
    }
    if (!frames.length) return;
    const target = xTime(event, source), frame = frames.reduce((best, next) => Math.abs(next.time - target) < Math.abs(best.time - target) ? next : best);
    $('source-hover').hidden = false; $('source-hover').querySelector('img').src = frame.image; $('source-hover').querySelector('span').textContent = '原片参考画面';
  };
  axis.onpointerleave = () => { $('source-hover').hidden = true; };
  function finish(cancel = false) {
    if (!drag) return;
    const ended = drag; drag = null;
    if (axis.hasPointerCapture(ended.pointer)) axis.releasePointerCapture(ended.pointer);
    const source = getSource(); if (source?.id !== ended.sourceId) return;
    if (!cancel) {
      if (ended.kind === 'head') run(() => seek(ended.position));
      else run(() => { workspace.trim(source.id, ended.clipId, ended.range); return seek(ended.range[ended.kind]); });
    }
    paintSelection(getSource());
  }
  axis.onpointerup = () => finish(); axis.onpointercancel = () => finish(true); axis.onlostpointercapture = () => finish(true);
  for (const [id, action] of Object.entries({ 'exit-selection': exit, 'exclude-selection': exclude, 'undo-selection': () => workspace.undo(getSource().id), 'redo-selection': () => workspace.redo(getSource().id) })) $(id).onclick = () => run(action);
  $('show-excluded').onchange = () => render(getSource());
  function predictionWindow(start, length) {
    const source = getSource(); length = Math.min(source.duration, Math.max(1, length));
    predictionStart = Math.max(0, Math.min(source.duration - length, start)); predictionEnd = predictionStart + length; render(source);
  }
  $('prediction-fit').onclick = () => predictionWindow(0, getSource().duration);
  $('prediction-zoom').onclick = () => { const length = (predictionEnd - predictionStart) / 2, clip = clipFor(getSource()), center = clip ? (clip.start + clip.end) / 2 : (predictionStart + predictionEnd) / 2; predictionWindow(center - length / 2, length); };
  $('prediction-prev').onclick = () => predictionWindow(predictionStart - (predictionEnd - predictionStart) * 0.7, predictionEnd - predictionStart);
  $('prediction-next').onclick = () => predictionWindow(predictionStart + (predictionEnd - predictionStart) * 0.7, predictionEnd - predictionStart);
  const keydown = (event) => {
    if (event.target.closest('input,select,textarea,[contenteditable=true]')) return;
    const source = getSource(); if (!source) return;
    if (event.key === 'Escape') { event.preventDefault(); if (drag) finish(true); else run(exit); return; }
    if (drag) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); run(() => workspace[event.shiftKey ? 'redo' : 'undo'](source.id)); }
    else if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); run(exclude); }
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && ['selection-left', 'selection-right'].includes(event.target.id)) {
      event.preventDefault(); const clip = clipFor(source); if (!clip) return;
      const key = event.target.id === 'selection-left' ? 'start' : 'end', value = bounded(clip, key, clip[key] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1));
      run(() => { pause(); workspace.trim(source.id, clip.id, { start: clip.start, end: clip.end, [key]: value }); return seek(value); });
    }
    else if (['source-head', 'selection-player-axis'].includes(event.target.id) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const [low, high] = windowFor(source);
      const target = event.key === 'Home' ? low : event.key === 'End' ? high : source.review.position + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1);
      run(() => { pause(); return seek(Math.max(low, Math.min(high, Math.round(target * 100) / 100))); });
    }
  };
  $('selection-player-axis').onkeydown = $('prediction-workspace').onkeydown = keydown;
  return { render, suspend() { finish(true); overviewTarget = null; evidence.cancel(); evidenceKey = null; $('source-hover').hidden = true; } };
}
