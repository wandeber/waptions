import { expect, test } from '@playwright/test';
import { createEditorProject } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

test.describe('editor persistence recovery', () => {
  test('surfaces a failed timeline transaction and persists the exact edit after retry', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await createEditorProject(page, 'Persistence retry');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('persistence-status-saved')).toBeVisible({ timeout: 30_000 });

    await page.evaluate(() => {
      const testWindow = window as typeof window & { restoreTimelineTransaction?: () => void };
      const prototype = IDBDatabase.prototype;
      const original = prototype.transaction;
      let failed = false;

      prototype.transaction = function transactionWithOneShotFailure(storeNames, mode, options) {
        if (!failed && this.name.startsWith('waptions-timelines-') && mode === 'readwrite') {
          failed = true;
          throw new DOMException('Injected one-shot timeline transaction failure.', 'UnknownError');
        }
        return original.call(this, storeNames, mode, options);
      };
      testWindow.restoreTimelineTransaction = () => {
        prototype.transaction = original;
        delete testWindow.restoreTimelineTransaction;
      };
    });

    await page.getByTitle('Add audio track').click();
    await expect(page.getByTestId('timeline-audio-track')).toHaveCount(1);
    const failure = page.getByTestId('persistence-status-error');
    await expect(failure).toContainText('Changes not saved', { timeout: 15_000 });
    await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible();

    await page.evaluate(() => {
      const testWindow = window as typeof window & { restoreTimelineTransaction?: () => void };
      testWindow.restoreTimelineTransaction?.();
    });
    await failure.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('persistence-status-saved')).toContainText('Saved', { timeout: 15_000 });

    await page.reload();
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('timeline-audio-track')).toHaveCount(1);
  });
});
