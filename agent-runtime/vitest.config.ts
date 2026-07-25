import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
  test: {
    environment: 'node',
    include: ['agent-runtime/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/agent-runtime',
      include: [
        'agent-runtime/media/**/*.ts',
        'agent-runtime/review/**/*.ts',
        'agent-runtime/source-registry/**/*.ts',
      ],
      exclude: [
        'agent-runtime/**/*.test.ts',
        'agent-runtime/**/test-fixtures.ts',
      ],
    },
  },
});
