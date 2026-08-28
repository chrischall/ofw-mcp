import { configDefaults, defineConfig } from 'vitest/config';

// Coverage-enforced: `npm run test:coverage` (wired into CI) fails the
// build on any regression below 100%. Genuinely-unreachable defensive
// branches are excluded inline with `/* v8 ignore next */`. The bare
// `npm test` stays coverage-free for fast local iteration.
export default defineConfig({
  test: {
    // Forces the session cache off and pins its path into a temp dir, so no
    // test can read or write the developer's real ~/.ofw-mcp — see tests/_setup.ts.
    setupFiles: ['./tests/_setup.ts'],
    exclude: [
      ...configDefaults.exclude,
      // Nested checkouts of this same repo — agent worktrees under
      // `.claude/worktrees/<branch>/`, and any manual `git worktree add` into
      // the tree. The default `include` is RECURSIVE (`**/*.test.ts`), so
      // without this every test file gets collected twice: once from `tests/`
      // and once from each worktree's copy, run against that worktree's `src/`.
      // A worktree's copies run against ITS `src/`, so they fail whenever the
      // branches differ — and a failing suite aborts the run before the summary
      // is computed, which silently stops `test:coverage` enforcing the 100%
      // gate locally. That is the reason to exclude them, not the noise.
      // Unanchored so a copy at any depth is excluded; a root-anchored form
      // silently stopped matching once a nested worktree existed.
      '**/.claude/**',
      '**/worktrees/**',
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
