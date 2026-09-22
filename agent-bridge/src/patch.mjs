import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function applyPatch(root, patchText) {
  if (typeof patchText !== 'string' || patchText.trim() === '') throw new Error('Patch is empty');
  if (Buffer.byteLength(patchText) > 4 * 1024 * 1024) throw new Error('Patch exceeds 4 MiB');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-patch-'));
  const patchFile = path.join(dir, 'change.patch');
  fs.writeFileSync(patchFile, patchText, 'utf8');
  try {
    const check = await run('git', ['apply', '--check', '--whitespace=nowarn', patchFile], { cwd: root });
    if (check.code !== 0) {
      throw new Error(`Patch check failed${check.stderr ? `: ${check.stderr.trim()}` : ''}`);
    }
    const applied = await run('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: root });
    if (applied.code !== 0) throw new Error(`Patch apply failed${applied.stderr ? `: ${applied.stderr.trim()}` : ''}`);
    const stat = await run('git', ['diff', '--stat', '--'], { cwd: root });
    return { applied: true, stat: stat.stdout.trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
