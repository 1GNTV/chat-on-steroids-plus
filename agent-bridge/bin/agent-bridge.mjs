#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { call, startDaemon, stopDaemon, ensureDaemon } from '../src/client.mjs';
import { json, readState } from '../src/common.mjs';

function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
      const name = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else positionals.push(arg);
  }
  return { positionals, flags };
}

function num(value) { return value === undefined ? undefined : Number(value); }
function help() {
  return `agent-bridge - local coding primitives\n\nCommands:\n  start [--root PATH]\n  stop\n  status\n  capabilities\n  call '<json>'\n  read PATH [--start-line N] [--end-line N] [--max-bytes N]\n  find QUERY [PATH] [--limit N]\n  apply-patch [--file PATCH]      (otherwise reads patch from stdin)\n  exec "COMMAND..." [--cmd STRING] [--cwd PATH] [--yield-ms N]\n  write-stdin SESSION_ID [--chars TEXT] [--yield-ms N] [--cursor N]\n  processes\n  kill SESSION_ID [--signal SIGTERM]\n\nAll successful commands print one JSON object to stdout.`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { positionals, flags } = parse(process.argv.slice(2));
  const cmd = positionals.shift();
  if (!cmd || cmd === 'help' || flags.help) { process.stdout.write(help() + '\n'); return; }

  if (cmd === 'start') {
    const state = await startDaemon(flags.root || process.cwd(), { restart: Boolean(flags.restart) });
    json({ ok: true, result: { pid: state.pid, root: state.root, port: state.port } }); return;
  }
  if (cmd === 'stop') { json({ ok: true, result: await stopDaemon() }); return; }
  if (cmd === 'status') {
    const state = readState();
    if (!state) { json({ ok: true, result: { running: false } }); return; }
    try { const live = await ensureDaemon(state.root); json({ ok: true, result: { running: true, pid: live.pid, root: live.root, port: live.port } }); }
    catch { json({ ok: true, result: { running: false } }); }
    return;
  }
  if (cmd === 'capabilities') { json({ ok: true, result: await call('capabilities', {}, flags.root ? { root: flags.root } : {}) }); return; }
  if (cmd === 'call') {
    const raw = positionals.join(' ');
    const req = JSON.parse(raw);
    json({ ok: true, result: await call(req.action, req.args || {}, flags.root ? { root: flags.root } : {}) }); return;
  }
  if (cmd === 'read') {
    json({ ok: true, result: await call('read', { path: positionals[0] || '.', start_line: num(flags['start-line']), end_line: num(flags['end-line']), max_bytes: num(flags['max-bytes']) }) }); return;
  }
  if (cmd === 'find') {
    json({ ok: true, result: await call('find', { query: positionals[0], path: positionals[1] || '.', limit: num(flags.limit) }) }); return;
  }
  if (cmd === 'apply-patch') {
    const patch = flags.file ? fs.readFileSync(path.resolve(String(flags.file)), 'utf8') : await readStdin();
    json({ ok: true, result: await call('apply_patch', { patch }) }); return;
  }
  if (cmd === 'exec') {
    const command = flags.cmd ? String(flags.cmd) : positionals.join(' ');
    json({ ok: true, result: await call('exec_command', { command, cwd: flags.cwd || '.', yield_ms: num(flags['yield-ms']) }) }); return;
  }
  if (cmd === 'write-stdin') {
    json({ ok: true, result: await call('write_stdin', { session_id: Number(positionals[0]), chars: flags.chars, yield_ms: num(flags['yield-ms']), cursor: num(flags.cursor) }) }); return;
  }
  if (cmd === 'processes') { json({ ok: true, result: await call('processes', {}) }); return; }
  if (cmd === 'kill') { json({ ok: true, result: await call('kill', { session_id: Number(positionals[0]), signal: flags.signal }) }); return; }
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((error) => {
  json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
