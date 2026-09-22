import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MAX_READ_BYTES, clampInt, relativeDisplay, resolveWithin } from './common.mjs';
import { applyPatch } from './patch.mjs';

function isProbablyBinary(buffer) {
  const len = Math.min(buffer.length, 8192);
  for (let i = 0; i < len; i++) if (buffer[i] === 0) return true;
  return false;
}

export async function readOp(root, args = {}) {
  const requested = args.path ?? '.';
  const target = resolveWithin(root, requested);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 500).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }));
    return { path: relativeDisplay(root, target), type: 'directory', entries, truncated: fs.readdirSync(target).length > 500 };
  }
  if (!stat.isFile()) return { path: relativeDisplay(root, target), type: 'other', size: stat.size };

  const fd = fs.openSync(target, 'r');
  try {
    const sniffSize = Math.min(8192, stat.size);
    const sniff = Buffer.alloc(sniffSize);
    if (sniffSize) fs.readSync(fd, sniff, 0, sniffSize, 0);
    if (isProbablyBinary(sniff)) return { path: relativeDisplay(root, target), type: 'binary', size: stat.size };
  } finally {
    fs.closeSync(fd);
  }

  const maxBytes = clampInt(args.max_bytes, 1, MAX_READ_BYTES, 128 * 1024);
  const all = fs.readFileSync(target, 'utf8');
  const lines = all.split(/\r?\n/);
  const start = clampInt(args.start_line, 1, Math.max(1, lines.length), 1);
  const end = clampInt(args.end_line, start, lines.length, lines.length);
  let bytes = 0;
  const out = [];
  let last = start - 1;
  let truncated = false;
  for (let n = start; n <= end; n++) {
    const rendered = `${n}\t${lines[n - 1] ?? ''}`;
    const cost = Buffer.byteLength(rendered) + 1;
    if (out.length && bytes + cost > maxBytes) { truncated = true; break; }
    out.push(rendered);
    bytes += cost;
    last = n;
  }
  return {
    path: relativeDisplay(root, target),
    type: 'text',
    size: stat.size,
    start_line: start,
    end_line: last,
    total_lines: lines.length,
    truncated: truncated || last < end,
    content: out.join('\n')
  };
}

function runRg(root, query, target, limit) {
  return new Promise((resolve) => {
    const args = ['--line-number', '--column', '--no-heading', '--color', 'never', '--hidden', '--glob', '!node_modules/**', '--glob', '!.git/**', '--glob', '!dist/**', '--glob', '!build/**', '--', query, target];
    const child = spawn('rg', args, { cwd: root, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < 2_000_000) stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) return resolve(null);
      const rows = stdout.split(/\r?\n/).filter(Boolean).slice(0, limit).map((line) => {
        const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
        return m ? { path: m[1].replace(/^\.([\\/])/, '').split(path.sep).join('/'), line: Number(m[2]), column: Number(m[3]), text: m[4] } : { text: line };
      });
      resolve({ matches: rows, truncated: stdout.split(/\r?\n/).filter(Boolean).length > limit, stderr: stderr.trim() || undefined });
    });
  });
}

function walkFiles(dir, out, max = 10000) {
  if (out.length >= max) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= max) return;
    if (['.git', 'node_modules', 'dist', 'build', '.next'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out, max);
    else if (entry.isFile()) out.push(p);
  }
}

export async function findOp(root, args = {}) {
  const query = String(args.query ?? '');
  if (!query) throw new Error('query is required');
  const limit = clampInt(args.limit, 1, 500, 100);
  const target = resolveWithin(root, args.path ?? '.');
  const relTarget = relativeDisplay(root, target);
  const rg = await runRg(root, query, relTarget, limit);
  if (rg) return { engine: 'ripgrep', ...rg };

  const files = [];
  if (fs.statSync(target).isFile()) files.push(target); else walkFiles(target, files);
  const matches = [];
  for (const file of files) {
    if (matches.length >= limit) break;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      const col = lines[i].indexOf(query);
      if (col >= 0) matches.push({ path: relativeDisplay(root, file), line: i + 1, column: col + 1, text: lines[i] });
    }
  }
  return { engine: 'node', matches, truncated: matches.length >= limit };
}

export async function patchOp(root, args = {}) {
  return applyPatch(root, String(args.patch ?? ''));
}
