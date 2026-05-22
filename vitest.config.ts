import { defineConfig } from 'vitest/config';

// Thresholds are aspirational targets, not strict gates — CI runs
// `npm test` (no --coverage), so these only fire on a local
// `vitest run --coverage`. Set them slightly below current reality so
// a real regression trips them, but a one-line uncovered branch
// doesn't. Tighten as we add coverage; never raise above the actual
// number to avoid creating a perpetual red light.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'], // stdio entry point — not unit-testable
      thresholds: {
        lines: 95,
        functions: 100,
        branches: 80,
        statements: 95,
      },
    },
  },
});
