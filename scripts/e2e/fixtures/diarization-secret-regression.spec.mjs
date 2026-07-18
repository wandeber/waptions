import { expect, test } from '@playwright/test';
import { CONTROLLED_FAILURE_MARKER } from '../diarization-secret-artifacts.mjs';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('fails generically after keeping a sentinel only in page state', async ({ page }) => {
  const sentinel = process.env.WAPTIONS_SECURITY_FIXTURE_SENTINEL;
  if (!sentinel) throw new Error('The controlled security fixture is missing its internal sentinel.');

  await page.goto('/');
  const input = page.getByLabel('Ephemeral API key');
  await input.fill(sentinel);
  await expect(input).toHaveAttribute('type', 'password');
  const storageMatchesInput = await page.evaluate((storageKey) => {
    const passwordInput = document.querySelector('input[type="password"]');
    if (!(passwordInput instanceof HTMLInputElement)) {
      throw new Error('The controlled password input is unavailable.');
    }
    window.localStorage.setItem(storageKey, passwordInput.value);
    return window.localStorage.getItem(storageKey) === passwordInput.value;
  }, 'waptions-controlled-secret-regression');
  expect(storageMatchesInput).toBe(true);

  throw new Error(CONTROLLED_FAILURE_MARKER);
});
