import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { LocalHttpServer } from './api/http-server.js';
import { KodexRuntime } from './runtime.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
dotenv.config({ path: path.join(repositoryRoot, '.env.local'), quiet: true });

const host = '127.0.0.1' as const;
const port = Math.max(1, Math.min(65_535, Number(process.env.KODEX_SERVER_PORT) || 47_831));
const allowedOrigins = new Set((process.env.KODEX_UI_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean));

const runtime = new KodexRuntime(repositoryRoot, process.env.OPENAI_API_KEY);
const server = new LocalHttpServer(runtime, { host, port, allowedOrigins });
let stopping = false;

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.stop();
  await server.close().catch(() => undefined);
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop());
process.once('uncaughtException', (error) => {
  process.stderr.write(`Kodex Local Server fatal error: ${error.message}\n`);
  void stop(1);
});
process.once('unhandledRejection', (reason) => {
  process.stderr.write(`Kodex Local Server unhandled rejection: ${String(reason)}\n`);
  void stop(1);
});

await server.listen();
process.stdout.write(`Kodex Local Server: http://${host}:${port}\n`);
process.stdout.write(`Kodex data: ${runtime.store.root}\n`);
process.stdout.write(`Codex App Server: ${runtime.appServer.status().state}\n`);
