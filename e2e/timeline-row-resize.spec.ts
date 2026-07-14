import { expect, test, type Locator, type Page } from '@playwright/test';

type RowKind = 'subtitle' | 'video' | 'audio';

const row = (page: Page, region: 'header' | 'content', kind: RowKind): Locator => (
  page.locator(`[data-testid="timeline-row-${region}"][data-row-kind="${kind}"]`).first()
);

const resizeHandle = (page: Page, kind: RowKind): Locator => (
  page.locator(`[data-testid="timeline-row-resize-handle"][data-row-kind="${kind}"]`).first()
);

const measuredHeight = async (locator: Locator): Promise<number> => {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error('The timeline row is not measurable.');
  return bounds.height;
};

test.describe('timeline row sizing', () => {
  test('resizes subtitle, video, and audio rows independently while keeping columns aligned', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByPlaceholder('Nombre del proyecto...').fill(`Resizable rows ${Date.now()}`);
    await page.getByRole('button', { name: 'Crear' }).click();
    // Project creation flushes the initial IndexedDB document before navigation. Cold browser or
    // dev-server starts can legitimately exceed Playwright's default five-second expect timeout.
    await expect(page).toHaveURL(/\/editor\//, { timeout: 15_000 });

    const subtitleHeader = row(page, 'header', 'subtitle');
    const subtitleContent = row(page, 'content', 'subtitle');
    const videoHeader = row(page, 'header', 'video');
    const videoContent = row(page, 'content', 'video');
    await expect(subtitleHeader).toBeVisible();
    await expect(videoHeader).toBeVisible();
    expect(await measuredHeight(subtitleHeader)).toBe(64);
    expect(await measuredHeight(subtitleContent)).toBe(64);
    expect(await measuredHeight(videoHeader)).toBe(64);
    expect(await measuredHeight(videoContent)).toBe(64);

    const subtitleHandle = resizeHandle(page, 'subtitle');
    const subtitleHandleBounds = await subtitleHandle.boundingBox();
    if (!subtitleHandleBounds) throw new Error('The subtitle resize handle is not measurable.');
    await page.mouse.move(
      subtitleHandleBounds.x + subtitleHandleBounds.width / 2,
      subtitleHandleBounds.y + subtitleHandleBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      subtitleHandleBounds.x + subtitleHandleBounds.width / 2,
      subtitleHandleBounds.y + subtitleHandleBounds.height / 2 + 28,
    );
    await page.mouse.up();

    await expect.poll(() => measuredHeight(subtitleHeader)).toBe(92);
    expect(await measuredHeight(subtitleContent)).toBe(92);
    expect(await measuredHeight(videoHeader)).toBe(64);
    expect(await measuredHeight(videoContent)).toBe(64);

    const videoHandle = resizeHandle(page, 'video');
    await videoHandle.focus();
    await videoHandle.press('Shift+ArrowDown');
    await expect.poll(() => measuredHeight(videoHeader)).toBe(80);
    expect(await measuredHeight(videoContent)).toBe(80);
    expect(await measuredHeight(subtitleHeader)).toBe(92);

    await page.getByTitle('Add audio track').click();
    const audioHeader = row(page, 'header', 'audio');
    const audioContent = row(page, 'content', 'audio');
    const audioHandle = resizeHandle(page, 'audio');
    await expect(audioHeader).toBeVisible();
    await audioHandle.focus();
    await audioHandle.press('End');
    await expect.poll(() => measuredHeight(audioHeader)).toBe(192);
    expect(await measuredHeight(audioContent)).toBe(192);

    // Escape is a terminal cancellation: an in-progress pointer resize restores the exact height
    // that the row had when the gesture started and does not disturb either neighboring row.
    const beforeCancelledResize = await measuredHeight(subtitleHeader);
    const cancelHandleBounds = await subtitleHandle.boundingBox();
    if (!cancelHandleBounds) throw new Error('The subtitle resize handle is not measurable.');
    await page.mouse.move(
      cancelHandleBounds.x + cancelHandleBounds.width / 2,
      cancelHandleBounds.y + cancelHandleBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      cancelHandleBounds.x + cancelHandleBounds.width / 2,
      cancelHandleBounds.y + cancelHandleBounds.height / 2 + 24,
    );
    await expect.poll(() => measuredHeight(subtitleHeader)).toBeGreaterThan(beforeCancelledResize);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect.poll(() => measuredHeight(subtitleHeader)).toBe(beforeCancelledResize);
    expect(await measuredHeight(subtitleContent)).toBe(beforeCancelledResize);

    const tracksScroll = page.getByTestId('timeline-tracks-scroll');
    const sidebarScroll = page.getByTestId('timeline-sidebar-scroll');
    await tracksScroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(async () => {
      const [tracksTop, sidebarTop] = await Promise.all([
        tracksScroll.evaluate((element) => element.scrollTop),
        sidebarScroll.evaluate((element) => element.scrollTop),
      ]);
      return Math.abs(tracksTop - sidebarTop);
    }).toBeLessThanOrEqual(1);

    // Shrinking the final row reclamps both scroll ranges after layout instead of leaving the
    // sidebar stranded at a stale bottom offset.
    await audioHandle.focus();
    await audioHandle.press('Home');
    await expect.poll(() => measuredHeight(audioHeader)).toBe(48);
    expect(await measuredHeight(audioContent)).toBe(48);
    await expect.poll(async () => {
      const [tracksTop, sidebarTop] = await Promise.all([
        tracksScroll.evaluate((element) => element.scrollTop),
        sidebarScroll.evaluate((element) => element.scrollTop),
      ]);
      return Math.abs(tracksTop - sidebarTop);
    }).toBeLessThanOrEqual(1);
  });
});
