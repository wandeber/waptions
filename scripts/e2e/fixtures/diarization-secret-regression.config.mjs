import { defineConfig, devices } from '@playwright/test';

const requireVariable = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`The controlled security fixture requires ${name}.`);
  return value;
};

export default defineConfig({
  testDir: '.',
  testMatch: 'diarization-secret-regression.spec.mjs',
  outputDir: requireVariable('WAPTIONS_SECURITY_FIXTURE_OUTPUT_DIR'),
  timeout: 15_000,
  retries: 0,
  workers: 1,
  // The controlled failure needs terminal evidence only. HTML reporters can retain serialized
  // action parameters even when trace/video/screenshots are disabled, so the secure path never
  // enables one for a test that fills an ephemeral credential.
  reporter: [['line']],
  use: {
    baseURL: requireVariable('WAPTIONS_SECURITY_FIXTURE_BASE_URL'),
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
  }],
});
