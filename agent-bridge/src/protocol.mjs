export const PROTOCOL_VERSION = 'cosplus-2026-09-22';

const object = (properties, required = [], additionalProperties = false) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties
});

export const TOOL_DEFINITIONS = [
  {
    name: 'read',
    title: 'Read file or directory',
    description: 'Read a text file, a bounded line range, inspect binary metadata, or list one directory inside the selected workspace.',
    inputSchema: object({
      path: { type: 'string', description: 'Workspace-relative file or directory path.' },
      start_line: { type: 'integer', minimum: 1 },
      end_line: { type: 'integer', minimum: 1 },
      max_bytes: { type: 'integer', minimum: 1, maximum: 524288 }
    }, ['path']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'find',
    title: 'Search workspace',
    description: 'Search for literal text inside files in the selected workspace.',
    inputSchema: object({
      query: { type: 'string', minLength: 1 },
      path: { type: 'string', default: '.' },
      limit: { type: 'integer', minimum: 1, maximum: 500 }
    }, ['query']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'apply_patch',
    title: 'Apply patch',
    description: 'Create, edit, rename, or delete workspace files using a validated unified Git patch.',
    inputSchema: object({ patch: { type: 'string', minLength: 1, description: 'Unified diff accepted by git apply.' } }, ['patch']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'exec_command',
    title: 'Execute command',
    description: 'Start a persistent shell command with its initial working directory inside the workspace. Returns a process session and task id.',
    inputSchema: object({
      command: { type: 'string', minLength: 1 },
      cwd: { type: 'string', default: '.' },
      yield_ms: { type: 'integer', minimum: 0, maximum: 30000, default: 1000 }
    }, ['command']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'write_stdin',
    title: 'Continue process',
    description: 'Read new output from a persistent process and optionally write input to its stdin.',
    inputSchema: object({
      session_id: { type: 'integer', minimum: 1 },
      chars: { type: 'string' },
      yield_ms: { type: 'integer', minimum: 0, maximum: 30000, default: 250 },
      cursor: { type: 'integer', minimum: 0, default: 0 }
    }, ['session_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'processes',
    title: 'List process sessions',
    description: 'List process sessions started through COS+ and their current state.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'kill',
    title: 'Stop process',
    description: 'Stop one process session started through COS+.',
    inputSchema: object({
      session_id: { type: 'integer', minimum: 1 },
      signal: { type: 'string', default: 'SIGTERM' }
    }, ['session_id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }
];

export const RESOURCE_DEFINITIONS = [
  { uri: 'resource://workspace/tree', name: 'Workspace tree', description: 'Bounded recursive workspace file tree.', mimeType: 'application/json' },
  { uri: 'resource://git/status', name: 'Git status', description: 'Current git status --short --branch.', mimeType: 'text/plain' },
  { uri: 'resource://git/diff', name: 'Git diff', description: 'Current unstaged and staged diff summary/content, bounded.', mimeType: 'text/plain' },
  { uri: 'resource://processes', name: 'Processes', description: 'COS+ process sessions and task state.', mimeType: 'application/json' },
  { uri: 'resource://project/metadata', name: 'Project metadata', description: 'Workspace identity and detected project metadata.', mimeType: 'application/json' }
];

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'resource://workspace/{path}',
    name: 'Workspace path',
    description: 'Read a workspace-relative file or list a directory.',
    mimeType: 'text/plain'
  }
];

function matchesType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

function validateValue(value, schema, key) {
  if (value === undefined) return;
  if (schema.type && !matchesType(value, schema.type)) throw protocolError('INVALID_ARGUMENT', `${key} must be ${schema.type}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw protocolError('INVALID_ARGUMENT', `${key} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw protocolError('INVALID_ARGUMENT', `${key} is too long`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw protocolError('INVALID_ARGUMENT', `${key} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw protocolError('INVALID_ARGUMENT', `${key} must be <= ${schema.maximum}`);
  }
}

export function validateToolArguments(name, args = {}) {
  const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!tool) throw protocolError('TOOL_NOT_FOUND', `Unknown tool: ${name}`);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw protocolError('INVALID_ARGUMENT', 'Tool arguments must be an object');
  for (const required of tool.inputSchema.required ?? []) {
    if (args[required] === undefined) throw protocolError('INVALID_ARGUMENT', `Missing required argument: ${required}`);
  }
  if (tool.inputSchema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in tool.inputSchema.properties)) throw protocolError('INVALID_ARGUMENT', `Unknown argument for ${name}: ${key}`);
    }
  }
  for (const [key, value] of Object.entries(args)) validateValue(value, tool.inputSchema.properties[key], key);
  if (name === 'read' && args.start_line !== undefined && args.end_line !== undefined && args.end_line < args.start_line) {
    throw protocolError('INVALID_ARGUMENT', 'end_line must be >= start_line');
  }
  return tool;
}

export function protocolError(code, message, data = undefined) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

export function errorCode(error) {
  if (typeof error?.code === 'string') return error.code;
  const message = String(error?.message ?? error);
  if (/not found/i.test(message)) return 'NOT_FOUND';
  if (/escapes workspace|unauthorized/i.test(message)) return 'PERMISSION_DENIED';
  if (/unknown session/i.test(message)) return 'TASK_NOT_FOUND';
  if (/already exited/i.test(message)) return 'TASK_COMPLETED';
  return 'TOOL_ERROR';
}

function textForResult(result) {
  if (result?.type === 'text' && typeof result.content === 'string') return result.content;
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

export function toolSuccess(name, result) {
  return {
    content: [{ type: 'text', text: textForResult(result) }],
    structuredContent: result,
    isError: false,
    meta: { tool: name }
  };
}

export function toolFailure(name, error) {
  const code = errorCode(error);
  return {
    content: [{ type: 'text', text: String(error?.message ?? error) }],
    isError: true,
    error: { code, message: String(error?.message ?? error), ...(error?.data !== undefined ? { data: error.data } : {}) },
    meta: { tool: name }
  };
}

export function taskFromSnapshot(snapshot) {
  const status = snapshot.running ? 'running' : snapshot.exit_code === 0 ? 'completed' : 'failed';
  return {
    taskId: `process:${snapshot.session_id}`,
    status,
    progress: {
      message: snapshot.running ? 'Process is running' : status === 'completed' ? 'Process completed' : 'Process exited with an error',
      indeterminate: snapshot.running
    },
    sessionId: snapshot.session_id,
    pid: snapshot.pid,
    cwd: snapshot.cwd,
    output: snapshot.output,
    nextCursor: snapshot.next_cursor,
    exitCode: snapshot.exit_code,
    signal: snapshot.signal,
    truncated: snapshot.truncated
  };
}

export function parseTaskId(taskId) {
  const match = /^process:(\d+)$/.exec(String(taskId ?? ''));
  if (!match) throw protocolError('TASK_NOT_FOUND', `Unknown task: ${taskId}`);
  return Number(match[1]);
}
