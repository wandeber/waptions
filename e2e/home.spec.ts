import { test, expect } from '@playwright/test';

test.describe('Home Page', () => {
  test('should expose the public dashboard without login', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Waptions' })).toBeVisible();
    await expect(page.getByText('Empieza algo nuevo')).toBeVisible();
  });

  test('should keep the login page hidden when auth is disabled', async ({ page }) => {
    await page.goto('/login');

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: 'Waptions' })).toBeVisible();
  });
}); 
