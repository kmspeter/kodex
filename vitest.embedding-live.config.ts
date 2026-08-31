import { defineConfig } from 'vitest/config';

if (process.env.KODEX_RAG_LIVE_SMOKE !== '1' || !process.env.OPENAI_API_KEY?.trim()) {
  throw new Error('KODEX_RAG_LIVE_SMOKE=1 and OPENAI_API_KEY are required for the live embedding smoke test.');
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/live/embedding-live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 10_000,
    fileParallelism: false,
  },
});
