import { expect, type Page } from '@playwright/test';

export interface PageFailureMonitor {
  errors: string[];
  underruns: string[];
}

/** Creates a real project through the public dashboard and waits for editor hydration. */
export async function createEditorProject(page: Page, prefix: string): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('Nombre del proyecto...').fill(`${prefix} ${Date.now()}`);
  await page.getByRole('button', { name: 'Crear' }).click();
  await expect(page).toHaveURL(/\/editor\//, { timeout: 15_000 });
}

/**
 * Records failures that would otherwise be easy to miss in a visually successful editor test.
 * Audio underruns are tracked separately because they are warnings rather than console errors.
 */
export function monitorPageFailures(page: Page): PageFailureMonitor {
  const monitor: PageFailureMonitor = { errors: [], underruns: [] };
  page.on('pageerror', (error) => monitor.errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') monitor.errors.push(`console: ${text}`);
    if (text.includes('Timeline audio underrun')) monitor.underruns.push(text);
  });
  return monitor;
}

/** Reads the precise clock value exposed beside the human-friendly timeline timestamp. */
export async function readTimelineTime(page: Page): Promise<number> {
  const value = await page.getByTestId('timeline-current-time').getAttribute('data-time-seconds');
  if (value === null) throw new Error('The timeline clock did not expose its precise time.');
  return Number.parseFloat(value);
}
