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
    try { record.child.kill(signal); } catch {}
  }
  await waitForExit(record);
}

async function execOp(args = {}) {
  const command = String(args.command ?? '');
  if (!command) throw new Error('command is required');
  const cwd = resolveWithin(root, args.cwd ?? '.');
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');

  const id = nextSession++;
  const child = spawn(command, {
    cwd,
    shell: true,
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
  if (!record) throw new Error(`Unknown session_id: ${args.session_id}`);
  const cursor = Math.max(0, Math.min(record.output.length, Number(args.cursor ?? 0)));

  if (args.chars !== undefined) {
    if (!record.running) throw new Error('Process has already exited');
    record.child.stdin.write(String(args.chars));
  }

  const yieldMs = Math.max(0, Math.min(30_000, Number(args.yield_ms ?? 250)));
  await waitForActivity(record, cursor, yieldMs);
  return snapshot(record, cursor);
}

async function killOp(args = {}) {
  const id = Number(args.session_id);
  const record = processes.get(id);
  if (!record) throw new Error(`Unknown session_id: ${args.session_id}`);
  await terminate(record, args.signal || 'SIGTERM');
  return { session_id: id, signalled: true, running: record.running };
}

async function dispatch(req, { remote = false } = {}) {
  switch (req.action) {
    case 'ping': return remote
      ? { version: VERSION, workspace: path.basename(root) }
      : { version: VERSION, pid: process.pid, root };
    case 'capabilities': return {
      version: VERSION,
      ...(remote ? { workspace: path.basename(root) } : { root }),
      actions: ['read', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'processes', 'kill']
    };
    case 'read': return readOp(root, req.args);
    case 'find': return findOp(root, req.args);
    case 'apply_patch': return patchOp(root, req.args);
    case 'exec_command': return execOp(req.args);
    case 'write_stdin': return writeStdinOp(req.args);
    case 'processes': return [...processes.values()].map((r) => snapshot(r, r.output.length));
    case 'kill': return killOp(req.args);
    case 'shutdown':
      if (remote) throw new Error('shutdown is local-only');
      setTimeout(() => { void shutdown(); }, 25).unref?.();
      return { shutting_down: true };
    default: throw new Error(`Unknown action: ${req.action}`);
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
    sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/health') {
    sendJson(res, 200, { ok: true, result: { version: VERSION, workspace: path.basename(root) } });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/call') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
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
      if (!res.headersSent) sendJson(res, 413, { ok: false, error: 'Request too large' });
      return;
    }
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await dispatch(payload, { remote: true });
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'Invalid request' });
  });
});

const localServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', async (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
      socket.end(JSON.stringify({ ok: false, error: 'Request too large' }) + '\n');
      return;
    }
    const idx = buffer.indexOf('\n');
    if (idx < 0) return;
    const line = buffer.slice(0, idx);
    buffer = '';
    try {
      const req = JSON.parse(line);
      if (req.token !== token) throw new Error('Unauthorized');
      const result = await dispatch(req);
      socket.end(JSON.stringify({ ok: true, result }) + '\n');
    } catch (error) {
      socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n');
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
