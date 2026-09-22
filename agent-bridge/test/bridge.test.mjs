import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { call, startDaemon, stopDaemon } from '../src/client.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await sleep(50);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
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
  const cmd = `node -e "console.log('first'); setTimeout(()=>console.log('second'), 250); setTimeout(()=>{},500)"`;
  const started = await call('exec_command', { command: cmd, yield_ms: 50 });
  assert.equal(typeof started.session_id, 'number');

  const first = /first/.test(started.output)
    ? started
    : await call('write_stdin', { session_id: started.session_id, cursor: 0, yield_ms: 1000 });
  assert.match(first.output, /first/);

  const later = await call('write_stdin', {
    session_id: started.session_id,
    cursor: first.next_cursor,
    yield_ms: 1000
  });
  assert.match(later.output, /second/);

  if (later.running) await call('kill', { session_id: started.session_id });
});

test('filesystem escape is refused', async () => {
  await assert.rejects(() => call('read', { path: '..' }), /escapes workspace root|Not found/);
});
