import { existsSync } from 'node:fs';
import path from 'node:path';

export interface BinaryResolution {
  command: string;
  source: 'local' | 'global-fallback';
}

export function resolveCodexBinary(repositoryRoot: string, environment: NodeJS.ProcessEnv = process.env): BinaryResolution | null {
  const configured = environment.KODEX_CODEX_BIN?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) || !existsSync(configured)) {
      throw new Error('KODEX_CODEX_BIN must point to an existing absolute path.');
    }
    return { command: configured, source: 'local' };
  }
  const local = path.join(repositoryRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (existsSync(local)) return { command: local, source: 'local' };
  if (environment.KODEX_ALLOW_GLOBAL_CODEX === '1') {
    return { command: process.platform === 'win32' ? 'codex.exe' : 'codex', source: 'global-fallback' };
  }
  return null;
}

export function appServerEnvironment(
  codexHome: string,
  credentials: { openAiApiKey?: string; localApiKey?: string },
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...environment, CODEX_HOME: codexHome };
  for (const key of Object.keys(output)) {
    const normalized = key.toLocaleUpperCase();
    if (normalized === 'OPENAI_API_KEY' || normalized === 'KODEX_LOCAL_LLM_API_KEY' || /^(?:NEXT_PUBLIC_|VITE_)/u.test(normalized)) delete output[key];
  }
  if (credentials.openAiApiKey) output.OPENAI_API_KEY = credentials.openAiApiKey;
  if (credentials.localApiKey) output.KODEX_LOCAL_LLM_API_KEY = credentials.localApiKey;
  return output;
}
