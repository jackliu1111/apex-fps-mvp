const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkerClient } = require('../worker-client.cjs');
const root = path.resolve(__dirname, '../..');
const python = process.env.APEX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const ffmpeg = process.env.APEX_FFMPEG || 'ffmpeg';
const ffprobe = process.env.APEX_FFPROBE || 'ffprobe';

test('desktop IPC can query its persistent Python service using request IDs', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-desktop-'));
  const client = new WorkerClient({ command: python, args: [path.join(root, 'model_ipc.py'),
    '--data-dir', data, '--ffmpeg', ffmpeg, '--ffprobe', ffprobe] });
  try {
    const [first, second] = await Promise.all([client.execute('get_config', {}), client.execute('get_config', {})]);
    assert.equal(first.data_dir, fs.realpathSync(data));
    assert.equal(second.model_state, 'not_loaded');
  } finally { await client.close(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('worker death becomes a visible IPC failure and does not leave requests hanging', { timeout: 2000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-desktop-'));
  const client = new WorkerClient({ command: python, args: [path.join(root, 'model_ipc.py'),
    '--data-dir', data, '--ffmpeg', ffmpeg, '--ffprobe', ffprobe] });
  try {
    await client.execute('get_config', {});
    client.process.kill('SIGKILL');
    await new Promise(resolve => client.process.once('exit', resolve));
    await assert.rejects(client.execute('get_config', {}), { code: 'worker_unavailable' });
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});


test('desktop process may pass its parent PID and shutdown completes within a bound', { timeout: 3000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-desktop-'));
  const client = new WorkerClient({ command: python, args: [path.join(root, 'model_ipc.py'),
    '--parent-pid', String(process.pid), '--data-dir', data, '--ffmpeg', ffmpeg, '--ffprobe', ffprobe] });
  try { await client.execute('get_config', {}); await client.close(); }
  finally { if (client.process.exitCode === null && client.process.signalCode === null) client.process.kill(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('an unready Python process fails startup promptly instead of hanging the interface', { timeout: 2000 }, async () => {
  const client = new WorkerClient({ command: python, args: ['-c', 'import time; time.sleep(60)'], readyTimeoutMs: 100 });
  try { await assert.rejects(client.execute('get_config', {}), { code: 'worker_unavailable' }); }
  finally { client.process.kill('SIGKILL'); }
});

test('oversized IPC envelopes reject promptly and the next operation remains usable', { timeout: 2000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-desktop-'));
  const client = new WorkerClient({ command: python, args: [path.join(root, 'model_ipc.py'),
    '--data-dir', data, '--ffmpeg', ffmpeg, '--ffprobe', ffprobe] });
  const overlarge = client.execute('probe_media', { path: 'x'.repeat(70000) });
  try {
    const outcome = await Promise.race([overlarge.then(() => 'succeeded', error => error.code),
      new Promise(resolve => setTimeout(() => resolve('hung'), 300))]);
    assert.equal(outcome, 'request_too_large');
    assert.equal((await client.execute('get_config', {})).model_state, 'not_loaded');
  } finally { await client.close(); await overlarge.catch(() => {}); fs.rmSync(data, { recursive: true, force: true }); }
});
