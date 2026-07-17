import { expect, test, type Locator, type Page } from '@playwright/test';
import { createEditorProject, monitorPageFailures } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

const videoRows = (page: Page) => page.locator(
  '[data-testid="timeline-row-content"][data-row-kind="video"]',
);

async function pointerDrag(page: Page, source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Video track drag geometry is not measurable.');
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 8,
    sourceBox.y + sourceBox.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function pointerDragToNewTrack(page: Page, source: Locator, insertionIndex: number): Promise<void> {
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error('Video clip drag geometry is not measurable.');
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 8, sourceBox.y + sourceBox.height / 2, { steps: 3 });
  const insertion = page.locator(`[data-video-track-insertion-index="${insertionIndex}"]`);
  await expect(insertion).toBeVisible();
  const targetBox = await insertion.boundingBox();
  if (!targetBox) throw new Error('New video track insertion target is not measurable.');
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe('video track editing', () => {
  test('adds, moves, creates, prunes, reloads, and restores vertical video membership', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Video lanes');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles([
      mediaFixtures.videoA,
      mediaFixtures.videoB,
    ]);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2, { timeout: 30_000 });
    await page.getByTitle('Fit timeline to view').click();

    const playbackToggle = page.getByTestId('timeline-playback-toggle');
    await expect(playbackToggle).toHaveAccessibleName('Play timeline');
    const firstClip = page.getByTestId('timeline-video-clip').first();
    const firstClipLabel = await firstClip.getAttribute('aria-label');
    const firstSourceName = firstClipLabel?.split(', video clip')[0];
    if (!firstSourceName) throw new Error('The first clip has no accessible source name.');
    await firstClip.focus();
    await firstClip.press('Space');
    await expect(page.getByTestId('media-inspector')).toContainText(firstSourceName);
    await expect(playbackToggle).toHaveAccessibleName('Play timeline');

    const secondKeyboardClip = page.getByTestId('timeline-video-clip').nth(1);
    const secondClipLabel = await secondKeyboardClip.getAttribute('aria-label');
    const secondSourceName = secondClipLabel?.split(', video clip')[0];
    if (!secondSourceName) throw new Error('The second clip has no accessible source name.');
    await secondKeyboardClip.focus();
    await secondKeyboardClip.press('Enter');
    await expect(page.getByTestId('media-inspector')).toContainText(secondSourceName);

    const trackControlsHeader = page.getByTestId('timeline-track-controls-header');
    await expect(trackControlsHeader).toContainText('Tracks');
    const timelineEditTools = page.getByRole('generic', { name: 'Timeline edit tools' });
    for (const name of ['Add video track', 'Add audio track', 'Add subtitle track']) {
      await expect(trackControlsHeader.getByRole('button', { name })).toBeVisible();
      await expect(timelineEditTools.getByRole('button', { name })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Add video track' }).click();
    await expect(videoRows(page)).toHaveCount(2);

    const secondClip = page.getByTestId('timeline-video-clip').nth(1);
    const secondClipBox = await secondClip.boundingBox();
    const secondRowBox = await videoRows(page).nth(1).boundingBox();
    if (!secondClipBox || !secondRowBox) throw new Error('Non-primary pointer geometry is not measurable.');
    await secondClip.dispatchEvent('pointerdown', {
      pointerId: 42,
      pointerType: 'touch',
      button: 0,
      buttons: 1,
      isPrimary: false,
      clientX: secondClipBox.x + secondClipBox.width / 2,
      clientY: secondClipBox.y + secondClipBox.height / 2,
    });
    await page.evaluate(({ targetX, targetY }) => {
      window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: 42,
        pointerType: 'touch',
        button: -1,
        buttons: 1,
        isPrimary: false,
        clientX: targetX,
        clientY: targetY,
        bubbles: true,
        cancelable: true,
      }));
      window.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 42,
        pointerType: 'touch',
        button: 0,
        buttons: 0,
        isPrimary: false,
        clientX: targetX,
        clientY: targetY,
        bubbles: true,
        cancelable: true,
      }));
    }, {
      targetX: secondRowBox.x + secondRowBox.width / 2,
      targetY: secondRowBox.y + secondRowBox.height / 2,
    });
    await expect(videoRows(page).nth(0).getByTestId('timeline-video-clip')).toHaveCount(2);
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip')).toHaveCount(0);
    await expect(page.locator('[data-video-track-insertion-index]')).toHaveCount(0);

    const horizontalPosition = await secondClip.evaluate((element) => (element as HTMLElement).style.left);
    await pointerDrag(page, secondClip, videoRows(page).nth(1));
    await expect(videoRows(page).nth(0).getByTestId('timeline-video-clip')).toHaveCount(1);
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip')).toHaveCount(1);
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip')).toHaveCSS('left', horizontalPosition);

    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(videoRows(page).nth(0).getByTestId('timeline-video-clip')).toHaveCount(2);
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip')).toHaveCount(0);
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip')).toHaveCount(1);

    await page.getByTitle(/^Save changes \(/).click();
    await expect(page.getByTitle(/^All changes saved \(/)).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(videoRows(page)).toHaveCount(2);
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip')).toHaveCount(1);

    await videoRows(page).nth(1).getByTestId('timeline-video-clip').click();
    const trackSelect = page.getByRole('combobox', { name: 'Video track', exact: true });
    await expect(trackSelect).toBeVisible();
    const firstTrackId = await trackSelect.locator('option').first().getAttribute('value');
    if (!firstTrackId) throw new Error('The first video track has no durable ID.');
    await trackSelect.selectOption(firstTrackId);
    await expect(videoRows(page)).toHaveCount(1);
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(videoRows(page)).toHaveCount(2);
    await videoRows(page).nth(1).getByTestId('timeline-video-clip').click();
    const newTrackButton = page.getByRole('button', { name: 'New video track' });
    await newTrackButton.focus();
    await newTrackButton.press('Enter');
    await expect(videoRows(page)).toHaveCount(2);
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(videoRows(page)).toHaveCount(2);

    await pointerDragToNewTrack(page, videoRows(page).nth(1).getByTestId('timeline-video-clip'), 2);
    // The emptied source lane is removed in the same transaction, so creating the new lane keeps
    // the lane count stable instead of leaving a permanent blank row behind.
    await expect(videoRows(page)).toHaveCount(2);
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip')).toHaveCount(1);

    await page.getByTestId('delete-selected-media').click();
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1);
    await expect(videoRows(page)).toHaveCount(1);
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(videoRows(page)).toHaveCount(2);
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(videoRows(page)).toHaveCount(1);

    // The target lane atomically replaces the emptied sole source lane. Deleting the moved clip
    // must then keep that final lane as the editor's required empty video lane.
    await page.getByTestId('timeline-video-clip').click();
    await page.getByRole('button', { name: 'New video track' }).click();
    await expect(videoRows(page)).toHaveCount(1);
    await expect(videoRows(page).getByTestId('timeline-video-clip')).toHaveCount(1);
    await page.getByTestId('delete-selected-media').click();
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(0);
    await expect(videoRows(page)).toHaveCount(1);

    const subtitleRows = page.locator(
      '[data-testid="timeline-row-content"][data-row-kind="subtitle"]',
    );
    const subtitleRowCount = await subtitleRows.count();
    await trackControlsHeader.getByRole('button', { name: 'Add subtitle track' }).click();
    await expect(subtitleRows).toHaveCount(subtitleRowCount + 1);

    expect(failures.errors).toEqual([]);
  });
});
