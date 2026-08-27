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

export function appServerEnvironment(codexHome: string, apiKey: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...environment, CODEX_HOME: codexHome, OPENAI_API_KEY: apiKey };
  for (const key of Object.keys(output)) {
    if (/^(?:NEXT_PUBLIC_|VITE_)/u.test(key)) delete output[key];
  }
  return output;
}
