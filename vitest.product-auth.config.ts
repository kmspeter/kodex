import { defineConfig } from 'vitest/config';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required for npm run test:product-auth');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/product-auth.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
  },
});
