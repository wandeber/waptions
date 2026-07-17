import { expect, test } from '@playwright/test';
import { createEditorProject, monitorPageFailures } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

test.describe('media inspector history', () => {
  test('commits an outside draggable-number release exactly once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);

    await createEditorProject(page, 'Media inspector history');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);

    const videoClip = page.getByTestId('timeline-video-clip');
    await expect(videoClip).toHaveCount(1, { timeout: 30_000 });
    await videoClip.click();

    const gainField = page.getByRole('textbox', { name: 'Embedded audio gain' });
    await expect(gainField).toHaveValue('0');
    await expect(page.getByRole('slider')).toHaveCount(0);
    const fieldBox = await gainField.boundingBox();
    if (!fieldBox) throw new Error('The embedded audio gain field is not measurable.');

    // Drag the existing Blender-style number field beyond its maximum and release above the
    // control. Pointer capture must route that terminal event back without producing
    // a second history entry when the browser subsequently reports lost pointer capture.
    const fieldX = fieldBox.x + fieldBox.width / 2;
    const fieldY = fieldBox.y + fieldBox.height / 2;
    await page.mouse.move(fieldX, fieldY);
    await page.mouse.down();
    await page.mouse.move(fieldX + 160, fieldY, { steps: 5 });
    await page.mouse.move(fieldX + 160, fieldBox.y - 40);
    await page.mouse.up();

    await expect(gainField).toHaveValue('12');
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(gainField).toHaveValue('0');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(gainField).toHaveValue('12');

    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });

  test('cancels a draggable-number gesture with Escape until the pointer ends', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);

    await createEditorProject(page, 'Cancelled media slider');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);
    const videoClip = page.getByTestId('timeline-video-clip');
    await expect(videoClip).toHaveCount(1, { timeout: 30_000 });
    await videoClip.click();

    const gainField = page.getByRole('textbox', { name: 'Embedded audio gain' });
    const fieldBox = await gainField.boundingBox();
    if (!fieldBox) throw new Error('The embedded audio gain field is not measurable.');
    const fieldX = fieldBox.x + fieldBox.width / 2;
    const fieldY = fieldBox.y + fieldBox.height / 2;

    await page.mouse.move(fieldX, fieldY);
    await page.mouse.down();
    await page.mouse.move(fieldX + 160, fieldY, { steps: 5 });
    await expect(gainField).toHaveValue('12');
    await page.keyboard.press('Escape');
    await expect(gainField).toHaveValue('0');

    // Movement after cancellation must not reopen the terminal session before physical pointerup.
    await page.mouse.move(fieldX - 80, fieldY, { steps: 3 });
    await page.mouse.up();
    await expect(gainField).toHaveValue('0');

    // Import is the only durable command. One Undo removing the clip proves the cancelled field
    // produced zero commits; returning to zero proves its single cancellation restored baseline.
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(videoClip).toHaveCount(0);
    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });

  test('normalizes discrete fade drafts before deciding whether to create history', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);

    await createEditorProject(page, 'Discrete fade precision');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);

    const videoClip = page.getByTestId('timeline-video-clip');
    await expect(videoClip).toHaveCount(1, { timeout: 30_000 });
    await videoClip.click();

    const fadeInField = page.getByRole('textbox', { name: 'Fade in' });
    await fadeInField.fill('0.4');
    await fadeInField.press('Enter');
    await expect(fadeInField).toHaveValue('0');

    // Rounding back to the existing durable frame must remain a no-op. Therefore the first Undo
    // still targets the import command instead of a phantom fade edit.
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(videoClip).toHaveCount(0);
    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });

  test('rounds negative gain midpoints symmetrically and keeps Undo aligned', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);

    await createEditorProject(page, 'Symmetric gain precision');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);

    const videoClip = page.getByTestId('timeline-video-clip');
    await expect(videoClip).toHaveCount(1, { timeout: 30_000 });
    await videoClip.click();

    const gainField = page.getByRole('textbox', { name: 'Embedded audio gain' });
    await gainField.fill('-0.05');
    await gainField.press('Enter');
    await expect(gainField).toHaveValue('-0.1');

    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(gainField).toHaveValue('0');
    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });

  test('presents imported sample-accurate fades as canonical milliseconds', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);

    await createEditorProject(page, 'Sample fade precision');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles([
      mediaFixtures.videoA,
      mediaFixtures.audio,
    ]);

    const audioClip = page.getByTestId('timeline-audio-clip');
    await expect(audioClip).toHaveCount(1, { timeout: 30_000 });
    await audioClip.click();

    await expect(page.getByText('ms', { exact: true })).toHaveCount(2);
    const fadeInField = page.getByRole('textbox', { name: 'Fade in' });
    await fadeInField.fill('0.0001');
    await fadeInField.press('Enter');
    await expect(fadeInField).toHaveValue('0');

    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });
});
