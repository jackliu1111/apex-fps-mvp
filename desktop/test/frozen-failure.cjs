/** Required native frozen failure evidence after guardian exit-status correction. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { WorkerClient } = require('../worker-client.cjs');
const root = path.resolve(__dirname, '../..');
const resources = path.join(root, 'desktop/resources');
const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'manifest.json')));
for (const [name, expected] of Object.entries(manifest.source_sha256)) {
  const actual = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
  assert.equal(actual, expected, `native build is stale: ${name}`);
}
const executable = path.join(resources, manifest.service);
const guardian = spawnSync(executable, ['--process-guardian', String(process.pid), '--', '/bin/sh', '-c', 'exit 7']);
assert.equal(guardian.status, 7, guardian.stderr.toString());
const directory = path.join(root, 'build/model-desktop/mac-arm64/frozen-real-smoke');
const oldResult = JSON.parse(fs.readFileSync(path.join(directory, 'result.json')));
const marker = path.join(directory, 'failed-media-path.txt');
const tool = path.join(directory, 'failing-ffmpeg');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(tool, `#!/bin/sh\nfor target in "$@"; do :; done\nprintf partial > "$target"\nprintf '%s' "$target" > ${quote(marker)}\nexit 7\n`);
fs.chmodSync(tool, 0o755);
const client = new WorkerClient({ command: executable, args: ['--data-dir', path.join(directory, 'data'),
  '--ffmpeg', tool, '--ffprobe', path.join(resources, manifest.ffprobe), '--model-workspace', path.join(resources, manifest.model_workspace),
  '--checkpoint', path.join(resources, manifest.checkpoint)] });
async function wait(submitted) {
  for (let i = 0; i < 200; i++) {
    const task = await client.execute('get_task', submitted);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('native media failure did not terminate');
}
async function run() {
  const result = await client.execute('get_result', { result_id: oldResult.result_id });
  const ref = { result_id: result.result_id, candidate_version: result.candidate_version };
  const candidate_id = result.candidates[0].candidate_id;
  await client.execute('update_selection', { ...ref, clips: [{ candidate_id, start_s: 1, end_s: 3 }] });
  const preview = await wait(await client.execute('request_preview', { ...ref, candidate_id }));
  assert.equal(preview.status, 'failed');
  assert.equal(preview.error.code, 'media_failed');
  assert.equal(fs.existsSync(fs.readFileSync(marker, 'utf8')), false, 'failed preview partial must be removed');
  const exported = await wait(await client.execute('export', { ...ref, output_dir: path.join(directory, 'failed-exports') }));
  assert.equal(exported.status, 'failed');
  assert.equal(exported.error.code, 'media_failed');
  assert.equal(exported.exports[0].path, null);
  assert.equal(fs.existsSync(fs.readFileSync(marker, 'utf8')), false, 'failed export partial must be removed');
  fs.writeFileSync(path.join(directory, 'frozen-failure.json'), JSON.stringify({ guardian_exit: guardian.status, preview, export: exported }, null, 2));
  console.log('PASS frozen guardian exit7, preview/export media_failed and partial cleanup');
}
run().then(async () => { await client.close(); }).catch(async error => { console.error(error); await client.close(); process.exitCode = 1; });
