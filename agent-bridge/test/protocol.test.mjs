import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { call, startDaemon, stopDaemon } from '../src/client.mjs';

let root;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-v3-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'x@y.z'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log("hello")\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name:'demo',scripts:{test:'echo ok'}},null,2));
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: root });
  await startDaemon(root, { restart: true });
});
after(async () => { await stopDaemon().catch(()=>{}); fs.rmSync(root,{recursive:true,force:true}); });

test('initialize exposes MCP-like capabilities', async () => {
  const init = await call('initialize', {});
  assert.match(init.protocolVersion, /^cosplus-/);
  assert.equal(init.capabilities.tools.listChanged, false);
  assert.equal(init.capabilities.tasks.cancel, true);
});

test('tools_list includes JSON schemas', async () => {
  const list = await call('tools_list', {});
  const read = list.tools.find(t=>t.name==='read');
  assert.equal(read.inputSchema.type,'object');
  assert.deepEqual(read.inputSchema.required,['path']);
});

test('tools_call returns typed result and typed error', async () => {
  const ok = await call('tools_call',{name:'read',arguments:{path:'src/a.js'}});
  assert.equal(ok.isError,false);
  assert.equal(ok.content[0].type,'text');
  const bad = await call('tools_call',{name:'read',arguments:{}});
  assert.equal(bad.isError,true);
  assert.equal(bad.error.code,'INVALID_ARGUMENT');
});

test('resources expose tree and workspace files', async () => {
  const list = await call('resources_list',{});
  assert.ok(list.resources.some(r=>r.uri==='resource://workspace/tree'));
  const file = await call('resources_read',{uri:'resource://workspace/src%2Fa.js'});
  assert.match(file.contents[0].text,/hello/);
});

test('process sessions are tasks and can be cancelled', async () => {
  const tool = await call('tools_call',{name:'exec_command',arguments:{command:'node -e "setTimeout(()=>{},10000)"',yield_ms:10}});
  assert.equal(tool.isError,false);
  const taskId=tool.structuredContent.task_id;
  assert.match(taskId,/^process:/);
  const task=await call('tasks_get',{task_id:taskId});
  assert.equal(task.status,'running');
  const cancelled=await call('tasks_cancel',{task_id:taskId});
  assert.notEqual(cancelled.status,'running');
});
