import { expect, test } from '@playwright/test';
import { createEditorProject, monitorPageFailures } from './support/editor-helpers';

test.describe('editor transaction history', () => {
  test('groups a multi-move subtitle style drag into one undo and redo step', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Style history');

    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('button', { name: 'Text style', exact: true }).click();
    const fontSizeInput = page.getByRole('textbox', { name: 'Tamaño' });
    await expect(fontSizeInput).toHaveValue('48');
    // The accordion animates its row height; measure only after the drag field reaches its final
    // layout so real pointer coordinates do not land on the next section header.
    await page.waitForTimeout(350);
    const fieldBox = await fontSizeInput.boundingBox();
    if (!fieldBox) throw new Error('The font-size drag field is not measurable.');

    const startX = fieldBox.x + fieldBox.width / 2;
    const startY = fieldBox.y + fieldBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 4, startY);
    await expect(fontSizeInput).toHaveValue('52');
    await page.mouse.move(startX + 8, startY);
    await expect(fontSizeInput).toHaveValue('56');
    await page.mouse.move(startX + 12, startY);
    await page.mouse.up();

    await expect(fontSizeInput).toHaveValue('60');
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(fontSizeInput).toHaveValue('48');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(fontSizeInput).toHaveValue('60');
    expect(failures.errors).toEqual([]);
  });

  test('cancels active style previews before undo and ignores late pointer terminals', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Style history cancellation');

    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('button', { name: 'Text style', exact: true }).click();
    const fontSizeInput = page.getByRole('textbox', { name: 'Tamaño' });
    await fontSizeInput.focus();
    await fontSizeInput.selectText();
    await fontSizeInput.pressSequentially('60');
    await fontSizeInput.press('Enter');
    await expect(fontSizeInput).toHaveValue('60');
    await page.waitForTimeout(350);

    const dragPreview = async () => {
      const fieldBox = await fontSizeInput.boundingBox();
      if (!fieldBox) throw new Error('The font-size drag field is not measurable.');
      const startX = fieldBox.x + fieldBox.width / 2;
      const startY = fieldBox.y + fieldBox.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 4, startY);
      await expect(fontSizeInput).toHaveValue('64');
    };

    await dragPreview();
    await page.keyboard.press('Control+z');
    await expect(fontSizeInput).toHaveValue('48');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(fontSizeInput).toHaveValue('48');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(fontSizeInput).toHaveValue('60');

    await dragPreview();
    await page.keyboard.press('Control+z');
    await expect(fontSizeInput).toHaveValue('48');
    await page.mouse.up();
    await expect(fontSizeInput).toHaveValue('48');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(fontSizeInput).toHaveValue('60');
    expect(failures.errors).toEqual([]);
  });

  test('preserves sequential decimal text and commits it as one undoable style edit', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Decimal style history');

    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('button', { name: 'Text style', exact: true }).click();
    const strokeWidthInput = page.getByRole('textbox', { name: 'Grosor del borde' }).first();
    await expect(strokeWidthInput).toHaveValue('6');

    await strokeWidthInput.focus();
    await strokeWidthInput.selectText();
    await strokeWidthInput.press('6');
    await strokeWidthInput.press('.');
    await expect(strokeWidthInput).toHaveValue('6.');
    await strokeWidthInput.press('5');
    await expect(strokeWidthInput).toHaveValue('6.5');
    await strokeWidthInput.press('Enter');

    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(strokeWidthInput).toHaveValue('6');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(strokeWidthInput).toHaveValue('6.5');
    expect(failures.errors).toEqual([]);
  });

  test('reset commits against the baseline from before an active typed draft', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Reset style history');

    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('button', { name: 'Text style', exact: true }).click();
    const strokeWidthInput = page.getByRole('textbox', { name: 'Grosor del borde' }).first();
    await expect(strokeWidthInput).toHaveValue('6');

    await strokeWidthInput.focus();
    await strokeWidthInput.selectText();
    await strokeWidthInput.press('0');
    await expect(strokeWidthInput).toHaveValue('0');
    await page.getByRole('button', { name: 'Reset Grosor del borde to default' }).first().click();
    await expect(strokeWidthInput).toHaveValue('0');
    await expect(strokeWidthInput).not.toBeFocused();

    await strokeWidthInput.focus();
    await strokeWidthInput.selectText();
    await strokeWidthInput.press('4');
    await strokeWidthInput.press('Enter');
    await expect(strokeWidthInput).toHaveValue('4');

    // Reset and the post-reset typed value are two independent durable sessions. Any lost edit or
    // duplicate blur command changes this exact two-step walk back through 4 -> 0 -> 6.
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(strokeWidthInput).toHaveValue('0');
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(strokeWidthInput).toHaveValue('6');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(strokeWidthInput).toHaveValue('0');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(strokeWidthInput).toHaveValue('4');
    expect(failures.errors).toEqual([]);
  });

  test('cancels incomplete hex drafts and commits one complete hex color', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Hex style history');

    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('button', { name: 'Text style', exact: true }).click();
    const textColorInput = page.getByRole('textbox', { name: 'Text color hex' });
    await expect(textColorInput).toHaveValue('#FFF50B');

    await textColorInput.focus();
    await textColorInput.selectText();
    await textColorInput.pressSequentially('#12');
    await expect(textColorInput).toHaveValue('#12');
    await textColorInput.blur();
    await expect(textColorInput).toHaveValue('#FFF50B');

    await textColorInput.focus();
    await textColorInput.selectText();
    await textColorInput.pressSequentially('#123456');
    await expect(textColorInput).toHaveValue('#123456');
    await textColorInput.press('Enter');

    // If the prior invalid draft had reached history, this single Undo would reveal `#12`
    // instead of the durable color that existed before either focus session.
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(textColorInput).toHaveValue('#FFF50B');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(textColorInput).toHaveValue('#123456');

    // Background fields use the same transactional draft boundary. Exercising this section keeps
    // incomplete text away from its paired native color input and verifies the shared wiring.
    await page.getByRole('button', { name: 'Background', exact: true }).click();
    const backgroundColorInput = page.getByRole('textbox', { name: 'Background color hex' });
    await expect(backgroundColorInput).toHaveValue('#000000');
    await backgroundColorInput.focus();
    await backgroundColorInput.selectText();
    await backgroundColorInput.pressSequentially('#ABCDE');
    await backgroundColorInput.blur();
    await expect(backgroundColorInput).toHaveValue('#000000');

    await backgroundColorInput.focus();
    await backgroundColorInput.selectText();
    await backgroundColorInput.pressSequentially('#ABCDEF');
    await backgroundColorInput.press('Enter');
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(backgroundColorInput).toHaveValue('#000000');
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(backgroundColorInput).toHaveValue('#ABCDEF');
    expect(failures.errors).toEqual([]);
  });

  test('cancels focused numeric and hex drafts before history button focus changes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'History pointer ordering');

    await page.getByRole('button', { name: 'Style', exact: true }).click();
    await page.getByRole('button', { name: 'Text style', exact: true }).click();
    const fontSizeInput = page.getByRole('textbox', { name: 'Tamaño' });
    const textColorInput = page.getByRole('textbox', { name: 'Text color hex' });
    const undoButton = page.getByTitle('Undo (Ctrl/Cmd+Z)');
    const redoButton = page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)');

    await fontSizeInput.focus();
    await fontSizeInput.selectText();
    await fontSizeInput.pressSequentially('60');
    await fontSizeInput.press('Enter');
    await undoButton.click();
    await expect(fontSizeInput).toHaveValue('48');

    // This complete numeric draft would commit on blur and clear the redo stack if cancellation
    // waited for click. Pointerdown must restore 48 first, then the requested Redo restores 60.
    await fontSizeInput.focus();
    await fontSizeInput.selectText();
    await fontSizeInput.pressSequentially('70');
    await expect(fontSizeInput).toHaveValue('70');
    await redoButton.click();
    await expect(fontSizeInput).toHaveValue('60');

    // A valid hex draft is intentionally used here: invalid input already cancels on blur and
    // would not expose an ordering regression. Undo must target font size, not a blur-created
    // color command, and the second draft must leave that redo entry intact as well.
    await textColorInput.focus();
    await textColorInput.selectText();
    await textColorInput.pressSequentially('#123456');
    await expect(textColorInput).toHaveValue('#123456');
    await undoButton.click();
    await expect(fontSizeInput).toHaveValue('48');
    await expect(textColorInput).toHaveValue('#FFF50B');

    await textColorInput.focus();
    await textColorInput.selectText();
    await textColorInput.pressSequentially('#ABCDEF');
    await redoButton.click();
    await expect(fontSizeInput).toHaveValue('60');
    await expect(textColorInput).toHaveValue('#FFF50B');

    // One final Undo exhausts the single durable style command. A duplicate blur/click commit
    // would leave another history step and keep this button enabled.
    await undoButton.click();
    await expect(fontSizeInput).toHaveValue('48');
    await expect(undoButton).toBeDisabled();
    expect(failures.errors).toEqual([]);
  });

  test('uses app undo and redo inside a focused controlled subtitle textarea', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Text history');

    await page.getByTitle('Añadir subtítulo').click();
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeFocused();
    await textarea.fill('Before');
    await textarea.blur();
    await textarea.focus();
    await textarea.fill('After');

    await textarea.press('Control+z');
    await expect(textarea).toHaveValue('Before');
    await expect(textarea).toBeFocused();
    await textarea.press('Control+y');
    await expect(textarea).toHaveValue('After');
    await expect(textarea).toBeFocused();
    expect(failures.errors).toEqual([]);
  });

  test('commits an active text draft before header Undo and keeps Delete inside the textarea', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Header text history');

    await page.getByTitle('Añadir subtítulo').click();
    const textarea = page.locator('textarea').first();
    await textarea.fill('Before');
    await textarea.blur();
    await textarea.focus();
    await textarea.fill('After');

    // Pointerdown commits the focused draft, and the subsequent click undoes exactly that new
    // command. Cancelling the draft here would make the click also consume the prior edit.
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(textarea).toHaveValue('Before');
    await expect(page.locator('textarea')).toHaveCount(1);

    await textarea.focus();
    await textarea.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 0));
    await textarea.press('Delete');
    await expect(page.locator('textarea')).toHaveCount(1);
    await expect(textarea).toHaveValue('efore');
    expect(failures.errors).toEqual([]);
  });

  test('enables header Undo for a draft when hydrated runtime history is empty', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Hydrated text draft');

    await page.getByTitle('Añadir subtítulo').click();
    let textarea = page.locator('textarea').first();
    await textarea.fill('Before');
    await textarea.blur();
    const saveButton = page.getByTitle('Save changes');
    if (await saveButton.isVisible()) await saveButton.click();
    await expect(page.getByTitle(/^All changes saved \(/)).toBeVisible();

    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    if (!projectId) throw new Error('The editor URL does not contain a project ID.');
    await page.evaluate(async (id) => {
      const request = indexedDB.open(`waptions-timelines-${id}`, 1);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('timeline', 'readwrite');
        const store = transaction.objectStore('timeline');
        const keysRequest = store.getAllKeys();
        keysRequest.onsuccess = () => {
          keysRequest.result
            .map(String)
            .filter((key) => key === 'editor-history:index' || key.startsWith('editor-history:entry:'))
            .forEach((key) => store.delete(key));
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      db.close();
    }, projectId);

    await page.reload();
    textarea = page.locator('textarea').first();
    const undoButton = page.getByTitle('Undo (Ctrl/Cmd+Z)');
    await expect(textarea).toHaveValue('Before');
    await expect(undoButton).toBeDisabled();

    await textarea.focus();
    await textarea.fill('After');
    await expect(undoButton).toBeEnabled();
    await undoButton.click();
    await expect(textarea).toHaveValue('Before');

    await textarea.focus();
    await textarea.fill('After');
    await textarea.press('Control+z');
    await expect(textarea).toHaveValue('Before');
    expect(failures.errors).toEqual([]);
  });

  test('cancels subtitle drags on history and Escape without accepting late mouseup', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Subtitle drag cancellation');

    await page.getByTitle('Añadir subtítulo').click();
    const textarea = page.locator('textarea').first();
    await textarea.fill('Drag target');
    await textarea.blur();
    const clip = page.getByTestId('timeline-subtitle-clip');
    const drag = async () => {
      const box = await clip.boundingBox();
      if (!box) throw new Error('The subtitle clip is not measurable.');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2);
    };

    await drag();
    await page.keyboard.press('Control+z');
    await expect(textarea).toHaveValue('');
    await page.mouse.up();
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(textarea).toHaveValue('Drag target');

    await drag();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(textarea).toHaveValue('');
    expect(failures.errors).toEqual([]);
  });

  test('jumps atomically through the inspector history while keeping the future branch', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'History inspector');

    await page.getByTitle('Añadir subtítulo').click();
    const textarea = page.locator('textarea').first();
    await textarea.fill('History entry');
    await textarea.blur();

    await page.getByRole('tab', { name: 'History', exact: true }).click();
    const panel = page.getByTestId('history-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-history-entry-id]')).toHaveCount(2);

    await panel.getByRole('button', { name: 'Earliest retained state' }).click();
    await expect(page.locator('textarea')).toHaveCount(0);
    // Jumping backward retains the complete future branch in the same panel. One direct jump to
    // its last entry restores both commands with one store revision and one persistence enqueue.
    await panel.locator('[data-history-entry-id]').first().click();
    await page.getByRole('tab', { name: 'Properties', exact: true }).click();
    await expect(page.locator('textarea').first()).toHaveValue('History entry');

    await page.getByTitle('Hide inspector').click();
    const hiddenInspector = page.getByTestId('editor-inspector');
    await expect(hiddenInspector).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => hiddenInspector.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('[aria-hidden="true"]') === null)).toBe(true);
    expect(failures.errors).toEqual([]);
  });
});
