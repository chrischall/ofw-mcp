import { configDefaults, defineConfig } from 'vitest/config';

// Coverage-enforced: `npm run test:coverage` (wired into CI) fails the
// build on any regression below 100%. Genuinely-unreachable defensive
// branches are excluded inline with `/* v8 ignore next */`. The bare
// `npm test` stays coverage-free for fast local iteration.
export default defineConfig({
  test: {
    // `tests/worker*.test.ts` only run under the Workers runtime pool
    // (`vitest.workers.config.ts` / `npm run worker:test`), which provides
    // the virtual `cloudflare:test` module they import.
    exclude: [...configDefaults.exclude, 'tests/worker.test.ts', 'tests/worker-cache.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // stdio entry point — not unit-testable
        // Worker-only entry points import cloudflare:workers / agents and
        // cannot run under the node pool — they are covered by the Workers
        // pool suite (tests/worker*.test.ts via `npm run worker:test`).
        'src/worker.ts',
        'src/cache/durable.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
