/** Throwaway benchmark adapter. Reuses production media renderer unchanged. */
import { probe, renderClip, runMedia, toolsPath } from '../typescript/src/media';
import { join } from 'node:path';
const request = await Bun.file(process.argv[2]).json();
const profile = process.argv[3];
const media = await probe(request.source, request.toolsDir);
if (profile === 'precise') {
  const c = request.clips[0];
  const result = await renderClip(request.source, c, media, join(request.outputDir, 'highlight-precise.mp4'), request.toolsDir);
  await Bun.write(join(request.outputDir, 'precise-render.json'), JSON.stringify(result, null, 2));
} else {
  const parts: string[] = [];
  const renders: unknown[] = [];
  for (const c of request.clips) {
    const path = join(request.outputDir, `preview-${c.index}.mp4`);
    renders.push(await renderClip(request.source, c, media, path, request.toolsDir, undefined, true));
    parts.push(path);
  }
  const manifest = join(request.outputDir, 'preview-concat.txt');
  await Bun.write(manifest, parts.map(p => `file '${p.split('/').at(-1)}'\n`).join(''));
  await runMedia(toolsPath(request.toolsDir, 'ffmpeg'), ['-nostdin','-v','error','-n','-f','concat','-safe','1','-i',manifest,'-c','copy','-movflags','+faststart',join(request.outputDir,'highlight-preview.mp4')]);
  for (const p of parts) await Bun.file(p).delete();
  await Bun.write(join(request.outputDir, 'preview-render.json'), JSON.stringify(renders, null, 2));
}
