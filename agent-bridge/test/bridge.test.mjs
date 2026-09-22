import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { call, startDaemon, stopDaemon } from '../src/client.mjs';
import { encodeConnection, readState } from '../src/common.mjs';
import { parseQuickTunnelUrl } from '../src/share.mjs';

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
  const started = await call('exec_command', { command: cmd, yield_ms: 1000 });
  assert.equal(typeof started.session_id, 'number');
  assert.match(started.output, /first/);

  const later = await call('write_stdin', {
    session_id: started.session_id,
    cursor: started.next_cursor,
    yield_ms: 1000
  });
  assert.match(later.output, /second/);
  if (later.running) await call('kill', { session_id: started.session_id });
});

test('filesystem escape is refused', async () => {
  await assert.rejects(() => call('read', { path: '..' }), /escapes workspace root|Not found/);
});

test('remote HTTP surface authenticates and hides absolute root', async () => {
  const state = readState();
  const endpoint = `http://127.0.0.1:${state.http_port}/v1/call`;
  const unauthorized = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'capabilities', args: {} })
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.share_token}`
    },
    body: JSON.stringify({ action: 'capabilities', args: {} })
  });
  const body = await authorized.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.workspace, path.basename(root));
  assert.equal('root' in body.result, false);
});

test('connection bundle is compact and does not expose token as plain query text', () => {
  const bundle = encodeConnection({ url: 'https://tiny-example.trycloudflare.com', token: 'secret-value' });
  assert.match(bundle, /^cosplus:\/\/v1\/[A-Za-z0-9_-]+$/);
  assert.equal(bundle.includes('secret-value'), false);
});

test('Quick Tunnel URL parser finds Cloudflare URL', () => {
  const line = 'INF Your quick Tunnel has been created! Visit it at https://kind-bird-7.trycloudflare.com';
  assert.equal(parseQuickTunnelUrl(line), 'https://kind-bird-7.trycloudflare.com');
});
