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
  let session = { handle: null, startedAt: 0, tracked: new Map() };
  let timer = null;
  const exportedNames = new Set();

  const snapshot = () => ({
    watching: !!session.handle,
    directoryName: session.handle?.name || null,
    startedAt: session.startedAt,
    tracked: [...session.tracked.entries()].map(([name, info]) => ({
      name,
      state: info.state,
      size: info.size,
      lastModified: info.lastModified,
      attempts: info.attempts,
    })),
  });

  const emit = () => onStatus(snapshot());
  // Without an earlier readable snapshot, only timestamps inside the observed watch interval
  // distinguish a later write. Equal or future-dated timestamps need a subsequent metadata change.
  const writtenDuringWatch = (file, startedAt) => file.lastModified > startedAt && file.lastModified <= now();

  async function scanOnce(current) {
    const { handle: directoryHandle, baseline, startedAt, tracked } = current;
    try {
      const seen = new Set();
      for await (const [name, handle] of directoryHandle.entries()) {
        if (session !== current) return;
        if (handle.kind !== 'file') continue;
        seen.add(name);
        if (exportedNames.has(name) || !isCandidateVideoName(name)) continue;

        let entry = tracked.get(name);
        if (entry?.state === 'ready') continue;

        let file;
        try {
          file = await handle.getFile();
        } catch {
          // Windows exclusive write lock while recording: stay in growing state and retry next poll.
          if (session !== current || exportedNames.has(name)) continue;
          if (!entry && !baseline.has(name)) {
            entry = { state: 'growing', size: -1, lastModified: 0, stableCount: 0, attempts: 0 };
            tracked.set(name, entry);
            emit();
          }
          continue;
        }

        if (session !== current || exportedNames.has(name)) continue;
        if (baseline.has(name)) {
          const initial = baseline.get(name);
          if (!initial && !writtenDuringWatch(file, startedAt)) {
            baseline.set(name, { size: file.size, lastModified: file.lastModified });
            continue;
          }
          if (initial && initial.size === file.size && initial.lastModified === file.lastModified) continue;
          baseline.delete(name);
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

        const changed = file.size !== entry.size || file.lastModified !== entry.lastModified;
        if (entry.state === 'ignored' && !changed) continue;
        entry.size = file.size;
        entry.lastModified = file.lastModified;
        entry.file = file;

        if (changed || file.size === 0) {
          entry.attempts = 0;
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
          if (session !== current || exportedNames.has(name)) continue;
          if (recheck.size !== file.size || recheck.lastModified !== file.lastModified) {
            entry.size = recheck.size;
            entry.lastModified = recheck.lastModified;
            entry.state = 'growing';
            entry.attempts = 0;
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
          if (session !== current || exportedNames.has(name)) continue;
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
      if (session === current) onError(error);
    }
  }

  function poll() {
    const current = session;
    if (!current.handle) return;
    // Automatic scans and manual refreshes share the snapshot or scan already in progress.
    current.pending ??= scanOnce(current).finally(() => { current.pending = null; });
    return current.pending;
  }

  async function readBaseline(current) {
    for await (const [name, entry] of current.handle.entries()) {
      if (session !== current) return;
      if (entry.kind !== 'file' || exportedNames.has(name) || !isCandidateVideoName(name)) continue;
      try {
        const file = await entry.getFile();
        if (!writtenDuringWatch(file, current.startedAt)) {
          current.baseline.set(name, { size: file.size, lastModified: file.lastModified });
        }
      } catch {
        // A locked recording may become readable only when OBS finishes writing it.
        current.baseline.set(name, null);
      }
    }
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    session = { handle: null, startedAt: session.startedAt, tracked: new Map(session.tracked) };
    emit();
  }

  return {
    async start(handle) {
      if (!handle) throw new Error('请选择录像目录');
      clearInterval(timer);
      const current = { handle, startedAt: now(), tracked: new Map(), baseline: new Map(), pending: null };
      session = current;
      try {
        current.pending = readBaseline(current);
        await current.pending;
      } catch (error) {
        if (session === current) stop();
        throw error;
      }
      current.pending = null;
      if (session === current) {
        timer = setInterval(poll, pollIntervalMs);
        emit();
      }
      return snapshot();
    },
    stop,
    registerExportedFilename(name) {
      if (!name) return;
      exportedNames.add(name);
      if (session.tracked.delete(name)) emit();
    },
    async pollNow() {
      await poll();
      return snapshot();
    },
    get state() {
      return snapshot();
    },
  };
}
