import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const fixturePaths = [
  process.env.WAPTIONS_E2E_VIDEO_A,
  process.env.WAPTIONS_E2E_VIDEO_B,
  process.env.WAPTIONS_E2E_AUDIO,
];

test.describe('linked and independent timeline audio', () => {
  test('imports, separates, edits, persists, and restores a complete audio graph', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    test.skip(
      fixturePaths.some((path) => !path || !existsSync(path)),
      'Set WAPTIONS_E2E_VIDEO_A, WAPTIONS_E2E_VIDEO_B, and WAPTIONS_E2E_AUDIO to real local media files.',
    );
    const [videoA, videoB, audio] = fixturePaths as [string, string, string];

    await page.goto('/');
    await page.getByPlaceholder('Nombre del proyecto...').fill(`Audio editor ${Date.now()}`);
    await page.getByRole('button', { name: 'Crear' }).click();
    await expect(page).toHaveURL(/\/editor\//);

    const mediaInput = page.locator('input[type="file"][accept="video/*,audio/*"]');
    await mediaInput.setInputFiles([videoA, videoB, audio]);

    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2);
    await expect(page.getByTestId('linked-video-waveform')).toHaveCount(2);
    await expect(page.getByTestId('timeline-audio-track')).toHaveCount(1);
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(1);

    // Waveform extraction is viewport-driven. Fit both clips before requiring their canvases to
    // be ready so the assertion describes visible editor behavior rather than offscreen prefetch.
    await page.getByTitle('Fit timeline to view').click();
    await expect(page.getByTestId('timeline-video-clip').last()).toBeInViewport();
    const linkedWaveforms = page.getByTestId('linked-video-waveform');
    for (let index = 0; index < 2; index += 1) {
      const waveform = linkedWaveforms.nth(index);
      await expect(waveform).toHaveAttribute('data-waveform-state', 'ready', { timeout: 60_000 });
      const geometry = await waveform.evaluate((canvas) => {
        const clip = canvas.closest<HTMLElement>('[data-testid="timeline-video-clip"]');
        if (!clip) throw new Error('The linked waveform has no owning video clip.');
        const clipBounds = clip.getBoundingClientRect();
        const waveformBounds = canvas.getBoundingClientRect();
        return {
          topRatio: (waveformBounds.top - clipBounds.top) / clipBounds.height,
          heightRatio: waveformBounds.height / clipBounds.height,
        };
      });
      expect(geometry.topRatio).toBeGreaterThan(0.45);
      expect(geometry.topRatio).toBeLessThan(0.55);
      expect(geometry.heightRatio).toBeGreaterThan(0.45);
      expect(geometry.heightRatio).toBeLessThan(0.55);
    }

    const firstVideo = page.getByTestId('timeline-video-clip').first();
    await firstVideo.click({ button: 'right' });
    await page.getByTestId('separate-audio-action').click();
    await expect(page.getByTestId('timeline-audio-track')).toHaveCount(2);
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(2);
    await expect(page.getByTestId('linked-video-waveform')).toHaveCount(1);

    // A detached parent remains detached. Reopening its context menu exposes a disabled terminal
    // action and must not create a second independent copy.
    await firstVideo.click({ button: 'right' });
    await expect(page.getByTestId('separate-audio-action')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(2);

    await page.getByTitle('Deshacer (Ctrl+Z)').click();
    await expect(page.getByTestId('timeline-audio-track')).toHaveCount(1);
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(1);
    await expect(page.getByTestId('linked-video-waveform')).toHaveCount(2);

    await firstVideo.focus();
    await firstVideo.press('Shift+F10');
    await expect(page.getByTestId('media-context-menu')).toBeVisible();
    await page.getByTestId('separate-audio-action').click();
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(2);

    // Move and trim the imported clip independently. The video sequence must remain unchanged.
    const importedAudio = page.getByTestId('timeline-audio-clip').first();
    const initialLeft = await importedAudio.evaluate((element) => parseFloat(element.style.left));
    await importedAudio.focus();
    await importedAudio.press('ArrowRight');
    await expect.poll(() => importedAudio.evaluate((element) => parseFloat(element.style.left)))
      .toBeGreaterThan(initialLeft);

    const initialWidth = await importedAudio.evaluate((element) => parseFloat(element.style.width));
    const trimHandle = importedAudio.getByTestId('audio-trim-right');
    const trimBox = await trimHandle.boundingBox();
    if (!trimBox) throw new Error('The imported audio trim handle is not measurable.');
    await page.mouse.move(trimBox.x + trimBox.width / 2, trimBox.y + trimBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(trimBox.x - 20, trimBox.y + trimBox.height / 2);
    await page.mouse.up();
    await expect.poll(() => importedAudio.evaluate((element) => parseFloat(element.style.width)))
      .toBeLessThan(initialWidth);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2);

    // Move the playhead into the selected audio interval, split it, then delete only the newly
    // selected right half. The ruler is the sibling immediately after the synchronized playhead
    // overlay; clicking it exercises the same frame-snapped seek path as a real editor gesture.
    // At fit zoom the snap threshold spans more than this short fixture, so disable magnetic snap
    // before clicking its visual center instead of letting the gesture collapse back to frame 0.
    await page.getByTitle('Snap').click();
    const ruler = page.locator('#timeline-playhead-sync').locator('xpath=../following-sibling::div[1]');
    const [audioBox, rulerBox] = await Promise.all([importedAudio.boundingBox(), ruler.boundingBox()]);
    if (!audioBox || !rulerBox) throw new Error('The selected audio clip or ruler is not measurable.');
    await ruler.click({
      position: {
        x: audioBox.x + audioBox.width / 2 - rulerBox.x,
        y: Math.min(16, rulerBox.height / 2),
      },
    });
    await importedAudio.click();
    await page.getByTestId('split-selected-media').click();
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(3);
    await page.getByTestId('delete-selected-media').click();
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(2);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2);

    await page.getByTestId('timeline-audio-clip').first().click();
    const mediaInspector = page.getByTestId('media-inspector');
    const inspectorPanel = mediaInspector.locator('..');
    await expect(mediaInspector).toBeVisible();
    await page.getByTitle('Hide inspector').click();
    await expect(inspectorPanel).toHaveAttribute('aria-hidden', 'true');
    await page.getByTitle('Show inspector').click();
    await expect(inspectorPanel).toHaveAttribute('aria-hidden', 'false');
    await expect(mediaInspector).toBeVisible();

    // Flush the coalesced IndexedDB writer before reloading so the assertion validates the V3
    // manifest and typed audio File restoration rather than merely the current Zustand state.
    const saveButton = page.getByTitle('Guardar cambios');
    if (await saveButton.isVisible().catch(() => false)) await saveButton.click();
    await page.reload();

    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2);
    await expect(page.getByTestId('linked-video-waveform')).toHaveCount(1);
    await expect(page.getByTestId('timeline-audio-track')).toHaveCount(2);
    await expect(page.getByTestId('timeline-audio-clip')).toHaveCount(2);

    // Leave the persisted project framed as a complete editor overview. Besides producing useful
    // screenshot evidence, this verifies that the fit command accounts for the full two-video
    // sequence and both independent audio lanes after IndexedDB restoration.
    await page.getByTitle('Fit timeline to view').click();
    await expect(page.getByTestId('timeline-video-clip').last()).toBeInViewport();
    await expect(page.getByTestId('linked-video-waveform'))
      .toHaveAttribute('data-waveform-state', 'ready', { timeout: 60_000 });
    const restoredAudioWaveforms = page.getByTestId('timeline-audio-clip').locator('canvas');
    await expect(restoredAudioWaveforms).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      await expect(restoredAudioWaveforms.nth(index))
        .toHaveAttribute('data-waveform-state', 'ready', { timeout: 60_000 });
    }

    const timelineDivider = page.getByTitle('Drag to resize the timeline');
    const dividerBox = await timelineDivider.boundingBox();
    if (!dividerBox) throw new Error('The timeline resize divider is not measurable.');
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y - 120);
    await page.mouse.up();
    await expect(page.getByTestId('timeline-audio-track').last()).toBeInViewport();
  });
});
