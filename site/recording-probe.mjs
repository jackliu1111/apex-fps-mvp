import { createMediaReadSource } from './media-read-source.mjs';

// Matroska element IDs retain the VINT marker; sizes omit it and may be all ones (unknown).
function readVint(bytes, offset, isId) {
  const first = bytes[offset];
  if (!first) return null;
  const width = Math.clz32(first) - 23;
  if ((isId && width > 4) || offset + width > bytes.length) return null;
  const mask = 0xff >> width;
  let value = isId ? first : first & mask;
  let unknown = !isId && value === mask;
  for (let i = 1; i < width; i++) {
    const byte = bytes[offset + i];
    value = value * 256 + byte;
    unknown = unknown && byte === 0xff;
  }
  return { value: unknown ? Infinity : value, next: offset + width };
}

function readElement(bytes, offset) {
  const id = readVint(bytes, offset, true);
  if (!id) return null;
  const size = readVint(bytes, id.next, false);
  return size && { id: id.value, data: size.next, end: size.next + size.value };
}

async function awaitingMatroskaTrailer(file) {
  // Inspect only the front matter. Other writers and valid streaming MKVs use the normal media probe.
  const bytes = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const header = readElement(bytes, 0);
  if (header?.id !== 0x1a45dfa3) return false;
  const segment = readElement(bytes, header.end);
  if (segment?.id !== 0x18538067) return false;
  if (segment.end !== Infinity) return segment.end > file.size;

  // Seekable FFmpeg/OBS reserves a Void for the SeekHead and another for the 11-byte
  // Duration element. Its trailer backpatches them in place. Packet payloads can contain
  // the same byte sequences, so only inspect direct children of Segment and Segment Info.
  const seekReservation = readElement(bytes, segment.data);
  if (seekReservation?.id !== 0xec || seekReservation.end - segment.data !== 161) return false;
  const info = readElement(bytes, seekReservation.end);
  if (info?.id !== 0x1549a966 || info.end > bytes.length) return false;
  let lavf = false;
  let reservedCrc = false;
  let reservedDuration = false;
  for (let at = info.data; at < info.end;) {
    const child = readElement(bytes, at);
    if (!child || child.end > info.end) return false;
    if (child.id === 0x4d80) { // MuxingApp
      lavf = new TextDecoder().decode(bytes.subarray(child.data, child.end)).startsWith('Lavf');
    }
    if (child.id === 0xec) {
      // Some Lavf inputs declare their duration in advance but still reserve the initial CRC-32 slot.
      if (at === info.data && child.end - at === 6 && child.end - child.data === 4) reservedCrc = true;
      if (child.end === info.end && child.end - at === 11 && child.data - at === 9) reservedDuration = true;
    }
    at = child.end;
  }
  return lavf && (reservedCrc || reservedDuration);
}

const ISO_BMFF_INITIAL_BOXES = new Set(['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov']);
const MAX_TOP_LEVEL_BOXES = 64;

function readIsoBoxHeader(bytes, offset, fileSize) {
  if (bytes.length < 8) return { truncated: true };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(0, false);
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  let headerSize = 8;
  let boxSize = size32;
  if (size32 === 1) {
    if (bytes.length < 16) return { truncated: true };
    const hi = view.getUint32(8, false);
    const lo = view.getUint32(12, false);
    boxSize = hi * 0x100000000 + lo;
    headerSize = 16;
  } else if (size32 === 0) {
    boxSize = fileSize - offset;
  }
  if (!Number.isFinite(boxSize) || boxSize < headerSize) return { invalid: true };
  return { type, headerSize, boxSize, end: offset + boxSize };
}

async function awaitingMp4Trailer(file) {
  if (typeof file.slice !== 'function') return false;
  if (file.size === 0) return true;
  let offset = 0;
  let seenMoov = false;
  let seenFtyp = false;
  let seenEmptyMdat = false;
  let boxCount = 0;
  while (offset < file.size && boxCount < MAX_TOP_LEVEL_BOXES) {
    const headerBytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + 16)).arrayBuffer());
    const box = readIsoBoxHeader(headerBytes, offset, file.size);
    if (box.truncated) return boxCount > 0;
    if (box.invalid) return seenFtyp && seenEmptyMdat && !seenMoov;
    if (boxCount === 0 && !ISO_BMFF_INITIAL_BOXES.has(box.type)) return false;
    if (box.end > file.size) return true;
    if (box.type === 'ftyp') seenFtyp = true;
    if (box.type === 'mdat' && box.boxSize === box.headerSize) seenEmptyMdat = true;
    if (box.type === 'moov') seenMoov = true;
    offset = box.end;
    boxCount++;
  }
  return !seenMoov;
}

export async function probeRecordingFile(file, MB) {
  const lower = (file.name || '').toLowerCase();
  if (lower.endsWith('.mkv') && await awaitingMatroskaTrailer(file)) {
    return { pendingFinalization: true };
  }
  if ((lower.endsWith('.mp4') || lower.endsWith('.mov')) && await awaitingMp4Trailer(file)) {
    return { pendingFinalization: true };
  }
  const input = new MB.Input({ source: createMediaReadSource({ MB, file, priority: 'analysis' }), formats: MB.ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('无视频轨');
    const origin = Math.max(0, await video.getFirstTimestamp());
    const duration = await video.computeDuration() - origin;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无效视频时长');
    return { duration, origin, width: video.displayWidth, height: video.displayHeight };
  } finally {
    input.dispose();
  }
}
