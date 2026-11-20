const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm']);
const TEMP_SUFFIXES = ['.tmp', '.part', '.crdownload', '.incomplete'];

export function isCandidateVideoName(name) {
  if (!name || name.startsWith('.')) return false;
  const lower = name.toLowerCase();
  if (TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  const dot = lower.lastIndexOf('.');
  return dot > 0 && VIDEO_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Read-only recording directory watcher with baseline snapshotting,
 * self-export suppression, and 5-state stability probing:
 * discovered -> growing -> stabilizing -> probing -> ready | ignored.
 */
export function createDirectoryWatcher({
  pollIntervalMs = 2000,
  stablePollsRequired = 2,
  probeFile,
  onStatus = () => {},
  onReady = () => {},
  onError = () => {},
  now = () => Date.now(),
} = {}) {
  let directoryHandle = null;
  let timer = null;
  let polling = false;
  let startedAt = 0;
  const baselineNames = new Set();
  const exportedNames = new Set();
  const tracked = new Map(); // name -> { state, size, lastModified, stableCount, attempts, file, meta }

  const snapshot = () => ({
    watching: !!directoryHandle,
    directoryName: directoryHandle?.name || null,
    startedAt,
    tracked: [...tracked.entries()].map(([name, info]) => ({
      name,
      state: info.state,
      size: info.size,
      lastModified: info.lastModified,
      attempts: info.attempts,
    })),
  });

  const emit = () => onStatus(snapshot());

  async function scanOnce() {
    if (!directoryHandle || polling) return;
    polling = true;
    try {
      const seen = new Set();
      for await (const [name, handle] of directoryHandle.entries()) {
        if (handle.kind !== 'file') continue;
        seen.add(name);
        if (baselineNames.has(name) || exportedNames.has(name) || !isCandidateVideoName(name)) continue;

        let entry = tracked.get(name);
        if (entry && (entry.state === 'ready' || entry.state === 'ignored' || entry.state === 'probing')) continue;

        let file;
        try {
          file = await handle.getFile();
        } catch {
          // Windows exclusive write lock while recording: stay in growing state and retry next poll.
          if (!entry) {
            entry = { state: 'growing', size: -1, lastModified: 0, stableCount: 0, attempts: 0 };
            tracked.set(name, entry);
            emit();
          }
          continue;
        }

        if (!entry) {
          entry = {
            state: 'discovered',
            size: file.size,
            lastModified: file.lastModified,
            stableCount: 0,
            attempts: 0,
            file,
          };
          tracked.set(name, entry);
          emit();
          continue;
        }

        const unchanged = file.size > 0 && file.size === entry.size && file.lastModified === entry.lastModified;
        entry.size = file.size;
        entry.lastModified = file.lastModified;
        entry.file = file;

        if (!unchanged) {
          entry.state = 'growing';
          entry.stableCount = 0;
          emit();
          continue;
        }

        entry.stableCount++;
        if (entry.stableCount < stablePollsRequired) {
          entry.state = 'stabilizing';
          emit();
          continue;
        }

        // Transition to Probing: verify readable container metadata & duration, then double-check size.
        entry.state = 'probing';
        entry.attempts++;
        emit();
        try {
          const meta = probeFile ? await probeFile(file) : { duration: null };
          const recheck = await handle.getFile();
          if (recheck.size !== file.size || recheck.lastModified !== file.lastModified) {
            entry.size = recheck.size;
            entry.lastModified = recheck.lastModified;
            entry.state = 'growing';
            entry.stableCount = 0;
            emit();
            continue;
          }
          entry.state = 'ready';
          entry.file = recheck;
          entry.meta = meta;
          emit();
          await onReady({ name, file: recheck, handle, meta });
        } catch (error) {
          // Incomplete moov box or temporary lock: drop back to growing unless exceeded max retries.
          if (entry.attempts >= 15) {
            entry.state = 'ignored';
            entry.error = error?.message || String(error);
          } else {
            entry.state = 'growing';
            entry.stableCount = 0;
          }
          emit();
        }
      }

      // Clean up temporary tracked entries that disappeared before becoming ready.
      for (const [name, entry] of tracked.entries()) {
        if (!seen.has(name) && entry.state !== 'ready') {
          tracked.delete(name);
          emit();
        }
      }
    } catch (error) {
      onError(error);
    } finally {
      polling = false;
    }
  }

  return {
    async start(handle) {
      if (!handle) throw new Error('请选择录像目录');
      if (timer) clearInterval(timer);
      directoryHandle = handle;
      startedAt = now();
      baselineNames.clear();
      tracked.clear();
      for await (const [name, entry] of handle.entries()) {
        if (entry.kind === 'file') baselineNames.add(name);
      }
      emit();
      timer = setInterval(() => { void scanOnce(); }, pollIntervalMs);
      return snapshot();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      directoryHandle = null;
      emit();
    },
    registerExportedFilename(name) {
      if (name) exportedNames.add(name);
    },
    async pollNow() {
      await scanOnce();
      return snapshot();
    },
    get state() {
      return snapshot();
    },
  };
}
