// Optional bounded binary packet log: 24-byte little-endian records.
// float64 timestamp, float64 duration, uint32 payload bytes, uint32 key(1)/delta(0).
import { open } from 'node:fs/promises';
export async function packetTimeline(path) {
  if (!path) return null;
  const file = await open(path, 'wx');
  const buffer = Buffer.allocUnsafe(4096 * 24);
  let used = 0, bytes = 0, closing;
  async function flush() {
    let offset = 0;
    while (offset < used) {
      const { bytesWritten } = await file.write(buffer, offset, used - offset);
      if (!bytesWritten) throw Error('Zero-byte timeline write');
      offset += bytesWritten;
    }
    bytes += used; used = 0;
  }
  return {
    async add(packet) {
      buffer.writeDoubleLE(packet.timestamp, used);
      buffer.writeDoubleLE(packet.duration, used + 8);
      buffer.writeUInt32LE(packet.data.length, used + 16);
      buffer.writeUInt32LE(packet.type === 'key' ? 1 : 0, used + 20);
      used += 24;
      if (used === buffer.length) await flush();
    },
    close() {
      return closing ||= (async () => {
        try { await flush(); } finally { await file.close(); }
        return { path, bytes, recordBytes: 24, encoding: 'LE float64 timestamp, float64 duration, uint32 payloadBytes, uint32 isKey' };
      })();
    },
  };
}
