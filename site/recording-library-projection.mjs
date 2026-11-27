// Pure snapshot projector for the Recording Library (ADR 0009 + ADR 0010).
// Zero DOM dependencies and zero imports from capture, watcher, or alignment engines.

export const LIBRARY_STATUSES = Object.freeze([
  'unanalyzed',
  'analyzing',
  'ready',
  'conformed-coarse',
]);

const VALID_LIVE_STATUSES = new Set([
  'off',
  'starting',
  'listening',
  'paused-loopback',
  'disconnected',
  'error',
  'unavailable',
]);

const VALID_WATCH_STATUSES = new Set([
  'unset',
  'watching',
  'needs-permission',
  'error',
]);

export function extractBasename(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim().replace(/[\\/]+$/g, '');
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

export function formatClockTime(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '';
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const kib = 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GB`;
  if (bytes >= mib) {
    const value = bytes / mib;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} MB`;
  }
  if (bytes >= kib) return `${Math.round(bytes / kib)} KB`;
  return `${Math.round(bytes)} B`;
}

export function projectRecordingStatus(rawStatus, alignment = null) {
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
  if (status === 'preparing' || status === 'queued' || status === 'analyzing') {
    return 'analyzing';
  }
  if (status === 'conformed-coarse' || status === 'ready-coarse') {
    return 'conformed-coarse';
  }
  if (status === 'conformed-exact' || status === 'ready-exact') {
    return 'ready';
  }
  if (status === 'complete' || status === 'completed' || status === 'ready') {
    return alignment?.confidence === 'coarse' ? 'conformed-coarse' : 'ready';
  }
  return 'unanalyzed';
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resolveRowActions(status, { canReview = true, canAnalyze = true, canStop = true, canReanalyze = true } = {}) {
  if (status === 'ready') {
    return { primaryAction: canReview ? 'review' : null, secondaryAction: null };
  }
  if (status === 'conformed-coarse') {
    return {
      primaryAction: canReview ? 'review' : null,
      secondaryAction: canReanalyze ? 'reanalyze' : null,
    };
  }
  if (status === 'analyzing') {
    return { primaryAction: canStop ? 'stop' : null, secondaryAction: null };
  }
  return { primaryAction: canAnalyze ? 'analyze' : null, secondaryAction: null };
}

function countSavedOutputsBySource(batches) {
  const counts = new Map();
  if (!Array.isArray(batches)) return counts;
  for (const batch of batches) {
    if (!batch?.sourceId || !Array.isArray(batch.outputs)) continue;
    let saved = 0;
    for (const output of batch.outputs) {
      if (output?.saved === true) saved += 1;
    }
    if (saved > 0) {
      counts.set(batch.sourceId, (counts.get(batch.sourceId) || 0) + saved);
    }
  }
  return counts;
}

function countCandidates(saved, record) {
  if (Array.isArray(saved?.clips)) {
    return saved.clips.filter((clip) => !clip.provisional && !clip.excluded).length;
  }
  if (Array.isArray(record?.candidates)) {
    return record.candidates.filter((candidate) => !candidate.provisional).length;
  }
  return 0;
}

function normalizeLiveMonitor(raw) {
  const status = VALID_LIVE_STATUSES.has(raw?.status) ? raw.status : 'off';
  const active = status === 'listening' || status === 'paused-loopback' || status === 'starting';
  const canToggle = raw?.canToggle !== undefined ? Boolean(raw.canToggle) : status !== 'unavailable';
  return Object.freeze({ status, active, canToggle });
}

function normalizeWatchDirectory(raw) {
  const basename = extractBasename(raw?.name);
  const name = basename || null;
  let status = VALID_WATCH_STATUSES.has(raw?.status) ? raw.status : (name ? 'watching' : 'unset');
  if (!name && status === 'watching') status = 'unset';
  const canChoose = raw?.canChoose !== undefined ? Boolean(raw.canChoose) : true;
  return Object.freeze({ status, name, canChoose });
}

function buildItem({
  id,
  recordId = null,
  rawName,
  recordedAtMs = null,
  durationSeconds = null,
  sizeBytes = null,
  rawStatus,
  alignment = null,
  processedUntil = 0,
  progressPercent = null,
  candidateCount = 0,
  exportedCount = 0,
  canReview = true,
  canAnalyze = true,
  canStop = true,
  canReanalyze = true,
  selected = false,
  isNew = false,
  intakeSource = null,
  orderIndex = 0,
}) {
  const status = projectRecordingStatus(rawStatus, alignment);
  const duration = Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : null;
  const size = Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null;
  const timestamp = Number.isFinite(recordedAtMs) && recordedAtMs > 0 ? recordedAtMs : null;

  let percent = 0;
  if (status === 'analyzing') {
    if (Number.isFinite(progressPercent)) {
      percent = clampPercent(progressPercent);
    } else if (duration && duration > 0 && Number.isFinite(processedUntil)) {
      percent = clampPercent((processedUntil / duration) * 100);
    }
  } else if (status === 'ready' || status === 'conformed-coarse') {
    percent = 100;
  }

  const actions = resolveRowActions(status, { canReview, canAnalyze, canStop, canReanalyze });

  return {
    orderIndex,
    item: Object.freeze({
      id: String(id),
      recordId: recordId != null ? String(recordId) : null,
      filename: extractBasename(rawName) || 'Untitled',
      recordedAtMs: timestamp,
      recordedTimeText: formatClockTime(timestamp),
      durationSeconds: duration,
      durationText: formatDuration(duration),
      sizeBytes: size,
      sizeText: formatFileSize(size),
      status,
      progressPercent: percent,
      candidateCount: Math.max(0, Math.floor(Number(candidateCount) || 0)),
      exportedCount: Math.max(0, Math.floor(Number(exportedCount) || 0)),
      primaryAction: actions.primaryAction,
      secondaryAction: actions.secondaryAction,
      canReview: Boolean(canReview),
      canAnalyze: Boolean(canAnalyze),
      canStop: Boolean(canStop),
      canReanalyze: Boolean(canReanalyze),
      selected: Boolean(selected),
      isNew: Boolean(isNew),
      intakeSource: intakeSource === 'auto' || intakeSource === 'manual' ? intakeSource : null,
    }),
  };
}

export function projectRecordingLibrary({
  sources = [],
  records = [],
  batches = [],
  items: directItems = null,
  activeSourceId = null,
  newIds = null,
  autoIngestedIds = null,
  manualImportedIds = null,
  sortOrder = 'newest-first',
  liveMonitor = null,
  watchDirectory = null,
} = {}) {
  const isNewId = (id) => (newIds instanceof Set ? newIds.has(id) : Array.isArray(newIds) ? newIds.includes(id) : false);
  const hasId = (collection, id) => (collection instanceof Set ? collection.has(id) : Array.isArray(collection) ? collection.includes(id) : false);
  const resolveIntakeSource = (id, rawSource, record) => {
    if (rawSource === 'auto' || rawSource === 'manual') return rawSource;
    if (record?.intakeSource === 'auto' || record?.intakeSource === 'manual') return record.intakeSource;
    if (hasId(autoIngestedIds, id)) return 'auto';
    if (hasId(manualImportedIds, id)) return 'manual';
    return null;
  };
  const projectedEntries = [];

  if (Array.isArray(directItems)) {
    directItems.forEach((raw, index) => {
      const id = raw.id ?? `item-${index}`;
      projectedEntries.push(buildItem({
        id,
        recordId: raw.recordId ?? null,
        rawName: raw.filename ?? raw.name ?? '',
        recordedAtMs: raw.recordedAtMs ?? raw.lastModified ?? null,
        durationSeconds: raw.durationSeconds ?? raw.duration ?? null,
        sizeBytes: raw.sizeBytes ?? raw.size ?? null,
        rawStatus: raw.status,
        alignment: raw.alignment ?? null,
        processedUntil: raw.processedUntil ?? 0,
        progressPercent: raw.progressPercent ?? null,
        candidateCount: raw.candidateCount ?? 0,
        exportedCount: raw.exportedCount ?? 0,
        canReview: raw.canReview !== undefined ? raw.canReview : true,
        canAnalyze: raw.canAnalyze !== undefined ? raw.canAnalyze : true,
        canStop: raw.canStop !== undefined ? raw.canStop : true,
        canReanalyze: raw.canReanalyze !== undefined ? raw.canReanalyze : true,
        selected: raw.selected !== undefined ? raw.selected : id === activeSourceId,
        isNew: raw.isNew !== undefined ? raw.isNew : isNewId(id),
        intakeSource: resolveIntakeSource(id, raw.intakeSource, null),
        orderIndex: index,
      }));
    });
  } else {
    const savedOutputs = countSavedOutputsBySource(batches);
    const recordsBySourceId = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      if (record?.sourceId) recordsBySourceId.set(record.sourceId, record);
    }

    let orderIndex = 0;
    for (const saved of Array.isArray(sources) ? sources : []) {
      const record = recordsBySourceId.get(saved.id) || null;
      const identity = saved.identity || record?.file || {};
      const rawStatus = record?.status || saved.analysis?.status || 'unanalyzed';
      const duration = saved.duration ?? record?.duration ?? null;
      const processedUntil = record?.processedUntil ?? saved.analysis?.processedUntil ?? 0;

      projectedEntries.push(buildItem({
        id: saved.id,
        recordId: record?.id ?? null,
        rawName: identity.name ?? '',
        recordedAtMs: identity.lastModified ?? record?.file?.lastModified ?? null,
        durationSeconds: duration,
        sizeBytes: identity.size ?? record?.file?.size ?? null,
        rawStatus,
        alignment: record?.alignment ?? saved.alignment ?? null,
        processedUntil,
        candidateCount: countCandidates(saved, record),
        exportedCount: savedOutputs.get(saved.id) || 0,
        canReview: true,
        canAnalyze: Boolean(record),
        canStop: Boolean(record),
        canReanalyze: Boolean(record),
        selected: saved.id === activeSourceId,
        isNew: isNewId(saved.id),
        intakeSource: resolveIntakeSource(saved.id, saved.intakeSource, record),
        orderIndex: orderIndex++,
      }));
    }

    for (const record of Array.isArray(records) ? records : []) {
      if (!record || record.sourceId) continue;
      const key = `runtime:${record.id}`;
      const file = record.file || {};
      projectedEntries.push(buildItem({
        id: key,
        recordId: record.id,
        rawName: file.name ?? '',
        recordedAtMs: file.lastModified ?? null,
        durationSeconds: record.duration ?? null,
        sizeBytes: file.size ?? null,
        rawStatus: record.status || 'unanalyzed',
        alignment: record.alignment ?? null,
        processedUntil: record.processedUntil ?? 0,
        candidateCount: countCandidates(null, record),
        exportedCount: 0,
        canReview: false,
        canAnalyze: true,
        canStop: true,
        canReanalyze: true,
        selected: key === activeSourceId,
        isNew: isNewId(key),
        intakeSource: resolveIntakeSource(key, null, record),
        orderIndex: orderIndex++,
      }));
    }
  }

  if (sortOrder === 'newest-first') {
    projectedEntries.sort((a, b) => {
      const ta = a.item.recordedAtMs ?? -1;
      const tb = b.item.recordedAtMs ?? -1;
      if (tb !== ta) return tb - ta;
      return b.orderIndex - a.orderIndex;
    });
  }

  const items = Object.freeze(projectedEntries.map((entry) => entry.item));
  const counts = Object.freeze({
    total: items.length,
    ready: items.filter((item) => item.status === 'ready').length,
    coarse: items.filter((item) => item.status === 'conformed-coarse').length,
    analyzing: items.filter((item) => item.status === 'analyzing').length,
    unanalyzed: items.filter((item) => item.status === 'unanalyzed').length,
  });

  return Object.freeze({
    items,
    counts,
    liveMonitor: normalizeLiveMonitor(liveMonitor),
    watchDirectory: normalizeWatchDirectory(watchDirectory),
  });
}
