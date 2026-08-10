import { defineConfig } from 'vitest/config';

// Integration tests need compiled worker files and have longer timeouts.
export default defineConfig({
    test: {
        include: ['tests/integration/**/*.test.ts'],
        testTimeout: 15_000,
    },
});
