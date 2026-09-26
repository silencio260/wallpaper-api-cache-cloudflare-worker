import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: { NEXWALL_API_KEY: 'test-secret-not-a-real-key' } },
  })],
  test: {
    fileParallelism: false,
    testTimeout: 20000,
  },
});
