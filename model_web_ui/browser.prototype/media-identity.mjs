// Identity is intentionally bounded: hash metadata and three 64 KiB samples.
// It detects same-name replacements without scanning a multi-gigabyte recording.
// It is not a whole-file checksum: modifications outside samples with identical
// metadata cannot be detected. Never use this as a media-integrity guarantee.
export async function identifyFile(file) {
  const size = file.size;
  const sampleSize = 64 * 1024;
  const offsets = [...new Set([0, Math.max(0, Math.floor(size / 2) - sampleSize / 2), Math.max(0, size - sampleSize)])];
  const descriptor = { name: file.name, size, lastModified: file.lastModified };
  const header = new TextEncoder().encode(JSON.stringify({ version: 1, ...descriptor, offsets }));
  const samples = await Promise.all(offsets.map((offset) => file.slice(offset, Math.min(size, offset + sampleSize)).arrayBuffer()));
  const bytes = new Uint8Array(header.length + samples.reduce((sum, sample) => sum + sample.byteLength, 0));
  bytes.set(header);
  let position = header.length;
  for (const sample of samples) { bytes.set(new Uint8Array(sample), position); position += sample.byteLength; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const fingerprint = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { id: `source:${fingerprint}`, ...descriptor, fingerprint, fingerprintVersion: 'metadata-and-three-samples-v1' };
}
