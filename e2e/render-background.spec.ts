import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { createEditorProject, monitorPageFailures } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

const EDITOR_DOCUMENT_V4_KEY = 'editor-document-v4';

async function rewriteRenderBackground(
  page: Page,
  projectId: string,
  backgroundColor: string | null,
): Promise<void> {
  await page.evaluate(async ({ databaseName, documentKey, color }) => {
    const request = indexedDB.open(databaseName);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('timeline', 'readwrite');
        const store = transaction.objectStore('timeline');
        const documentRequest = store.get(documentKey);
        documentRequest.onsuccess = () => {
          const record = documentRequest.result as {
            id: string;
            data: {
              renderBackgroundColor?: string;
              videoClips: Array<{ timelineStartFrame: number }>;
            };
          };
          if (!record?.data?.videoClips[0]) {
            transaction.abort();
            return;
          }
          if (color === null) delete record.data.renderBackgroundColor;
          else record.data.renderBackgroundColor = color;
          // A one-second leading gap makes the project background observable independently of
          // source pixels while retaining real media for preview/export sizing and duration.
          record.data.videoClips[0].timelineStartFrame = 30;
          store.put(record);
          const keysRequest = store.getAllKeys();
          keysRequest.onsuccess = () => {
            keysRequest.result
              .map(String)
              .filter((key) => key.startsWith('editor-history:')
                || key.startsWith('editor-recovery:')
                || key.startsWith('editor-engine:'))
              .forEach((key) => store.delete(key));
          };
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Background fixture transaction aborted.'));
      });
    } finally {
      database.close();
    }
  }, {
    databaseName: `waptions-timelines-${projectId}`,
    documentKey: EDITOR_DOCUMENT_V4_KEY,
    color: backgroundColor,
  });
}

async function readPreviewCenterPixel(page: Page): Promise<number[]> {
  return page.getByTestId('video-preview-canvas').evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)
      || element.dataset.hasContent !== 'true'
      || element.width === 0
      || element.height === 0) {
      return [];
    }
    const context = element.getContext('2d');
    if (!context) return [];
    const pixel = context.getImageData(
      Math.floor(element.width / 2),
      Math.floor(element.height / 2),
      1,
      1,
    ).data;
    return [pixel[0], pixel[1], pixel[2]];
  });
}

test.describe('durable render background', () => {
  test('keeps preview and export in parity while old V4 projects remain black', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    });

    await createEditorProject(page, 'Render background');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('persistence-status-saved')).toBeVisible({ timeout: 30_000 });
    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    if (!projectId) throw new Error('The editor URL does not contain a project ID.');

    await rewriteRenderBackground(page, projectId, '#123abc');
    await page.reload();
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => readPreviewCenterPixel(page), { timeout: 30_000 })
      .toEqual([18, 58, 188]);

    await page.getByTitle('Export video with timeline audio and subtitles').click();
    await page.getByRole('button', { name: 'WebM (VP9)' }).click();
    await page.getByLabel('Include timeline audio').uncheck();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    const download = await downloadPromise;
    const outputPath = await download.path();
    if (!outputPath) throw new Error('Playwright did not retain the exported artifact.');
    const artifactBytes = Array.from(await readFile(outputPath));
    const exportedPixel = await page.evaluate(async (bytes) => {
      const video = document.createElement('video');
      video.muted = true;
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
      video.src = url;
      try {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(video.error ?? new Error('Export decode failed.')), { once: true });
        });
        const seeked = new Promise<void>((resolve) => video.addEventListener('seeked', () => resolve(), { once: true }));
        video.currentTime = 0.25;
        await seeked;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('The browser could not create an export probe canvas.');
        context.drawImage(video, 0, 0);
        const pixel = context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
        return [pixel[0], pixel[1], pixel[2]];
      } finally {
        URL.revokeObjectURL(url);
      }
    }, artifactBytes);
    expect(exportedPixel[0]).toBeLessThan(50);
    expect(exportedPixel[1]).toBeGreaterThan(35);
    expect(exportedPixel[1]).toBeLessThan(90);
    expect(exportedPixel[2]).toBeGreaterThan(150);

    await rewriteRenderBackground(page, projectId, null);
    await page.reload();
    await expect.poll(() => readPreviewCenterPixel(page), { timeout: 30_000 })
      .toEqual([0, 0, 0]);
    expect(failures.errors).toEqual([]);
  });
});
