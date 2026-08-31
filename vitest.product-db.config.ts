import { defineConfig } from 'vitest/config';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required for npm run test:product-db');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/product-db.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
