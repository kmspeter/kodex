import { defineConfig } from 'vitest/config';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required for npm run test:workspace-invitations-postgres');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/workspace-invitation-postgres.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
