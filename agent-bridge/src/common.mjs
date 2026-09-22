import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.3.0';
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_READ_BYTES = 512 * 1024;
export const MAX_PROCESS_BUFFER = 2 * 1024 * 1024;
export const STATE_DIR = path.join(os.homedir(), '.agent-bridge');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const SHARE_FILE = path.join(STATE_DIR, 'share.json');
export const DAEMON_LOG = path.join(STATE_DIR, 'daemon.log');
export const TUNNEL_LOG = path.join(STATE_DIR, 'tunnel.log');
export const BIN_DIR = path.join(STATE_DIR, 'bin');

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  ensureStateDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch {}
}

export function readState() { return readJson(STATE_FILE); }
export function writeState(state) { writeJson(STATE_FILE, state); }
export function removeState() { removeFile(STATE_FILE); }
export function readShareState() { return readJson(SHARE_FILE); }
export function writeShareState(state) { writeJson(SHARE_FILE, state); }
export function removeShareState() { removeFile(SHARE_FILE); }

export function canonicalRoot(input) {
  const resolved = fs.realpathSync(path.resolve(input));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${input}`);
  return resolved;
}

export function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

export function resolveWithin(root, requested, { allowMissing = false } = {}) {
  if (typeof requested !== 'string' || requested.length === 0) throw new Error('Path must be a non-empty string');
  if (requested.includes('\0')) throw new Error('Path contains a null byte');
  const candidate = path.resolve(root, requested);
  let checked = candidate;
  if (allowMissing && !fs.existsSync(checked)) {
    const tail = [];
    while (!fs.existsSync(checked)) {
      const parent = path.dirname(checked);
      if (parent === checked) throw new Error(`Cannot resolve path: ${requested}`);
      tail.unshift(path.basename(checked));
      checked = parent;
    }
    const realParent = fs.realpathSync(checked);
    const rebuilt = path.join(realParent, ...tail);
    if (!isWithin(root, rebuilt)) throw new Error(`Path escapes workspace root: ${requested}`);
    return rebuilt;
  }
  if (!fs.existsSync(candidate)) throw new Error(`Not found: ${requested}`);
  const real = fs.realpathSync(candidate);
  if (!isWithin(root, real)) throw new Error(`Path escapes workspace root: ${requested}`);
  return real;
}

export function relativeDisplay(root, target) {
  const rel = path.relative(root, target) || '.';
  return rel.split(path.sep).join('/');
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function encodeConnection({ url, token }) {
  const payload = Buffer.from(JSON.stringify({ v: 1, url, token }), 'utf8').toString('base64url');
  return `cosplus://v1/${payload}`;
}

export function json(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
