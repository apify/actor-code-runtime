import { defineConfig } from 'vitest/config';

// Exclude compiled test artifacts from Vitest discovery.
export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts'],
    },
});
