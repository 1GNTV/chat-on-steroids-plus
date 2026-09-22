import readline from 'node:readline';
import { remoteCall } from './core.mjs';

const METHOD_MAP = new Map([
  ['initialize', ['initialize', (params) => params ?? {}]],
  ['tools/list', ['tools_list', () => ({})]],
  ['tools/call', ['tools_call', (params) => ({ name: params?.name, arguments: params?.arguments ?? {} })]],
  ['resources/list', ['resources_list', () => ({})]],
  ['resources/read', ['resources_read', (params) => ({ uri: params?.uri })]],
  ['tasks/list', ['tasks_list', () => ({})]],
  ['tasks/get', ['tasks_get', (params) => ({ task_id: params?.taskId ?? params?.task_id, cursor: params?.cursor, yield_ms: params?.yieldMs ?? params?.yield_ms })]],
  ['tasks/cancel', ['tasks_cancel', (params) => ({ task_id: params?.taskId ?? params?.task_id, signal: params?.signal })]],
  ['ping', ['ping', () => ({})]]
]);

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function rpcCode(code) {
  if (code === 'METHOD_NOT_FOUND') return -32601;
  if (code === 'INVALID_ARGUMENT') return -32602;
  if (code === 'UNAUTHORIZED' || code === 'PERMISSION_DENIED') return -32001;
  if (code === 'TOOL_NOT_FOUND') return -32002;
  if (code === 'RESOURCE_NOT_FOUND') return -32003;
  if (code === 'TASK_NOT_FOUND') return -32004;
  return -32000;
}

export async function handleRpc(config, message) {
  const id = message?.id;
  if (message?.jsonrpc !== '2.0' || typeof message?.method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  const mapped = METHOD_MAP.get(message.method);
  if (!mapped) return rpcError(id, -32601, `Method not found: ${message.method}`);
  try {
    const [action, transform] = mapped;
    const result = await remoteCall(config, action, transform(message.params));
    return { jsonrpc: '2.0', id: id ?? null, result };
  } catch (error) {
    return rpcError(id, rpcCode(error?.code), error instanceof Error ? error.message : String(error), error?.data);
  }
}

export async function runAgent(config, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch {
      output.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n');
      continue;
    }
    const response = await handleRpc(config, message);
    if (message.id !== undefined) output.write(JSON.stringify(response) + '\n');
  }
}
