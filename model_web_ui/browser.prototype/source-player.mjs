/** Full-source, bounded preview. Times exposed to callers are relative to video origin. */
export function createSourcePlayer({ MB, canvas, onState = () => {}, createAudioContext = (options) => new AudioContext(options),
  clock = { now: () => performance.now(), request: (fn) => requestAnimationFrame(fn), cancel: (id) => cancelAnimationFrame(id) } }) {
  const display = canvas.getContext('2d');
  let input, videoSink, audioTrack, origin = 0, videoIterator;
  let revision = 0, loadRevision = 0, pendingSeek = false, seeking;
  const openingInputs = new Set();
  let audioContext, audioSink, audioIterator, nextAudio, audioFilling = false;
  let nextFrame, videoReading = false, animation, wantPlay = false, basePosition = 0, baseClock = 0, lastEmit = 0;
  const audioNodes = new Set();
  let state = { status: 'empty', duration: 0, target: 0, position: 0, actual: null, playing: false, error: null,
    audioPolicy: 'source-primary', metrics: { framesDisplayed: 0, seeks: 0, lastSeekMs: null, maxFrameLagMs: 0 } };
  const emit = (patch = {}) => { state = { ...state, ...patch }; onState(structuredClone(state)); };
  const draw = (frame) => {
    display.clearRect(0, 0, canvas.width, canvas.height);
    display.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
    state.actual = Math.max(0, frame.timestamp - origin);
    state.metrics.framesDisplayed++;
  };
  const currentPosition = () => state.playing
    ? Math.min(state.duration, basePosition + Math.max(0, audioContext.currentTime - baseClock)) : state.position;
  function stopPlayback() {
    if (animation !== undefined) clock.cancel(animation);
    animation = undefined;
    for (const node of audioNodes) { try { node.stop(); } catch {} node.disconnect(); }
    audioNodes.clear();
    void audioIterator?.return().catch(() => {});
    audioIterator = null; nextAudio = null; nextFrame = null;
  }
  function fail(error, ownRevision) {
    if (revision !== ownRevision) return;
    const position = currentPosition();
    revision++; wantPlay = false; stopPlayback();
    emit({ status: 'error', playing: false, position, error: error.message || String(error) });
  }
  async function readVideo(ownRevision) {
    if (videoReading || nextFrame || !videoIterator) return;
    videoReading = true;
    const iterator = videoIterator;
    try {
      while (ownRevision === revision && state.playing) {
        const frame = (await iterator.next()).value;
        if (ownRevision !== revision || !frame) return;
        if (frame.timestamp - origin > currentPosition()) { nextFrame = frame; return; }
        draw(frame);
      }
    } catch (error) { fail(error, ownRevision); }
    finally { videoReading = false; }
  }
  async function fillAudio(ownRevision) {
    if (!audioIterator || audioFilling) return;
    const iterator = audioIterator;
    audioFilling = true;
    try {
      while (ownRevision === revision && state.playing) {
        const sample = nextAudio || (await iterator.next()).value;
        if (ownRevision !== revision || !sample) return;
        nextAudio = sample;
        const sourceStart = sample.timestamp - origin;
        if (sourceStart > currentPosition() + 0.5) return;
        nextAudio = null;
        const offset = Math.max(0, currentPosition() - sourceStart);
        if (offset >= sample.buffer.duration) continue;
        const node = audioContext.createBufferSource(); node.buffer = sample.buffer;
        node.connect(audioContext.destination);
        audioNodes.add(node);
        node.onended = () => { audioNodes.delete(node); node.disconnect(); };
        const startAt = baseClock + (sourceStart - basePosition);
        node.start(Math.max(audioContext.currentTime, startAt), offset,
          Math.min(sample.buffer.duration - offset, state.duration - sourceStart - offset));
      }
    } catch (error) { fail(error, ownRevision); }
    finally { audioFilling = false; }
  }
  function tick(ownRevision) {
    if (ownRevision !== revision || !state.playing) return;
    state.position = currentPosition();
    if (state.position >= state.duration) {
      wantPlay = false; revision++; stopPlayback();
      emit({ status: 'ended', playing: false, position: state.duration, target: state.duration }); return;
    }
    if (nextFrame && nextFrame.timestamp - origin <= state.position) { draw(nextFrame); nextFrame = null; }
    if (state.actual !== null) state.metrics.maxFrameLagMs = Math.max(state.metrics.maxFrameLagMs, (state.position - state.actual) * 1000);
    void readVideo(ownRevision); void fillAudio(ownRevision);
    if (clock.now() - lastEmit >= 100) { lastEmit = clock.now(); emit(); }
    animation = clock.request(() => tick(ownRevision));
  }
  function startPlayback(ownRevision) {
    if (!wantPlay || ownRevision !== revision) return;
    basePosition = state.position; baseClock = audioContext.currentTime;
    if (audioSink) audioIterator = audioSink.buffers(origin + basePosition, origin + state.duration);
    emit({ status: 'playing', playing: true });
    tick(ownRevision);
  }
  async function drainSeeks() {
    while (pendingSeek) {
      await videoIterator?.return(); videoIterator = null;
      const ownRevision = revision;
      const target = state.target;
      const started = clock.now();
      pendingSeek = false;
      try {
        videoIterator = videoSink.canvases(origin + Math.min(target, Math.max(0, state.duration - 0.001)), origin + state.duration);
        const frame = (await videoIterator.next()).value;
        if (ownRevision !== revision) continue;
        if (!frame) throw new Error('该位置没有可解码的视频画面');
        draw(frame); state.metrics.lastSeekMs = clock.now() - started;
        emit({ status: 'paused' });
        startPlayback(ownRevision);
      } catch (error) {
        if (ownRevision !== revision) continue;
        emit({ status: 'error', error: error.message });
        throw error;
      }
    }
    return player.state;
  }
  function seek(seconds) {
    if (!Number.isFinite(seconds)) return Promise.reject(new Error('定位时间无效'));
    if (!videoSink) return Promise.reject(new Error('请先关联原录像'));
    const target = Math.max(0, Math.min(state.duration, seconds));
    revision++; pendingSeek = true; state.metrics.seeks++;
    stopPlayback();
    emit({ target, position: target, playing: false, status: 'seeking' });
    if (!seeking) seeking = drainSeeks().finally(() => { seeking = null; });
    return seeking;
  }
  async function release() {
    player.pause();
    for (const opening of openingInputs) opening.dispose();
    openingInputs.clear();
    await seeking?.catch(() => {}); await videoIterator?.return(); videoIterator = null;
    await audioContext?.close(); audioContext = null;
    input?.dispose(); input = null; videoSink = null; audioSink = null;
  }
  async function load(source) {
    const ownLoad = ++loadRevision;
    await release();
    if (ownLoad !== loadRevision) return player.state;
    emit({ status: 'loading', playing: false, error: null, actual: null });
    const opened = new MB.Input({ source: new MB.BlobSource(source.file), formats: MB.ALL_FORMATS });
    openingInputs.add(opened);
    try {
      const video = await opened.getPrimaryVideoTrack();
      const audio = await opened.getPrimaryAudioTrack();
      if (!video || !await video.canDecode()) throw new Error('浏览器无法解码原录像画面');
      if (audio && !await audio.canDecode()) throw new Error('浏览器无法解码原录像默认声音');
      const sourceOrigin = source.origin ?? Math.max(0, await video.getFirstTimestamp());
      const duration = source.duration ?? (await video.computeDuration()) - sourceOrigin;
      if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('原录像没有有效时长');
      if (ownLoad !== loadRevision) return player.state;
      input = opened; audioTrack = audio; origin = sourceOrigin;
      canvas.width = Math.min(1280, video.displayWidth);
      canvas.height = Math.max(1, Math.round(canvas.width * video.displayHeight / video.displayWidth));
      videoSink = new MB.CanvasSink(video, { width: canvas.width, height: canvas.height, fit: 'contain', poolSize: 2 });
      audioSink = audio ? new MB.AudioBufferSink(audio) : null;
      emit({ duration, playing: false });
      return await seek(source.position || 0);
    } catch (error) {
      if (ownLoad !== loadRevision) return player.state;
      emit({ status: 'error', playing: false, error: error.message || String(error) });
      throw error;
    } finally {
      openingInputs.delete(opened);
      if (input !== opened) opened.dispose();
    }
  }
  const player = {
    load, seek,
    async play() {
      if (!videoSink) throw new Error('请先关联原录像');
      audioContext ||= createAudioContext({ sampleRate: audioTrack?.sampleRate });
      const ownRevision = revision;
      wantPlay = true;
      await audioContext.resume();
      if (!wantPlay || ownRevision !== revision) return player.state;
      return seek(state.position >= state.duration ? 0 : state.position);
    },
    pause() {
      const position = currentPosition();
      wantPlay = false; revision++; pendingSeek = false; stopPlayback();
      void videoIterator?.return().catch(() => {});
      emit({ position, target: position, playing: false, status: videoSink ? 'paused' : 'empty' });
      return player.state;
    },
    get state() { return structuredClone(state); },
    async dispose() {
      loadRevision++;
      await release();
      emit({ status: 'empty', playing: false });
    },
  };
  return player;
}
