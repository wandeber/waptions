import { expect, test } from '@playwright/test';

test.describe('editor project load failure', () => {
  test('keeps a missing route actionable without mounting an unbound editor', async ({ page }) => {
    await page.goto('/editor/project-that-does-not-exist');

    await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Projects' })).toBeVisible();
    await expect(page.getByTitle('Download project file (.waptions)')).toHaveCount(0);
  });
});
