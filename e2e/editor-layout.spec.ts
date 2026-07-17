import { expect, test } from '@playwright/test';
import { EDITOR_LAYOUT_STORAGE_KEY } from '../src/lib/editor-layout';
import { createEditorProject, monitorPageFailures, readTimelineTime } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

test.describe('editor layout controls', () => {
  test('resizes focused separators without also running timeline arrow shortcuts', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Keyboard layout resize');

    // Give the global timeline shortcuts a non-zero position and an earlier key point. Without
    // propagation isolation, ArrowUp on the timeline divider jumps back to the subtitle start and
    // ArrowRight on the inspector divider advances another frame while resizing the panel.
    await page.getByTitle('Añadir subtítulo').click();
    const textarea = page.locator('textarea').first();
    await textarea.fill('Layout shortcut guard');
    await textarea.blur();
    await page.getByRole('button', { name: 'Next frame' }).click();
    await expect(page.getByRole('group', { name: 'Playback controls' })).toBeVisible();
    const initialTime = await readTimelineTime(page);
    expect(initialTime).toBeGreaterThan(0);

    const workspace = page.locator('.editor-shell > div').first();
    const workspaceSize = await workspace.evaluate((element) => ({
      width: element.clientWidth,
      height: element.clientHeight,
    }));

    const timelineSeparator = page.getByRole('separator', { name: 'Resize timeline' });
    const initialTimelineHeight = Number(await timelineSeparator.getAttribute('aria-valuenow'));
    expect(Number(await timelineSeparator.getAttribute('aria-valuemax'))).toBe(
      Math.max(180, Math.floor(workspaceSize.height * 0.6)),
    );
    await timelineSeparator.press('ArrowUp');
    expect(Number(await timelineSeparator.getAttribute('aria-valuenow'))).toBeGreaterThan(initialTimelineHeight);
    expect(await readTimelineTime(page)).toBeCloseTo(initialTime, 6);

    const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
    const initialInspectorWidth = Number(await inspectorSeparator.getAttribute('aria-valuenow'));
    expect(Number(await inspectorSeparator.getAttribute('aria-valuemax'))).toBe(
      Math.max(280, Math.min(520, Math.floor(workspaceSize.width * 0.45))),
    );
    await inspectorSeparator.press('ArrowRight');
    expect(Number(await inspectorSeparator.getAttribute('aria-valuenow'))).toBeLessThan(initialInspectorWidth);
    expect(await readTimelineTime(page)).toBeCloseTo(initialTime, 6);

    expect(failures.errors).toEqual([]);
  });

  test('lets the focused transport button own Space and Enter while timeline arrows remain global', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Transport keyboard ownership');

    // A real content duration keeps playback active long enough to assert each native toggle.
    await page.getByTitle('Añadir subtítulo').click();
    const textarea = page.locator('textarea').first();
    await textarea.fill('Before');
    await textarea.blur();

    const playbackToggle = page.getByTestId('timeline-playback-toggle');
    const assertSingleNativeToggle = async (key: 'Space' | 'Enter') => {
      await playbackToggle.focus();
      await playbackToggle.press(key);
      await expect(playbackToggle).toHaveAccessibleName('Pause timeline');
      await expect(playbackToggle).toBeFocused();
      await playbackToggle.press(key);
      await expect(playbackToggle).toHaveAccessibleName('Play timeline');
    };

    // If a global handler also consumes either key, the native click is suppressed or playback is
    // toggled twice. The accessible name proves that each press produced exactly one state change.
    await assertSingleNativeToggle('Space');
    await assertSingleNativeToggle('Enter');

    // Modified editor shortcuts must remain active after a native control retains focus. Saving
    // here also proves that Ctrl/Cmd+S was prevented before the browser can open Save Page UI.
    const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await playbackToggle.focus();
    await playbackToggle.press(`${shortcutModifier}+s`);
    await expect(page.getByTitle(/^All changes saved \(/)).toBeVisible();
    await expect(playbackToggle).toBeFocused();

    await textarea.focus();
    await textarea.fill('After');
    await textarea.blur();
    await playbackToggle.focus();
    await playbackToggle.press(`${shortcutModifier}+z`);
    await expect(textarea).toHaveValue('Before');
    await expect(playbackToggle).toBeFocused();
    await playbackToggle.press(`${shortcutModifier}+Shift+z`);
    await expect(textarea).toHaveValue('After');
    await expect(playbackToggle).toBeFocused();

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const timeBeforeArrow = await readTimelineTime(page);
    await page.keyboard.press('ArrowRight');
    expect(await readTimelineTime(page)).toBeGreaterThan(timeBeforeArrow);
    expect(failures.errors).toEqual([]);
  });

  test('lets a focused style select own navigation and Delete keys', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Select keyboard ownership');

    await page.getByTitle('Añadir subtítulo').click();
    const textarea = page.locator('textarea').first();
    await textarea.fill('Selected subtitle must remain');
    await textarea.blur();
    await expect(page.getByTestId('timeline-subtitle-clip')).toHaveCount(1);

    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('button', { name: 'Text style', exact: true }).click();
    const fontWeightSelect = page.getByText('Grosor de fuente', { exact: true })
      .locator('..')
      .locator('select');
    const initialFontWeight = await fontWeightSelect.inputValue();
    const nextFontWeight = await fontWeightSelect.evaluate((element) => {
      const select = element as HTMLSelectElement;
      return select.options.item(select.selectedIndex + 1)?.value ?? null;
    });
    if (!nextFontWeight) throw new Error('The font-weight select has no next option to test.');
    // Headless Chromium on macOS does not apply keyboard defaults to a closed native select. Listbox
    // mode uses the same select and key event while making the browser's ArrowDown behavior
    // observable; the previous global preventDefault still blocks this native value change.
    await fontWeightSelect.evaluate((element) => {
      const select = element as HTMLSelectElement;
      select.size = select.options.length;
    });

    const timeBeforeArrow = await readTimelineTime(page);
    await fontWeightSelect.focus();
    await fontWeightSelect.press('ArrowDown');
    expect(nextFontWeight).not.toBe(initialFontWeight);
    await expect(fontWeightSelect).toHaveValue(nextFontWeight);
    expect(await readTimelineTime(page)).toBeCloseTo(timeBeforeArrow, 6);

    await fontWeightSelect.press('Delete');
    await expect(fontWeightSelect).toBeFocused();
    await expect(page.getByTestId('timeline-subtitle-clip')).toHaveCount(1);
    expect(failures.errors).toEqual([]);
  });

  test('transfers focus between inspector visibility controls', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Inspector focus transfer');

    const hideInspector = page.getByRole('button', { name: 'Hide inspector' });
    await hideInspector.focus();
    await hideInspector.press('Enter');
    const showInspector = page.getByRole('button', { name: 'Show inspector' });
    await expect(showInspector).toBeVisible();
    await expect(showInspector).toBeFocused();

    await showInspector.press('Enter');
    await expect(hideInspector).toBeVisible();
    await expect(hideInspector).toBeFocused();
    expect(failures.errors).toEqual([]);
  });

  test('disables text selection on editor drag surfaces while preserving text editing', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Editor selection contract');

    await expect(page.getByTestId('editor-workspace')).toHaveCSS('user-select', 'none');
    await expect(page.getByTestId('timeline-track-controls-header')).toHaveCSS('user-select', 'none');

    await page.getByTitle('Añadir subtítulo').click();
    const subtitleText = page.locator('textarea');
    await expect(subtitleText).toHaveCount(1);
    await expect(subtitleText).toHaveCSS('user-select', 'text');
    expect(failures.errors).toEqual([]);
  });

  test('keeps track actions, inspector toggle, tabs, separators, history order, and shortcut hints unambiguous', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Editor visual contracts');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaFixtures.videoA);
    await expect(page.getByRole('button', { name: 'Add media' })).toBeVisible({ timeout: 30_000 });

    const trackControlsHeader = page.getByTestId('timeline-track-controls-header');
    await expect(trackControlsHeader).toContainText('Tracks');
    const trackCreationButtons = trackControlsHeader.getByRole('button');
    await expect(trackCreationButtons).toHaveCount(3);
    const trackHeaderBox = await trackControlsHeader.boundingBox();
    if (!trackHeaderBox) throw new Error('Track controls header is not measurable.');
    const tracksLabelBox = await trackControlsHeader.getByText('Tracks', { exact: true }).boundingBox();
    const trackControlsGroup = trackControlsHeader.getByRole('group', { name: 'Track controls' });
    const controlsGroupBox = await trackControlsGroup.boundingBox();
    if (!tracksLabelBox || !controlsGroupBox) {
      throw new Error('Track controls header children are not measurable.');
    }
    expect(controlsGroupBox.x).toBeGreaterThanOrEqual(tracksLabelBox.x + tracksLabelBox.width);
    expect(controlsGroupBox.x + controlsGroupBox.width).toBeLessThanOrEqual(
      trackHeaderBox.x + trackHeaderBox.width,
    );
    expect(controlsGroupBox.y - trackHeaderBox.y).toBeGreaterThanOrEqual(3.5);
    expect(
      trackHeaderBox.y + trackHeaderBox.height - (controlsGroupBox.y + controlsGroupBox.height),
    ).toBeGreaterThanOrEqual(3.5);
    expect(await trackControlsGroup.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderWidth: style.borderWidth,
        gap: style.gap,
        padding: style.padding,
      };
    })).toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderWidth: '0px',
      gap: '4px',
      padding: '0px',
    });
    const timelineRulerBox = await page.getByTestId('timeline-ruler-scroll').boundingBox();
    if (!timelineRulerBox) throw new Error('Timeline ruler is not measurable.');
    expect(trackHeaderBox.height).toBe(32);
    expect(timelineRulerBox.height).toBe(32);
    expect(Math.abs(
      trackHeaderBox.y + trackHeaderBox.height - (timelineRulerBox.y + timelineRulerBox.height),
    )).toBeLessThanOrEqual(0.5);
    for (const name of ['Add video track', 'Add audio track', 'Add subtitle track']) {
      const button = trackControlsHeader.getByRole('button', { name });
      const buttonBox = await button.boundingBox();
      if (!buttonBox) throw new Error(`${name} is not measurable.`);
      expect(buttonBox.x).toBeGreaterThanOrEqual(trackHeaderBox.x);
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(trackHeaderBox.x + trackHeaderBox.width);
      expect(buttonBox.y).toBeGreaterThanOrEqual(trackHeaderBox.y);
      expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(trackHeaderBox.y + trackHeaderBox.height);
    }

    const timelineEditTools = page.getByRole('group', { name: 'Timeline edit tools' });
    const timelineZoomControls = page.getByRole('group', { name: 'Timeline zoom controls' });
    for (const group of [
      timelineEditTools,
      timelineZoomControls,
      page.getByRole('group', { name: 'History controls' }),
      page.getByRole('group', { name: 'Clipboard controls' }),
    ]) {
      expect(await group.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderWidth: style.borderWidth,
          padding: style.padding,
        };
      })).toEqual({
        backgroundColor: 'rgba(0, 0, 0, 0)',
        borderWidth: '0px',
        padding: '0px',
      });
      const groupBox = await group.boundingBox();
      if (!groupBox) throw new Error('Flat toolbar group is not measurable.');
      expect(groupBox.height).toBeLessThanOrEqual(28);
    }

    await expect(timelineEditTools.getByText('Edit', { exact: true })).toHaveCount(0);
    for (const [group, expectedIconCount] of [
      [timelineEditTools, 5],
      [timelineZoomControls, 3],
    ] as const) {
      // Fixed-width icon buttons must not inherit the medium button padding: it leaves only four
      // pixels for the SVG and makes the toolbar controls look empty at normal editor scale.
      const iconSizes = await group.evaluate((element) => Array.from(
        element.querySelectorAll('button > svg'),
        (icon) => {
          const bounds = icon.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        },
      ));
      expect(iconSizes).toHaveLength(expectedIconCount);
      expect(iconSizes.every(({ width, height }) => width >= 14 && height >= 14)).toBe(true);
    }

    const inspectorToggle = page.getByTestId('inspector-toggle');
    await expect(inspectorToggle).toHaveAccessibleName('Hide inspector');
    await expect(page.locator('aside[aria-label="Inspector controls"]')).toHaveCount(0);
    const addMedia = page.getByRole('button', { name: 'Add media' });
    const toggleBox = await inspectorToggle.boundingBox();
    const addMediaBox = await addMedia.boundingBox();
    const editorWorkspaceBox = await page.getByTestId('editor-workspace').boundingBox();
    if (!toggleBox || !addMediaBox || !editorWorkspaceBox) {
      throw new Error('Viewport controls are not measurable.');
    }
    expect(toggleBox.x - (addMediaBox.x + addMediaBox.width)).toBeGreaterThanOrEqual(5);
    expect(toggleBox.x - (addMediaBox.x + addMediaBox.width)).toBeLessThanOrEqual(7);
    expect(Math.abs(toggleBox.y - addMediaBox.y)).toBeLessThanOrEqual(1);
    await inspectorToggle.focus();
    await inspectorToggle.press('Enter');
    await expect(inspectorToggle).toHaveAccessibleName('Show inspector');
    await expect(inspectorToggle).toBeFocused();
    await expect(page.getByTestId('editor-inspector')).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => page.getByTestId('editor-inspector').evaluate((element) => (element as HTMLElement).inert))
      .toBe(true);
    await page.waitForTimeout(250);
    const collapsedWorkspaceBox = await page.getByTestId('editor-primary-workspace').boundingBox();
    if (!collapsedWorkspaceBox) throw new Error('Collapsed editor workspace is not measurable.');
    expect(Math.abs(
      collapsedWorkspaceBox.x + collapsedWorkspaceBox.width
      - (editorWorkspaceBox.x + editorWorkspaceBox.width),
    )).toBeLessThanOrEqual(1);
    await inspectorToggle.press('Enter');
    await expect(inspectorToggle).toHaveAccessibleName('Hide inspector');
    await expect(inspectorToggle).toBeFocused();
    await page.waitForTimeout(250);

    const tablist = page.getByRole('tablist', { name: 'Inspector views' });
    const properties = tablist.getByRole('tab', { name: 'Properties' });
    const history = tablist.getByRole('tab', { name: 'History' });
    await expect(properties).toHaveAttribute('aria-selected', 'true');
    await expect(properties).toHaveAttribute('tabindex', '0');
    await expect(history).toHaveAttribute('tabindex', '-1');
    const propertiesBox = await properties.boundingBox();
    const historyBox = await history.boundingBox();
    if (!propertiesBox || !historyBox) throw new Error('Inspector tabs are not measurable.');
    expect(historyBox.x - (propertiesBox.x + propertiesBox.width)).toBeGreaterThanOrEqual(7);
    const timeBeforeTabNavigation = await readTimelineTime(page);
    await properties.focus();
    await properties.press('ArrowRight');
    await expect(history).toHaveAttribute('aria-selected', 'true');
    await expect(history).toHaveAttribute('tabindex', '0');
    await expect(history).toBeFocused();
    expect(await readTimelineTime(page)).toBeCloseTo(timeBeforeTabNavigation, 6);
    await expect(page.getByRole('tabpanel', { name: 'History' })).toBeVisible();
    await history.press('ArrowLeft');
    await expect(properties).toHaveAttribute('aria-selected', 'true');
    await expect(properties).toBeFocused();
    expect(await readTimelineTime(page)).toBeCloseTo(timeBeforeTabNavigation, 6);
    // ArrowLeft wraps from the first tab to the last tab, matching the ARIA tabs pattern.
    await properties.press('ArrowLeft');
    await expect(history).toHaveAttribute('aria-selected', 'true');
    await expect(history).toBeFocused();
    expect(await readTimelineTime(page)).toBeCloseTo(timeBeforeTabNavigation, 6);

    await page.getByRole('button', { name: 'Add video track' }).click();
    await page.getByRole('button', { name: 'Add audio track' }).click();
    const historyPanel = page.getByTestId('history-panel');
    const displayedEntries = historyPanel.locator('[data-history-entry-id]');
    await expect(displayedEntries.first()).toContainText('Add audio track');
    await expect(displayedEntries.nth(1)).toContainText('Add video track');
    await expect(historyPanel.getByRole('button').last()).toContainText('Earliest retained state');

    const timelineSeparator = page.getByRole('separator', { name: 'Resize timeline' });
    const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
    const separatorContract = await page.evaluate(() => {
      const timeline = document.querySelector('[data-testid="timeline-tracks-scroll"]')?.closest('.flex.h-full') ?? null;
      const transport = document.querySelector('[data-testid="timeline-playback-toggle"]')?.closest('.relative.flex') ?? null;
      const inspector = document.querySelector('[data-testid="editor-inspector"]');
      const timelineHandle = document.querySelector('[role="separator"][aria-label="Resize timeline"]');
      const inspectorHandle = document.querySelector('[role="separator"][aria-label="Resize inspector"]');
      const style = (element: Element | null) => element ? getComputedStyle(element) : null;
      return {
        timelineTop: style(timeline)?.borderTopWidth,
        transportTop: style(transport)?.borderTopWidth,
        transportBottom: style(transport)?.borderBottomWidth,
        inspectorLeft: style(inspector)?.borderLeftWidth,
        horizontalLineHeight: style(timelineHandle)?.height,
        verticalLineWidth: style(inspectorHandle)?.width,
      };
    });
    expect(separatorContract).toEqual({
      timelineTop: '0px',
      transportTop: '0px',
      transportBottom: '0px',
      inspectorLeft: '0px',
      horizontalLineHeight: '1px',
      verticalLineWidth: '1px',
    });
    await expect(timelineSeparator).toBeVisible();
    await expect(inspectorSeparator).toBeVisible();

    await expect(page.getByLabel('Undo')).toHaveAttribute('title', 'Undo (Ctrl/Cmd+Z)');
    await expect(page.getByLabel('Undo')).toHaveAttribute('aria-keyshortcuts', 'Control+z Meta+z');
    await expect(page.getByTestId('timeline-playback-toggle')).toHaveAttribute('title', /\(Space\)$/);
    await expect(page.getByRole('button', { name: 'Previous frame' })).toHaveAttribute('title', /Left Arrow/);
    await expect(page.getByTestId('delete-selected-media')).toHaveAttribute('title', /Backspace/);
    expect(failures.errors).toEqual([]);
  });

  test('ignores non-left and non-primary pointer resize attempts', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Rejected pointer resize');

    const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
    const inspector = page.getByTestId('editor-inspector');
    const initialInspectorWidth = Number(await inspectorSeparator.getAttribute('aria-valuenow'));
    await expect.poll(() => page.evaluate((storageKey) => {
      const serialized = window.localStorage.getItem(storageKey);
      if (!serialized) return null;
      return (JSON.parse(serialized) as { inspectorWidth?: number }).inspectorWidth ?? null;
    }, EDITOR_LAYOUT_STORAGE_KEY)).toBe(initialInspectorWidth);

    const separatorBounds = await inspectorSeparator.boundingBox();
    expect(separatorBounds).not.toBeNull();
    if (!separatorBounds) throw new Error('The inspector separator is not visible.');
    const pointerX = separatorBounds.x + separatorBounds.width / 2;
    const pointerY = separatorBounds.y + separatorBounds.height / 2;

    const dispatchRejectedGesture = async (
      pointerId: number,
      button: number,
      buttons: number,
      isPrimary: boolean,
    ) => {
      await inspectorSeparator.dispatchEvent('pointerdown', {
        pointerId,
        button,
        buttons,
        isPrimary,
        clientX: pointerX,
        clientY: pointerY,
      });
      await page.evaluate(({ id, activeButtons, primary, x, y }) => {
        window.dispatchEvent(new PointerEvent('pointermove', {
          pointerId: id,
          button: -1,
          buttons: activeButtons,
          isPrimary: primary,
          clientX: x - 96,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          pointerId: id,
          button: 0,
          buttons: 0,
          isPrimary: primary,
          clientX: x - 96,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }));
      }, {
        id: pointerId,
        activeButtons: buttons,
        primary: isPrimary,
        x: pointerX,
        y: pointerY,
      });
    };

    await dispatchRejectedGesture(41, 2, 2, true);
    await dispatchRejectedGesture(42, 0, 1, false);

    await expect(inspectorSeparator).toHaveAttribute('aria-valuenow', String(initialInspectorWidth));
    await expect(inspector).not.toHaveClass(/transition-none/);
    expect(await page.evaluate((storageKey) => {
      const serialized = window.localStorage.getItem(storageKey);
      if (!serialized) return null;
      return (JSON.parse(serialized) as { inspectorWidth?: number }).inspectorWidth ?? null;
    }, EDITOR_LAYOUT_STORAGE_KEY)).toBe(initialInspectorWidth);
    expect(failures.errors).toEqual([]);
  });

  test('persists the final pointer-resized inspector width without writing during the drag', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Pointer layout resize');

    const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
    const inspector = page.getByTestId('editor-inspector');
    const initialInspectorWidth = Number(await inspectorSeparator.getAttribute('aria-valuenow'));
    await expect.poll(() => page.evaluate((storageKey) => {
      const serialized = window.localStorage.getItem(storageKey);
      if (!serialized) return null;
      return (JSON.parse(serialized) as { inspectorWidth?: number }).inspectorWidth ?? null;
    }, EDITOR_LAYOUT_STORAGE_KEY)).toBe(initialInspectorWidth);

    const separatorBounds = await inspectorSeparator.boundingBox();
    expect(separatorBounds).not.toBeNull();
    if (!separatorBounds) throw new Error('The inspector separator is not visible.');
    const pointerX = separatorBounds.x + separatorBounds.width / 2;
    const pointerY = separatorBounds.y + separatorBounds.height / 2;
    await page.mouse.move(pointerX, pointerY);
    await page.mouse.down();
    await page.mouse.move(pointerX - 96, pointerY);

    const resizedInspectorWidth = Number(await inspectorSeparator.getAttribute('aria-valuenow'));
    expect(resizedInspectorWidth).toBeGreaterThan(initialInspectorWidth);
    await expect(inspector).toHaveClass(/transition-none/);
    // The visual width updates immediately, but persistence waits for the pointer terminal event.
    expect(await page.evaluate((storageKey) => {
      const serialized = window.localStorage.getItem(storageKey);
      if (!serialized) return null;
      return (JSON.parse(serialized) as { inspectorWidth?: number }).inspectorWidth ?? null;
    }, EDITOR_LAYOUT_STORAGE_KEY)).toBe(initialInspectorWidth);

    await page.mouse.up();
    await expect(inspector).not.toHaveClass(/transition-none/);
    await expect(inspectorSeparator).toBeFocused();
    await expect.poll(() => page.evaluate((storageKey) => {
      const serialized = window.localStorage.getItem(storageKey);
      if (!serialized) return null;
      return (JSON.parse(serialized) as { inspectorWidth?: number }).inspectorWidth ?? null;
    }, EDITOR_LAYOUT_STORAGE_KEY)).toBe(resizedInspectorWidth);

    await page.reload();
    await expect(page.getByRole('separator', { name: 'Resize inspector' })).toHaveAttribute(
      'aria-valuenow',
      String(resizedInspectorWidth),
    );
    await expect(page.getByTestId('editor-inspector')).toHaveClass(/transition-\[width,opacity\]/);
    expect(failures.errors).toEqual([]);
  });
});
