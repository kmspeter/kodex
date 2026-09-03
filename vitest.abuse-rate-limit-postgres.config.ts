import { defineConfig } from 'vitest/config';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required for npm run test:abuse-rate-limit-postgres');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/abuse-rate-limit-postgres.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
