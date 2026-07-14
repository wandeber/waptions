import { defineConfig, devices } from '@playwright/test';

function requireIsolationVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Playwright requires ${name}. Run tests through \`pnpm run test:e2e\` so compiler and artifact paths are isolated.`,
    );
  }
  return value;
}

const parsedE2ePort = Number.parseInt(requireIsolationVariable('WAPTIONS_E2E_PORT'), 10);
if (!Number.isSafeInteger(parsedE2ePort) || parsedE2ePort <= 0 || parsedE2ePort > 65_535) {
  throw new Error('WAPTIONS_E2E_PORT must be a valid TCP port.');
}
const e2eBaseUrl = `http://localhost:${parsedE2ePort}`;
const e2eOutputDir = requireIsolationVariable('WAPTIONS_E2E_OUTPUT_DIR');
const e2eReportDir = requireIsolationVariable('WAPTIONS_E2E_REPORT_DIR');
requireIsolationVariable('WAPTIONS_NEXT_DIST_DIR');
requireIsolationVariable('WAPTIONS_TSCONFIG_PATH');
requireIsolationVariable('WAPTIONS_E2E_RUN_ID');

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',
  // Every invocation owns its artifact tree. Playwright clears outputDir at startup, so sharing
  // the default `test-results` directory can delete traces from another active test process.
  outputDir: e2eOutputDir,
  /* Maximum time one test can run for. */
  timeout: 30 * 1000,
  expect: {
    /**
     * Maximum time expect() should wait for the condition to be met.
     * For example in `await expect(locator).toHaveText();`
     */
    timeout: 5000
  },
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Deterministic media failures must remain visible in every environment. */
  retries: 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [['html', { outputFolder: e2eReportDir, open: 'never' }]],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: e2eBaseUrl,

    /* Keep diagnostic artifacts only for failures; successful media runs should remain cheap. */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    }
  ],
}); 
