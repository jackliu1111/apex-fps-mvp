// One policy for submission estimates, cache limits and actual browser encoding.
export const MAX_EXPORT_MEMORY_BYTES = 64 * 1024 * 1024;
export const MAX_REUSABLE_ARTIFACTS = 128;
export const DEFAULT_EXPORT_SETTINGS = Object.freeze({ format: 'mp4', videoCodec: 'avc', audioCodec: 'aac', width: null, height: null, videoBitrate: null, audioBitrate: 192000 });

export function exportSettings(requested = {}) {
  const format = requested.format ?? DEFAULT_EXPORT_SETTINGS.format;
  const codecs = { mp4: { videoCodec: 'avc', audioCodec: 'aac', audioBitrate: 192000 }, webm: { videoCodec: 'vp8', audioCodec: 'opus', audioBitrate: 96000 } }[format];
  if (!codecs) throw new Error('不支持该输出格式');
  const settings = Object.fromEntries(Object.entries({ ...DEFAULT_EXPORT_SETTINGS, ...codecs, format }).map(([key, value]) => [key, requested[key] ?? value]));
  if (settings.videoCodec !== codecs.videoCodec || settings.audioCodec !== codecs.audioCodec) throw new Error('不支持该输出格式或编码');
  for (const key of ['width', 'height', 'videoBitrate', 'audioBitrate']) if (!(settings[key] === null && key !== 'audioBitrate') && (!Number.isFinite(settings[key]) || settings[key] <= 0)) throw new Error('输出尺寸或码率无效');
  return settings;
}

// Budget generously for high-motion footage. This is an encoding target, not
// a claim of source quality or an upper bound on the encoded file size.
export function sourceExportSettings(requested, video) {
  const settings = exportSettings(requested);
  const width = settings.width ?? video.displayWidth;
  const height = settings.height ?? video.displayHeight;
  return exportSettings({ ...settings, width, height,
    videoBitrate: settings.videoBitrate ?? Math.max(2000000, Math.ceil(width * height * 0.15 * 60)) });
}
