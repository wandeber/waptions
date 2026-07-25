import { expect, test, type Page } from '@playwright/test';
import {
  CUSTOM_TRANSCRIPTION_PREFERENCES_KEY,
  LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY,
} from '../src/lib/ai/transcription-preferences';
import { createEditorProject, monitorPageFailures } from './support/editor-helpers';
import { mediaFixtures } from './support/media-fixtures';

const openTranscriptionModal = async (page: Page): Promise<void> => {
  await page.getByTitle('Generar subtítulos automáticamente con IA').click();
  await expect(page.getByRole('heading', { name: /Configura tu transcriptor|Potencia tu contenido/ }))
    .toBeVisible();
};

const importAudibleFixture = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][accept="video/*,audio/*"]')
    .setInputFiles(mediaFixtures.videoA);
  await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1);
};

test.describe('transcription preferences', () => {
  test('persists every local and custom choice while keeping diarization custom-only', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    await createEditorProject(page, 'Transcription preferences');
    await importAudibleFixture(page);
    await openTranscriptionModal(page);
    const modal = page.getByRole('dialog', { name: /Configura tu transcriptor|Potencia tu contenido/ });

    const localRoute = page.getByTestId('transcription-route-local-browser');
    await expect(localRoute).toHaveAttribute('data-selected', 'true');
    await modal.getByLabel('Runtime').selectOption('wasm');
    await modal.getByLabel('Language').selectOption('es');
    await modal.getByLabel(/Allow slow WASM fallback/).check();
    await expect(modal.getByLabel('Speaker diarization')).toHaveCount(0);

    const customRoute = page.getByTestId('transcription-route-custom-openai-compatible');
    await customRoute.click();
    await expect(customRoute).toHaveAttribute('data-selected', 'true');
    await expect(localRoute).toHaveAttribute('data-selected', 'false');
    await modal.getByRole('button', { name: /Server/ }).click();
    await modal.getByLabel('Endpoint').fill('https://transcriber.test/v1');
    await modal.getByLabel('Model').fill('whisper-1');
    await modal.getByLabel('Optional API key').fill('  exact local test key  ');
    await modal.getByLabel('Speaker diarization').check();

    await expect.poll(() => page.evaluate(({ customKey, localKey }) => ({
      custom: JSON.parse(window.localStorage.getItem(customKey) ?? '{}'),
      local: JSON.parse(window.localStorage.getItem(localKey) ?? '{}'),
    }), {
      customKey: CUSTOM_TRANSCRIPTION_PREFERENCES_KEY,
      localKey: LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY,
    })).toMatchObject({
      custom: {
        version: 1,
        selectedRouteId: 'custom-openai-compatible',
        enabled: true,
        requestMode: 'server',
        endpoint: 'https://transcriber.test/v1',
        apiKey: '  exact local test key  ',
        model: 'whisper-1',
        diarizationEnabled: true,
      },
      local: {
        version: 1,
        device: 'wasm',
        language: 'es',
        allowWasmFallback: true,
      },
    });

    await page.reload();
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1);
    await openTranscriptionModal(page);
    const restoredModal = page.getByRole('dialog', { name: /Configura tu transcriptor|Potencia tu contenido/ });

    await expect(page.getByTestId('transcription-route-custom-openai-compatible'))
      .toHaveAttribute('data-selected', 'true');
    await expect(restoredModal.getByLabel('Endpoint')).toHaveValue('https://transcriber.test/v1');
    await expect(restoredModal.getByLabel('Model')).toHaveValue('whisper-1');
    await expect(restoredModal.getByLabel('Optional API key')).toHaveValue('  exact local test key  ');
    await expect(restoredModal.getByRole('button', { name: /Server/ })).toHaveClass(/border-blue-500/);
    await expect(restoredModal.getByLabel('Speaker diarization')).toBeChecked();

    await page.getByTestId('transcription-route-local-browser').click();
    await expect(restoredModal.getByLabel('Runtime')).toHaveValue('wasm');
    await expect(restoredModal.getByLabel('Language')).toHaveValue('es');
    await expect(restoredModal.getByLabel(/Allow slow WASM fallback/)).toBeChecked();
    await expect(restoredModal.getByLabel('Speaker diarization')).toHaveCount(0);
    expect(failures.errors).toEqual([]);
  });

  test('keeps the modal usable and shows only a generic warning when storage is unavailable', async ({ page }) => {
    const secret = 'sentinel-api-key-must-not-render';
    const endpoint = 'http://sentinel-endpoint.invalid/v1';
    const exceptionText = 'sentinel-storage-exception-must-not-render';
    await page.addInitScript(({ customKey, localKey, secretValue, endpointValue, errorText }) => {
      const originalGetItem = Storage.prototype.getItem;
      const originalSetItem = Storage.prototype.setItem;
      originalSetItem.call(window.localStorage, customKey, JSON.stringify({
        selectedRouteId: 'custom-openai-compatible',
        endpoint: endpointValue,
        apiKey: secretValue,
      }));
      Storage.prototype.getItem = function getItem(key: string): string | null {
        if (key === customKey || key === localKey) throw new Error(errorText);
        return originalGetItem.call(this, key);
      };
      Storage.prototype.setItem = function setItem(key: string, value: string): void {
        if (key === customKey || key === localKey) throw new Error(errorText);
        originalSetItem.call(this, key, value);
      };
    }, {
      customKey: CUSTOM_TRANSCRIPTION_PREFERENCES_KEY,
      localKey: LOCAL_BROWSER_TRANSCRIPTION_PREFERENCES_KEY,
      secretValue: secret,
      endpointValue: endpoint,
      errorText: exceptionText,
    });

    await createEditorProject(page, 'Unavailable transcription storage');
    await importAudibleFixture(page);
    await openTranscriptionModal(page);
    const modal = page.getByRole('dialog', { name: /Configura tu transcriptor|Potencia tu contenido/ });

    const warning = page.getByTestId('transcription-preferences-storage-warning');
    await expect(warning).toHaveText(
      'Transcription preferences could not be read or saved in this browser. Your current choices will work for this session only.',
    );
    await expect(page.getByTestId('transcription-route-local-browser')).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('transcription-route-custom-openai-compatible').click();
    await modal.getByLabel('Endpoint').fill('https://session-only.test/v1');
    await modal.getByLabel('Speaker diarization').check();
    await expect(modal.getByLabel('Speaker diarization')).toBeChecked();

    const modalText = await page.locator('.fixed.inset-0').innerText();
    expect(modalText).not.toContain(secret);
    expect(modalText).not.toContain(endpoint);
    expect(modalText).not.toContain(exceptionText);
    expect(modalText).not.toContain('selectedRouteId');
  });
});
