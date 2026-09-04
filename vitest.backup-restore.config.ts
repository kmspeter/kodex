import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/acceptance/backup-restore.test.mjs'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
