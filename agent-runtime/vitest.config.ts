import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['agent-runtime/**/*.test.ts'],
        environment: 'node',
    },
});
