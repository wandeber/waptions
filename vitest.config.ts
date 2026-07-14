import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/wider',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'src/hooks/**/*.ts',
        'src/lib/**/*.ts',
        'src/stores/**/*.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
      ],
    },
  },
});
