import { expect, test } from '@playwright/test';
import { createEditorProject, monitorPageFailures } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

test.describe('contextual scene cut detection', () => {
  test('opens a modal for selected clips or an entire video track', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Contextual scene cuts');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles([
      mediaFixtures.videoA,
      mediaFixtures.videoB,
    ]);

    const clips = page.getByTestId('timeline-video-clip');
    await expect(clips).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Detect scene cuts' })).toHaveCount(0);

    const firstClip = clips.first();
    const secondClip = clips.nth(1);
    await firstClip.click();
    const additiveModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await secondClip.click({ modifiers: [additiveModifier] });
    await expect(firstClip).toHaveClass(/ring-1/);
    await expect(secondClip).toHaveClass(/ring-1/);

    await secondClip.click({ button: 'right' });
    await expect(page.getByTestId('separate-audio-action')).toBeVisible();
    await page.getByTestId('detect-scene-cuts-action').click();

    const dialog = page.getByTestId('video-cut-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[value="selection"]')).toBeChecked();
    await expect(dialog).toContainText('Selected clips (2)');
    await expect(dialog.getByRole('slider')).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Sensitivity threshold' })).toHaveValue('0.35');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(secondClip).toBeFocused();
    await expect(firstClip).toHaveClass(/ring-1/);
    await expect(secondClip).toHaveClass(/ring-1/);

    const trackHeader = page.getByTestId('timeline-video-track-header');
    await expect(trackHeader).toHaveCount(1);
    await trackHeader.click({ button: 'right' });
    await expect(page.getByTestId('separate-audio-action')).toHaveCount(0);
    await page.getByTestId('detect-scene-cuts-action').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[value="track"]')).toBeChecked();
    await expect(dialog).toContainText('Entire track');
    await expect(dialog).toContainText('All video tracks');
    await dialog.locator('input[value="all-tracks"]').check();
    await expect(dialog.locator('input[value="all-tracks"]')).toBeChecked();

    // A modal must own destructive shortcuts even before its async action starts.
    await page.keyboard.press('Backspace');
    await expect(clips).toHaveCount(2);

    await dialog.getByRole('button', { name: 'Detect cuts' }).click();
    await expect(dialog).toHaveAttribute('aria-busy', 'true');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(clips).toHaveCount(2);

    await expect(dialog).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(dialog.getByRole('button', { name: 'Close scene cut detection' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trackHeader).toBeFocused();

    expect(failures.errors).toEqual([]);
  });
});
