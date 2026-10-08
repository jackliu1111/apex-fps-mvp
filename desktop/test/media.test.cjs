const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createProtocolHandler } = require('../protocol.cjs');
const { fixture } = require('./service-fixture.cjs');

test('desktop playback retrieves only registered current previews and supports byte seeking', async () => {
  const f = await fixture();
  try {
    const result = await f.analyze();
    const ref = { result_id: result.result_id, candidate_version: result.candidate_version };
    const candidate_id = result.candidates[0].candidate_id;
    const task = await f.wait(await f.execute('request_preview', { ...ref, candidate_id }));
    assert.equal(task.status, 'completed', JSON.stringify(task));
    const artifact = await f.execute('get_artifact', { artifact_id: task.preview_id });
    const handler = createProtocolHandler(f.client, { uiDir: '' });
    const response = await handler(new Request(`apex://artifact/${task.preview_id}`, { headers: { Range: 'bytes=0-7' } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes 0-7/${artifact.size}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(artifact.path).subarray(0, 8));
    await f.execute('update_selection', { ...ref, clips: [{ candidate_id, start_s: 1, end_s: 4 }] });
    const stale = await handler(new Request(`apex://artifact/${task.preview_id}`));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'stale_preview');
    assert.equal((await handler(new Request('apex://artifact/../../etc/passwd'))).status, 404);
  } finally { await f.close(); }
});

test('the local protocol rejects external schemes and embedded credentials', async () => {
  const f = await fixture();
  try {
    const handler = createProtocolHandler(f.client, { uiDir: require('node:path').resolve(__dirname, '../../model_web_ui') });
    for (const url of ['https://ui/index.html', 'apex://stranger@ui/index.html'])
      assert.equal((await handler({ url, method: 'GET', headers: new Headers() })).status, 404);
  } finally { await f.close(); }
});
