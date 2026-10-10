/* Public OS-shell entry point; external carrier fixture never starts a GUI/model. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const launcher = path.resolve(__dirname, '../handoff/desktop-verify-kit/run-mac.command');

function invoke(args) {
  return spawnSync('/bin/sh', [launcher, ...args], { encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin' } });
}

test('operator can read help without an app, source or developer runtime', () => {
  const result = invoke(['--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const option of ['--app', '--source', '--audio-stream', '--evidence', '--preflight']) {
    assert.ok(result.stdout.includes(option));
  }
  assert.ok(result.stdout.includes('bundled Electron'));
});

test('incomplete invocation is rejected before any carrier launch', () => {
  const result = invoke(['--source', '/not-a-recording.mkv']);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes('Required: --app --source --audio-stream --evidence'));
});

test('audio stream must be explicitly given as a nonnegative container index', () => {
  for (const stream of ['-1', '1.5', 'game']) {
    const result = invoke(['--app', '/fake.app', '--source', '/fake.mkv',
      '--audio-stream', stream, '--evidence', '/fake-evidence']);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('audio-stream must be a nonnegative integer'));
  }
});

test('quoted Chinese paths dispatch only to the chosen package carrier with preflight mode', () => {
  const fixture = fs.mkdtempSync('/private/tmp/apex-kit-cli-');
  try {
    const app = path.join(fixture, '中文 空格.app');
    const binary = path.join(app, 'Contents/MacOS/Apex Model Review');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$APEX_PACKAGED_APP" "$APEX_SAMPLE" "$APEX_SAMPLE_AUDIO_STREAM" "$APEX_VALIDATION_DIR" "$APEX_KIT_PREFLIGHT" "$1"\n');
    fs.chmodSync(binary, 0o755);
    const source = path.join(fixture, '真实 录像.mkv');
    fs.writeFileSync(source, 'external path-only carrier fixture');
    const evidence = path.join(fixture, '验收 记录'); fs.mkdirSync(evidence);
    const result = invoke(['--app', app, '--source', source, '--audio-stream', '1', '--evidence', evidence, '--preflight']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['1', app, source, '1', evidence, '1',
      path.resolve(__dirname, '../handoff/desktop-verify-kit/controller.cjs')]);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('operator can provide total and per-stage budgets for a long recording', () => {
  const fixture = fs.mkdtempSync('/private/tmp/apex-kit-budget-');
  try {
    const app = path.join(fixture, 'Budget.app');
    const binary = path.join(app, 'Contents/MacOS/Apex Model Review');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$APEX_KIT_STAGE_TIMEOUT_S" "$APEX_KIT_TOTAL_TIMEOUT_S"\n');
    fs.chmodSync(binary, 0o755);
    const source = path.join(fixture, 'source.mkv'); fs.writeFileSync(source, 'external carrier fixture');
    const evidence = path.join(fixture, 'evidence'); fs.mkdirSync(evidence);
    const result = invoke(['--app', app, '--source', source, '--audio-stream', '1', '--evidence', evidence,
      '--preflight', '--stage-timeout-s', '1200', '--total-timeout-s', '7200']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['1200', '7200']);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
