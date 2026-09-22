import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  MAX_MESSAGE_BYTES,
  MAX_PROCESS_BUFFER,
  VERSION,
  canonicalRoot,
  randomToken,
  relativeDisplay,
  resolveWithin,
  writeState,
  removeState
} from './common.mjs';
import { findOp, patchOp, readOp } from './ops.mjs';
import {
  PROTOCOL_VERSION,
  TOOL_DEFINITIONS,
  validateToolArguments,
  toolSuccess,
  toolFailure,
  taskFromSnapshot,
  parseTaskId,
  protocolError
} from './protocol.mjs';
import { listResources, readResource } from './resources.mjs';

const rootArg = process.argv[2] ?? process.cwd();
const root = canonicalRoot(rootArg);
const token = process.env.AGENT_BRIDGE_TOKEN || randomToken();
const shareToken = process.env.AGENT_BRIDGE_SHARE_TOKEN || randomToken();
const processes = new Map();
let nextSession = 1;
let shuttingDown = false;

function appendBuffer(record, chunk, stream) {
  const text = chunk.toString();
  record.output += text;
  record.events.push({ stream, text, at: Date.now() });
  if (Buffer.byteLength(record.output) > MAX_PROCESS_BUFFER) {
    const bytes = Buffer.from(record.output);
    record.output = bytes.subarray(bytes.length - MAX_PROCESS_BUFFER).toString();
    record.truncated = true;
  }
  notifyRecord(record);
}

function notifyRecord(record) {
  for (const resolve of record.waiters) resolve();
  record.waiters.clear();
}

function snapshot(record, from = 0) {
  return {
    session_id: record.id,
    task_id: `process:${record.id}`,
    running: record.running,
    exit_code: record.exitCode,
    signal: record.signal,
    pid: record.child.pid,
    cwd: relativeDisplay(root, record.cwd),
    output: record.output.slice(from),
    next_cursor: record.output.length,
    truncated: record.truncated
  };
}

function processSnapshots() {
  return [...processes.values()].map((record) => snapshot(record, record.output.length));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitForActivity(record, cursor, timeoutMs) {
  if (!record.running || record.output.length > cursor || timeoutMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      record.waiters.delete(finish);
      if (timer) clearTimeout(timer);
      resolve();
    };
    record.waiters.add(finish);
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    if (!record.running || record.output.length > cursor) finish();
  });
}

function waitForExit(record, timeoutMs = 1500) {
  if (!record.running) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => record.child.once('close', resolve)),
    sleep(timeoutMs)
  ]);
}

async function terminate(record, signal = 'SIGTERM') {
  if (!record.running) return;
  if (process.platform === 'win32' && record.child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(record.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('error', () => { try { record.child.kill(signal); } catch {} resolve(); });
      killer.once('close', resolve);
    });
  } else {
    try {
      if (record.child.pid) process.kill(-record.child.pid, signal);
      else record.child.kill(signal);
    } catch {
      try { record.child.kill(signal); } catch {}
    }
  }
  await waitForExit(record, 2500);
}

async function execOp(args = {}) {
  const command = String(args.command ?? '');
  if (!command) throw protocolError('INVALID_ARGUMENT', 'command is required');
  const cwd = resolveWithin(root, args.cwd ?? '.');
  if (!fs.statSync(cwd).isDirectory()) throw protocolError('INVALID_ARGUMENT', 'cwd must be a directory');

  const id = nextSession++;
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: { ...process.env, AGENT_BRIDGE_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const record = { id, child, cwd, output: '', events: [], waiters: new Set(), running: true, exitCode: null, signal: null, truncated: false };
  processes.set(id, record);
  child.stdout.on('data', (d) => appendBuffer(record, d, 'stdout'));
  child.stderr.on('data', (d) => appendBuffer(record, d, 'stderr'));
  child.on('error', (error) => appendBuffer(record, Buffer.from(`\n[spawn error] ${error.message}\n`), 'stderr'));
  child.on('close', (code, signal) => {
    record.running = false;
    record.exitCode = code;
    record.signal = signal;
    notifyRecord(record);
  });

  const yieldMs = Math.max(0, Math.min(30_000, Number(args.yield_ms ?? 1000)));
  await waitForActivity(record, 0, yieldMs);
  return snapshot(record, 0);
}

async function writeStdinOp(args = {}) {
  const id = Number(args.session_id);
  const record = processes.get(id);
  if (!record) throw protocolError('TASK_NOT_FOUND', `Unknown session_id: ${args.session_id}`);
  const cursor = Math.max(0, Math.min(record.output.length, Number(args.cursor ?? 0)));

  if (args.chars !== undefined) {
    if (!record.running) throw protocolError('TASK_COMPLETED', 'Process has already exited');
    record.child.stdin.write(String(args.chars));
  }

  const yieldMs = Math.max(0, Math.min(30_000, Number(args.yield_ms ?? 250)));
  await waitForActivity(record, cursor, yieldMs);
  return snapshot(record, cursor);
}

async function killOp(args = {}) {
  const id = Number(args.session_id);
  const record = processes.get(id);
  if (!record) throw protocolError('TASK_NOT_FOUND', `Unknown session_id: ${args.session_id}`);
  await terminate(record, args.signal || 'SIGTERM');
  return { session_id: id, task_id: `process:${id}`, signalled: true, running: record.running };
}

async function callPrimitive(name, args = {}) {
  switch (name) {
    case 'read': return readOp(root, args);
    case 'find': return findOp(root, args);
    case 'apply_patch': return patchOp(root, args);
    case 'exec_command': return execOp(args);
    case 'write_stdin': return writeStdinOp(args);
    case 'processes': return processSnapshots();
    case 'kill': return killOp(args);
    default: throw protocolError('TOOL_NOT_FOUND', `Unknown tool: ${name}`);
  }
}

function initialize(remote) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: 'COS+ Agent Bridge', version: VERSION },
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      tasks: { list: true, get: true, cancel: true, progress: true }
    },
    workspace: { name: path.basename(root), ...(remote ? {} : { root }) },
    transport: remote ? 'https' : 'local'
  };
}

async function toolCall(args = {}) {
  const name = String(args.name ?? '');
  const input = args.arguments ?? {};
  try {
    validateToolArguments(name, input);
    return toolSuccess(name, await callPrimitive(name, input));
  } catch (error) {
    return toolFailure(name || 'unknown', error);
  }
}

async function taskGet(args = {}) {
  const sessionId = parseTaskId(args.task_id);
  const record = processes.get(sessionId);
  if (!record) throw protocolError('TASK_NOT_FOUND', `Unknown task: ${args.task_id}`);
  const cursor = Math.max(0, Math.min(record.output.length, Number(args.cursor ?? record.output.length)));
  const yieldMs = Math.max(0, Math.min(30_000, Number(args.yield_ms ?? 0)));
  await waitForActivity(record, cursor, yieldMs);
  return taskFromSnapshot(snapshot(record, cursor));
}

async function taskCancel(args = {}) {
  const sessionId = parseTaskId(args.task_id);
  const record = processes.get(sessionId);
  if (!record) throw protocolError('TASK_NOT_FOUND', `Unknown task: ${args.task_id}`);
  await terminate(record, args.signal || 'SIGTERM');
  return taskFromSnapshot(snapshot(record, record.output.length));
}

async function dispatch(req, { remote = false } = {}) {
  switch (req.action) {
    case 'ping': return remote
      ? { version: VERSION, protocolVersion: PROTOCOL_VERSION, workspace: path.basename(root) }
      : { version: VERSION, protocolVersion: PROTOCOL_VERSION, pid: process.pid, root };
    case 'initialize': return initialize(remote);
    case 'capabilities': return {
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      ...(remote ? { workspace: path.basename(root) } : { root }),
      actions: TOOL_DEFINITIONS.map((tool) => tool.name),
      protocolActions: ['initialize', 'tools_list', 'tools_call', 'resources_list', 'resources_read', 'tasks_list', 'tasks_get', 'tasks_cancel']
    };
    case 'tools_list': return { tools: TOOL_DEFINITIONS };
    case 'tools_call': return toolCall(req.args);
    case 'resources_list': return listResources();
    case 'resources_read': return readResource(root, req.args?.uri, { processSnapshots });
    case 'tasks_list': return { tasks: processSnapshots().map(taskFromSnapshot) };
    case 'tasks_get': return taskGet(req.args);
    case 'tasks_cancel': return taskCancel(req.args);
    case 'read':
    case 'find':
    case 'apply_patch':
    case 'exec_command':
    case 'write_stdin':
    case 'processes':
    case 'kill': return callPrimitive(req.action, req.args);
    case 'shutdown':
      if (remote) throw protocolError('PERMISSION_DENIED', 'shutdown is local-only');
      setTimeout(() => { void shutdown(); }, 25).unref?.();
      return { shutting_down: true };
    default: throw protocolError('METHOD_NOT_FOUND', `Unknown action: ${req.action}`);
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

function authorized(req) {
  const header = req.headers.authorization || '';
  return header === `Bearer ${shareToken}`;
}

const httpServer = http.createServer((req, res) => {
  if (!authorized(req)) {
    sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/health') {
    sendJson(res, 200, { ok: true, result: { version: VERSION, protocolVersion: PROTOCOL_VERSION, workspace: path.basename(root) } });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/call') {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    return;
  }

  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_MESSAGE_BYTES) {
      req.destroy(new Error('Request too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if (size > MAX_MESSAGE_BYTES) {
      if (!res.headersSent) sendJson(res, 413, { ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'Request too large' } });
      return;
    }
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await dispatch(payload, { remote: true });
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: error?.code || 'PROTOCOL_ERROR', message: error instanceof Error ? error.message : String(error), ...(error?.data !== undefined ? { data: error.data } : {}) } });
    }
  });
  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid request' } });
  });
});

const localServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', async (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
      socket.end(JSON.stringify({ ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'Request too large' } }) + '\n');
      return;
    }
    const idx = buffer.indexOf('\n');
    if (idx < 0) return;
    const line = buffer.slice(0, idx);
    buffer = '';
    try {
      const req = JSON.parse(line);
      if (req.token !== token) throw protocolError('UNAUTHORIZED', 'Unauthorized');
      const result = await dispatch(req);
      socket.end(JSON.stringify({ ok: true, result }) + '\n');
    } catch (error) {
      socket.end(JSON.stringify({ ok: false, error: { code: error?.code || 'PROTOCOL_ERROR', message: error instanceof Error ? error.message : String(error) } }) + '\n');
    }
  });
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind local server');
  return address.port;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...processes.values()].map((record) => terminate(record).catch(() => {})));
  removeState();
  await Promise.all([
    new Promise((resolve) => localServer.close(resolve)),
    new Promise((resolve) => httpServer.close(resolve))
  ]);
  process.exit(0);
}

const [port, httpPort] = await Promise.all([listen(localServer), listen(httpServer)]);
writeState({
  version: VERSION,
  protocol_version: PROTOCOL_VERSION,
  pid: process.pid,
  port,
  http_port: httpPort,
  token,
  share_token: shareToken,
  root,
  started_at: new Date().toISOString()
});

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('exit', removeState);
