// Deterministic media for automated regression checks; never used by the product demo.
import * as MB from '/assets/vendor/mediabunny.mjs';

export async function createSyntheticFile({ duration = 12, frameRate = 12, sourceLabel } = {}) {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; const ctx = canvas.getContext('2d');
    const output = new MB.Output({ format: new MB.WebMOutputFormat(), target: new MB.BufferTarget() });
    const video = new MB.CanvasSource(canvas, { codec: 'vp8', bitrate: 600000 });
    const audio = new MB.AudioBufferSource({ codec: 'opus', bitrate: 64000 }), second = new MB.AudioBufferSource({ codec: 'opus', bitrate: 64000 });
    output.addVideoTrack(video, { frameRate }); output.addAudioTrack(audio, { name: '合成脉冲' }); output.addAudioTrack(second, { name: '440 Hz 对照' }); await output.start();
    const pulse = new AudioBuffer({ numberOfChannels: 1, length: 48000 * duration, sampleRate: 48000 }), tone = new AudioBuffer({ numberOfChannels: 1, length: 48000 * duration, sampleRate: 48000 });
    let seed = 12345;
    for (let i = 0; i < pulse.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; const t = i / 48000; pulse.getChannelData(0)[i] = t % 2 < 0.12 ? ((seed >>> 0) / 4294967296 - 0.5) * 0.6 * Math.exp(-30 * (t % 2)) : 0; tone.getChannelData(0)[i] = 0.08 * Math.sin(2 * Math.PI * 440 * t); }
    await audio.add(pulse); await second.add(tone);
    for (let i = 0; i < duration * frameRate; i++) { ctx.fillStyle = '#101b22'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = '#afedc9'; ctx.fillRect(30 + (i * 3) % 500, 240, 80, 10); ctx.font = '24px sans-serif'; ctx.fillText('BROWSER / SYNTHETIC SAMPLE', 30, 65); ctx.font = '64px monospace'; ctx.fillText(`${(i / frameRate).toFixed(2)} s`, 30, 165); if (sourceLabel) drawLabel(ctx, sourceLabel, i);
      await video.add(i / frameRate, 1 / frameRate); }
    video.close(); audio.close(); second.close(); await output.finalize();
  return new File([output.target.buffer], sourceLabel ? sourceLabel + '.webm' : 'browser-synthetic.webm', { type: 'video/webm', lastModified: 1793059200000 });
}

// Burn a human-readable label and a machine-readable source bit and frame number
// into the same video image. Sample cell centers to tolerate VP8 compression.
function drawLabel(ctx, source, frame) {
  if (!['A', 'B'].includes(source) || frame > 255) throw new RangeError('Use A/B and at most 256 frames');
  ctx.fillStyle = 'white';
  ctx.font = '32px monospace';
  ctx.fillText(source + ' / frame ' + frame, 30, 225);
  const bits = (source === 'B' ? 256 : 0) + frame;
  for (let index = 0; index < 9; index++) {
    ctx.fillStyle = bits & (1 << index) ? '#fff' : '#000';
    ctx.fillRect(32 + 32 * index, 280, 32, 32);
  }
}

export function readSyntheticFrame(canvas) {
  const ctx = canvas.getContext('2d');
  let bits = 0;
  for (let index = 0; index < 9; index++) {
    const x = (48 + 32 * index) * canvas.width / 640;
    const y = 296 * canvas.height / 360;
    if (ctx.getImageData(x, y, 1, 1).data[0] > 128) bits |= 1 << index;
  }
  return { source: bits & 256 ? 'B' : 'A', frame: bits & 255 };
}
