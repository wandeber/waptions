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
  const sourceCenterX = sourceBox.x + sourceBox.width / 2;
  const sourceCenterY = sourceBox.y + sourceBox.height / 2;
  await page.mouse.move(sourceCenterX, sourceCenterY);
  await page.mouse.down();
  await page.mouse.move(
    sourceCenterX + 8,
    sourceCenterY,
    { steps: 3 },
  );
  // A vertical lane move must not accidentally inherit the center x-coordinate of a full-width
  // row. Keeping the pointer on the clip's original x-position makes this helper express exactly
  // the membership change its callers intend to test.
  await page.mouse.move(sourceCenterX, targetBox.y + targetBox.height / 2, { steps: 8 });
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
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function beginHorizontalDrag(page: Page, source: Locator, deltaX: number): Promise<void> {
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error('Video clip drag geometry is not measurable.');
  const sourceCenterX = sourceBox.x + sourceBox.width / 2;
  const sourceCenterY = sourceBox.y + sourceBox.height / 2;
  await page.mouse.move(sourceCenterX, sourceCenterY);
  await page.mouse.down();
  await page.mouse.move(sourceCenterX + deltaX, sourceCenterY, { steps: 8 });
}

test.describe('video track editing', () => {
  test('moves video and follow-ripple subtitles atomically through undo and redo', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Atomic horizontal video drag');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);

    const videoClip = page.getByTestId('timeline-video-clip');
    await expect(videoClip).toHaveCount(1, { timeout: 30_000 });
    await page.getByTitle('Añadir subtítulo').click();
    const subtitleTextarea = page.locator('textarea').first();
    await subtitleTextarea.fill('Subtitle survives video drag');
    await subtitleTextarea.blur();
    const subtitleClip = page.getByTestId('timeline-subtitle-clip');
    await expect(subtitleClip).toHaveCount(1);

    // The defect only reproduced on tracks that follow project ripple. Toggle the public control
    // instead of seeding IndexedDB so this test covers the same path a user takes in the editor.
    await page.getByRole('button', {
      name: /unlinked video edit response: stay absolute/i,
    }).click();
    await page.getByTitle('Fit timeline to view').click();

    const initialVideoFrame = Number(await videoClip.getAttribute('data-preview-start-frame'));
    const initialVideoLeft = await videoClip.evaluate((element) => (element as HTMLElement).style.left);
    const initialSubtitleLeft = await subtitleClip.evaluate((element) => (element as HTMLElement).style.left);

    await beginHorizontalDrag(page, videoClip, 100);
    await expect(videoClip).toHaveAttribute('data-dragging', 'true');
    await expect.poll(async () => (
      Number(await videoClip.getAttribute('data-preview-start-frame'))
    )).toBeGreaterThan(initialVideoFrame);
    await expect(subtitleClip).toHaveCount(1);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    await page.mouse.up();

    await expect(videoClip).toHaveAttribute('data-dragging', 'false');
    const movedVideoFrame = Number(await videoClip.getAttribute('data-preview-start-frame'));
    const movedVideoLeft = await videoClip.evaluate((element) => (element as HTMLElement).style.left);
    const movedSubtitleLeft = await subtitleClip.evaluate((element) => (element as HTMLElement).style.left);
    expect(movedVideoFrame).toBeGreaterThan(initialVideoFrame);
    expect(movedVideoLeft).not.toBe(initialVideoLeft);
    expect(movedSubtitleLeft).toBe(movedVideoLeft);
    await expect(subtitleClip).toHaveCount(1);

    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(videoClip).toHaveAttribute('data-preview-start-frame', String(initialVideoFrame));
    await expect.poll(async () => (
      subtitleClip.evaluate((element) => (element as HTMLElement).style.left)
    )).toBe(initialSubtitleLeft);
    await expect(subtitleClip).toHaveCount(1);

    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(videoClip).toHaveAttribute('data-preview-start-frame', String(movedVideoFrame));
    await expect.poll(async () => (
      subtitleClip.evaluate((element) => (element as HTMLElement).style.left)
    )).toBe(movedSubtitleLeft);
    await expect(subtitleClip).toHaveCount(1);
    expect(failures.errors).toEqual([]);
  });

  test('previews snapping and invalid drops while fully restoring canceled video drags', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Video drag lifecycle');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles([
      mediaFixtures.videoA,
      mediaFixtures.videoB,
    ]);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2, { timeout: 30_000 });
    await page.getByTitle('Añadir subtítulo').click();
    const subtitleTextarea = page.locator('textarea').first();
    await subtitleTextarea.fill('Visible through every drag terminal');
    await subtitleTextarea.blur();
    await page.getByRole('button', {
      name: /unlinked video edit response: stay absolute/i,
    }).click();
    await page.getByRole('button', { name: 'Add video track' }).click();
    await page.getByTitle('Fit timeline to view').click();

    const secondClip = videoRows(page).nth(0).getByTestId('timeline-video-clip').nth(1);
    const initialFrame = Number(await secondClip.getAttribute('data-preview-start-frame'));
    const initialLeft = await secondClip.evaluate((element) => (element as HTMLElement).style.left);

    // The second clip begins on the first clip's end boundary. Moving inside the fifteen-pixel
    // tolerance must show the shared snap affordance while retaining the exact boundary frame.
    await beginHorizontalDrag(page, secondClip, 8);
    await expect(secondClip).toHaveAttribute('data-dragging', 'true');
    await expect(secondClip).toHaveAttribute('data-preview-start-frame', String(initialFrame));
    await expect(page.getByTestId('timeline-snap-indicator')).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(secondClip).toHaveAttribute('data-dragging', 'false');
    await expect(secondClip).toHaveAttribute('data-preview-start-frame', String(initialFrame));
    await expect(page.getByTestId('timeline-snap-indicator')).toHaveCount(0);
    await expect(page.locator('[data-video-track-insertion-index]')).toHaveCount(0);

    // A partial overlap is rejected before the terminal store command. Both the clip and lane use
    // the same invalid state, and releasing the pointer restores the persisted geometry exactly.
    const secondClipBox = await secondClip.boundingBox();
    if (!secondClipBox) throw new Error('Collision drag geometry is not measurable.');
    await beginHorizontalDrag(page, secondClip, -Math.max(20, secondClipBox.width / 4));
    await expect(secondClip).toHaveAttribute('data-drag-invalid', 'true');
    await expect(videoRows(page).nth(0)).toHaveAttribute('data-video-drag-invalid', 'true');
    await page.mouse.up();
    await expect(secondClip).toHaveAttribute('data-dragging', 'false');
    await expect(secondClip).toHaveAttribute('data-preview-start-frame', String(initialFrame));
    await expect(secondClip).toHaveCSS('left', initialLeft);

    // Releasing outside every explicit lane is also a rejected drop, not a best-effort move.
    await beginHorizontalDrag(page, secondClip, 40);
    await page.mouse.move(10, 10, { steps: 5 });
    await expect(secondClip).toHaveAttribute('data-drag-invalid', 'true');
    await page.mouse.up();
    await expect(secondClip).toHaveAttribute('data-dragging', 'false');
    await expect(secondClip).toHaveAttribute('data-preview-start-frame', String(initialFrame));
    await expect(secondClip).toHaveCSS('left', initialLeft);
    await expect(page.getByTestId('timeline-snap-indicator')).toHaveCount(0);
    await expect(page.locator('[data-video-track-insertion-index]')).toHaveCount(0);

    // A vertical move retains the horizontal frame and keeps the source lane populated, making
    // both memberships observable without relying on lane-pruning side effects.
    await pointerDrag(page, secondClip, videoRows(page).nth(1));
    await expect(videoRows(page).nth(0).getByTestId('timeline-video-clip')).toHaveCount(1);
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip')).toHaveCount(1);
    await expect(videoRows(page).nth(1).getByTestId('timeline-video-clip'))
      .toHaveAttribute('data-preview-start-frame', String(initialFrame));
    await expect(page.getByTestId('timeline-subtitle-clip')).toHaveCount(1);
    expect(failures.errors).toEqual([]);
  });

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
    // Track creation and its queued undo keep the same row count. Wait for the authoritative
    // engine projection instead of treating that unchanged count as command completion.
    await expect(page.locator(
      '[data-testid="timeline-video-clip"][data-dragging="true"]',
    )).toHaveCount(0);

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
    // The loaded project is engine-owned. Core cannot yet atomically add a second subtitle track
    // and make it the durable active track, so the compatibility adapter must fail closed instead
    // of partially creating a lane with different selection behavior.
    await expect(subtitleRows).toHaveCount(subtitleRowCount);
    await expect(page.getByTestId('persistence-status-error')).toBeVisible();

    expect(failures.errors).toEqual([]);
  });
});
