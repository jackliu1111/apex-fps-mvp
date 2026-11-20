export const DEFAULT_PROXY_MEMORY_CAP_BYTES = 150 * 1024 * 1024; // 150 MiB hard cap
const DEFAULT_VIDEO_BITS_PER_SECOND = 2_500_000; // ~2.5 Mbps @ 720p30
const DEFAULT_AUDIO_BITS_PER_SECOND = 96_000;
const CHUNK_TIMESLICE_MS = 2000; // 2 s chunks / GOP alignment

const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=h264,opus',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/webm',
];

export function selectSupportedProxyMime(MediaRecorderCtor = globalThis.MediaRecorder, MediaSourceCtor = globalThis.MediaSource) {
  if (!MediaRecorderCtor?.isTypeSupported) return null;
  for (const mime of PREFERRED_MIME_TYPES) {
    if (!MediaRecorderCtor.isTypeSupported(mime)) continue;
    if (MediaSourceCtor?.isTypeSupported && !MediaSourceCtor.isTypeSupported(mime)) continue;
    return mime;
  }
  return null;
}

/**
 * Rolling live proxy buffer (default: smooth 720p30 MSE video ring; fallback: 2fps filmstrip).
 * Never allowed to feed export-queue; strictly for live preview and recent-window replay.
 */
export function createLiveProxyBuffer({
  windowSeconds = 120,
  maxBytes = DEFAULT_PROXY_MEMORY_CAP_BYTES,
  mode = 'smooth', // 'smooth' | 'eco'
  onState = () => {},
  onOverload = () => {},
  onChunk = () => {},
} = {}) {
  let activeMode = mode;
  let maxWindowSec = Math.max(60, Math.min(300, windowSeconds));
  let recorder = null;
  let mediaSource = null;
  let sourceBuffer = null;
  let objectUrl = null;
  let pendingQueue = [];
  let flushing = false;
  let bufferedBytes = 0;
  let chunkRecords = []; // { byteLength, wallEndMs }
  let filmstrip = [];    // eco mode: { wallMs, dataUrl, bytes }
  let filmTimer = null;
  let currentStream = null;
  let previewVideoEl = null;
  let paused = false;
  let mimeType = null;
  let startedWallMs = 0;
  let elapsedSec = 0;
  let slowChunks = 0;
  let lastChunkAt = 0;
  let lastChunkGapMs = 0;
  let bitrateBps = 0;
  let recentThroughput = []; // { wallMs, bytes, gapMs }

  function updateThroughput(bytes, gapMs, wallMs) {
    recentThroughput.push({ wallMs, bytes, gapMs: Math.max(1, gapMs) });
    const cutoff = wallMs - 10_000;
    while (recentThroughput.length > 1 && recentThroughput[0].wallMs < cutoff) {
      recentThroughput.shift();
    }
    let totalBytes = 0;
    let totalMs = 0;
    for (const item of recentThroughput) {
      totalBytes += item.bytes;
      totalMs += item.gapMs;
    }
    bitrateBps = totalMs > 0 ? Math.round((totalBytes * 8 * 1000) / totalMs) : 0;
    lastChunkGapMs = Math.round(gapMs);
  }

  const emit = () => onState({
    mode: activeMode,
    mimeType,
    windowSeconds: maxWindowSec,
    bufferedBytes,
    maxBytes,
    elapsedSec,
    paused,
    replayUrl: objectUrl,
    filmstripCount: filmstrip.length,
    bitrateBps,
    lastChunkGapMs,
  });

  function teardownSmooth() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    }
    recorder = null;
    pendingQueue = [];
    flushing = false;
    chunkRecords = [];
    if (mediaSource && mediaSource.readyState === 'open') {
      try { mediaSource.endOfStream(); } catch {}
    }
    sourceBuffer = null;
    mediaSource = null;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  function teardownEco() {
    if (filmTimer) clearInterval(filmTimer);
    filmTimer = null;
    filmstrip = [];
  }

  function trimSmoothBuffer() {
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return false;
    const start = sourceBuffer.buffered.start(0);
    const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
    elapsedSec = Math.max(elapsedSec, end);
    const desiredStart = end - maxWindowSec;
    if (desiredStart > start + 2) {
      try {
        sourceBuffer.remove(start, desiredStart);
        // Estimate trimmed bytes proportionally.
        while (chunkRecords.length && (chunkRecords.length * (CHUNK_TIMESLICE_MS / 1000)) > maxWindowSec + 4) {
          const dropped = chunkRecords.shift();
          bufferedBytes = Math.max(0, bufferedBytes - dropped.byteLength);
        }
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function flushPending() {
    if (flushing || !sourceBuffer || sourceBuffer.updating) return;
    if (trimSmoothBuffer()) return;
    if (!pendingQueue.length) return;
    flushing = true;
    const chunk = pendingQueue.shift();
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (error) {
      flushing = false;
      if (error?.name === 'QuotaExceededError') {
        onOverload('回看缓存已达浏览器上限，建议切换为省电缩略图');
        trimSmoothBuffer();
      }
    }
  }

  function startSmooth(stream) {
    teardownEco();
    teardownSmooth();
    mimeType = selectSupportedProxyMime();
    if (!mimeType || typeof MediaSource === 'undefined') {
      activeMode = 'eco';
      onOverload('当前浏览器不支持流畅回看，已切换为省电缩略图');
      if (previewVideoEl) startEco(previewVideoEl);
      return;
    }

    mediaSource = new MediaSource();
    objectUrl = URL.createObjectURL(mediaSource);
    startedWallMs = Date.now();
    elapsedSec = 0;
    bufferedBytes = 0;
    slowChunks = 0;
    lastChunkAt = performance.now();
    lastChunkGapMs = 0;
    bitrateBps = 0;
    recentThroughput = [];

    mediaSource.addEventListener('sourceopen', () => {
      if (!mediaSource || mediaSource.readyState !== 'open') return;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      } catch {
        activeMode = 'eco';
        onOverload('回看视频初始化失败，已切换为省电缩略图');
        if (previewVideoEl) startEco(previewVideoEl);
        return;
      }
      sourceBuffer.addEventListener('updateend', () => {
        flushing = false;
        emit();
        flushPending();
      });
      flushPending();
    }, { once: true });

    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: DEFAULT_VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: DEFAULT_AUDIO_BITS_PER_SECOND,
      });
    } catch {
      activeMode = 'eco';
      onOverload('无法启动流畅回看，已切换为省电缩略图');
      if (previewVideoEl) startEco(previewVideoEl);
      return;
    }

    recorder.ondataavailable = async (event) => {
      if (!event.data || !event.data.size || paused) return;
      const nowPerf = performance.now();
      const gap = nowPerf - lastChunkAt;
      lastChunkAt = nowPerf;
      if (gap > CHUNK_TIMESLICE_MS * 2.2) {
        slowChunks++;
        if (slowChunks >= 3) {
          onOverload('回看编码较慢，可切换为省电缩略图');
          slowChunks = 0;
        }
      } else {
        slowChunks = Math.max(0, slowChunks - 1);
      }

      const buf = await event.data.arrayBuffer();
      const wallMs = Date.now();
      bufferedBytes += buf.byteLength;
      chunkRecords.push({ byteLength: buf.byteLength, wallEndMs: wallMs });
      updateThroughput(buf.byteLength, gap, wallMs);

      if (bufferedBytes > maxBytes) {
        onOverload('回看缓存接近上限，建议切换为省电缩略图');
        while (pendingQueue.length > 2) pendingQueue.shift();
      }
      pendingQueue.push(buf);
      flushPending();
      onChunk({
        bytes: buf.byteLength,
        gapMs: lastChunkGapMs,
        bitrateBps,
        bufferedBytes,
        maxBytes,
        mode: activeMode,
        nowMs: wallMs,
      });
      emit();
    };

    recorder.start(CHUNK_TIMESLICE_MS);
    emit();
  }

  function startEco(videoEl) {
    teardownSmooth();
    teardownEco();
    activeMode = 'eco';
    startedWallMs = Date.now();
    bufferedBytes = 0;
    lastChunkAt = performance.now();
    lastChunkGapMs = 0;
    bitrateBps = 0;
    recentThroughput = [];
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = 320;
    snapCanvas.height = 180;
    const ctx = snapCanvas.getContext('2d');
    filmTimer = setInterval(() => {
      if (paused || !videoEl || videoEl.readyState < 2) return;
      try {
        const nowPerf = performance.now();
        const gap = nowPerf - lastChunkAt;
        lastChunkAt = nowPerf;
        ctx.drawImage(videoEl, 0, 0, snapCanvas.width, snapCanvas.height);
        const dataUrl = snapCanvas.toDataURL('image/jpeg', 0.6);
        const bytes = dataUrl.length;
        const wallMs = Date.now();
        filmstrip.push({ wallMs, dataUrl, bytes });
        bufferedBytes += bytes;
        const cutoff = wallMs - maxWindowSec * 1000;
        while (filmstrip.length && (filmstrip[0].wallMs < cutoff || bufferedBytes > maxBytes)) {
          const old = filmstrip.shift();
          bufferedBytes = Math.max(0, bufferedBytes - old.bytes);
        }
        elapsedSec = (wallMs - startedWallMs) / 1000;
        updateThroughput(bytes, gap, wallMs);
        onChunk({
          bytes,
          gapMs: lastChunkGapMs,
          bitrateBps,
          bufferedBytes,
          maxBytes,
          mode: activeMode,
          nowMs: wallMs,
        });
        emit();
      } catch {}
    }, 500); // 2 fps
    emit();
  }

  return {
    start({ stream, videoElement }) {
      currentStream = stream;
      previewVideoEl = videoElement;
      paused = false;
      const hasVideo = !!stream?.getVideoTracks?.().length;
      if (activeMode === 'smooth' && hasVideo) startSmooth(stream);
      else if (hasVideo) startEco(videoElement);
      else emit();
    },
    setMode(nextMode) {
      if (nextMode !== 'smooth' && nextMode !== 'eco') return;
      activeMode = nextMode;
      if (currentStream) {
        if (activeMode === 'smooth' && currentStream.getVideoTracks().length) startSmooth(currentStream);
        else if (previewVideoEl && currentStream.getVideoTracks().length) startEco(previewVideoEl);
      }
      emit();
    },
    setWindowSeconds(seconds) {
      maxWindowSec = Math.max(60, Math.min(300, Number(seconds) || 120));
      trimSmoothBuffer();
      emit();
    },
    setPaused(flag) {
      paused = !!flag;
      if (recorder) {
        try {
          if (paused && recorder.state === 'recording') recorder.pause();
          else if (!paused && recorder.state === 'paused') recorder.resume();
        } catch {}
      }
      emit();
    },
    captureSnapshot(videoEl = previewVideoEl) {
      if (!videoEl || videoEl.readyState < 2) return null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        canvas.getContext('2d').drawImage(videoEl, 0, 0, 160, 90);
        return canvas.toDataURL('image/jpeg', 0.65);
      } catch {
        return null;
      }
    },
    getFilmstrip() {
      return [...filmstrip];
    },
    getFrameAtLag(lagSeconds) {
      if (!filmstrip.length) return null;
      const latestMs = filmstrip[filmstrip.length - 1].wallMs;
      const targetMs = latestMs - Math.max(0, lagSeconds) * 1000;
      let chosen = filmstrip[0];
      for (const frame of filmstrip) {
        if (frame.wallMs <= targetMs + 250) chosen = frame;
        else break;
      }
      return chosen;
    },
    getReplayUrl() {
      return objectUrl;
    },
    getReplayRange() {
      if (!sourceBuffer || !sourceBuffer.buffered.length) return null;
      return {
        start: sourceBuffer.buffered.start(0),
        end: sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1),
      };
    },
    getDvrBounds() {
      if (activeMode === 'smooth') {
        const range = this.getReplayRange();
        if (!range) return { availableSec: 0, start: 0, end: 0 };
        return {
          availableSec: Math.min(maxWindowSec, Math.max(0, range.end - range.start)),
          start: range.start,
          end: range.end,
        };
      }
      if (filmstrip.length >= 2) {
        const span = Math.max(0, (filmstrip[filmstrip.length - 1].wallMs - filmstrip[0].wallMs) / 1000);
        return { availableSec: Math.min(maxWindowSec, span), start: 0, end: span };
      }
      return { availableSec: 0, start: 0, end: 0 };
    },
    stop() {
      teardownSmooth();
      teardownEco();
      currentStream = null;
      previewVideoEl = null;
      bufferedBytes = 0;
      elapsedSec = 0;
      lastChunkGapMs = 0;
      bitrateBps = 0;
      recentThroughput = [];
      emit();
    },
  };
}
