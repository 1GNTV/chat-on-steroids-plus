#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeConnection, remoteCall } from '../src/core.mjs';
import { runAgent } from '../src/agent.mjs';

const STATE_DIR = path.join(os.homedir(), '.cos-plus-client');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

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
function json(value) { process.stdout.write(JSON.stringify(value) + '\n'); }

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { throw new Error('COS+ is not connected. Run the connect command supplied by the host first.'); }
}

function writeConfig(config) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function removeConfig() { try { fs.unlinkSync(CONFIG_FILE); } catch {} }

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonArgument(positionals, fallback = {}) {
  const raw = positionals.join(' ').trim();
  return raw ? JSON.parse(raw) : fallback;
}

function help() {
  return `cos-plus - remote COS+ agent client\n\nSetup:\n  cos-plus connect CONNECTION\n  cos-plus initialize\n  cos-plus status\n  cos-plus disconnect\n\nMCP-like protocol:\n  cos-plus tools\n  cos-plus call-tool NAME '{"arg":"value"}'\n  cos-plus resources\n  cos-plus read-resource URI\n  cos-plus tasks\n  cos-plus task TASK_ID [--cursor N] [--yield-ms N]\n  cos-plus cancel TASK_ID [--signal SIGTERM]\n  cos-plus agent                 newline-delimited JSON-RPC over stdin/stdout\n\nLegacy convenience commands:\n  cos-plus capabilities\n  cos-plus read PATH [--start-line N] [--end-line N] [--max-bytes N]\n  cos-plus find QUERY [PATH] [--limit N]\n  cos-plus apply-patch [--file PATCH]\n  cos-plus exec "COMMAND..." [--cmd STRING] [--cwd PATH] [--yield-ms N]\n  cos-plus write-stdin SESSION_ID [--chars TEXT] [--yield-ms N] [--cursor N]\n  cos-plus processes\n  cos-plus kill SESSION_ID [--signal SIGTERM]\n  cos-plus call '<json>'`;
}

async function main() {
  const { positionals, flags } = parse(process.argv.slice(2));
  const cmd = positionals.shift();
  if (!cmd || cmd === 'help' || flags.help) { process.stdout.write(help() + '\n'); return; }

  if (cmd === 'connect') {
    const config = decodeConnection(positionals[0]);
    const init = await remoteCall(config, 'initialize', {});
    const tools = await remoteCall(config, 'tools_list', {});
    writeConfig(config);
    process.stdout.write(`COS+ connected to workspace: ${init.workspace?.name || 'workspace'}\n`);
    process.stdout.write(`Protocol: ${init.protocolVersion}\n`);
    process.stdout.write(`Available tools: ${tools.tools.map((tool) => tool.name).join(', ')}\n`);
    process.stdout.write('Start with `cos-plus initialize` and `cos-plus tools`, or run `cos-plus agent` for JSON-RPC mode.\n');
    return;
  }
  if (cmd === 'disconnect') { removeConfig(); process.stdout.write('COS+ disconnected locally.\n'); return; }

  const config = readConfig();
  if (cmd === 'agent') { await runAgent(config); return; }
  if (cmd === 'initialize') { json({ ok: true, result: await remoteCall(config, 'initialize', {}) }); return; }
  if (cmd === 'status') {
    const init = await remoteCall(config, 'initialize', {});
    json({ ok: true, result: { connected: true, protocolVersion: init.protocolVersion, workspace: init.workspace?.name, capabilities: init.capabilities } });
    return;
  }
  if (cmd === 'tools') { json({ ok: true, result: await remoteCall(config, 'tools_list', {}) }); return; }
  if (cmd === 'call-tool') {
    const name = positionals.shift();
    json({ ok: true, result: await remoteCall(config, 'tools_call', { name, arguments: parseJsonArgument(positionals, {}) }) });
    return;
  }
  if (cmd === 'resources') { json({ ok: true, result: await remoteCall(config, 'resources_list', {}) }); return; }
  if (cmd === 'read-resource') { json({ ok: true, result: await remoteCall(config, 'resources_read', { uri: positionals[0] }) }); return; }
  if (cmd === 'tasks') { json({ ok: true, result: await remoteCall(config, 'tasks_list', {}) }); return; }
  if (cmd === 'task') {
    json({ ok: true, result: await remoteCall(config, 'tasks_get', { task_id: positionals[0], cursor: num(flags.cursor), yield_ms: num(flags['yield-ms']) }) });
    return;
  }
  if (cmd === 'cancel') {
    json({ ok: true, result: await remoteCall(config, 'tasks_cancel', { task_id: positionals[0], signal: flags.signal }) });
    return;
  }
  if (cmd === 'capabilities') { json({ ok: true, result: await remoteCall(config, 'capabilities', {}) }); return; }
  if (cmd === 'call') {
    const req = JSON.parse(positionals.join(' '));
    json({ ok: true, result: await remoteCall(config, req.action, req.args || {}) });
    return;
  }
  if (cmd === 'read') {
    json({ ok: true, result: await remoteCall(config, 'read', {
      path: positionals[0] || '.',
      start_line: num(flags['start-line']),
      end_line: num(flags['end-line']),
      max_bytes: num(flags['max-bytes'])
    }) });
    return;
  }
  if (cmd === 'find') {
    json({ ok: true, result: await remoteCall(config, 'find', {
      query: positionals[0],
      path: positionals[1] || '.',
      limit: num(flags.limit)
    }) });
    return;
  }
  if (cmd === 'apply-patch') {
    const patch = flags.file ? fs.readFileSync(path.resolve(String(flags.file)), 'utf8') : await readStdin();
    json({ ok: true, result: await remoteCall(config, 'apply_patch', { patch }) });
    return;
  }
  if (cmd === 'exec') {
    const command = flags.cmd ? String(flags.cmd) : positionals.join(' ');
    json({ ok: true, result: await remoteCall(config, 'exec_command', {
      command,
      cwd: flags.cwd || '.',
      yield_ms: num(flags['yield-ms'])
    }) });
    return;
  }
  if (cmd === 'write-stdin') {
    json({ ok: true, result: await remoteCall(config, 'write_stdin', {
      session_id: Number(positionals[0]),
      chars: flags.chars,
      yield_ms: num(flags['yield-ms']),
      cursor: num(flags.cursor)
    }) });
    return;
  }
  if (cmd === 'processes') { json({ ok: true, result: await remoteCall(config, 'processes', {}) }); return; }
  if (cmd === 'kill') {
    json({ ok: true, result: await remoteCall(config, 'kill', {
      session_id: Number(positionals[0]),
      signal: flags.signal
    }) });
    return;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((error) => {
  json({ ok: false, error: { code: error?.code || 'CLIENT_ERROR', message: error instanceof Error ? error.message : String(error), ...(error?.data !== undefined ? { data: error.data } : {}) } });
  process.exitCode = 1;
});
