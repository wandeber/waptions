import { createHash } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { access, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';
import JSZip from 'jszip';
import { EDITORIAL_TRANSCRIPT_DATABASE } from '../src/lib/storage/editorial-transcript-repository';
import { parseEditMaxEditorialTranscript } from '../src/lib/editorial-transcription/edit-max-parser';
import { hydrateEditorDocumentV4 } from '../src/lib/editor-document-v4-migration';
import { exactClipSourceFrameRange, planActivateNarrative } from '../src/lib/narrative/commands';
import {
  createNarrativeCommandGuard,
  createTimelinePatchFromV4Document,
  integrateNarrativeCommandLinks,
} from '../src/stores/timeline-v4-command-adapter';
import type { EditorialTranscriptDescriptorV1 } from '../src/types/editorial';
import type {
  EditorManifestV4,
  VideoClipV4,
  VideoSourceAssetV3,
  VideoSourceDescriptorV3,
} from '../src/types/video';
import { createEditorProject, monitorPageFailures, readTimelineTime } from './support/editor-helpers';
import {
  parseEditorialMultipartRequest,
  type ObservedEditorialRequest,
} from './support/editorial-transcription-fixture';

const LIVE_TEST_TIMEOUT_MS = 20 * 60 * 1000;
const SECURE_RUN_MARKER = 'waptions-secure-text-editor-v1';
const FIXED_MODEL = 'qwen-1.7b-edit-max';
const EDITOR_DOCUMENT_V4_KEY = 'editor-document-v4';
const EDITORIAL_SERVER_ROUTE_PATH = '/api/editorial-transcription';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const liveConfig = {
  secureRun: process.env.WAPTIONS_E2E_TEXT_EDITOR_SECURE_RUN,
  endpoint: process.env.WAPTIONS_E2E_TEXT_EDITOR_ENDPOINT,
  apiKey: process.env.WAPTIONS_E2E_TEXT_EDITOR_API_KEY,
  apiKeyDigest: process.env.WAPTIONS_E2E_TEXT_EDITOR_API_KEY_SHA256,
  media: process.env.WAPTIONS_E2E_TEXT_EDITOR_MEDIA,
};

const missingConfiguration = [
  ['WAPTIONS_E2E_TEXT_EDITOR_SECURE_RUN', liveConfig.secureRun === SECURE_RUN_MARKER ? liveConfig.secureRun : undefined],
  ['WAPTIONS_E2E_TEXT_EDITOR_ENDPOINT', liveConfig.endpoint],
  ['WAPTIONS_E2E_TEXT_EDITOR_API_KEY', liveConfig.apiKey],
  ['WAPTIONS_E2E_TEXT_EDITOR_API_KEY_SHA256', liveConfig.apiKeyDigest],
  ['WAPTIONS_E2E_TEXT_EDITOR_MEDIA', liveConfig.media],
].filter(([, value]) => !value).map(([name]) => name);

interface LiveResponseShape {
  model?: unknown;
  words?: unknown;
  editing?: {
    schema_version?: unknown;
    profile?: unknown;
    requested_model?: unknown;
    canonical_model?: unknown;
    timeline?: {
      sample_rate_hz?: unknown;
      sample_count?: unknown;
      duration?: unknown;
      time_origin?: unknown;
    };
    speech_regions?: unknown;
    edit_boundaries?: unknown;
  };
  diarization?: {
    speakers?: unknown;
    segments?: unknown;
  };
}

interface DurableEditorialSnapshot {
  manifest: Record<string, unknown>;
  records: Array<{ recordId: string; canonicalJson: string; byteLength: number }>;
  requests: Array<{ requestKey: string; descriptor: Record<string, unknown> }>;
  pins: unknown[];
}

interface ImportedCropSnapshot {
  source: VideoSourceDescriptorV3;
  clip: VideoClipV4;
}

/** Replays only pure planning so validation reports its fixed path instead of UI-generic text. */
async function validateReproducedActivationGraph(input: {
  mediaPath: string;
  snapshot: DurableEditorialSnapshot;
  record: Awaited<ReturnType<typeof parseEditMaxEditorialTranscript>>;
}): Promise<void> {
  const manifest = input.snapshot.manifest as unknown as EditorManifestV4;
  if (manifest.videoSourceDescriptors.length !== 1 || manifest.audioSourceDescriptors.length !== 0) {
    throw new Error('The live activation diagnostic requires one video source and no independent audio source.');
  }
  const descriptor = input.snapshot.requests[0]?.descriptor as unknown as EditorialTranscriptDescriptorV1;
  if (!descriptor || descriptor.recordId !== input.record.recordId) {
    throw new Error('The live activation diagnostic could not match the verified CAS descriptor.');
  }
  const mediaBytes = await readFile(input.mediaPath);
  const videoSources: VideoSourceAssetV3[] = manifest.videoSourceDescriptors.map((source) => ({
    ...source,
    file: new NodeFile([mediaBytes], source.originalName, {
      type: source.mimeType,
      lastModified: source.lastModified,
    }) as unknown as File,
  }));
  const document = hydrateEditorDocumentV4({
    ...manifest,
    editorialTranscriptDescriptors: [descriptor],
  }, videoSources, []);
  let id = 0;
  const planned = planActivateNarrative({
    document,
    guard: createNarrativeCommandGuard(document),
    selectedTrackIds: [document.videoClips[0].trackId],
    recordIdBySourceId: { [document.videoSources[0].id]: input.record.recordId },
    bodies: { [input.record.recordId]: input.record.body },
    idFactory: (kind) => `${kind}-live-diagnostic-${++id}`,
    nowIso: '2026-01-01T00:00:00.000Z',
    splitOnSpeakerChange: false,
  });
  if (planned.kind !== 'success') {
    throw new Error(`Pure live activation diagnostic failed before graph validation (${planned.kind}).`);
  }
  const integrated = integrateNarrativeCommandLinks({
    before: document,
    narrativeResult: planned,
    discoverNewOverlaps: true,
  });
  if (integrated.kind !== 'success') {
    throw new Error(`Pure live link diagnostic failed before graph validation (${integrated.kind}).`);
  }
  createTimelinePatchFromV4Document(integrated.document, {
    [input.record.recordId]: input.record.body,
  });
}

/** Waits for either the unified editor or its deliberately generic user-facing failure. */
async function activateTextEditor(page: Page, timeout = LIVE_TEST_TIMEOUT_MS): Promise<void> {
  await page.getByRole('button', { name: 'Prepare text editor' }).click();
  const narrative = page.getByRole('listbox', { name: 'Unified text edit narrative' });
  const visibleError = page.getByRole('alert').filter({ hasText: /\S/ }).last();
  const outcome = await Promise.race([
    narrative.waitFor({ state: 'visible', timeout }).then(() => 'ready'),
    visibleError.waitFor({ state: 'visible', timeout }).then(() => 'failed'),
  ]);
  if (outcome === 'failed') {
    // The product deliberately exposes a credential-free error. Include that bounded message in
    // the live failure so a retained artifact is actionable without enabling traces or screenshots.
    const message = (await visibleError.textContent())?.trim() || 'Unknown text preparation failure.';
    throw new Error(`Text editor activation failed: ${message}`);
  }
}

async function releaseOnlyControlledTrack(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Release / })).toBeVisible();
  await page.getByRole('button', { name: 'Release control' }).click();
  await expect(page.getByTestId('editorial-text-setup')).toBeVisible();
}

/** Flushes the coalesced project writer before reading its descriptor-only manifest. */
async function flushProject(page: Page): Promise<void> {
  const saveButton = page.getByRole('button', { name: 'Save changes' });
  if (await saveButton.isEnabled().catch(() => false)) await saveButton.click();
  await expect(page.getByTitle(/^All changes saved \(/)).toBeVisible({ timeout: 30_000 });
}

/** Reads only the non-secret source/crop values needed to diagnose pre-provider live failures. */
async function readImportedCropSnapshot(page: Page, projectId: string): Promise<ImportedCropSnapshot> {
  return page.evaluate(async ({ databaseName, documentKey }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const document = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const transaction = database.transaction('timeline', 'readonly');
        const request = transaction.objectStore('timeline').get(documentKey);
        request.onsuccess = () => resolve(request.result?.data ?? {});
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      });
      const source = (document.videoSourceDescriptors as ImportedCropSnapshot['source'][] | undefined)?.[0];
      const clip = (document.videoClips as ImportedCropSnapshot['clip'][] | undefined)?.[0];
      if (!source || !clip) throw new Error('The imported live source/crop was not persisted.');
      return { source, clip };
    } finally {
      database.close();
    }
  }, {
    databaseName: `waptions-timelines-${projectId}`,
    documentKey: EDITOR_DOCUMENT_V4_KEY,
  });
}

async function readDurableEditorialSnapshot(page: Page, projectId: string): Promise<DurableEditorialSnapshot> {
  return page.evaluate(async ({ transcriptDatabase, projectDatabase, documentKey }) => {
    const openDatabase = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readStore = (database: IDBDatabase, storeName: string) => new Promise<unknown[]>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });

    const transcript = await openDatabase(transcriptDatabase);
    const project = await openDatabase(projectDatabase);
    try {
      const [records, requests, pins] = await Promise.all([
        readStore(transcript, 'records'),
        readStore(transcript, 'request-index'),
        readStore(transcript, 'pins'),
      ]);
      const manifest = await new Promise<unknown>((resolve, reject) => {
        const transaction = project.transaction('timeline', 'readonly');
        const request = transaction.objectStore('timeline').get(documentKey);
        request.onsuccess = () => resolve(request.result?.data ?? null);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      });
      return { manifest, records, requests, pins } as DurableEditorialSnapshot;
    } finally {
      transcript.close();
      project.close();
    }
  }, {
    transcriptDatabase: EDITORIAL_TRANSCRIPT_DATABASE,
    projectDatabase: `waptions-timelines-${projectId}`,
    documentKey: EDITOR_DOCUMENT_V4_KEY,
  });
}

/** Searches browser-owned persistence and the current DOM without returning the credential. */
async function browserPersistenceContainsSecret(page: Page, secret: string): Promise<boolean> {
  return page.evaluate(async (needle) => {
    const chunks = [location.href, document.documentElement.innerHTML];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key) chunks.push(key, localStorage.getItem(key) ?? '');
    }
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key) chunks.push(key, sessionStorage.getItem(key) ?? '');
    }
    const databases = await indexedDB.databases();
    for (const databaseInfo of databases) {
      if (!databaseInfo.name) continue;
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseInfo.name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        for (const storeName of Array.from(database.objectStoreNames)) {
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readonly');
            const request = transaction.objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            transaction.onabort = () => reject(transaction.error);
          });
          chunks.push(JSON.stringify(values));
        }
      } finally {
        database.close();
      }
    }
    return chunks.some((chunk) => chunk.includes(needle));
  }, secret);
}

function assertLiveResponse(payload: LiveResponseShape, sampleCount: number): void {
  expect(payload.editing?.schema_version).toBe(1);
  expect(payload.editing?.profile).toBe('edit-max-v1');
  expect(payload.editing?.requested_model).toBe(FIXED_MODEL);
  expect(typeof payload.editing?.canonical_model).toBe('string');
  expect(payload.editing?.canonical_model).toBe(payload.model);
  expect(payload.editing?.timeline).toMatchObject({
    sample_rate_hz: 16_000,
    sample_count: sampleCount,
    time_origin: 'decoded_audio_start',
  });
  const duration = payload.editing?.timeline?.duration;
  expect(typeof duration).toBe('number');
  expect(Math.abs((duration as number) - sampleCount / 16_000)).toBeLessThanOrEqual(1 / 16_000);
  expect(duration as number).toBeGreaterThan(0);
  expect(duration as number).toBeLessThanOrEqual(60);

  const words = payload.words;
  expect(Array.isArray(words)).toBe(true);
  expect((words as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
  expect((words as Array<Record<string, unknown>>).every((word, index) => (
    typeof word.word === 'string'
    && word.word.trim().length > 0
    && typeof word.start === 'number'
    && typeof word.end === 'number'
    && (word.end > word.start || hasEvidenceBackedPointAnchor(payload, index))
  ))).toBe(true);
  const regions = payload.editing?.speech_regions;
  const boundaries = payload.editing?.edit_boundaries;
  expect(Array.isArray(regions)).toBe(true);
  expect((regions as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
  expect((regions as Array<Record<string, unknown>>).every((region) => (
    Number.isSafeInteger(region.start_sample)
    && Number.isSafeInteger(region.end_sample)
    && (region.start_sample as number) >= 0
    && (region.end_sample as number) > (region.start_sample as number)
    && (region.end_sample as number) <= sampleCount
    && typeof region.evidence === 'string'
  ))).toBe(true);
  expect(Array.isArray(boundaries)).toBe(true);
  expect((boundaries as Array<Record<string, unknown>>).every((boundary) => (
    Number.isSafeInteger(boundary.sample)
    && (boundary.sample as number) >= 0
    && (boundary.sample as number) <= sampleCount
    && typeof boundary.evidence === 'string'
  ))).toBe(true);
}

/**
 * Mirrors the parser's narrow structural exception for a provider point-anchor.
 *
 * One added sample is only a minimum half-open encoding backed by the region catalog and its
 * validated boundaries. It is not treated as acoustic duration or improved timing precision.
 */
function hasEvidenceBackedPointAnchor(payload: LiveResponseShape, wordIndex: number): boolean {
  if (!Array.isArray(payload.words)
    || !Array.isArray(payload.editing?.speech_regions)
    || !Array.isArray(payload.editing?.edit_boundaries)) return false;
  const words = payload.words as Array<Record<string, unknown>>;
  const word = words[wordIndex];
  if (!word || typeof word.start !== 'number' || word.start !== word.end) return false;
  const anchor = Math.floor(word.start * 16_000 + 0.5);
  const regions = payload.editing.speech_regions as Array<Record<string, unknown>>;
  const owners = regions.filter((region) => (
    Number.isSafeInteger(region.word_start_index)
    && Number.isSafeInteger(region.word_end_index)
    && (region.word_start_index as number) <= wordIndex
    && wordIndex < (region.word_end_index as number)
  ));
  if (owners.length !== 1) return false;
  const owner = owners[0];
  if ((owner.evidence !== 'alignment_acoustic' && owner.evidence !== 'alignment_only')
    || !Number.isSafeInteger(owner.start_sample)
    || !Number.isSafeInteger(owner.end_sample)
    || anchor < (owner.start_sample as number)
    || anchor >= (owner.end_sample as number)) return false;

  const next = words[wordIndex + 1];
  if (next && typeof next.start === 'number' && typeof next.end === 'number') {
    const nextStart = Math.floor(next.start * 16_000 + 0.5);
    const nextEnd = Math.floor(next.end * 16_000 + 0.5);
    if (nextStart === anchor && nextEnd <= anchor + 1) return false;
  }
  const boundaries = payload.editing.edit_boundaries as Array<Record<string, unknown>>;
  return ['speech_start', 'speech_end'].every((type) => {
    const expectedSample = type === 'speech_start' ? owner.start_sample : owner.end_sample;
    return boundaries.some((boundary) => (
      boundary.region_id === owner.id
      && boundary.type === type
      && boundary.sample === expectedSample
      && boundary.evidence === owner.evidence
    ));
  });
}

async function waitForEditorialResponse(page: Page, endpoint: string): Promise<Response> {
  return page.waitForResponse((response) => (
    response.url() === endpoint && response.request().method() === 'POST'
  ), { timeout: LIVE_TEST_TIMEOUT_MS });
}

type ActivationOutcome =
  | { kind: 'ready' }
  | { kind: 'failed'; error: unknown };

function observeActivation(activation: Promise<void>): Promise<ActivationOutcome> {
  return activation.then(
    () => ({ kind: 'ready' }),
    (error: unknown) => ({ kind: 'failed', error }),
  );
}

/**
 * A setup/preflight failure can happen before any POST exists. Surface it immediately instead of
 * hiding the real product cause behind the twenty-minute response timeout.
 */
async function waitForEditorialResponseOrActivationFailure(
  page: Page,
  endpoint: string,
  activation: Promise<ActivationOutcome>,
): Promise<Response> {
  const outcome = await Promise.race([
    waitForEditorialResponse(page, endpoint).then((response) => ({
      kind: 'response' as const,
      response,
    })),
    activation.then((result) => ({
      kind: 'activation' as const,
      result,
    })),
  ]);
  if (outcome.kind === 'response') return outcome.response;
  if (outcome.result.kind === 'failed') throw outcome.result.error;
  throw new Error('Text editor activation completed without the required transcription POST.');
}

test.describe('secure live text editor', () => {
  test.skip(
    missingConfiguration.length > 0,
    `Requires ${missingConfiguration.join(', ')}. The live service is intentionally runner-owned.`,
  );

  test('uses real edit-max acquisition, CAS cache, reload, preview, export, and secret containment', async ({ page }) => {
    test.setTimeout(LIVE_TEST_TIMEOUT_MS);
    const config = liveConfig as Record<keyof typeof liveConfig, string>;
    if (!/^[a-f0-9]{64}$/.test(config.apiKeyDigest)) {
      throw new Error('The secure runner did not provide a valid credential digest.');
    }
    if (!isAbsolute(config.media)) throw new Error('The live media path must be absolute.');
    const [mediaRealPath, worktreeRealPath] = await Promise.all([
      realpath(config.media),
      realpath(process.cwd()),
    ]).catch(() => {
      throw new Error('The live media path is unavailable.');
    });
    await access(mediaRealPath).catch(() => {
      throw new Error('The live media path is unreadable.');
    });
    const mediaRelativeToWorktree = relative(worktreeRealPath, mediaRealPath);
    if (!(mediaRelativeToWorktree === '..'
      || mediaRelativeToWorktree.startsWith(`..${sep}`)
      || isAbsolute(mediaRelativeToWorktree))) {
      throw new Error('The live media path must resolve outside the Waptions worktree.');
    }

    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const failures = monitorPageFailures(page);
    const observedRequests: ObservedEditorialRequest[] = [];
    let requestParseFailure: 'missing-multipart' | 'missing-wav' | 'unexpected' | null = null;
    let authorizationDigestMatched = false;
    let endpointFieldMatched = false;
    await page.route(`**${EDITORIAL_SERVER_ROUTE_PATH}`, async (route) => {
      const request = route.request();
      try {
        const parsed = parseEditorialMultipartRequest(request);
        const transientApiKey = parsed.fields.apiKey ?? '';
        endpointFieldMatched = parsed.fields.endpoint === config.endpoint;
        authorizationDigestMatched = createHash('sha256').update(transientApiKey, 'utf8').digest('hex')
          === config.apiKeyDigest;
        // Keep only provider fields after proving the transient server-envelope values. This
        // prevents the credential from surviving in the test's request observations or artifacts.
        delete parsed.fields.apiKey;
        delete parsed.fields.endpoint;
        observedRequests.push(parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        requestParseFailure = message === 'The editorial request did not contain multipart bytes.'
          ? 'missing-multipart'
          : message === 'The editorial request omitted its WAV file.'
            ? 'missing-wav'
            : 'unexpected';
      } finally {
        // Observation must never substitute a mock: the unchanged multipart still traverses the
        // real Waptions proxy and runner-owned Lazy Whisper instance.
        await route.continue();
      }
    });

    await createEditorProject(page, 'Secure live text editor');
    const projectId = new URL(page.url()).pathname.split('/').at(-1);
    if (!projectId) throw new Error('The editor URL does not contain a project ID.');
    await page.locator('input[type="file"][accept="video/*,audio/*"]').setInputFiles(mediaRealPath);
    await expect(page.getByTestId('timeline-video-clip')).toHaveCount(1, { timeout: 120_000 });
    await flushProject(page);
    const importedCrop = await readImportedCropSnapshot(page, projectId);
    if (!exactClipSourceFrameRange(importedCrop.clip, importedCrop.source)) {
      throw new Error(`Imported live crop is not source-frame aligned: ${JSON.stringify(importedCrop)}`);
    }

    await page.getByRole('tab', { name: 'Text', exact: true }).click();
    await page.getByRole('textbox', { name: 'OpenAI-compatible endpoint' }).fill(config.endpoint);
    await page.getByRole('textbox', { name: /API key/ }).fill(config.apiKey);
    await page.getByRole('button', { name: 'server', exact: true }).click({ timeout: 30_000 });
    const serverRoute = new URL(EDITORIAL_SERVER_ROUTE_PATH, page.url()).href;
    const activationOutcomePromise = observeActivation(activateTextEditor(page));
    const firstResponse = await waitForEditorialResponseOrActivationFailure(
      page,
      serverRoute,
      activationOutcomePromise,
    );
    expect(firstResponse.ok()).toBe(true);
    const firstPayload = await firstResponse.json() as LiveResponseShape;

    expect(requestParseFailure).toBeNull();
    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0].fields).toEqual({
      model: FIXED_MODEL,
      response_format: 'verbose_json',
      stream: 'false',
      language: 'es',
    });
    expect(observedRequests[0].authorization).toBe(false);
    expect(authorizationDigestMatched).toBe(true);
    expect(endpointFieldMatched).toBe(true);
    const wav = observedRequests[0].wav;
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    const sampleCount = wav.readUInt32LE(40) / 2;
    // Parse the already-received payload in the test process before surfacing the UI's generic
    // error. The parser reports only a schema path and fixed diagnostic, never transcript text.
    const parsedRecord = await parseEditMaxEditorialTranscript(firstPayload, {
      sourceFingerprint: importedCrop.source.fingerprint,
      sampleCount,
      language: 'es',
      speakerMode: 'none',
    });
    assertLiveResponse(firstPayload, sampleCount);
    const activationOutcome = await activationOutcomePromise;
    if (activationOutcome.kind === 'failed') {
      const failedSnapshot = await readDurableEditorialSnapshot(page, projectId);
      await validateReproducedActivationGraph({
        mediaPath: mediaRealPath,
        snapshot: failedSnapshot,
        record: parsedRecord,
      });
      throw activationOutcome.error;
    }
    await expect(page.getByRole('listbox', { name: 'Unified text edit narrative' }).getByRole('option'))
      .not.toHaveCount(0);

    // Releasing ownership and activating the identical profile again must hydrate the verified
    // request-index winner without a second browser request or requiring the transient API key.
    await releaseOnlyControlledTrack(page);
    await activateTextEditor(page);
    expect(observedRequests).toHaveLength(1);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('editorial-text-setup')).toBeVisible();
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.getByRole('listbox', { name: 'Unified text edit narrative' })).toBeVisible();
    await flushProject(page);

    const snapshot = await readDurableEditorialSnapshot(page, projectId);
    const manifest = snapshot.manifest as {
      version?: unknown;
      editorialTranscriptDescriptors?: Array<Record<string, unknown>>;
      narrative?: { blockIds?: unknown[] } | null;
    };
    expect(manifest.version).toBe(4);
    expect(manifest.editorialTranscriptDescriptors).toHaveLength(1);
    expect(manifest.narrative?.blockIds?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot.manifest)).not.toContain('"canonicalJson":');
    expect(JSON.stringify(snapshot.manifest)).not.toContain('editorialTranscriptRecordBodies');
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.pins.length).toBeGreaterThan(0);
    const storedRecord = snapshot.records[0];
    expect(createHash('sha256').update(storedRecord.canonicalJson, 'utf8').digest('hex'))
      .toBe(storedRecord.recordId.replace('sha256:', ''));
    expect(Buffer.byteLength(storedRecord.canonicalJson)).toBe(storedRecord.byteLength);
    expect(snapshot.requests[0].descriptor.recordId).toBe(storedRecord.recordId);
    expect(manifest.editorialTranscriptDescriptors?.[0]?.recordId).toBe(storedRecord.recordId);

    await page.reload();
    await page.getByRole('tab', { name: 'Text', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Unified text edit narrative' })).toBeVisible();
    expect(observedRequests).toHaveLength(1);
    await page.getByRole('button', { name: 'Play timeline' }).click();
    await expect.poll(() => readTimelineTime(page), { timeout: 15_000 }).toBeGreaterThan(0.2);
    await page.getByRole('button', { name: 'Pause timeline' }).click();

    const bundleDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download project file' }).click();
    const bundlePath = await (await bundleDownloadPromise).path();
    if (!bundlePath) throw new Error('The project bundle was not retained for verification.');
    const bundleBytes = await readFile(bundlePath);
    expect(bundleBytes.includes(Buffer.from(config.apiKey, 'utf8'))).toBe(false);
    const bundle = await JSZip.loadAsync(bundleBytes);
    const metadataText = await bundle.file('metadata.json')?.async('string');
    if (!metadataText) throw new Error('The live project bundle has no metadata.');
    const metadata = JSON.parse(metadataText) as {
      version?: unknown;
      editorManifest?: { editorialTranscriptDescriptors?: Array<Record<string, unknown>> };
      editorialTranscriptFiles?: Record<string, string>;
    };
    expect(metadata.version).toBe('4.0');
    expect(metadata.editorManifest?.editorialTranscriptDescriptors).toHaveLength(1);
    const transcriptFiles = Object.entries(metadata.editorialTranscriptFiles ?? {});
    expect(transcriptFiles).toHaveLength(1);
    const [bundleRecordId, sidecarPath] = transcriptFiles[0];
    const sidecar = await bundle.file(sidecarPath)?.async('string');
    if (!sidecar) throw new Error('The live project bundle has no transcript sidecar.');
    expect(createHash('sha256').update(sidecar, 'utf8').digest('hex'))
      .toBe(bundleRecordId.replace('sha256:', ''));
    expect(metadata.editorManifest?.editorialTranscriptDescriptors?.[0]?.recordId).toBe(bundleRecordId);

    await page.getByTitle('Export video with timeline audio and subtitles').click();
    await page.getByRole('button', { name: 'WebM (VP9)' }).click();
    const mediaDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    const mediaPath = await (await mediaDownloadPromise).path();
    if (!mediaPath) throw new Error('The live media export was not retained for verification.');
    const mediaBytes = await readFile(mediaPath);
    expect(mediaBytes.byteLength).toBeGreaterThan(1_024);
    expect(mediaBytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    expect(mediaBytes.includes(Buffer.from(config.apiKey, 'utf8'))).toBe(false);

    // When the authorized local runtime advertises a ready diarization stack, exercise the same
    // fixed edit-max profile in a separate speaker-enabled request and validate its catalog.
    const healthUrl = new URL('/healthz', config.endpoint);
    const health = await fetch(healthUrl, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.ok ? response.json() : null).catch(() => null);
    const diarizationReady = health?.diarization?.enabled === true
      && health?.diarization?.runtime_available === true
      && health?.diarization?.model_available === true
      && (health?.diarization?.ready === true || health?.diarization?.state === 'loaded');
    if (diarizationReady) {
      await releaseOnlyControlledTrack(page);
      await page.getByRole('textbox', { name: 'OpenAI-compatible endpoint' }).fill(config.endpoint);
      await page.getByRole('textbox', { name: /API key/ }).fill(config.apiKey);
      await page.getByRole('combobox', { name: 'Speaker analysis' }).selectOption('on');
      const diarizedResponsePromise = waitForEditorialResponse(page, serverRoute);
      await activateTextEditor(page);
      const diarizedResponse = await diarizedResponsePromise;
      expect(diarizedResponse.ok()).toBe(true);
      const diarizedPayload = await diarizedResponse.json() as LiveResponseShape;
      const diarizedRequest = observedRequests.at(-1);
      if (!diarizedRequest) throw new Error('The speaker-enabled request was not observed.');
      expect(diarizedRequest.fields).toEqual({
        model: FIXED_MODEL,
        response_format: 'verbose_json',
        stream: 'false',
        language: 'es',
        diarize: 'true',
      });
      assertLiveResponse(diarizedPayload, diarizedRequest.wav.readUInt32LE(40) / 2);
      expect(Array.isArray(diarizedPayload.diarization?.speakers)).toBe(true);
      expect((diarizedPayload.diarization?.speakers as unknown[]).length).toBeGreaterThan(0);
      expect(Array.isArray(diarizedPayload.diarization?.segments)).toBe(true);
    }

    await flushProject(page);
    expect(await browserPersistenceContainsSecret(page, config.apiKey)).toBe(false);
    expect(failures.errors).toEqual([]);
    expect(failures.underruns).toEqual([]);
  });
});
