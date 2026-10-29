// Preview uses the production view and workspace, with disposable persistence.
import { selectionWindow } from './selection-timeline.mjs';
export const preview = new URLSearchParams(location.search).has('reviewPreview');
const scenarios = { sample: '真实波形设计样本', default: '默认复核', analyzing: '分析中', saving: '保存中', error: '保存失败', empty: '无候选', many: '大量候选' };
let mode = new URLSearchParams(location.search).get('reviewPreview') || 'default';
if (!Object.hasOwn(scenarios, mode)) mode = 'default';
let releaseSave;
let sampleFrames = [];
// Saved reference pictures are preview-only; never masquerade as a bound video.
export function renderReviewPreview(source, bound) {
  if (!preview || mode !== 'sample' || source?.id !== 'combat-design-sample' || bound || !sampleFrames.length) return;
  const at = time => sampleFrames.reduce((best, frame) => frame.time <= time ? frame : best, sampleFrames[0]);
  const frame = at(source.review.position);
  const canvas = document.getElementById('source-canvas');
  const context = canvas.getContext('2d');
  const scale = Math.min(canvas.width / frame.bitmap.naturalWidth, canvas.height / frame.bitmap.naturalHeight);
  const width = frame.bitmap.naturalWidth * scale, height = frame.bitmap.naturalHeight * scale;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(frame.bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  document.getElementById('player-status').textContent = `参考帧 ${frame.time.toFixed(1)} 秒 · 静态画面模拟`;
  document.getElementById('play-pause').textContent = '静态帧预览';
  const strip = document.getElementById('source-filmstrip');
  const { zoomStart, zoomEnd } = source.review;
  const frames = Array.from({ length: 10 }, (_, i) => at(zoomStart + (zoomEnd - zoomStart) * i / 10));
  const key = frames.map(frame => frame.time).join(',');
  if (strip.dataset.previewFrames !== key || !strip.children.length) {
    strip.replaceChildren(...frames.map(frame => {
      const image = document.createElement('img'); image.src = frame.image;
      image.alt = `样本参考帧 ${frame.time} 秒`; image.title = image.alt; return image;
    }));
    strip.dataset.previewFrames = key;
  }
  document.getElementById('evidence-status').textContent = '预载真实参考帧 · 每 5 秒一张';
}
export const previewStorage = {
  async load() { return null; },
  async save() {
    if (mode === 'error') throw new Error('模拟存储失败；编辑仍在当前页面');
    if (mode === 'saving') await new Promise(resolve => { releaseSave = resolve; });
  },
};
export async function mountReviewPreview(app) {
  const bar = document.createElement('section');
  bar.className = 'panel'; bar.setAttribute('aria-label', '复核场景预览');
  const label = document.createElement('label'); label.textContent = '场景预览 · ';
  const select = document.createElement('select'); select.setAttribute('aria-label', '切换复核场景');
  for (const [key, name] of Object.entries(scenarios)) select.add(new Option(name, key, false, key === mode));
  select.onchange = () => { location.search = `?reviewPreview=${select.value}`; };
  label.append(select); bar.append(label);
  const reset = document.createElement('button'); reset.textContent = '重置场景'; reset.onclick = () => location.reload(); bar.append(reset);
  const recover = document.createElement('button'); recover.textContent = '恢复存储并重试'; recover.hidden = !['saving', 'error'].includes(mode);
  recover.onclick = async () => { mode = 'default'; releaseSave?.(); await app.workspace.flush(); recover.hidden = true; }; bar.append(recover);
  const note = document.createElement('p'); note.textContent = '临时场景：候选为预设数据，不运行模型；修改刷新即清空，不影响正式复核记录。正在准备 12 秒合成录像…'; bar.append(note);
  document.querySelector('#main').prepend(bar);
  if (mode === 'sample') {
    const { loadReviewFixture } = await import('./review-fixture.mjs');
    const fixture = await loadReviewFixture();
    sampleFrames = await Promise.all(fixture.frames.map(async frame => {
      const bitmap = new Image(); bitmap.src = frame.image; await bitmap.decode();
      return { ...frame, bitmap };
    }));
    const id = app.workspace.addSource({ id: 'combat-design-sample', name: 'apex-combat-60s.mp4', duration: fixture.duration });
    app.workspace.publishCandidates(id, fixture.candidates);
    app.workspace.updateWaveform(id, fixture.waveform);
    app.workspace.updateAnalysis(id, { status: 'completed', processedUntil: fixture.duration });
    await app.openReview(id);
    const firstClip = app.workspace.getSource(id).clips[0];
    app.workspace.setReview(id, { selectedClipId: firstClip.id, position: firstClip.start, ...selectionWindow(fixture.duration, firstClip) });
    note.textContent = '已预载真实对局参考帧和声音波形；六段区间为设计预设。定位会切换到此前最近的参考帧（每 5 秒一张），并非连续视频播放。刷新即可重置，不影响正式记录。';
    void app.workspace.flush(); bar.dataset.ready = 'true'; return;
  }
  const { createSyntheticFile } = await import('./tests/synthetic-media.mjs');
  const file = await createSyntheticFile();
  const id = app.workspace.addSource({ id: 'preview-source', name: file.name, size: file.size, lastModified: file.lastModified, duration: 12 });
  const candidates = mode === 'empty' ? [] : mode === 'many' ? Array.from({ length: 40 }, (_, i) => ({ id: `clip-${i}`, start: i * .3, end: i * .3 + .2 })) : [{ id: 'first', start: 2, end: 5 }, { id: 'second', start: 8, end: 10 }];
  app.workspace.publishCandidates(id, candidates);
  app.workspace.updateAnalysis(id, { status: mode === 'analyzing' ? 'analyzing' : 'completed', processedUntil: mode === 'analyzing' ? 6 : 12 });
  app.bindings.set(id, { file, duration: 12, origin: 0, status: 'complete', candidates, timings: {} });
  await app.openReview(id);
  note.textContent = '临时场景：12 秒合成录像，可真实播放与调整选片；候选和分析进度为预设，不代表识别结果。修改刷新即清空。';
  if (candidates.length) {
    const firstClip = app.workspace.getSource(id).clips[0];
    app.workspace.setReview(id, { selectedClipId: firstClip.id, position: candidates[0].start, ...selectionWindow(12, firstClip) });
    await app.player.seek(candidates[0].start);
  }
  void app.workspace.flush();
  bar.dataset.ready = 'true';
}
