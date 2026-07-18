import { access, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CUSTOM_TRANSCRIPTION_PREFERENCES_KEY } from '../src/lib/ai/transcription-preferences';
import { createEditorProject } from './support/editor-helpers';

const EDITOR_DOCUMENT_V3_KEY = 'editor-document-v3';
const DIARIZATION_EXTENSION_KEY = 'waptions.transcription.diarization';
const LIVE_TEST_TIMEOUT_MS = 20 * 60 * 1000;
const SECURE_RUN_MARKER = 'waptions-secure-diarization-v1';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const liveConfig = {
  secureRun: process.env.WAPTIONS_E2E_DIARIZATION_SECURE_RUN,
  endpoint: process.env.WAPTIONS_E2E_DIARIZATION_ENDPOINT,
  apiKey: process.env.WAPTIONS_E2E_DIARIZATION_API_KEY,
  apiKeyDigest: process.env.WAPTIONS_E2E_DIARIZATION_API_KEY_SHA256,
  model: process.env.WAPTIONS_E2E_DIARIZATION_MODEL,
  media: process.env.WAPTIONS_E2E_DIARIZATION_MEDIA,
};

const missingConfiguration = [
  ['WAPTIONS_E2E_DIARIZATION_SECURE_RUN', liveConfig.secureRun === SECURE_RUN_MARKER ? liveConfig.secureRun : undefined],
  ['WAPTIONS_E2E_DIARIZATION_ENDPOINT', liveConfig.endpoint],
  ['WAPTIONS_E2E_DIARIZATION_API_KEY', liveConfig.apiKey],
  ['WAPTIONS_E2E_DIARIZATION_API_KEY_SHA256', liveConfig.apiKeyDigest],
  ['WAPTIONS_E2E_DIARIZATION_MODEL', liveConfig.model],
  ['WAPTIONS_E2E_DIARIZATION_MEDIA', liveConfig.media],
].filter(([, value]) => !value).map(([name]) => name);

interface DurableSubtitle {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
}

interface DurableSubtitleTrack {
  id: string;
  name: string;
  isVisible: boolean;
  timingDomain: string;
  subtitles: DurableSubtitle[];
  [key: string]: unknown;
}

interface DurableTrackProvenance {
  stale: boolean;
  provider?: string;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

interface DurableEditorManifest {
  activeSubtitleTrackId: string | null;
  subtitleTracks: DurableSubtitleTrack[];
  transcriptionByTrackId: Record<string, DurableTrackProvenance>;
}

interface DiarizationExtensionV1 {
  version: 1;
  setId: string;
  targetTrackId: string;
  speakerOrdinal: number;
  sourceSpeakerLabel: string;
  audioScope: 'audible-project-mix';
}

interface DiarizedSetProjection {
  setId: string;
  targetTrackId: string;
  memberTrackIds: string[];
}

/** Reads the durable V3 manifest rather than relying on track names rendered by the UI. */
async function readDurableManifest(page: Page, projectId: string): Promise<DurableEditorManifest> {
  const manifest = await page.evaluate(async ({ databaseName, documentKey }) => {
    const openRequest = indexedDB.open(databaseName, 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error);
    });

    try {
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction('timeline', 'readonly');
        const request = transaction.objectStore('timeline').get(documentKey);
        request.onsuccess = () => resolve(request.result?.data ?? null);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, {
    databaseName: `waptions-timelines-${projectId}`,
    documentKey: EDITOR_DOCUMENT_V3_KEY,
  });

  if (!manifest || typeof manifest !== 'object') {
    throw new Error('The durable editor-document-v3 manifest is unavailable.');
  }
  return manifest as DurableEditorManifest;
}

/** Flushes the editor's coalesced writer before any durable-state assertion. */
async function flushProject(page: Page): Promise<void> {
  const saveButton = page.getByRole('button', { name: 'Save changes' });
  if (await saveButton.isEnabled().catch(() => false)) await saveButton.click();
  await expect(page.getByTitle(/^All changes saved \(/)).toBeVisible({ timeout: 30_000 });
}

const subtitleProjection = (manifest: DurableEditorManifest) => ({
  activeSubtitleTrackId: manifest.activeSubtitleTrackId,
  subtitleTracks: manifest.subtitleTracks,
  transcriptionByTrackId: manifest.transcriptionByTrackId,
});

function readDiarizationExtension(provenance: DurableTrackProvenance): DiarizationExtensionV1 | null {
  const value = provenance.extensions?.[DIARIZATION_EXTENSION_KEY];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DiarizationExtensionV1>;
  if (candidate.version !== 1
    || typeof candidate.setId !== 'string'
    || typeof candidate.targetTrackId !== 'string'
    || !Number.isSafeInteger(candidate.speakerOrdinal)
    || typeof candidate.sourceSpeakerLabel !== 'string'
    || candidate.audioScope !== 'audible-project-mix') {
    return null;
  }
  return candidate as DiarizationExtensionV1;
}

/**
 * Asserts the complete anchored set contract against persisted IDs and provenance. Visible names
 * are deliberately ignored because users may rename generated tracks without changing identity.
 */
function assertDiarizedSet(
  manifest: DurableEditorManifest,
  originalTargetTrackId: string,
  expectedMemberIds?: readonly string[],
): DiarizedSetProjection {
  const allTrackIds = manifest.subtitleTracks.map((track) => track.id);
  expect(new Set(allTrackIds).size).toBe(allTrackIds.length);
  expect(Object.keys(manifest.transcriptionByTrackId).every((trackId) => allTrackIds.includes(trackId))).toBe(true);
  expect(manifest.activeSubtitleTrackId).toBe(originalTargetTrackId);

  const diarizationEntries = Object.entries(manifest.transcriptionByTrackId)
    .filter(([, provenance]) => Object.prototype.hasOwnProperty.call(
      provenance.extensions ?? {},
      DIARIZATION_EXTENSION_KEY,
    ))
    .map(([trackId, provenance]) => ({
      trackId,
      provenance,
      extension: readDiarizationExtension(provenance),
    }));
  expect(diarizationEntries.every((entry) => entry.extension !== null)).toBe(true);
  const members = diarizationEntries
    .filter((entry): entry is typeof entry & { extension: DiarizationExtensionV1 } => entry.extension !== null)
    .sort((left, right) => left.extension.speakerOrdinal - right.extension.speakerOrdinal);

  expect(members.length).toBeGreaterThanOrEqual(2);
  const setId = members[0].extension.setId;
  const memberTrackIds = members.map((member) => member.trackId);
  expect(memberTrackIds[0]).toBe(originalTargetTrackId);
  expect(expectedMemberIds === undefined || memberTrackIds.every((id, index) => id === expectedMemberIds[index])).toBe(true);
  expect(expectedMemberIds === undefined || memberTrackIds.length === expectedMemberIds.length).toBe(true);

  const memberTrackPositions = memberTrackIds.map((trackId) => allTrackIds.indexOf(trackId));
  expect(memberTrackPositions.every((position, index) => (
    index === 0 || position === memberTrackPositions[index - 1] + 1
  ))).toBe(true);

  const firstContentTimes: number[] = [];
  members.forEach((member, ordinal) => {
    expect(member.extension).toMatchObject({
      version: 1,
      setId,
      targetTrackId: originalTargetTrackId,
      speakerOrdinal: ordinal,
      audioScope: 'audible-project-mix',
    });
    expect(member.extension.sourceSpeakerLabel.trim().length).toBeGreaterThan(0);
    expect(member.provenance.provider).toBe('custom-openai-compatible');
    expect(member.provenance.stale).toBe(false);

    const track = manifest.subtitleTracks.find((candidate) => candidate.id === member.trackId);
    expect(track).toBeDefined();
    expect(track!.subtitles.length).toBeGreaterThan(0);
    expect(track!.subtitles.every((subtitle) => (
      subtitle.text.trim().length > 0
      && Number.isFinite(subtitle.startTime)
      && Number.isFinite(subtitle.endTime)
      && subtitle.endTime > subtitle.startTime
    ))).toBe(true);
    expect(track!.subtitles.every((subtitle, index) => (
      index === 0 || subtitle.startTime >= track!.subtitles[index - 1].startTime
    ))).toBe(true);
    firstContentTimes.push(track!.subtitles[0].startTime);
  });

  expect(firstContentTimes.every((time, index) => index === 0 || time >= firstContentTimes[index - 1])).toBe(true);
  expect(members.filter((member) => member.extension.setId === setId).length).toBe(memberTrackIds.length);

  return { setId, targetTrackId: originalTargetTrackId, memberTrackIds };
}

async function openTranscriptionModal(page: Page): Promise<void> {
  await page.getByTitle('Generar subtítulos automáticamente con IA').click();
  await expect(page.getByRole('heading', { name: /Configura tu transcriptor|Potencia tu contenido/ }))
    .toBeVisible();
}

async function runDiarization(page: Page, dialogObserved: () => boolean): Promise<void> {
  await page.getByRole('button', { name: /Generar Subtítulos/ }).click();
  const heading = page.getByRole('heading', { name: /Configura tu transcriptor|Potencia tu contenido/ });
  await expect.poll(async () => {
    if (dialogObserved()) return 'dialog';
    return await heading.isVisible().catch(() => false) ? 'processing' : 'closed';
  }, { timeout: LIVE_TEST_TIMEOUT_MS }).toBe('closed');
}

test.describe('live whole-project speaker diarization', () => {
  test.skip(
    missingConfiguration.length > 0,
    `Requires ${missingConfiguration.join(', ')}. The live service is intentionally opt-in.`,
  );

  test('persists preferences and applies, restores, reuses, and reloads the anchored speaker set', async ({ page }) => {
    test.setTimeout(LIVE_TEST_TIMEOUT_MS);
    const config = liveConfig as Record<keyof typeof liveConfig, string>;
    if (!/^[a-f0-9]{64}$/.test(config.apiKeyDigest)) {
      throw new Error('WAPTIONS_E2E_DIARIZATION_API_KEY_SHA256 must be a lowercase SHA-256 digest.');
    }
    if (!isAbsolute(config.media)) {
      throw new Error('WAPTIONS_E2E_DIARIZATION_MEDIA must be an absolute path outside the Waptions worktree.');
    }
    const [mediaRealPath, worktreeRealPath] = await Promise.all([
      realpath(config.media),
      realpath(process.cwd()),
    ]).catch(() => {
      throw new Error('WAPTIONS_E2E_DIARIZATION_MEDIA must point to a readable two-speaker media file.');
    });
    await access(mediaRealPath).catch(() => {
      throw new Error('WAPTIONS_E2E_DIARIZATION_MEDIA must point to a readable two-speaker media file.');
    });
    const mediaRelativeToWorktree = relative(worktreeRealPath, mediaRealPath);
    const mediaIsOutsideWorktree = mediaRelativeToWorktree === '..'
      || mediaRelativeToWorktree.startsWith(`..${sep}`)
      || isAbsolute(mediaRelativeToWorktree);
    if (!mediaIsOutsideWorktree) {
      throw new Error('WAPTIONS_E2E_DIARIZATION_MEDIA must resolve outside the Waptions worktree.');
    }

    let hadErrorDialog = false;
    let diarizationRequestCount = 0;
    page.on('dialog', async (dialog) => {
      hadErrorDialog = true;
      await dialog.dismiss();
    });
    page.on('request', (request) => {
      const requestUrl = new URL(request.url());
      if (request.method() === 'POST' && requestUrl.pathname === '/api/generate-subtitles/diarize') {
        diarizationRequestCount += 1;
      }
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await createEditorProject(page, 'Live diarization');
    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    if (!projectId) throw new Error('The editor URL does not contain a project ID.');

    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaRealPath);
    await expect(page.locator('[data-testid="timeline-video-clip"], [data-testid="timeline-audio-clip"]'))
      .toHaveCount(1, { timeout: 120_000 });
    await flushProject(page);

    const importedManifest = await readDurableManifest(page, projectId);
    const originalTargetTrackId = importedManifest.activeSubtitleTrackId;
    if (!originalTargetTrackId) throw new Error('The imported project has no active subtitle track.');

    await openTranscriptionModal(page);
    const localManifestId = await page.getByLabel('Model').inputValue();
    await page.getByLabel('Runtime').selectOption('wasm');
    await page.getByLabel('Language').selectOption('es');
    await page.getByLabel(/Allow slow WASM fallback/).check();
    await page.getByTestId('transcription-route-custom-openai-compatible').click();
    await page.getByRole('button', { name: /Server/ }).click();
    await page.getByLabel('Endpoint').fill(config.endpoint);
    await page.getByLabel('Model').fill(config.model);
    await page.getByLabel('Optional API key').fill(config.apiKey);
    await page.getByLabel('Speaker diarization').check();

    // Hash the stored key entirely inside page context. The raw value is never returned and the
    // expected key is never an evaluator parameter, assertion expectation, or diagnostic value.
    await expect.poll(() => page.evaluate(async (storageKey) => {
      const serialized = window.localStorage.getItem(storageKey);
      if (!serialized) return null;
      try {
        const value = JSON.parse(serialized) as Record<string, unknown>;
        const apiKey = typeof value.apiKey === 'string' ? value.apiKey : '';
        const digestBytes = await window.crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(apiKey),
        );
        const apiKeyDigest = Array.from(new Uint8Array(digestBytes))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        return {
          selectedRouteId: value.selectedRouteId,
          requestMode: value.requestMode,
          endpoint: value.endpoint,
          model: value.model,
          diarizationEnabled: value.diarizationEnabled,
          apiKeyDigest,
        };
      } catch {
        return null;
      }
    }, CUSTOM_TRANSCRIPTION_PREFERENCES_KEY)).toEqual({
      selectedRouteId: 'custom-openai-compatible',
      requestMode: 'server',
      endpoint: config.endpoint,
      model: config.model,
      diarizationEnabled: true,
      apiKeyDigest: config.apiKeyDigest,
    });

    // Reloading while the modal is open proves that browser-global preferences, rather than
    // transient React state, restore the complete selected custom route on the next mount.
    await page.reload();
    await expect(page.locator('[data-testid="timeline-video-clip"], [data-testid="timeline-audio-clip"]'))
      .toHaveCount(1, { timeout: 120_000 });
    await openTranscriptionModal(page);
    await expect(page.getByTestId('transcription-route-custom-openai-compatible'))
      .toHaveAttribute('data-selected', 'true');
    await expect(page.getByLabel('Endpoint')).toHaveValue(config.endpoint);
    await expect(page.getByLabel('Model')).toHaveValue(config.model);
    const restoredApiKeyDigest = await page.getByLabel('Optional API key').evaluate(async (input) => {
      const bytes = await window.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode((input as HTMLInputElement).value),
      );
      return Array.from(new Uint8Array(bytes))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    });
    expect(restoredApiKeyDigest).toBe(config.apiKeyDigest);
    await expect(page.getByRole('button', { name: /Server/ })).toHaveClass(/border-blue-500/);
    await expect(page.getByLabel('Speaker diarization')).toBeChecked();
    await page.getByTestId('transcription-route-local-browser').click();
    await expect(page.getByLabel('Model')).toHaveValue(localManifestId);
    await expect(page.getByLabel('Runtime')).toHaveValue('wasm');
    await expect(page.getByLabel('Language')).toHaveValue('es');
    await expect(page.getByLabel(/Allow slow WASM fallback/)).toBeChecked();
    await expect(page.getByLabel('Speaker diarization')).toHaveCount(0);
    await page.getByTestId('transcription-route-custom-openai-compatible').click();

    const preCommandManifest = await readDurableManifest(page, projectId);
    const preCommandProjection = subtitleProjection(preCommandManifest);
    await runDiarization(page, () => hadErrorDialog);
    expect(diarizationRequestCount).toBe(1);
    await flushProject(page);

    const firstManifest = await readDurableManifest(page, projectId);
    const firstSet = assertDiarizedSet(firstManifest, originalTargetTrackId);
    const firstPostProjection = subtitleProjection(firstManifest);

    await page.getByRole('button', { name: 'Undo' }).click();
    await flushProject(page);
    expect(subtitleProjection(await readDurableManifest(page, projectId))).toEqual(preCommandProjection);

    await page.getByRole('button', { name: 'Redo' }).click();
    await flushProject(page);
    const redoneManifest = await readDurableManifest(page, projectId);
    expect(subtitleProjection(redoneManifest)).toEqual(firstPostProjection);
    assertDiarizedSet(redoneManifest, originalTargetTrackId, firstSet.memberTrackIds);

    await openTranscriptionModal(page);
    await runDiarization(page, () => hadErrorDialog);
    expect(diarizationRequestCount).toBe(2);
    await flushProject(page);
    const secondManifest = await readDurableManifest(page, projectId);
    const secondSet = assertDiarizedSet(secondManifest, originalTargetTrackId, firstSet.memberTrackIds);
    expect(secondSet.setId).toBe(firstSet.setId);
    const secondProjection = subtitleProjection(secondManifest);

    await page.reload();
    await expect(page.locator('[data-testid="timeline-video-clip"], [data-testid="timeline-audio-clip"]'))
      .toHaveCount(1, { timeout: 120_000 });
    const reloadedManifest = await readDurableManifest(page, projectId);
    expect(subtitleProjection(reloadedManifest)).toEqual(secondProjection);
    const reloadedSet = assertDiarizedSet(reloadedManifest, originalTargetTrackId, firstSet.memberTrackIds);
    expect(reloadedSet.setId).toBe(firstSet.setId);
    expect(hadErrorDialog).toBe(false);
  });
});
