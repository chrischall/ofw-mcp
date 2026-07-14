import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs `tests/worker.test.ts` inside the real Workers runtime (via Miniflare),
// against `wrangler.jsonc`'s bindings (the `OFWMcpAgent` Durable Object +
// `OFWCacheDO` + `OAUTH_KV`). Kept separate from the stdio suite's
// `vitest.config.ts` / `npm test`, which runs under Node and never touches
// this file.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/worker.test.ts', 'tests/worker-cache.test.ts'],
  },
});
