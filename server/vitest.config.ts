import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Reliability tests drive a real 50k-row export end to end.
    testTimeout: 600_000,
    hookTimeout: 300_000,
    // Integration/concurrency suites share one database; never run them in
    // parallel or they will fight over the records table.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['verbose'],
    setupFiles: ['src/tests/setup.ts'],
  },
});
