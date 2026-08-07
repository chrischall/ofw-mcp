import { configDefaults, defineConfig } from 'vitest/config';

// Coverage-enforced: `npm run test:coverage` (wired into CI) fails the
// build on any regression below 100%. Genuinely-unreachable defensive
// branches are excluded inline with `/* v8 ignore next */`. The bare
// `npm test` stays coverage-free for fast local iteration.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Nested checkouts of this same repo — agent worktrees under
      // `.claude/worktrees/<branch>/`, and any manual `git worktree add` into
      // the tree. The default `include` is RECURSIVE (`**/*.test.ts`), so
      // without this every test file gets collected twice: once from `tests/`
      // and once from each worktree's copy, run against that worktree's `src/`.
      // The duplicates pass, so the only visible symptom is the copied
      // TOTALS stay clean (the `include` below is root-anchored, so a
      // worktree's `src/` never merges in) — but those failing suites abort the
      // run before the summary is computed, so `test:coverage` silently stops
      // enforcing the 100% gate locally. That is the reason to exclude them,
      // not the noise.
      '**/.claude/**',
      '**/worktrees/**',
      // root-anchored so a copy at any depth is excluded too — the anchored
      // form silently stopped matching once a worktree existed.
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts', // stdio entry point — not unit-testable
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
