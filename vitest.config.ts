import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: [
      'test/live/**',
      'test/integration/local-provider.test.ts',
      'test/integration/product-db.test.ts',
      'test/integration/real-app-server.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
