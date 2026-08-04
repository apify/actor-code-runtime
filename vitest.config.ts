import { defineConfig } from 'vitest/config';

// Only the .ts sources under tests/unit/ — without this, `pnpm build`'s tsc output leaves a
// compiled tests/unit/*.js next to each *.ts (gitignored build byproduct, same as tests/*.js
// for the probe fixtures), and vitest's own default file discovery picks up both, silently
// running every unit test twice under two different module instances.
export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts'],
    },
});
