const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { WorkerClient } = require('../worker-client.cjs');
const root = path.resolve(__dirname, '../..');
async function fixture(events = [[2, 2.4, 0], [14, 14.4, 1]], options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ipc-'));
  const python = process.env.APEX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const ffmpeg = process.env.APEX_FFMPEG || 'ffmpeg';
  const ffprobe = process.env.APEX_FFPROBE || 'ffprobe';
  const video = path.join(directory, '中文 录像.mp4');
  const encoded = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i',
    'testsrc2=size=96x64:rate=10:duration=24', '-f', 'lavfi', '-i', 'sine=sample_rate=16000:duration=24',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0', '-c:a', 'aac', '-output_ts_offset', '3', video]);
  if (encoded.status !== 0) throw new Error(encoded.stderr.toString());
  const spec = path.join(directory, 'predictions.json');
  const { serviceFfmpeg = ffmpeg, ...predictions } = options;
  fs.writeFileSync(spec, JSON.stringify({ events, ...predictions }));
  const runner = path.join(directory, 'worker.py');
  fs.writeFileSync(runner, `import sys\nsys.path.insert(0, ${JSON.stringify(root)})\nfrom model_service import ModelService\nfrom model_ipc import serve\nservice = ModelService(data_dir=${JSON.stringify(path.join(directory, 'data'))}, ffmpeg=${JSON.stringify(serviceFfmpeg)}, ffprobe=${JSON.stringify(ffprobe)}, model_command=[sys.executable, ${JSON.stringify(path.join(root, 'tests/fixtures/model_worker.py'))}, ${JSON.stringify(spec)}])\nserve(service, sys.stdin, sys.stdout)\n`);
  const client = new WorkerClient({ command: python, args: [runner] });
  const execute = (operation, payload) => client.execute(operation, payload);
  const wait = async submitted => {
    for (let count = 0; count < 500; count++) {
      const task = await execute('get_task', submitted);
      if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('task did not finish');
  };
  const analyze = async () => {
    const media = await execute('probe_media', { path: video });
    await execute('confirm_audio', { media_id: media.media_id, stream_index: 1 });
    const task = await wait(await execute('analyze', { media_id: media.media_id }));
    if (task.status !== 'completed') throw new Error(JSON.stringify(task));
    return execute('get_result', { result_id: task.result_id });
  };
  return { directory, video, client, execute, wait, analyze,
    close: async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
module.exports = { fixture };
