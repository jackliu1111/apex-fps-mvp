const MEMORY_LIMIT = 64 * 1024 * 1024;
const abortError = () => new DOMException('本批导出已取消', 'AbortError');

/** Position-addressed memory writer; bounds actual encoded bytes, including metadata rewrites. */
function memoryDestination(limit) {
  const blockSize = Math.min(256 * 1024, limit);
  const blocks = new Map();
  let size = 0;
  return {
    write({ position, data }) {
      const end = position + data.byteLength;
      if (end > limit) throw new Error('成片超出下载缓存预算，请选择输出目录后重新提交');
      size = Math.max(size, end);
      for (let offset = 0; offset < data.byteLength;) {
        const index = Math.floor((position + offset) / blockSize), within = (position + offset) % blockSize;
        if (!blocks.has(index)) blocks.set(index, new Uint8Array(blockSize));
        const amount = Math.min(blockSize - within, data.byteLength - offset);
        blocks.get(index).set(data.subarray(offset, offset + amount), within); offset += amount;
      }
    },
    blob() {
      const parts = [];
      for (let start = 0; start < size; start += blockSize) parts.push((blocks.get(start / blockSize) || new Uint8Array(blockSize)).subarray(0, Math.min(blockSize, size - start)));
      return new Blob(parts, { type: 'video/webm' });
    },
  };
}

async function newOutputFile(directory, proposedName) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = attempt ? proposedName.replace(/\.webm$/, `-${attempt}.webm`) : proposedName;
    try { await directory.getFileHandle(name); continue; }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    const handle = await directory.getFileHandle(name, { create: true });
    return { name, handle };
  }
  throw new Error('无法为本次导出建立新的文件名');
}

/** Each conversion owns its input/encoder; cancelling export cannot cancel analysis or preview. */
export function createBrowserConverter({ MB, makeId = () => crypto.randomUUID() }) {
  return async function convert({ batch, clip, source, index = 0, signal = new AbortController().signal,
    onProgress = () => {}, memoryBudgetBytes = MEMORY_LIMIT }) {
    signal.throwIfAborted();
    if (!source?.file) throw new Error('原录像暂不可用，请重新关联');
    const limit = Math.floor(Math.min(MEMORY_LIMIT, memoryBudgetBytes));
    if (!(limit > 0) && !source.directoryHandle) throw new Error('下载缓存没有可用空间，请选择输出目录');
    let name = `${source.file.name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}-${String(index + 1).padStart(2, '0')}-${makeId()}.webm`;
    const input = new MB.Input({ source: new MB.BlobSource(source.file), formats: MB.ALL_FORMATS });
    let conversion, cancelWork, abortListener, diskFile, diskWriter, diskClosed = false, completed = false;
    try {
      const video = await input.getPrimaryVideoTrack();
      const tracks = await input.getAudioTracks();
      const audio = batch.audio?.trackId !== undefined ? tracks.find((track) => track.id === batch.audio.trackId)
        : Number.isInteger(batch.audio?.trackIndex) ? tracks[batch.audio.trackIndex] : await input.getPrimaryAudioTrack();
      if (!video || !audio) throw new Error('提交时指定的声画轨不可用');
      const destination = source.directoryHandle ? null : memoryDestination(limit);
      if (source.directoryHandle) {
        diskFile = await newOutputFile(source.directoryHandle, name); name = diskFile.name;
        diskWriter = await diskFile.handle.createWritable();
      }
      const writable = new WritableStream({
        async write({ position, data }) {
          signal.throwIfAborted();
          if (diskWriter) await diskWriter.write({ type: 'write', position, data });
          else destination.write({ position, data });
        },
        async close() {
          if (diskWriter) {
            if (signal.aborted) await diskWriter.abort();
            else { await diskWriter.close(); diskClosed = true; }
          }
        },
        async abort() { if (diskWriter && !diskClosed) await diskWriter.abort(); },
      });
      const target = new MB.StreamTarget(writable, { chunked: true, chunkSize: 256 * 1024 });
      target.onwrite = (_start, end) => { if (!diskWriter && end > limit) throw new Error('成片超出下载缓存预算，请选择输出目录后重新提交'); };
      const output = new MB.Output({ format: new MB.WebMOutputFormat(), target });
      const settings = batch.output || {}, origin = source.origin || 0;
      conversion = await MB.Conversion.init({ input, output, trim: { start: origin + clip.start, end: origin + clip.end },
        video: (track) => track === video ? { codec: 'vp8', width: Math.min(1280, settings.width || 1280, track.displayWidth),
          height: Math.min(720, settings.height || 720, track.displayHeight), fit: 'contain', bitrate: settings.videoBitrate || 2000000, forceTranscode: true } : { discard: true },
        audio: (track) => track === audio ? { codec: 'opus', bitrate: settings.audioBitrate || 96000, forceTranscode: true } : { discard: true },
      });
      if (!conversion.isValid || conversion.discardedTracks.some((entry) => entry.track === video || entry.track === audio)) throw new Error('浏览器无法完整导出提交的声画轨');
      conversion.onProgress = onProgress;
      signal.throwIfAborted();
      // Pinned Mediabunny deliberately leaves execute() pending after cancellation.
      // Await cancel's resource cleanup, then settle our own public operation.
      const aborted = new Promise((_, reject) => {
        abortListener = () => {
          cancelWork ||= Promise.resolve(conversion.cancel());
          cancelWork.then(() => reject(signal.reason || abortError()), reject);
        };
        signal.addEventListener('abort', abortListener, { once: true });
      });
      await Promise.race([conversion.execute(), aborted]);
      signal.throwIfAborted();
      if (diskFile && !diskClosed) throw new Error('输出文件尚未成功关闭');
      const blob = destination?.blob();
      const resultFile = diskFile ? await diskFile.handle.getFile() : blob;
      const probe = new MB.Input({ source: new MB.BlobSource(resultFile), formats: MB.ALL_FORMATS });
      let measuredDuration = null, verificationError = null;
      try { measuredDuration = await probe.computeDuration(); }
      catch (error) { verificationError = error.message || String(error); }
      finally { probe.dispose(); }
      signal.throwIfAborted(); completed = true;
      return { name, ...(blob ? { blob } : {}), bytes: resultFile.size, start: clip.start, end: clip.end,
        requestedDuration: clip.end - clip.start, measuredDuration, verificationError, actualRange: null, saved: diskClosed };
    } catch (error) {
      try { await (cancelWork || conversion?.cancel()); } catch {}
      throw error;
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener); input.dispose();
      if (diskFile && !completed) {
        try { if (!diskClosed) await diskWriter?.abort(); } catch {}
        try { await source.directoryHandle.removeEntry(name); }
        catch (error) { throw new Error(`导出未完成，无法清理本次部分文件 ${name}：${error.message}`); }
      }
    }
  };
}
