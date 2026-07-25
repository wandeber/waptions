import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import JSZip from 'jszip';
import {
  EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
  LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
} from '../src/lib/editorial-transcription/preferences';
import { createEditorProject, monitorPageFailures } from './support/editor-helpers';
import { createEditorialRouteFixture } from './support/editorial-transcription-fixture';
import { mediaFixtures } from './support/media-fixtures';

const EDITORIAL_ENDPOINT = 'http://localhost:43123/v1/audio/transcriptions';
const DEFAULT_EDITORIAL_ENDPOINT = 'http://localhost:43556/v1/audio/transcriptions';
const EDITOR_DOCUMENT_V4_KEY = 'editor-document-v4';

async function readEditorialPersistence(
  page: import('@playwright/test').Page,
  projectId: string,
): Promise<{
  manifest: Record<string, unknown>;
  records: Array<{ recordId: string; canonicalJson: string }>;
  requests: Array<{ descriptor: Record<string, unknown> }>;
}> {
  return page.evaluate(async ({ projectDatabase, documentKey }) => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readAll = (database: IDBDatabase, store: string) => new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transcripts = await open('waptions-editorial-transcripts');
    const project = await open(projectDatabase);
    try {
      const [records, requests] = await Promise.all([
        readAll(transcripts, 'records'),
        readAll(transcripts, 'request-index'),
      ]);
      const manifest = await new Promise<unknown>((resolve, reject) => {
        const request = project.transaction('timeline', 'readonly').objectStore('timeline').get(documentKey);
        request.onsuccess = () => resolve(request.result?.data ?? null);
        request.onerror = () => reject(request.error);
      });
      return { manifest, records, requests } as {
        manifest: Record<string, unknown>;
        records: Array<{ recordId: string; canonicalJson: string }>;
        requests: Array<{ descriptor: Record<string, unknown> }>;
      };
    } finally {
      transcripts.close();
      project.close();
    }
  }, { projectDatabase: `waptions-timelines-${projectId}`, documentKey: EDITOR_DOCUMENT_V4_KEY });
}

async function browserPersistenceContains(
  page: import('@playwright/test').Page,
  needle: string,
): Promise<boolean> {
  return page.evaluate(async (secret) => {
    const chunks = [location.href];
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key) chunks.push(key, storage.getItem(key) ?? '');
      }
    }
    for (const databaseInfo of await indexedDB.databases()) {
      if (!databaseInfo.name) continue;
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseInfo.name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        for (const storeName of Array.from(database.objectStoreNames)) {
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          chunks.push(JSON.stringify(values));
        }
      } finally {
        database.close();
      }
    }
    return chunks.some((chunk) => chunk.includes(secret));
  }, needle);
}

async function activateTextEditor(
  page: import('@playwright/test').Page,
  requestSummary: () => string,
): Promise<void> {
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Language' })).toHaveValue('es');
  const endpointInput = page.getByRole('textbox', { name: 'OpenAI-compatible endpoint' });
  await expect(endpointInput).toHaveValue(DEFAULT_EDITORIAL_ENDPOINT);
  const serverMode = page.getByRole('button', { name: 'server', exact: true });
  const browserMode = page.getByRole('button', { name: 'browser', exact: true });
  await expect(serverMode).toHaveAttribute('aria-pressed', 'true');
  await expect(browserMode).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('textbox', { name: /API key/ })).toHaveValue('');
  // The deterministic route fixture intercepts browser requests; production first use remains Server.
  await browserMode.click();
  await endpointInput.fill(EDITORIAL_ENDPOINT);
  await page.getByRole('textbox', { name: /API key/ }).fill('deterministic-session-key');
  await page.getByRole('button', { name: 'Prepare text editor' }).click();
  const ready = page.getByRole('listbox', { name: 'Unified text edit narrative' });
  const visibleError = page.getByRole('alert').filter({ hasText: /\S/ }).last();
  const outcome = await Promise.race([
    ready.waitFor({ state: 'visible', timeout: 60_000 }).then(() => 'ready'),
    visibleError.waitFor({ state: 'visible', timeout: 60_000 })
      .then(async () => `failed after ${requestSummary()}: ${await visibleError.textContent()}`),
  ]);
  expect(outcome).toBe('ready');
  await expect(page.getByRole('listbox', { name: 'Unified text edit narrative' }))
    .toBeVisible();
}

test.describe('text-based video editor', () => {
  test('migrates the legacy local Browser default to Server without a CORS request', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(({ key, endpoint }) => {
      window.localStorage.setItem(key, JSON.stringify({
        version: 1,
        endpoint,
        requestMode: 'browser',
        language: 'en',
        detectSpeakers: true,
      }));
    }, {
      key: LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
      endpoint: DEFAULT_EDITORIAL_ENDPOINT,
    });
    let directProviderRequests = 0;
    let serverProxyRequests = 0;
    await page.route('http://localhost:43556/**', async (route) => {
      directProviderRequests += 1;
      await route.abort('blockedbyclient');
    });
    await page.route('**/api/editorial-transcription', async (route) => {
      serverProxyRequests += 1;
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        headers: { 'x-waptions-editorial-failure': 'provider-unavailable' },
        body: JSON.stringify({ error: 'Editorial transcription provider request failed.' }),
      });
    });

    await createEditorProject(page, 'Migrated editorial transcription preferences');
    await page.locator('input[type="file"][accept="video/*,audio/*"]')
      .setInputFiles(mediaFixtures.videoA);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await page.getByRole('tab', { name: 'Text', exact: true }).click();

    await expect(page.getByRole('textbox', { name: 'OpenAI-compatible endpoint' }))
      .toHaveValue(DEFAULT_EDITORIAL_ENDPOINT);
    await expect(page.getByRole('button', { name: 'server', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'browser', exact: true }))
      .toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('textbox', { name: 'Language' })).toHaveValue('en');
    await expect(page.getByRole('combobox', { name: 'Speaker analysis' })).toHaveValue('on');
    await expect(page.getByRole('textbox', { name: /API key/ })).toHaveValue('');
    await expect.poll(() => page.evaluate(({ currentKey, legacyKey }) => ({
      current: JSON.parse(window.localStorage.getItem(currentKey) ?? 'null'),
      legacy: window.localStorage.getItem(legacyKey),
    }), {
      currentKey: EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
      legacyKey: LEGACY_EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY,
    })).toEqual({
      current: {
        version: 2,
        endpoint: DEFAULT_EDITORIAL_ENDPOINT,
        requestMode: 'server',
        language: 'en',
        detectSpeakers: true,
      },
      legacy: null,
    });

    await page.getByRole('button', { name: 'Prepare text editor' }).click();
    await expect(page.getByTestId('editorial-text-setup').getByText(
      'The transcription provider is unavailable. Check the service and try again.',
      { exact: true },
    )).toBeVisible({ timeout: 60_000 });
    expect(serverProxyRequests).toBe(1);
    expect(directProviderRequests).toBe(0);
  });

  test('keeps the project atomic after the default Server path reports a provider timeout', async ({ page }) => {
    test.setTimeout(120_000);
    let directProviderRequests = 0;
    let serverProxyRequests = 0;
    await page.route('http://localhost:43556/**', async (route) => {
      directProviderRequests += 1;
      await route.abort('blockedbyclient');
    });
    await page.route('**/api/editorial-transcription', async (route) => {
      serverProxyRequests += 1;
      // The proxy exposes only this closed classification header. Provider response bodies are
      // intentionally not trusted as UI copy or retained in browser persistence.
      await route.fulfill({
        status: 504,
        contentType: 'application/json',
        headers: { 'x-waptions-editorial-failure': 'provider-timeout' },
        body: JSON.stringify({ error: 'Editorial transcription provider timed out.' }),
      });
    });

    await createEditorProject(page, 'Text editor provider timeout');
    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    if (!projectId) throw new Error('The editor URL did not retain its project ID.');
    await page.locator('input[type="file"][accept="video/*,audio/*"]')
      .setInputFiles(mediaFixtures.videoA);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await page.getByRole('tab', { name: 'Text', exact: true }).click();
    await expect(page.getByRole('button', { name: 'server', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'browser', exact: true }))
      .toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('textbox', { name: /API key/ }).fill('timeout-session-key');
    await page.getByRole('button', { name: 'Prepare text editor' }).click();

    await expect(page.getByTestId('editorial-text-setup').getByText(
      'The transcription provider took too long to respond. Check that the service is still running, then try again.',
      { exact: true },
    )).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('listbox', { name: 'Unified text edit narrative' })).toHaveCount(0);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1);
    expect(serverProxyRequests).toBe(1);
    expect(directProviderRequests).toBe(0);

    await page.getByTitle('Save changes').click();
    await expect(page.getByTitle(/^All changes saved \(/)).toBeVisible({ timeout: 30_000 });
    const persistence = await readEditorialPersistence(page, projectId);
    expect(persistence.records).toHaveLength(0);
    expect(persistence.requests).toHaveLength(0);
    expect(await browserPersistenceContains(page, 'timeout-session-key')).toBe(false);

    await page.reload();
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await page.getByRole('tab', { name: 'Text', exact: true }).click();
    await expect(page.getByTestId('editorial-text-setup')).toBeVisible();
    expect(serverProxyRequests).toBe(1);
  });

  test('restores an explicit current Browser choice over first-use defaults', async ({ page }) => {
    const savedEndpoint = 'https://saved-transcriber.example/v1/audio/transcriptions';
    await page.addInitScript(({ key, endpoint }) => {
      window.localStorage.setItem(key, JSON.stringify({
        version: 2,
        endpoint,
        requestMode: 'browser',
        language: 'en',
        detectSpeakers: true,
      }));
    }, { key: EDITORIAL_TRANSCRIPTION_PREFERENCES_KEY, endpoint: savedEndpoint });

    await createEditorProject(page, 'Restored editorial transcription preferences');
    await page.locator('input[type="file"][accept="video/*,audio/*"]')
      .setInputFiles(mediaFixtures.videoA);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
    await page.getByRole('tab', { name: 'Text', exact: true }).click();

    await expect(page.getByRole('textbox', { name: 'OpenAI-compatible endpoint' }))
      .toHaveValue(savedEndpoint);
    await expect(page.getByRole('textbox', { name: 'Language' })).toHaveValue('en');
    await expect(page.getByRole('button', { name: 'browser', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'server', exact: true }))
      .toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('combobox', { name: 'Speaker analysis' })).toHaveValue('on');
    await expect(page.getByRole('textbox', { name: /API key/ })).toHaveValue('');
  });

  test('uses the exact full-source request and synchronizes Text edits with history and persistence', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    const routeFixture = await createEditorialRouteFixture();
    await routeFixture.install(page);

    await createEditorProject(page, 'Text editor exact request');
    await page.locator('input[type="file"][accept="video/*,audio/*"]')
      .setInputFiles(mediaFixtures.videoA);
    const sourceClip = page.getByTestId('timeline-video-clip');
    await expect(sourceClip).toHaveCount(1, { timeout: 30_000 });
    await sourceClip.click();
    for (let frame = 0; frame < 7; frame += 1) {
      await page.getByRole('button', { name: 'Next frame' }).click();
    }
    await page.getByRole('button', { name: 'Split selected media at playhead' }).click();
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(2);
    await activateTextEditor(page, () => {
      const wav = routeFixture.requests.at(-1)?.wav;
      return `${routeFixture.requests.length} provider requests; ${wav ? wav.readUInt32LE(40) / 2 : 'no'} samples`;
    });

    expect(routeFixture.requests).toHaveLength(1);
    expect(routeFixture.requests[0].fields).toEqual({
      model: 'qwen-1.7b-edit-max',
      response_format: 'verbose_json',
      stream: 'false',
      language: 'es',
    });
    expect(routeFixture.requests[0].authorization).toBe(true);
    const wav = routeFixture.requests[0].wav;
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40) / 2).toBe(32_006);

    const narrative = page.getByRole('listbox', { name: 'Unified text edit narrative' });
    // The deliberate frame-7 source split remains two distinct occurrences: its first clip is
    // all silence, while the second contributes separate leading and trailing silence blocks.
    await expect(narrative.getByText('Silence', { exact: true })).toHaveCount(3);
    const alpha = page.getByRole('button', { name: /alpha, no speaker/ }).first();
    await alpha.click();
    await expect(alpha).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('narrative-inspector')).toBeVisible();
    await page.getByLabel('Instance correction').fill('Alpha corrected');
    await page.getByRole('button', { name: 'Save correction' }).click();
    await expect(page.getByRole('button', { name: /Alpha corrected, no speaker/ })).toBeVisible();
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(page.getByRole('button', { name: /alpha, no speaker/ }).first()).toBeVisible();
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(page.getByRole('button', { name: /Alpha corrected, no speaker/ })).toBeVisible();

    await page.getByRole('button', { name: 'Delete all silences' }).click();
    await expect(page.getByRole('heading', { name: 'Delete all silences' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete silences' }).click();
    await expect(narrative.getByText('Silence', { exact: true })).toHaveCount(0);
    await page.getByTitle('Undo (Ctrl/Cmd+Z)').click();
    await expect(narrative.getByText('Silence', { exact: true })).toHaveCount(3);
    await page.getByTitle('Redo (Ctrl/Cmd+Shift+Z)').click();
    await expect(narrative.getByText('Silence', { exact: true })).toHaveCount(0);

    await page.getByTitle('Save changes').click();
    await expect(page.getByTitle(/^All changes saved \(/)).toBeVisible({ timeout: 30_000 });
    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    if (!projectId) throw new Error('The editor URL did not retain its project ID.');
    const persistence = await readEditorialPersistence(page, projectId);
    expect(persistence.records).toHaveLength(1);
    expect(persistence.requests).toHaveLength(1);
    expect(createHash('sha256').update(persistence.records[0].canonicalJson, 'utf8').digest('hex'))
      .toBe(persistence.records[0].recordId.replace('sha256:', ''));
    expect(persistence.requests[0].descriptor.recordId).toBe(persistence.records[0].recordId);
    expect(JSON.stringify(persistence.manifest)).not.toContain('"canonicalJson":');
    expect(JSON.stringify(persistence.manifest)).not.toContain('deterministic-session-key');
    expect(await browserPersistenceContains(page, 'deterministic-session-key')).toBe(false);

    const bundleDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download project file' }).click();
    const bundlePath = await (await bundleDownloadPromise).path();
    if (!bundlePath) throw new Error('The deterministic V4 bundle was not retained.');
    const bundleBytes = await readFile(bundlePath);
    expect(bundleBytes.includes(Buffer.from('deterministic-session-key'))).toBe(false);
    const bundle = await JSZip.loadAsync(bundleBytes);
    const metadataText = await bundle.file('metadata.json')?.async('string');
    if (!metadataText) throw new Error('The deterministic V4 bundle omitted metadata.');
    const metadata = JSON.parse(metadataText) as {
      version?: unknown;
      editorManifest?: Record<string, unknown>;
      editorialTranscriptFiles?: Record<string, string>;
    };
    expect(metadata.version).toBe('4.0');
    expect(JSON.stringify(metadata.editorManifest)).not.toContain('"canonicalJson":');
    const transcriptFiles = Object.entries(metadata.editorialTranscriptFiles ?? {});
    expect(transcriptFiles).toHaveLength(1);
    const [bundleRecordId, sidecarPath] = transcriptFiles[0];
    const sidecar = await bundle.file(sidecarPath)?.async('string');
    if (!sidecar) throw new Error('The deterministic V4 bundle omitted its transcript sidecar.');
    expect(createHash('sha256').update(sidecar, 'utf8').digest('hex'))
      .toBe(bundleRecordId.replace('sha256:', ''));

    await page.reload();
    await page.getByRole('tab', { name: 'Text', exact: true }).click();
    await expect(page.getByRole('button', { name: /Alpha corrected, no speaker/ })).toBeVisible();
    expect(routeFixture.requests).toHaveLength(1);
    expect(failures.errors).toEqual([]);
  });

  for (const scenario of [
    {
      name: 'provider unavailable response',
      options: { status: 503 },
      expectedMessage: 'The transcription provider is unavailable. Check the service and try again.',
    },
    {
      name: 'provider authentication failure',
      options: { status: 401 },
      expectedMessage: 'The transcription provider rejected the API key. Enter a valid API key, or leave it empty if this endpoint does not require one.',
    },
    {
      name: 'parser failure',
      options: {
        responseMutator: (response: Record<string, unknown>) => {
          const editing = response.editing as { timeline: { sample_count: number } };
          editing.timeline.sample_count -= 1;
        },
      },
      expectedMessage: 'Editorial transcript acquisition failed before publication.',
    },
  ]) {
    test(`keeps the previous project atomic and reopenable after ${scenario.name}`, async ({ page }) => {
      test.setTimeout(120_000);
      const routeFixture = await createEditorialRouteFixture(scenario.options);
      await routeFixture.install(page);
      await createEditorProject(page, `Text editor ${scenario.name}`);
      const projectId = new URL(page.url()).pathname.split('/').at(-1);
      if (!projectId) throw new Error('The editor URL did not retain its project ID.');
      await page.locator('input[type="file"][accept="video/*,audio/*"]')
        .setInputFiles(mediaFixtures.videoA);
      await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
      await page.getByRole('tab', { name: 'Text', exact: true }).click();
      await page.getByRole('button', { name: 'browser', exact: true }).click();
      await page.getByRole('textbox', { name: 'OpenAI-compatible endpoint' }).fill(EDITORIAL_ENDPOINT);
      await page.getByRole('textbox', { name: /API key/ }).fill('atomic-session-key');
      await page.getByRole('button', { name: 'Prepare text editor' }).click();
      await expect(page.getByTestId('editorial-text-setup').getByText(
        scenario.expectedMessage,
        { exact: true },
      )).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('listbox', { name: 'Unified text edit narrative' })).toHaveCount(0);
      await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1);

      await page.getByTitle('Save changes').click();
      await expect(page.getByTitle(/^All changes saved \(/)).toBeVisible({ timeout: 30_000 });
      const persistence = await readEditorialPersistence(page, projectId);
      expect(persistence.records).toHaveLength(0);
      expect(persistence.requests).toHaveLength(0);
      expect(await browserPersistenceContains(page, 'atomic-session-key')).toBe(false);

      await page.reload();
      await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 30_000 });
      await page.getByRole('tab', { name: 'Text', exact: true }).click();
      await expect(page.getByTestId('editorial-text-setup')).toBeVisible();
      expect(routeFixture.requests).toHaveLength(1);
    });
  }
});
