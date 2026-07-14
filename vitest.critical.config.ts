import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The critical profile deliberately follows the editor's latency- and memory-sensitive runtime.
 * Keeping this list explicit makes newly uncovered transport, decoding, cache, waveform, and
 * export files visible instead of diluting them inside the wider application baseline.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    // Every unit suite may exercise these modules through a higher-level contract. Coverage is
    // still measured only over the explicitly owned replacement runtime below.
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/critical-runtime',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'src/lib/editor-commands.ts',
        'src/lib/export-job.ts',
        'src/lib/frame-cache.ts',
        'src/lib/runtime-diagnostics.ts',
        'src/lib/timeline-audio-worklet.ts',
        'src/lib/waveform-repository.ts',
        'src/stores/timeline-store-snapshot.ts',
      ],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
      },
    },
  },
});
