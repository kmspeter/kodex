import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/acceptance/release-deployment.test.mjs'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
