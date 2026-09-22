#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { call, startDaemon, stopDaemon, ensureDaemon } from '../src/client.mjs';
import { json, readState } from '../src/common.mjs';
import { shareStatus, startShare, stopShare } from '../src/share.mjs';

const CLIENT_SPEC = 'https://github.com/1GNTV/chat-on-steroids-plus/archive/refs/heads/cos-plus-client.tar.gz';

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
  return `cos-plus - connect a coding agent to this computer\n\nEasy mode:\n  cos-plus start [PATH]        start local bridge + free Quick Tunnel\n  cos-plus status              show local/tunnel status\n  cos-plus stop                stop tunnel and local bridge\n\nLocal-only mode:\n  agent-bridge start [--root PATH] --local\n\nCoding commands:\n  capabilities\n  call '<json>'\n  read PATH [--start-line N] [--end-line N] [--max-bytes N]\n  find QUERY [PATH] [--limit N]\n  apply-patch [--file PATCH]      (otherwise reads patch from stdin)\n  exec "COMMAND..." [--cmd STRING] [--cwd PATH] [--yield-ms N]\n  write-stdin SESSION_ID [--chars TEXT] [--yield-ms N] [--cursor N]\n  processes\n  kill SESSION_ID [--signal SIGTERM]\n\nUse --json with start/status/stop for machine-readable output.`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function printReady(state, share) {
  const command = `npm install --global ${CLIENT_SPEC} && cos-plus connect ${share.connection}`;
  process.stdout.write(`\nCOS+ ready\n\nWorkspace: ${state.root}\nTunnel:    ${share.url}\n\nGive ChatGPT this exact command:\n\n${command}\n\nKeep this terminal/PC online while ChatGPT is working.\nRun \"cos-plus stop\" when you are done.\n\n`);
}

async function main() {
  const { positionals, flags } = parse(process.argv.slice(2));
  const cmd = positionals.shift();
  if (!cmd || cmd === 'help' || flags.help) { process.stdout.write(help() + '\n'); return; }

  if (cmd === 'start') {
    const root = flags.root || positionals[0] || process.cwd();
    const state = await startDaemon(root, { restart: Boolean(flags.restart) });
    if (flags.local) {
      const result = { mode: 'local', pid: state.pid, root: state.root, port: state.port };
      flags.json ? json({ ok: true, result }) : process.stdout.write(`Agent Bridge ready locally for ${state.root}\n`);
      return;
    }
    const share = await startShare(state, { restart: Boolean(flags.restart) });
    if (flags.json) json({ ok: true, result: { mode: 'remote', pid: state.pid, root: state.root, tunnel: share.url, connection: share.connection } });
    else printReady(state, share);
    return;
  }
  if (cmd === 'stop') {
    const share = await stopShare();
    const daemon = await stopDaemon();
    if (flags.json) json({ ok: true, result: { share, daemon } });
    else process.stdout.write('COS+ stopped.\n');
    return;
  }
  if (cmd === 'status') {
    const state = readState();
    let daemon = { running: false };
    if (state) {
      try {
        const live = await ensureDaemon(state.root);
        daemon = { running: true, pid: live.pid, root: live.root, port: live.port, http_port: live.http_port };
      } catch {}
    }
    const tunnel = shareStatus();
    const result = { daemon, tunnel };
    if (flags.json) json({ ok: true, result });
    else {
      process.stdout.write(`COS+ ${daemon.running ? 'running' : 'stopped'}\n`);
      if (daemon.running) process.stdout.write(`Workspace: ${daemon.root}\n`);
      process.stdout.write(`Tunnel: ${tunnel.running ? tunnel.url : 'stopped'}\n`);
    }
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
