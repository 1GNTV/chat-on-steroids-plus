import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  BIN_DIR,
  STATE_DIR,
  TUNNEL_LOG,
  encodeConnection,
  ensureStateDir,
  readShareState,
  removeShareState,
  writeShareState
} from './common.mjs';

const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function systemCloudflared() {
  const explicit = process.env.CLOUDFLARED_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const result = spawnSync('cloudflared', ['--version'], { windowsHide: true, stdio: 'ignore' });
  if (result.status === 0) return 'cloudflared';
  return null;
}

function releaseAsset() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64') return { name: 'cloudflared-windows-amd64.exe', archive: false, exe: true };
  if (platform === 'linux' && arch === 'x64') return { name: 'cloudflared-linux-amd64', archive: false };
  if (platform === 'linux' && arch === 'arm64') return { name: 'cloudflared-linux-arm64', archive: false };
  if (platform === 'darwin' && arch === 'x64') return { name: 'cloudflared-darwin-amd64.tgz', archive: true };
  if (platform === 'darwin' && arch === 'arm64') return { name: 'cloudflared-darwin-arm64.tgz', archive: true };
  throw new Error(`Automatic cloudflared install is not available for ${platform}/${arch}. Install cloudflared manually and put it on PATH.`);
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target, bytes, { mode: 0o700 });
}

export async function ensureCloudflared() {
  const system = systemCloudflared();
  if (system) return system;

  ensureStateDir();
  const asset = releaseAsset();
  const finalPath = path.join(BIN_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(finalPath)) return finalPath;

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`;
  const tmp = path.join(BIN_DIR, `${asset.name}.${process.pid}.tmp`);
  await download(url, tmp);

  if (asset.archive) {
    const extractDir = path.join(BIN_DIR, `extract-${process.pid}`);
    fs.mkdirSync(extractDir, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', tmp, '-C', extractDir], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`Unable to extract cloudflared: ${tar.stderr || tar.stdout}`);
    const extracted = path.join(extractDir, 'cloudflared');
    if (!fs.existsSync(extracted)) throw new Error('cloudflared archive did not contain the expected binary');
    fs.renameSync(extracted, finalPath);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tmp, { force: true });
  } else {
    fs.renameSync(tmp, finalPath);
  }
  if (process.platform !== 'win32') fs.chmodSync(finalPath, 0o700);
  return finalPath;
}

export function parseQuickTunnelUrl(text) {
  return QUICK_TUNNEL_RE.exec(text)?.[0] ?? null;
}

async function terminatePid(pid) {
  if (!processAlive(pid)) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      child.once('error', resolve);
      child.once('close', resolve);
    });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20 && processAlive(pid); i++) await sleep(50);
  if (processAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

export async function stopShare() {
  const state = readShareState();
  if (!state) return { stopped: false, reason: 'not_running' };
  await terminatePid(Number(state.pid));
  removeShareState();
  return { stopped: true };
}

export async function startShare(daemonState, { restart = false } = {}) {
  const existing = readShareState();
  if (existing && processAlive(Number(existing.pid)) && existing.daemon_pid === daemonState.pid && !restart) {
    return { ...existing, connection: encodeConnection({ url: existing.url, token: daemonState.share_token }) };
  }
  if (existing) await stopShare();

  const cloudflared = await ensureCloudflared();
  ensureStateDir();
  fs.writeFileSync(TUNNEL_LOG, '', { mode: 0o600 });
  const logFd = fs.openSync(TUNNEL_LOG, 'a');
  const isolatedHome = path.join(STATE_DIR, 'cloudflared-home');
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });

  const child = spawn(cloudflared, [
    'tunnel',
    '--no-autoupdate',
    '--url', `http://127.0.0.1:${daemonState.http_port}`
  ], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome
    }
  });
  child.unref();
  fs.closeSync(logFd);

  let url = null;
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    let log = '';
    try { log = fs.readFileSync(TUNNEL_LOG, 'utf8'); } catch {}
    url = parseQuickTunnelUrl(log);
    if (url) break;
    if (!processAlive(child.pid)) break;
  }
  if (!url) {
    await terminatePid(child.pid);
    let tail = '';
    try { tail = fs.readFileSync(TUNNEL_LOG, 'utf8').slice(-3000); } catch {}
    throw new Error(`Cloudflare Quick Tunnel did not become ready.${tail ? `\n${tail}` : ''}`);
  }

  const state = {
    pid: child.pid,
    daemon_pid: daemonState.pid,
    url,
    started_at: new Date().toISOString()
  };
  writeShareState(state);
  return { ...state, connection: encodeConnection({ url, token: daemonState.share_token }) };
}

export function shareStatus() {
  const state = readShareState();
  if (!state) return { running: false };
  return { ...state, running: processAlive(Number(state.pid)) };
}
