import fs from 'node:fs';
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
const processes = new Map();
let nextSession = 1;

function appendBuffer(record, chunk, stream) {
  const text = chunk.toString();
  record.output += text;
  record.events.push({ stream, text, at: Date.now() });
  if (Buffer.byteLength(record.output) > MAX_PROCESS_BUFFER) {
    const bytes = Buffer.from(record.output);
    record.output = bytes.subarray(bytes.length - MAX_PROCESS_BUFFER).toString();
    record.truncated = true;
  }
}

function snapshot(record, from = 0) {
  const output = record.output.slice(from);
  return {
    session_id: record.id,
    running: record.running,
    exit_code: record.exitCode,
    signal: record.signal,
    pid: record.child.pid,
    cwd: relativeDisplay(root, record.cwd),
    output,
    next_cursor: record.output.length,
    truncated: record.truncated
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
  const record = { id, child, cwd, output: '', events: [], running: true, exitCode: null, signal: null, truncated: false };
  processes.set(id, record);
  child.stdout.on('data', (d) => appendBuffer(record, d, 'stdout'));
  child.stderr.on('data', (d) => appendBuffer(record, d, 'stderr'));
  child.on('error', (error) => appendBuffer(record, Buffer.from(`\n[spawn error] ${error.message}\n`), 'stderr'));
  child.on('close', (code, signal) => { record.running = false; record.exitCode = code; record.signal = signal; });
  const yieldMs = Math.max(0, Math.min(30_000, Number(args.yield_ms ?? 1000)));
  if (yieldMs) await sleep(yieldMs);
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
  if (yieldMs) await sleep(yieldMs);
  return snapshot(record, cursor);
}

async function killOp(args = {}) {
  const id = Number(args.session_id);
  const record = processes.get(id);
  if (!record) throw new Error(`Unknown session_id: ${args.session_id}`);
  if (record.running) record.child.kill(args.signal || 'SIGTERM');
  return { session_id: id, signalled: true };
}

async function dispatch(req) {
  switch (req.action) {
    case 'ping': return { version: VERSION, pid: process.pid, root };
    case 'capabilities': return {
      version: VERSION,
      root,
      actions: ['read', 'find', 'apply_patch', 'exec_command', 'write_stdin', 'kill', 'processes']
    };
    case 'read': return readOp(root, req.args);
    case 'find': return findOp(root, req.args);
    case 'apply_patch': return patchOp(root, req.args);
    case 'exec_command': return execOp(req.args);
    case 'write_stdin': return writeStdinOp(req.args);
    case 'kill': return killOp(req.args);
    case 'processes': return [...processes.values()].map((r) => snapshot(r, r.output.length));
    case 'shutdown': setTimeout(() => process.exit(0), 50); return { shutting_down: true };
    default: throw new Error(`Unknown action: ${req.action}`);
  }
}

const server = net.createServer((socket) => {
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

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind daemon');
  writeState({ version: VERSION, pid: process.pid, port: address.port, token, root, started_at: new Date().toISOString() });
});

function shutdown() {
  for (const record of processes.values()) if (record.running) record.child.kill('SIGTERM');
  removeState();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', removeState);
