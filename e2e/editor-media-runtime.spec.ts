import { expect, test } from '@playwright/test';
import { createEditorProject, monitorPageFailures, readTimelineTime } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

async function classifyPreviewCenterPixel(page: import('@playwright/test').Page) {
  return page.getByTestId('video-preview-canvas').evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)
      || element.dataset.hasContent !== 'true'
      || element.width === 0
      || element.height === 0) {
      return 'missing';
    }
    const context = element.getContext('2d');
    if (!context) return 'missing';
    const pixel = context.getImageData(
      Math.floor(element.width / 2),
      Math.floor(element.height / 2),
      1,
      1,
    ).data;
    // Direct indexing remains compatible with the project's ES5 target without requiring
    // downlevel iteration for Uint8ClampedArray.
    const red = pixel[0];
    const green = pixel[1];
    const blue = pixel[2];
    if (red > green + 50 && red > blue + 50) return 'red';
    if (blue > red + 50 && blue > green + 50) return 'blue';
    return `other:${red},${green},${blue}`;
  });
}

test.describe('real browser media runtime', () => {
  test('keeps AudioWorklet transport stable across clips, edits, pause, seek, and resume', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);

    await createEditorProject(page, 'Media runtime');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles([
      mediaFixtures.videoA,
      mediaFixtures.videoB,
      mediaFixtures.audio,
    ]);

    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(1);
    await page.getByTitle('Fit timeline to view').click();
    await expect(page.getByTestId('linked-video-waveform').first())
      .toHaveAttribute('data-waveform-state', 'ready', { timeout: 60_000 });
    await expect(page.getByTestId('timeline-audio-clip').locator('canvas'))
      .toHaveAttribute('data-waveform-state', 'ready', { timeout: 60_000 });
    // The first fixture is a solid red video. Sampling the actual published canvas catches a
    // preview that advances its transport while every cold decode is discarded as obsolete.
    await expect.poll(() => classifyPreviewCenterPixel(page), { timeout: 30_000 }).toBe('red');

    await page.getByRole('button', { name: 'Play timeline' }).click();
    await expect.poll(() => readTimelineTime(page), { timeout: 15_000 }).toBeGreaterThan(0.45);

    // A real mix mutation while the worklet owns the clock must re-prime atomically without
    // dropping transport or rebuilding unrelated source sessions.
    const beforeMixEdit = await readTimelineTime(page);
    await page.getByRole('button', { name: /^Mute / }).first().click();
    await expect(page.getByRole('button', { name: /^Unmute / }).first()).toBeVisible();
    await expect.poll(() => readTimelineTime(page), { timeout: 15_000 })
      .toBeGreaterThan(beforeMixEdit + 0.3);

    // The fixture boundary is exactly two seconds. Crossing it proves that sequential source
    // sessions and the project-space audio clock remain continuous. The blue pixel assertion also
    // proves that real preview frames progress across the cut instead of only advancing the clock.
    await expect.poll(() => readTimelineTime(page), { timeout: 20_000 }).toBeGreaterThan(2.2);
    await expect.poll(() => classifyPreviewCenterPixel(page), { timeout: 15_000 }).toBe('blue');
    await page.getByRole('button', { name: 'Pause timeline' }).click();
    const pausedAt = await readTimelineTime(page);
    await page.waitForTimeout(500);
    expect(Math.abs((await readTimelineTime(page)) - pausedAt)).toBeLessThanOrEqual(1 / 30);

    // Disable magnetic snapping so this gesture exercises an ordinary seek rather than snapping
    // to the source boundary that was just crossed.
    await page.getByTitle('Snap').click();
    const ruler = page.getByTestId('timeline-ruler');
    const rulerBox = await ruler.boundingBox();
    if (!rulerBox) throw new Error('The timeline ruler is not measurable.');
    const rulerDuration = Number(await ruler.getAttribute('data-duration-seconds'));
    if (!Number.isFinite(rulerDuration) || rulerDuration <= 1) {
      throw new Error('The timeline ruler did not expose a valid duration.');
    }
    // The editor keeps a minimum ruler duration beyond the four-second fixture content. Convert
    // the intended one-second seek to a rendered coordinate instead of assuming content fills it.
    await ruler.click({ position: { x: rulerBox.width / rulerDuration, y: rulerBox.height / 2 } });
    const seekedAt = await readTimelineTime(page);
    expect(seekedAt).toBeGreaterThan(0.7);
    expect(seekedAt).toBeLessThan(1.3);

    await page.getByRole('button', { name: 'Play timeline' }).click();
    await expect.poll(() => readTimelineTime(page), { timeout: 15_000 })
      .toBeGreaterThan(seekedAt + 0.35);
    await page.getByRole('button', { name: 'Pause timeline' }).click();

    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });
});
