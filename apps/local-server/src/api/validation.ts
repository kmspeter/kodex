import type { ClientRequest, RequestId, ServerRequest } from '@kodex/codex-protocol';
import type { KodexSettings } from '@kodex/kodex-api';

type ObjectValue = Record<string, unknown>;

export function isObject(value: unknown): value is ObjectValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid request: ${message}`);
}

function stringValue(value: unknown, name: string, maximum = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`${name} must be a non-empty string of at most ${maximum} characters.`);
  return value;
}

function optionalString(value: unknown, name: string, maximum = 20_000): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, name, maximum);
}

function exactKeys(value: ObjectValue, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) fail(`${name}.${unexpected} is not supported.`);
}

export function validateSettingsPatch(value: unknown): Partial<KodexSettings> {
  if (!isObject(value)) fail('settings patch must be an object.');
  exactKeys(value, ['sandbox', 'approvalPolicy', 'network', 'provider', 'lastProjectId', 'sidebarOpen', 'detailPanelOpen'], 'settings');
  const output: Partial<KodexSettings> = {};
  if (value.sandbox !== undefined) {
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(value.sandbox))) fail('settings.sandbox is invalid.');
    output.sandbox = value.sandbox as KodexSettings['sandbox'];
  }
  if (value.approvalPolicy !== undefined) {
    if (!['untrusted', 'on-request', 'never'].includes(String(value.approvalPolicy))) fail('settings.approvalPolicy is invalid.');
    output.approvalPolicy = value.approvalPolicy as KodexSettings['approvalPolicy'];
  }
  if (value.network !== undefined) {
    if (!isObject(value.network)) fail('settings.network must be an object.');
    exactKeys(value.network, ['shell', 'webSearch'], 'settings.network');
    const network: Partial<KodexSettings['network']> = {};
    for (const key of ['shell', 'webSearch'] as const) {
      if (value.network[key] !== undefined && typeof value.network[key] !== 'boolean') fail(`settings.network.${key} must be boolean.`);
      if (typeof value.network[key] === 'boolean') network[key] = value.network[key];
    }
    output.network = network as KodexSettings['network'];
  }
  if (value.provider !== undefined) {
    if (!isObject(value.provider)) fail('settings.provider must be an object.');
    exactKeys(value.provider, ['mode', 'baseUrl', 'model'], 'settings.provider');
    if (value.provider.mode !== 'openai' && value.provider.mode !== 'local') fail('settings.provider.mode must be openai or local.');
    const mode = value.provider.mode;
    const baseUrl = typeof value.provider.baseUrl === 'string' ? value.provider.baseUrl.trim() : '';
    if (typeof value.provider.model !== 'string' || value.provider.model.length > 200) fail('settings.provider.model must be a string of at most 200 characters.');
    const model = value.provider.model.trim();
    if (mode === 'local') validateLoopbackUrl(baseUrl);
    if (mode === 'local' && !model) fail('settings.provider.model is required in local provider mode.');
    if (mode === 'openai' && baseUrl) fail('OpenAI mode does not accept a custom base URL.');
    output.provider = { mode, baseUrl, model };
  }
  for (const key of ['sidebarOpen', 'detailPanelOpen'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`settings.${key} must be boolean.`);
    if (typeof value[key] === 'boolean') output[key] = value[key];
  }
  if (value.lastProjectId !== undefined) {
    if (value.lastProjectId !== null && typeof value.lastProjectId !== 'string') fail('settings.lastProjectId must be a string or null.');
    output.lastProjectId = value.lastProjectId as string | null;
  }
  return output;
}

export function validateLoopbackUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { return fail('local provider baseUrl must be a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('local provider baseUrl must use http or https.');
  const hostname = url.hostname.toLocaleLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) fail('local provider baseUrl must use a localhost/loopback host.');
  if (url.username || url.password) fail('local provider baseUrl must not contain credentials.');
  return url;
}

export type ProjectMutation = { id: string } | { path: string; name?: string };

export function validateProjectMutation(value: unknown): ProjectMutation {
  if (!isObject(value)) fail('project body must be an object.');
  exactKeys(value, ['id', 'path', 'name'], 'project');
  if (value.id !== undefined) {
    if (value.path !== undefined || value.name !== undefined) fail('project selection cannot include path or name.');
    return { id: stringValue(value.id, 'project.id', 200) };
  }
  return { path: stringValue(value.path, 'project.path', 32_000), name: optionalString(value.name, 'project.name', 120) };
}

export function validateIdBody(value: unknown, resource: string): { id: string } {
  if (!isObject(value)) fail(`${resource} body must be an object.`);
  exactKeys(value, ['id'], resource);
  return { id: stringValue(value.id, `${resource}.id`, 200) };
}

export interface AutomationInput { name: string; prompt: string; intervalMinutes: number; projectId?: string }

export function validateAutomationInput(value: unknown): AutomationInput {
  if (!isObject(value)) fail('automation body must be an object.');
  exactKeys(value, ['name', 'prompt', 'intervalMinutes', 'projectId'], 'automation');
  const intervalMinutes = Number(value.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10_080) fail('automation.intervalMinutes must be an integer from 1 to 10080.');
  return {
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 120) : 'Local automation',
    prompt: stringValue(value.prompt, 'automation.prompt', 20_000).trim(),
    intervalMinutes,
    projectId: optionalString(value.projectId, 'automation.projectId', 200),
  };
}

export function validateClientRequest(value: unknown, allowedMethods: ReadonlySet<string>): ClientRequest {
  if (!isObject(value) || typeof value.method !== 'string') fail('RPC request must contain a method.');
  if (!allowedMethods.has(value.method)) fail(`RPC method ${value.method} is not exposed by Kodex.`);
  if (typeof value.id !== 'string' && typeof value.id !== 'number') fail('RPC id must be a string or number.');
  if (value.params !== undefined && !isObject(value.params)) fail(`RPC params for ${value.method} must be an object or undefined.`);
  const params = value.params as ObjectValue | undefined;
  const requireStringParam = (key: string) => stringValue(params?.[key], `${value.method}.${key}`, 32_000);
  if (value.method.startsWith('thread/') && !['thread/start', 'thread/list'].includes(value.method)) requireStringParam('threadId');
  if (['turn/start', 'turn/steer', 'turn/interrupt'].includes(value.method)) requireStringParam('threadId');
  if (value.method === 'turn/start' && !Array.isArray(params?.input)) fail('turn/start.input must be an array.');
  if (value.method === 'turn/start' && (params?.input as unknown[]).some((entry) => !isObject(entry) || typeof entry.type !== 'string')) fail('turn/start.input entries must be typed objects.');
  if (value.method === 'thread/start' && params?.cwd !== undefined && typeof params.cwd !== 'string') fail('thread/start.cwd must be a string.');
  if (value.method === 'config/value/write') {
    const keyPath = requireStringParam('keyPath');
    if (!Object.hasOwn(params ?? {}, 'value')) fail('config/value/write.value is required.');
    if (keyPath.startsWith('mcp_servers.')) {
      if (!/^mcp_servers\.[A-Za-z0-9_-]+$/u.test(keyPath) || !isObject(params?.value) || typeof params.value.url !== 'string') fail('remote MCP writes require mcp_servers.<name> and a URL object.');
      let url: URL;
      try { url = new URL(params.value.url); } catch { return fail('remote MCP URL is invalid.'); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('remote MCP URL must use http or https.');
    }
  }
  return value as ClientRequest;
}

export type ValidatedSocketMessage =
  | { type: 'ping' }
  | { type: 'replay'; epoch: string; afterSequence: number }
  | { type: 'rpc'; requestId: string; request: ClientRequest }
  | { type: 'server-response'; requestId: RequestId; result: unknown }
  | { type: 'server-error'; requestId: RequestId; code: number; message: string };

function requestId(value: unknown): RequestId {
  if (typeof value !== 'string' && typeof value !== 'number') fail('requestId must be a string or number.');
  return value;
}

export function validateSocketMessage(value: unknown, allowedMethods: ReadonlySet<string>): ValidatedSocketMessage {
  if (!isObject(value) || typeof value.type !== 'string') fail('WebSocket envelope must be an object with a type.');
  switch (value.type) {
    case 'ping':
      exactKeys(value, ['type'], 'message');
      return { type: 'ping' };
    case 'replay': {
      exactKeys(value, ['type', 'epoch', 'afterSequence'], 'message');
      if (!Number.isSafeInteger(value.afterSequence) || Number(value.afterSequence) < 0) fail('replay.afterSequence must be a non-negative safe integer.');
      return { type: 'replay', epoch: stringValue(value.epoch, 'replay.epoch', 200), afterSequence: Number(value.afterSequence) };
    }
    case 'rpc':
      exactKeys(value, ['type', 'requestId', 'request'], 'message');
      return { type: 'rpc', requestId: stringValue(value.requestId, 'rpc.requestId', 200), request: validateClientRequest(value.request, allowedMethods) };
    case 'server-response':
      exactKeys(value, ['type', 'requestId', 'result'], 'message');
      if (!Object.hasOwn(value, 'result')) fail('server-response.result is required.');
      return { type: 'server-response', requestId: requestId(value.requestId), result: value.result };
    case 'server-error':
      exactKeys(value, ['type', 'requestId', 'code', 'message'], 'message');
      if (!Number.isInteger(value.code)) fail('server-error.code must be an integer.');
      return { type: 'server-error', requestId: requestId(value.requestId), code: Number(value.code), message: stringValue(value.message, 'server-error.message', 4_000) };
    default:
      return fail(`WebSocket message type ${value.type} is not supported.`);
  }
}

export function validateServerRequestResult(method: ServerRequest['method'], value: unknown): unknown {
  if (!isObject(value)) fail(`response for ${method} must be an object.`);
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(String(value.decision)) && !isObject(value.decision)) fail(`${method}.decision is invalid.`);
  } else if (method === 'item/permissions/requestApproval') {
    if (!isObject(value.permissions) || !['turn', 'session'].includes(String(value.scope))) fail(`${method} requires permissions and a valid scope.`);
  } else if (method === 'item/tool/requestUserInput') {
    if (!isObject(value.answers)) fail(`${method}.answers must be an object.`);
    for (const answer of Object.values(value.answers)) {
      if (!isObject(answer) || !Array.isArray(answer.answers) || answer.answers.some((entry) => typeof entry !== 'string')) fail(`${method} answers must contain string arrays.`);
    }
  } else if (method === 'mcpServer/elicitation/request') {
    if (!['accept', 'decline', 'cancel'].includes(String(value.action))) fail(`${method}.action is invalid.`);
  } else {
    fail(`${method} is not implemented by the local UI host.`);
  }
  return value;
}
