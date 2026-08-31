import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ClientNotification, ClientRequest, InitializeParams, InitializeResponse, RequestId, ServerNotification, ServerRequest } from '@kodex/codex-protocol';
import type { EngineStatus, ProviderSettings } from '@kodex/kodex-api';
import { JsonlDecoder, redactSecrets, sanitizeUnknown } from '@kodex/shared';
import type { ClientMethod, KnownResponse, ParamsFor } from '../app-server/methods.js';
import { appServerEnvironment, resolveCodexBinary, type BinaryResolution } from './binary.js';

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AppServerClientOptions {
  repositoryRoot: string;
  codexHome: string;
  apiKey: string | undefined;
  localApiKey?: string | undefined;
  provider?: ProviderSettings;
  log: (filename: string, line: string) => Promise<void>;
  binary?: BinaryResolution | null;
  extraArgs?: string[];
  spawnArgs?: string[];
  stableRunMs?: number;
  maxConsecutiveRestarts?: number;
  restartDelaysMs?: number[];
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isResponse(value: unknown): value is JsonRpcResponse {
  return isObject(value) && Object.hasOwn(value, 'id') && !Object.hasOwn(value, 'method');
}

function isServerRequest(value: unknown): value is ServerRequest {
  return isObject(value) && Object.hasOwn(value, 'id') && typeof value.method === 'string' && isObject(value.params);
}

function isServerNotification(value: unknown): value is ServerNotification {
  return isObject(value) && !Object.hasOwn(value, 'id') && typeof value.method === 'string' && Object.hasOwn(value, 'params');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export class AppServerClient extends EventEmitter {
  readonly options: AppServerClientOptions;
  #provider: ProviderSettings;
  #binary: BinaryResolution | null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #decoder = new JsonlDecoder();
  #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #startPromise: Promise<void> | null = null;
  #expectedStop = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #stableTimer: NodeJS.Timeout | null = null;
  #malformedLines = 0;
  #version: string | null = null;
  #lastError: string | null = null;
  #restartCount = 0;
  #consecutiveFailures = 0;
  #ready = false;

  constructor(options: AppServerClientOptions) {
    super();
    this.options = options;
    this.#provider = options.provider ?? { mode: 'openai', baseUrl: '', model: '' };
    this.#binary = options.binary === undefined ? resolveCodexBinary(options.repositoryRoot) : options.binary;
  }

  configureProvider(provider: ProviderSettings): void {
    if (this.#child || this.#startPromise) throw new Error('Stop the App Server before changing model provider settings.');
    this.#provider = { ...provider };
    this.#lastError = null;
  }

  status(): EngineStatus {
    if (this.#provider.mode === 'openai' && !this.options.apiKey) {
      return this.#status('missing-key', 'OPENAI_API_KEY is not set. Add it to .env.local and restart the App Server.');
    }
    if (!this.#binary) return this.#status('missing-binary', 'Local bin/codex executable is missing. Run npm run codex:build.');
    if (this.#ready) return this.#status('ready', `Official Codex App Server is connected to the ${this.#provider.mode === 'local' ? 'loopback local' : 'OpenAI'} provider.`);
    if (this.#startPromise || this.#restartTimer) return this.#status('starting', 'Starting the local Codex App Server.');
    if (this.#lastError) return this.#status('failed', this.#lastError);
    return this.#status('stopped', 'Codex App Server is stopped.');
  }

  #status(state: EngineStatus['state'], message: string): EngineStatus {
    return {
      state, message, apiKeyConfigured: this.#provider.mode === 'openai' ? Boolean(this.options.apiKey) : Boolean(this.options.localApiKey), binary: this.#binary?.command ?? null,
      binarySource: this.#binary?.source ?? null, version: this.#version, pid: this.#child?.pid ?? null,
      restartCount: this.#restartCount, consecutiveFailures: this.#consecutiveFailures,
      providerMode: this.#provider.mode, providerModel: this.#provider.model || null, transport: 'stdio JSONL',
    };
  }

  detectVersion(): string {
    if (this.#version) return this.#version;
    if (!this.#binary) throw new Error('Local Codex binary is missing.');
    const result = spawnSync(this.#binary.command, ['--version'], {
      cwd: this.options.repositoryRoot, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000,
    });
    if (result.error || result.status !== 0) throw new Error(redactSecrets(result.error?.message ?? result.stderr ?? 'Codex version check failed.'));
    const reported = (result.stdout || result.stderr).trim();
    const expectedLocal = path.join(this.options.repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (path.resolve(this.#binary.command) === path.resolve(expectedLocal)) {
      try {
        const metadata = JSON.parse(readFileSync(path.join(this.options.repositoryRoot, 'bin', 'codex-build.json'), 'utf8')) as { displayVersion?: string; commit?: string };
        this.#version = metadata.displayVersion ?? (metadata.commit ? `Codex source build ${metadata.commit.slice(0, 12)}` : reported);
      } catch { this.#version = reported; }
    } else this.#version = reported;
    return this.#version;
  }

  async start(): Promise<void> {
    if (this.#ready) return;
    if (this.#startPromise) return this.#startPromise;
    if (this.#provider.mode === 'openai' && !this.options.apiKey) throw new Error(this.status().message);
    if (!this.#binary) throw new Error(this.status().message);
    this.#startPromise = this.#startInternal().finally(() => { this.#startPromise = null; });
    return this.#startPromise;
  }

  async #startInternal(): Promise<void> {
    this.detectVersion();
    mkdirSync(this.options.codexHome, { recursive: true });
    this.#expectedStop = false;
    this.#lastError = null;
    this.#decoder = new JsonlDecoder();
    const args = this.options.spawnArgs ?? this.#appServerArgs();
    const credentials = this.#provider.mode === 'openai'
      ? { openAiApiKey: this.options.apiKey }
      : { localApiKey: this.options.localApiKey };
    const child = spawn(this.#binary!.command, args, {
      cwd: this.options.repositoryRoot,
      env: appServerEnvironment(this.options.codexHome, credentials),
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stdout.on('data', (chunk: Buffer) => this.#handleChunk(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const safe = redactSecrets(chunk.toString(), this.#secrets()).trim();
      if (safe) void this.options.log('app-server.log', `${new Date().toISOString()} ${safe}`);
    });
    child.once('error', (error) => this.#handleProcessError(error));
    child.once('exit', (code, signal) => this.#handleExit(code, signal));

    const initialize: InitializeParams = {
      clientInfo: { name: 'kodex_local', title: 'Kodex', version: '0.2.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await this.requestRaw<InitializeResponse>('initialize', initialize, 20_000);
    const initialized: ClientNotification = { method: 'initialized' };
    this.#write(initialized);
    this.#ready = true;
    this.#stableTimer = setTimeout(() => {
      this.#stableTimer = null;
      if (!this.#ready) return;
      this.#consecutiveFailures = 0;
      this.emit('status', this.status());
    }, this.options.stableRunMs ?? 60_000);
    this.#stableTimer.unref?.();
    this.emit('status', this.status());
  }

  #appServerArgs(): string[] {
    const common = ['app-server', '--listen', 'stdio://', '-c', 'shell_environment_policy.exclude=["OPENAI_API_KEY","KODEX_LOCAL_LLM_API_KEY"]'];
    if (this.#provider.mode === 'openai') {
      common.push('-c', 'forced_login_method="api"');
      if (this.#provider.model) common.push('-c', `model=${tomlString(this.#provider.model)}`);
    } else {
      common.push(
        '-c', 'model_provider="kodex_local"',
        '-c', `model=${tomlString(this.#provider.model)}`,
        '-c', 'model_providers.kodex_local.name="Kodex local Responses provider"',
        '-c', `model_providers.kodex_local.base_url=${tomlString(this.#provider.baseUrl)}`,
        '-c', 'model_providers.kodex_local.wire_api="responses"',
        '-c', 'model_providers.kodex_local.requires_openai_auth=false',
        '-c', 'model_providers.kodex_local.supports_websockets=false',
      );
      if (this.options.localApiKey) common.push('-c', 'model_providers.kodex_local.env_key="KODEX_LOCAL_LLM_API_KEY"');
    }
    return [...common, ...(this.options.extraArgs ?? [])];
  }

  async request<M extends ClientMethod>(method: M, params: ParamsFor<M>, timeoutMs = 120_000): Promise<KnownResponse<M>> {
    await this.start();
    return this.requestRaw<KnownResponse<M>>(method, params, timeoutMs);
  }

  requestRaw<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.#child?.stdin.writable) return Promise.reject(new Error('Codex App Server stdin is unavailable.'));
    const id: RequestId = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestKey(id));
        reject(new Error(`${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.#pending.set(requestKey(id), { method, resolve: (value) => resolve(value as T), reject, timer });
      try { this.#write({ method, id, params } as ClientRequest); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestKey(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: RequestId, result: unknown): void { this.#write({ id, result }); }
  respondError(id: RequestId, code: number, message: string): void {
    this.#write({ id, error: { code, message: redactSecrets(message, this.#secrets()) } });
  }

  #write(message: unknown): void {
    if (!this.#child?.stdin.writable) throw new Error('Codex App Server stdin is unavailable.');
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleChunk(chunk: Buffer): void {
    for (const line of this.#decoder.push(chunk)) this.#handleLine(line);
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); this.#malformedLines = 0; } catch {
      this.#malformedLines += 1;
      void this.options.log('protocol-errors.log', `${new Date().toISOString()} malformed JSON: ${redactSecrets(line, this.#secrets()).slice(0, 4_000)}`);
      this.emit('protocol-error', new Error('App Server emitted malformed JSONL.'));
      if (this.#malformedLines >= 3) this.#child?.kill();
      return;
    }
    if (isResponse(parsed)) {
      const pending = this.#pending.get(requestKey(parsed.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(requestKey(parsed.id));
      if (parsed.error) pending.reject(new Error(redactSecrets(parsed.error.message, this.#secrets())));
      else pending.resolve(sanitizeUnknown(parsed.result, this.#secrets()));
      return;
    }
    if (isServerRequest(parsed)) { this.emit('server-request', sanitizeUnknown(parsed, this.#secrets()) as ServerRequest); return; }
    if (isServerNotification(parsed)) { this.emit('notification', sanitizeUnknown(parsed, this.#secrets()) as ServerNotification); return; }
    void this.options.log('protocol-errors.log', `${new Date().toISOString()} invalid message: ${redactSecrets(line, this.#secrets()).slice(0, 4_000)}`);
  }

  #secrets(): string[] { return [this.options.apiKey ?? '', this.options.localApiKey ?? ''].filter(Boolean); }

  #handleProcessError(error: Error): void {
    this.#lastError = redactSecrets(error.message, this.#secrets());
    this.emit('status', this.status());
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#ready = false;
    this.#child = null;
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex App Server exited before responding.'));
    }
    this.#pending.clear();
    if (this.#expectedStop) { this.emit('status', this.status()); return; }
    this.#consecutiveFailures += 1;
    this.#lastError = `Codex App Server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`;
    this.emit('status', this.status());
    const maxRestarts = this.options.maxConsecutiveRestarts ?? 3;
    const canStart = this.#provider.mode === 'local' || Boolean(this.options.apiKey);
    if (this.#consecutiveFailures > maxRestarts || !canStart || !this.#binary) {
      if (this.#consecutiveFailures > maxRestarts) this.#lastError += ` Automatic restart stopped after ${maxRestarts} consecutive retries. Use Restart App Server to try again.`;
      this.emit('status', this.status());
      return;
    }
    const delays = this.options.restartDelaysMs ?? [500, 1_500, 4_000];
    const delay = delays[Math.min(this.#consecutiveFailures - 1, delays.length - 1)] ?? 4_000;
    this.#restartCount += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.start().catch((error: unknown) => {
        this.#lastError = redactSecrets(error instanceof Error ? error.message : String(error), this.#secrets());
        this.emit('status', this.status());
      });
    }, delay);
    this.#restartTimer.unref?.();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.#expectedStop = false;
    this.#consecutiveFailures = 0;
    this.#lastError = null;
    await this.start();
  }

  async stop(): Promise<void> {
    this.#expectedStop = true;
    this.#ready = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    this.#restartTimer = null;
    this.#stableTimer = null;
    const child = this.#child;
    if (!child || child.killed) { this.#child = null; this.#lastError = null; return; }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin.end();
    child.kill();
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    this.#child = null;
    this.#lastError = null;
  }
}
