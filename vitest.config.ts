import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: [
      'test/live/**',
      'test/integration/local-provider.test.ts',
      'test/integration/product-db.test.ts',
      'test/integration/product-auth.test.ts',
      'test/integration/real-app-server.test.ts',
      'test/integration/tenant-auth-postgres.test.ts',
      'test/integration/history-postgres.test.ts',
      'test/integration/rag-postgres.test.ts',
      'test/integration/retention-postgres.test.ts',
      'test/integration/abuse-rate-limit-postgres.test.ts',
      'test/integration/password-reset-postgres.test.ts',
      'test/integration/data-lifecycle-postgres.test.ts',
      'test/integration/workspace-membership-postgres.test.ts',
      'test/integration/workspace-invitation-postgres.test.ts',
      'test/acceptance/full-stack.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
