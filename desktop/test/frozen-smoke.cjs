/** Local native runtime evidence, separate from clean-machine platform acceptance. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WorkerClient } = require('../worker-client.cjs');
const root = path.resolve(__dirname, '../..');
const resources = path.join(root, 'desktop/resources');
const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'manifest.json')));
const directory = process.env.APEX_VALIDATION_DIR || path.join(root, 'build/model-desktop/mac-arm64/frozen-real-smoke');
fs.mkdirSync(directory, { recursive: true });
const log = fs.createWriteStream(path.join(directory, 'worker.log'));
const client = new WorkerClient({ command: path.join(resources, manifest.service), args: [
  '--data-dir', path.join(directory, 'data'), '--ffmpeg', path.join(resources, manifest.ffmpeg),
  '--ffprobe', path.join(resources, manifest.ffprobe), '--model-workspace', path.join(resources, manifest.model_workspace),
  '--checkpoint', path.join(resources, manifest.checkpoint)], onLog: message => log.write(message) });
const run = async () => {
  const media = await client.execute('probe_media', { path: process.env.APEX_SAMPLE || '/Users/jackliu/payload/sample-apex.mp4' });
  const requestedTrack = process.env.APEX_SAMPLE_AUDIO_STREAM;
  if (media.audio_tracks.length > 1 && requestedTrack === undefined) throw new Error('多音轨素材必须通过 APEX_SAMPLE_AUDIO_STREAM 明确指定游戏音轨');
  const stream_index = requestedTrack === undefined ? media.audio_tracks[0].stream_index : Number(requestedTrack);
  await client.execute('confirm_audio', { media_id: media.media_id, stream_index });
  const submitted = await client.execute('analyze', { media_id: media.media_id });
  let task;
  for (let i = 0; i < 2400; i++) {
    task = await client.execute('get_task', submitted);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fs.writeFileSync(path.join(directory, 'analysis-task.json'), JSON.stringify(task, null, 2));
  if (task.status !== 'completed') throw new Error(JSON.stringify(task));
  const result = await client.execute('get_result', { result_id: task.result_id });
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  const waitTask = async submitted => {
    for (let i = 0; i < 600; i++) {
      const task = await client.execute('get_task', submitted);
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('media task timed out');
  };
  const ref = { result_id: result.result_id, candidate_version: result.candidate_version };
  const artifacts = [];
  if (result.candidates.length) {
    const preview = await waitTask(await client.execute('request_preview', { ...ref, candidate_id: result.candidates[0].candidate_id }));
    if (preview.status !== 'completed') throw new Error(JSON.stringify(preview));
    fs.writeFileSync(path.join(directory, 'preview-task.json'), JSON.stringify(preview, null, 2));
    artifacts.push(await client.execute('get_artifact', { artifact_id: preview.preview_id }));
    const exported = await waitTask(await client.execute('export', { ...ref, output_dir: path.join(directory, 'exports'), mode: 'copy' }));
    fs.writeFileSync(path.join(directory, 'export-task.json'), JSON.stringify(exported, null, 2));
    if (exported.status !== 'completed') throw new Error(JSON.stringify(exported));
    artifacts.push(...exported.exports);
    for (const artifact of artifacts) {
      const decoded = spawnSync(path.join(resources, manifest.ffmpeg), ['-nostdin', '-v', 'error', '-xerror', '-i', artifact.path,
        '-map', '0:v', '-map', '0:a', '-f', 'null', '-'], { env: { ...process.env, PATH: '/nonexistent' } });
      if (decoded.status !== 0) throw new Error(decoded.stderr.toString());
    }
  }
  fs.writeFileSync(path.join(directory, 'decoded-artifacts.json'), JSON.stringify(artifacts, null, 2));
  console.log(JSON.stringify({ decodedArtifacts: artifacts.length, status: task.status, candidates: result.candidates.length, timings: task.timings, model: result.prediction.model }));
};
run().then(async () => { await client.close(); log.end(); }).catch(async error => {
  console.error(error); await client.close(); log.end(); process.exitCode = 1;
});
