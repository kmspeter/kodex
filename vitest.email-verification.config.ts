import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/email-verification-postgres.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
