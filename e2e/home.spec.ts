import { test, expect } from '@playwright/test';

test.describe('Home Page', () => {
  test('should load the home page successfully', async ({ page }) => {
    await page.goto('/');
    
    // Verify that the main components are present
    await expect(page.getByRole('heading', { name: /waptions/i })).toBeVisible();
    
    // Verify that the video editor components are present
    await expect(page.locator('[data-testid="video-viewport"]')).toBeVisible();
    await expect(page.locator('[data-testid="subtitle-editor"]')).toBeVisible();
  });

  test('should have working video upload functionality', async ({ page }) => {
    await page.goto('/');
    
    // Verify that the upload zone is present and interactive
    const uploadZone = page.locator('[data-testid="upload-zone"]');
    await expect(uploadZone).toBeVisible();
    await expect(uploadZone).toBeEnabled();
  });
}); 