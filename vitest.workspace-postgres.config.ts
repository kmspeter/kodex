import { defineConfig } from 'vitest/config';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required for npm run test:workspace-postgres');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/workspace-membership-postgres.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
  },
});
