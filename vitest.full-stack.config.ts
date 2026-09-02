import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required for the full-stack acceptance test.');
}
const binary = path.resolve('bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
if (!existsSync(binary)) {
  throw new Error(`The repository Codex binary is required at ${binary}.`);
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/acceptance/full-stack.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
