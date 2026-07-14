import { expect, test } from '@playwright/test';
import { createEditorProject, monitorPageFailures } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

test.describe('media inspector history', () => {
  test('commits an outside slider release exactly once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);

    await createEditorProject(page, 'Media inspector history');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);

    const videoClip = page.getByTestId('timeline-video-clip');
    await expect(videoClip).toHaveCount(1, { timeout: 30_000 });
    await videoClip.click();

    const gainSlider = page.getByRole('slider', { name: 'Embedded audio gain' });
    await expect(gainSlider).toHaveValue('0');
    const sliderBox = await gainSlider.boundingBox();
    if (!sliderBox) throw new Error('The embedded audio gain slider is not measurable.');

    // Start on the current zero-dB thumb, drag beyond the horizontal range, and release above the
    // control. Pointer capture must route that terminal event back to the slider without producing
    // a second history entry when the browser subsequently reports lost pointer capture.
    const minimum = Number(await gainSlider.getAttribute('min'));
    const maximum = Number(await gainSlider.getAttribute('max'));
    const initial = Number(await gainSlider.inputValue());
    const thumbRatio = (initial - minimum) / (maximum - minimum);
    const thumbX = sliderBox.x + sliderBox.width * thumbRatio;
    const thumbY = sliderBox.y + sliderBox.height / 2;
    await page.mouse.move(thumbX, thumbY);
    await page.mouse.down();
    await page.mouse.move(sliderBox.x + sliderBox.width + 12, thumbY, { steps: 5 });
    await page.mouse.move(sliderBox.x + sliderBox.width + 12, sliderBox.y - 40);
    await page.mouse.up();

    await expect(gainSlider).toHaveValue('12');
    await page.getByTitle('Deshacer (Ctrl+Z)').click();
    await expect(gainSlider).toHaveValue('0');
    await page.getByTitle('Rehacer (Ctrl+Shift+Z)').click();
    await expect(gainSlider).toHaveValue('12');

    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });

  test('suppresses range changes after Escape until the cancelled pointer ends', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);

    await createEditorProject(page, 'Cancelled media slider');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);
    const videoClip = page.getByTestId('timeline-video-clip');
    await expect(videoClip).toHaveCount(1, { timeout: 30_000 });
    await videoClip.click();

    const gainSlider = page.getByRole('slider', { name: 'Embedded audio gain' });
    const sliderBox = await gainSlider.boundingBox();
    if (!sliderBox) throw new Error('The embedded audio gain slider is not measurable.');
    const minimum = Number(await gainSlider.getAttribute('min'));
    const maximum = Number(await gainSlider.getAttribute('max'));
    const initial = Number(await gainSlider.inputValue());
    const thumbX = sliderBox.x + sliderBox.width * ((initial - minimum) / (maximum - minimum));
    const thumbY = sliderBox.y + sliderBox.height / 2;

    await page.mouse.move(thumbX, thumbY);
    await page.mouse.down();
    await page.mouse.move(sliderBox.x + sliderBox.width + 12, thumbY, { steps: 5 });
    await expect(gainSlider).toHaveValue('12');
    await gainSlider.press('Escape');
    await expect(gainSlider).toHaveValue('0');

    // This synthetic range movement represents the browser's late change after Escape. It must
    // stay suppressed until the physical pointerup instead of becoming a keyboard-style commit.
    await gainSlider.evaluate((element) => {
      const input = element as HTMLInputElement;
      const nativeValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      if (!nativeValueSetter) throw new Error('The range input value setter is unavailable.');
      nativeValueSetter.call(input, '-12');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.mouse.up();
    await expect(gainSlider).toHaveValue('0');

    // Import is the only durable command. One Undo removing the clip proves the cancelled slider
    // produced zero commits; returning to zero proves its single cancellation restored baseline.
    await page.getByTitle('Deshacer (Ctrl+Z)').click();
    await expect(videoClip).toHaveCount(0);
    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });
});
