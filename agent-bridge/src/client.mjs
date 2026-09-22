import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_LOG, STATE_FILE, ensureStateDir, readState, removeState, canonicalRoot } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(here, 'daemon.mjs');

function requestRaw(state, payload, timeoutMs = 35_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(state.port, '127.0.0.1');
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Daemon request timed out')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ ...payload, token: state.token }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try { resolve(JSON.parse(buffer.slice(0, idx))); } catch (error) { reject(error); }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function ping(state) {
  try {
    const res = await requestRaw(state, { action: 'ping', args: {} }, 1000);
    return Boolean(res?.ok);
  } catch { return false; }
}

async function waitUntilStopped(state, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await ping(state))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await ping(state));
}

export async function startDaemon(rootInput = process.cwd(), { restart = false } = {}) {
  const root = canonicalRoot(rootInput);
  const existing = readState();
  if (existing && await ping(existing)) {
    const compatible = existing.root === root && existing.http_port && existing.share_token;
    if (compatible && !restart) return existing;
    try { await requestRaw(existing, { action: 'shutdown', args: {} }, 1500); } catch {}
    await waitUntilStopped(existing, 3000);
  }
  removeState();
  ensureStateDir();
  const fd = fs.openSync(DAEMON_LOG, 'a');
  const child = spawn(process.execPath, [daemonPath, root], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd]
  });
  child.unref();
  fs.closeSync(fd);

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const state = readState();
    if (state && state.pid === child.pid && state.http_port && state.share_token && await ping(state)) return state;
  }
  throw new Error(`Daemon did not start. See ${DAEMON_LOG}`);
}

export async function ensureDaemon(root = null) {
  const state = readState();
  if (state && state.http_port && state.share_token && await ping(state)) {
    if (root === null || canonicalRoot(root) === state.root) return state;
  }
  return startDaemon(root ?? process.cwd());
}

export async function call(action, args = {}, options = {}) {
  const state = options.state ?? await ensureDaemon(options.root ?? null);
  const res = await requestRaw(state, { action, args });
  if (!res.ok) throw new Error(res.error || 'Unknown daemon error');
  return res.result;
}

export async function stopDaemon() {
  const state = readState();
  if (!state) return { stopped: false, reason: 'not_running' };
  if (!(await ping(state))) { removeState(); return { stopped: false, reason: 'stale_state' }; }
  const res = await requestRaw(state, { action: 'shutdown', args: {} }, 1500);
  if (!(await waitUntilStopped(state, 3000))) throw new Error('Daemon did not stop cleanly');
  removeState();
  return { stopped: true, result: res.result };
}

export { STATE_FILE };
