import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { relativeDisplay, resolveWithin } from './common.mjs';
import { RESOURCE_DEFINITIONS, RESOURCE_TEMPLATES, protocolError } from './protocol.mjs';
import { readOp } from './ops.mjs';

const MAX_RESOURCE_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 2000;

function walk(root, dir, out) {
  if (out.length >= MAX_TREE_ENTRIES) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_TREE_ENTRIES) return;
    if (['.git', 'node_modules', 'dist', 'build', '.next'].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = relativeDisplay(root, absolute);
    if (entry.isDirectory()) {
      out.push({ path: relative, type: 'directory' });
      walk(root, absolute, out);
    } else if (entry.isFile()) {
      out.push({ path: relative, type: 'file', size: fs.statSync(absolute).size });
    }
  }
}

function capText(text) {
  const buffer = Buffer.from(text);
  if (buffer.length <= MAX_RESOURCE_BYTES) return { text, truncated: false };
  return { text: buffer.subarray(0, MAX_RESOURCE_BYTES).toString(), truncated: true };
}

function runCapture(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (Buffer.byteLength(stdout) < MAX_RESOURCE_BYTES) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk.toString(); });
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function content(uri, mimeType, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { contents: [{ uri, mimeType, text }] };
}

export function listResources() {
  return { resources: RESOURCE_DEFINITIONS, resourceTemplates: RESOURCE_TEMPLATES };
}

export async function readResource(root, uri, { processSnapshots = () => [] } = {}) {
  if (typeof uri !== 'string') throw protocolError('INVALID_ARGUMENT', 'uri must be a string');

  if (uri === 'resource://workspace/tree') {
    const entries = [];
    walk(root, root, entries);
    return content(uri, 'application/json', { entries, truncated: entries.length >= MAX_TREE_ENTRIES });
  }

  if (uri === 'resource://git/status') {
    const result = await runCapture('git', ['status', '--short', '--branch'], root);
    if (result.code !== 0) throw protocolError('RESOURCE_ERROR', result.stderr.trim() || 'git status failed');
    return content(uri, 'text/plain', capText(result.stdout).text);
  }

  if (uri === 'resource://git/diff') {
    const [unstaged, staged] = await Promise.all([
      runCapture('git', ['diff', '--no-ext-diff', '--'], root),
      runCapture('git', ['diff', '--cached', '--no-ext-diff', '--'], root)
    ]);
    if (unstaged.code !== 0 && staged.code !== 0) throw protocolError('RESOURCE_ERROR', unstaged.stderr.trim() || staged.stderr.trim() || 'git diff failed');
    const joined = `# Unstaged\n${unstaged.stdout}\n# Staged\n${staged.stdout}`;
    const capped = capText(joined);
    return content(uri, 'text/plain', capped.text + (capped.truncated ? '\n\n[truncated]' : ''));
  }

  if (uri === 'resource://processes') return content(uri, 'application/json', { processes: processSnapshots() });

  if (uri === 'resource://project/metadata') {
    const metadata = { workspace: path.basename(root), files: {} };
    for (const file of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
      const absolute = path.join(root, file);
      if (!fs.existsSync(absolute)) continue;
      if (file === 'package.json') {
        try {
          const pkg = JSON.parse(fs.readFileSync(absolute, 'utf8'));
          metadata.files[file] = { name: pkg.name, version: pkg.version, scripts: pkg.scripts ? Object.keys(pkg.scripts) : [] };
        } catch { metadata.files[file] = { present: true }; }
      } else metadata.files[file] = { present: true };
    }
    return content(uri, 'application/json', metadata);
  }

  const prefix = 'resource://workspace/';
  if (uri.startsWith(prefix)) {
    const raw = uri.slice(prefix.length);
    let requested;
    try { requested = decodeURIComponent(raw); } catch { throw protocolError('INVALID_ARGUMENT', 'Invalid resource URI encoding'); }
    if (!requested) requested = '.';
    resolveWithin(root, requested);
    const result = await readOp(root, { path: requested });
    if (result.type === 'text') return content(uri, 'text/plain', result.content);
    return content(uri, 'application/json', result);
  }

  throw protocolError('RESOURCE_NOT_FOUND', `Unknown resource: ${uri}`);
}
