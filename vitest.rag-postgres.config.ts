import { defineConfig } from 'vitest/config';

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required for the PostgreSQL RAG integration test.');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/rag-postgres.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
