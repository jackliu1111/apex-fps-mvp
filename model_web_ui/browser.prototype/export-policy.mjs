// One policy for submission estimates, cache limits and actual browser encoding.
export const MAX_EXPORT_MEMORY_BYTES = 64 * 1024 * 1024;
export const MAX_REUSABLE_ARTIFACTS = 128;
export const DEFAULT_EXPORT_SETTINGS = Object.freeze({ format: 'webm', videoCodec: 'vp8', audioCodec: 'opus', width: 1280, height: 720, videoBitrate: 2000000, audioBitrate: 96000 });

export function exportSettings(requested = {}) {
  const settings = Object.fromEntries(Object.entries(DEFAULT_EXPORT_SETTINGS).map(([key, value]) => [key, requested[key] ?? value]));
  if (settings.format !== 'webm' || settings.videoCodec !== 'vp8' || settings.audioCodec !== 'opus') throw new Error('不支持该输出格式或编码');
  for (const key of ['width', 'height', 'videoBitrate', 'audioBitrate']) if (!Number.isFinite(settings[key]) || settings[key] <= 0) throw new Error('输出尺寸或码率无效');
  settings.width = Math.min(DEFAULT_EXPORT_SETTINGS.width, settings.width);
  settings.height = Math.min(DEFAULT_EXPORT_SETTINGS.height, settings.height);
  return settings;
}
