import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { call, startDaemon, stopDaemon } from '../src/client.mjs';

let root;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'hello.txt'), 'one\ntwo\nthree\n');
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  await startDaemon(root, { restart: true });
});
after(async () => {
  await stopDaemon().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('read returns bounded numbered lines', async () => {
  const r = await call('read', { path: 'hello.txt', start_line: 2, end_line: 3 });
  assert.equal(r.content, '2\ttwo\n3\tthree');
});

test('find finds text', async () => {
  const r = await call('find', { query: 'two', path: '.' });
  assert.ok(r.matches.some((m) => m.path === 'hello.txt' && m.line === 2));
});

test('apply_patch changes a file', async () => {
  const patch = `diff --git a/hello.txt b/hello.txt\nindex 4cb29ea..cc3d5ed 100644\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n`;
  await call('apply_patch', { patch });
  assert.match(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), /TWO/);
});

test('exec session persists and can be polled', async () => {
  const cmd = process.platform === 'win32'
    ? `node -e "console.log('first'); setTimeout(()=>console.log('second'), 250); setTimeout(()=>{},500)"`
    : `node -e "console.log('first'); setTimeout(()=>console.log('second'), 250); setTimeout(()=>{},500)"`;
  const first = await call('exec_command', { command: cmd, yield_ms: 50 });
  assert.equal(typeof first.session_id, 'number');
  assert.match(first.output, /first/);
  const later = await call('write_stdin', { session_id: first.session_id, cursor: first.next_cursor, yield_ms: 350 });
  assert.match(later.output, /second/);
});

test('filesystem escape is refused', async () => {
  await assert.rejects(() => call('read', { path: '..' }), /escapes workspace root|Not found/);
});
