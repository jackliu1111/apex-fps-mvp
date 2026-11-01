import { MAX_EXPORT_BUFFER_BYTES, EXPORT_WRITE_CHUNK_BYTES, sourceExportSettings, exportSettings } from './export-policy.mjs';
const abortError = () => new DOMException('本批导出已取消', 'AbortError');
async function directoryOperation(action) {
  try { return await action(); }
  catch (error) { if (error.name !== 'AbortError') error.needsDestination = true; throw error; }
}

async function newOutputFile(directory, proposedName) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = attempt ? proposedName.replace(/(\.[^.]+)$/, `-${attempt}$1`) : proposedName;
    try { await directory.getFileHandle(name); continue; }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    const handle = await directory.getFileHandle(name, { create: true });
    return { name, handle };
  }
  throw new Error('无法为本次导出建立新的文件名');
}

/** Each conversion owns its input/encoder; cancelling export cannot cancel analysis or preview. */
export function createBrowserConverter({ MB, makeId = () => crypto.randomUUID(), maxBufferedBytes = MAX_EXPORT_BUFFER_BYTES }) {
  if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 1) throw new Error('写入缓冲预算无效');
  const bufferLimit = Math.floor(Math.min(maxBufferedBytes, MAX_EXPORT_BUFFER_BYTES));
  return async function convert({ batch, clip, source, index = 0, signal = new AbortController().signal,
    onProgress = () => {} }) {
    signal.throwIfAborted();
    if (!source?.file) throw new Error('原录像暂不可用，请重新关联');
    if (!source.directoryHandle) throw new Error('请先选择输出目录');
    const format = exportSettings(batch.output).format;
    let name = `${source.file.name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}-${String(index + 1).padStart(2, '0')}-${makeId()}.${format}`;
    const input = new MB.Input({ source: new MB.BlobSource(source.file), formats: MB.ALL_FORMATS });
    let conversion, cancelWork, closeWork, primaryError, streamError, abortListener, diskFile, diskWriter, diskClosed = false, writtenBytes = 0, pendingBytes = 0;
    try {
      const video = await input.getPrimaryVideoTrack();
      const tracks = await input.getAudioTracks();
      const audio = batch.audio?.trackId !== undefined ? tracks.find((track) => track.id === batch.audio.trackId)
        : Number.isInteger(batch.audio?.trackIndex) ? tracks[batch.audio.trackIndex] : await input.getPrimaryAudioTrack();
      if (!video || !audio) throw new Error('提交时指定的声画轨不可用');
      diskFile = await directoryOperation(() => newOutputFile(source.directoryHandle, name)); name = diskFile.name;
      diskWriter = await directoryOperation(() => diskFile.handle.createWritable());
      const writable = new WritableStream({
        async write({ position, data }) {
          signal.throwIfAborted();
          try {
            await directoryOperation(() => diskWriter.write({ type: 'write', position, data }));
            writtenBytes = Math.max(writtenBytes, position + data.byteLength);
          } finally { pendingBytes -= data.byteLength; }
        },
        async close() {
          if (diskWriter) {
            if (signal.aborted || primaryError) await diskWriter.abort();
            else { closeWork = Promise.resolve().then(() => directoryOperation(() => diskWriter.close())).then(() => { diskClosed = true; }); await closeWork; }
          }
        },
        async abort() { if (diskWriter && !diskClosed) await diskWriter.abort(); },
      }, {
        highWaterMark: 1,
        size({ data }) {
          if (pendingBytes + data.byteLength > bufferLimit) throw new Error('输出写入缓冲超出预算，导出已停止；请重试或选择更快的目录');
          pendingBytes += data.byteLength;
          return data.byteLength;
        },
      });
      // Pinned Mediabunny queues writes without awaiting their promises. Observe
      // rejection here while retaining the original promise and stream error state:
      // execute()/ready/closed must still reject and trigger normal file cleanup.
      const getWriter = writable.getWriter.bind(writable);
      writable.getWriter = () => {
        const writer = getWriter(), write = writer.write.bind(writer);
        writer.write = (chunk) => {
          const pending = write(chunk);
          void pending.catch((error) => { streamError ||= error; });
          return pending;
        };
        return writer;
      };
      const target = new MB.StreamTarget(writable, { chunked: true, chunkSize: EXPORT_WRITE_CHUNK_BYTES });
      const output = new MB.Output({ format: format === 'mp4' ? new MB.Mp4OutputFormat({ fastStart: false }) : new MB.WebMOutputFormat(), target });
      const settings = sourceExportSettings(batch.output, video), origin = source.origin || 0;
      // Deliberately omit frameRate: preserve source timestamps, including VFR.
      conversion = await MB.Conversion.init({ input, output, trim: { start: origin + clip.start, end: origin + clip.end },
        video: (track) => track === video ? { codec: settings.videoCodec, width: settings.width,
          height: settings.height, fit: 'contain', bitrate: settings.videoBitrate, forceTranscode: true } : { discard: true },
        audio: (track) => track === audio ? { codec: settings.audioCodec, bitrate: settings.audioBitrate, forceTranscode: true } : { discard: true },
      });
      if (!conversion.isValid || conversion.discardedTracks.some((entry) => entry.track === video || entry.track === audio)) throw new Error(`浏览器无法按 ${settings.width}×${settings.height} 和原片帧率完整导出 ${format.toUpperCase()} 声画轨；未降低分辨率或帧率。${format === 'mp4' ? '请改选 WebM，或尝试支持 H.264 + AAC 编码的浏览器。' : '请尝试支持该规格的浏览器。'}`);
      conversion.onProgress = onProgress;
      signal.throwIfAborted();
      // Pinned Mediabunny deliberately leaves execute() pending after cancellation.
      // Await cancel's resource cleanup, then settle our own public operation.
      const aborted = new Promise((_, reject) => {
        abortListener = () => {
          if (diskClosed) return;
          cancelWork ||= (async () => {
            if (closeWork) { try { await closeWork; } catch {} }
            if (diskClosed) return;
            try { await conversion.cancel(); } catch {}
            throw signal.reason || abortError();
          })();
          cancelWork.catch(reject);
        };
        signal.addEventListener('abort', abortListener, { once: true });
      });
      let postSaveError;
      try { await Promise.race([conversion.execute(), aborted]); }
      catch (error) { if (!diskClosed) throw error; postSaveError = error; }
      if (!diskClosed) signal.throwIfAborted();
      if (diskFile && !diskClosed) throw new Error('输出文件尚未成功关闭');
      let resultFile, probe, checkAbort, measuredDuration = null, verificationError = postSaveError ? postSaveError.message || String(postSaveError) : null;
      try {
        signal.throwIfAborted();
        const cancelledCheck = new Promise((_, reject) => {
          checkAbort = () => reject(signal.reason || abortError());
          signal.addEventListener('abort', checkAbort, { once: true });
        });
        measuredDuration = await Promise.race([(async () => {
          resultFile = await diskFile.handle.getFile();
          signal.throwIfAborted();
          probe = new MB.Input({ source: new MB.BlobSource(resultFile), formats: MB.ALL_FORMATS });
          return probe.computeDuration();
        })(), cancelledCheck]);
      } catch (error) { verificationError = [verificationError, error.message || String(error)].filter(Boolean).join('；'); }
      finally {
        if (checkAbort) signal.removeEventListener('abort', checkAbort);
        probe?.dispose();
      }
      if (!diskClosed) signal.throwIfAborted();
      return { name, ...(resultFile ? { artifact: { fileHandle: diskFile.handle, size: resultFile.size, lastModified: resultFile.lastModified } } : {}), bytes: resultFile?.size ?? writtenBytes, start: clip.start, end: clip.end,
        requestedDuration: clip.end - clip.start, measuredDuration, verificationError, actualRange: null, saved: diskClosed };
    } catch (error) {
      // Encoder shutdown may reject execute() before our cancellation promise.
      if (signal.aborted && !diskClosed) error = signal.reason || abortError();
      else if (streamError && !diskClosed) error = streamError;
      primaryError = error;
      try { await (cancelWork || conversion?.cancel()); } catch {}
      if (diskFile && !diskClosed) {
        try { await diskWriter?.abort(); } catch {}
        try { await source.directoryHandle.removeEntry(name); }
        catch (cleanupError) {
          const partialFile = `${source.directoryHandle.name || '所选目录'}/${name}`;
          throw Object.assign(new Error(`${error.message || error}；清理失败：${cleanupError.message || cleanupError}；遗留文件：${partialFile}`, { cause: error }),
            { originalError: error, cleanupError, partialFile, needsDestination: error.needsDestination === true });
        }
      }
      throw error;
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
      input.dispose();
    }
  };
}
