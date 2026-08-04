import { defineConfig } from 'vitest/config';

// Separate from vitest.config.ts (the fast, pure-function unit suite): these tests spawn a
// real workerd process per case, so they're slower and need worker/runner.js + worker/guard.js
// already compiled (`pnpm build` first — see package.json's test:integration script and
// .github/workflows/typecheck.yml's integration job).
export default defineConfig({
    test: {
        include: ['tests/integration/**/*.test.ts'],
        testTimeout: 15_000,
    },
});
