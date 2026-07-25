import { z } from 'zod';
import type { McpToolEnvelope } from './mcp-envelope';
import type {
  McpArtifactListData,
  McpEventsReadData,
  McpHistoryGetData,
  McpJobListData,
  McpProjectSummaryData,
  McpTimelineQueryData,
  McpViewData,
} from './mcp-projection-contract';

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = safeInteger.refine((value) => value > 0);
const opaqueId = z.string().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
);
const operationId = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestamp = z.string().min(1).max(64);
const boundedDetails = z.strictObject({
  operationId: operationId.optional(),
  resourceKind: z.string().min(1).max(64).optional(),
  ids: z.array(opaqueId).max(64).optional(),
  issues: z.array(z.strictObject({
    code: z.string().min(1).max(128),
    path: z.string().min(1).max(512),
    message: z.string().min(1).max(1024),
  })).max(64).optional(),
  domain: z.enum(['session', 'document', 'audio', 'narrative', 'view', 'playback']).optional(),
  expectedRevision: safeInteger.optional(),
  actualRevision: safeInteger.optional(),
  limitBytes: positiveSafeInteger.optional(),
  grantId: opaqueId.optional(),
  jobId: opaqueId.optional(),
  cursor: opaqueId.optional(),
}).refine((details) => Object.keys(details).length > 0);

export const mcpStateTokenSchema = z.strictObject({
  sessionId: opaqueId,
  projectId: opaqueId,
  sessionEpoch: opaqueId,
  sessionRevision: safeInteger,
  documentRevision: safeInteger,
  audioGraphRevision: safeInteger,
  narrativeRevision: safeInteger.optional(),
  eventCursor: opaqueId,
});

export const mcpPageSchema = z.strictObject({
  nextCursor: opaqueId.optional(),
  hasMore: z.boolean(),
});

const graphReference = z.strictObject({
  id: opaqueId,
  kind: z.string().min(1).max(64),
  trackId: opaqueId.optional(),
  startFrame: safeInteger.optional(),
  endFrame: safeInteger.optional(),
  label: z.string().max(512).optional(),
});

export const mcpProjectSummaryDataSchema: z.ZodType<McpProjectSummaryData> = z.strictObject({
  projectId: opaqueId,
  name: z.string().min(1).max(256),
  renderProfile: z.strictObject({
    fps: z.strictObject({
      numerator: positiveSafeInteger,
      denominator: positiveSafeInteger,
    }),
    width: positiveSafeInteger,
    height: positiveSafeInteger,
    audioSampleRate: z.literal(48_000),
    isFrameRateLocked: z.boolean(),
    isCanvasSizeLocked: z.boolean(),
  }),
  renderBackgroundColor: z.string().regex(/^#[0-9a-f]{6}$/),
  counts: z.strictObject({
    tracks: safeInteger,
    clips: safeInteger,
    subtitles: safeInteger,
    sources: safeInteger,
    links: safeInteger,
  }),
  activeJobIds: z.array(opaqueId).max(256),
  references: z.array(graphReference).max(500),
  page: mcpPageSchema,
});

export const mcpTimelineQueryDataSchema: z.ZodType<McpTimelineQueryData> = z.strictObject({
  entityKind: z.string().min(1).max(64),
  items: z.array(graphReference).max(500),
  page: mcpPageSchema,
});

const historySummary = z.strictObject({
  entryId: opaqueId,
  label: z.string().min(1).max(256),
  category: z.string().min(1).max(256),
  occurredAt: timestamp,
  operationIds: z.array(operationId).max(256),
  fromRevision: safeInteger,
  toRevision: safeInteger,
});

export const mcpHistoryGetDataSchema: z.ZodType<McpHistoryGetData> = z.strictObject({
  currentIndex: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  past: z.array(historySummary).max(500),
  future: z.array(historySummary).max(500),
  page: mcpPageSchema,
});

const jobRecord = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: opaqueId,
  projectId: opaqueId,
  kind: z.enum([
    'media-probe-import',
    'contact-sheet',
    'thumbnail-strip',
    'waveform-audio-map',
    'silence-speech-map',
    'scene-cut-candidates',
    'review-proxy',
    'subtitle-transcription',
    'editorial-transcription',
    'bundle-import',
    'bundle-export',
    'headless-project-validation',
    'final-video-export',
    'cleanup-verification',
  ]),
  inputDigest: digest,
  capturedState: mcpStateTokenSchema,
  jobSequence: safeInteger,
  state: z.enum([
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'stale',
    'interrupted',
  ]),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  stage: z.string().min(1).max(128),
  fraction: z.number().min(0).max(1).optional(),
  message: z.string().max(1024).optional(),
  cancellationRequested: z.boolean(),
  cancellationRequestedAt: timestamp.optional(),
  checkpointRef: opaqueId.optional(),
  resultArtifactIds: z.array(opaqueId).max(256),
  error: z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
    retryable: z.boolean(),
    details: boundedDetails.optional(),
  }).optional(),
});

export const mcpJobListDataSchema: z.ZodType<McpJobListData> = z.strictObject({
  items: z.array(jobRecord).max(500),
  page: mcpPageSchema,
});

const artifactRecord = z.strictObject({
  schemaVersion: z.literal(1),
  artifactId: opaqueId,
  projectId: opaqueId,
  jobId: opaqueId.optional(),
  kind: z.enum([
    'contact-sheet',
    'thumbnail-strip',
    'waveform',
    'audio-map',
    'silence-speech-map',
    'scene-cuts',
    'review-proxy',
    'transcript',
    'project-bundle',
    'reference-snapshot',
    'proof-record',
    'video-export',
    'validation-report',
  ]),
  contentDigest: digest,
  byteLength: safeInteger,
  createdAt: timestamp,
  expiresAt: timestamp.optional(),
  storageRef: opaqueId,
});

export const mcpArtifactListDataSchema: z.ZodType<McpArtifactListData> = z.strictObject({
  items: z.array(artifactRecord).max(500),
  page: mcpPageSchema,
});

const viewSelection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.enum(['tracks', 'clips', 'subtitles', 'narrative']),
    ids: z.array(opaqueId).min(1).max(256),
  }),
]);

export const mcpViewDataSchema: z.ZodType<McpViewData> = z.strictObject({
  view: z.strictObject({
    viewId: opaqueId,
    viewRevision: safeInteger,
    selection: viewSelection,
    playheadFrame: safeInteger,
    zoom: z.number().nonnegative(),
    scrollLeft: z.number().nonnegative(),
    focusedPanel: z.string().max(128).optional(),
    presentation: z.enum(['inline', 'fullscreen', 'picture-in-picture']),
    participantIds: z.array(opaqueId).max(128),
  }),
});

const eventRecord = z.strictObject({
  schemaVersion: z.literal(1),
  cursor: opaqueId,
  type: z.enum([
    'session.recovered',
    'project.snapshot',
    'project.mutated',
    'history.changed',
    'job.changed',
    'artifact.created',
    'diagnostics.changed',
    'presence.changed',
    'view.changed',
    'source.invalidated',
  ]),
  occurredAt: timestamp,
  state: mcpStateTokenSchema,
  sequence: safeInteger,
  // Event payloads are discriminated by type in the canonical schema. The shared Core schema
  // loader is Node-only, so the browser transport validates the closed envelope and projection
  // fields it consumes without duplicating every event payload definition.
  data: z.record(z.string(), z.unknown()),
});

export const mcpEventsReadDataSchema: z.ZodType<McpEventsReadData> = z.strictObject({
  events: z.array(eventRecord).max(500),
  nextCursor: opaqueId,
  hasMore: z.boolean(),
});

export const mcpUnknownDataSchema = z.record(z.string(), z.unknown());

const warningSchema = z.strictObject({
  code: z.enum([
    'NO_OP',
    'INPUT_NORMALIZED',
    'PARTIAL_RESULT',
    'RENDER_BACKEND_FALLBACK',
    'PRESENTATION_FALLBACK',
    'SAFE_CACHE_RETAINED',
  ]),
  message: z.string().min(1).max(1024),
  operationId: operationId.optional(),
});

const failureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
    retryable: z.boolean(),
    details: boundedDetails.optional(),
  }),
  state: mcpStateTokenSchema.optional(),
});

export const parseMcpToolEnvelope = <Data>(
  value: unknown,
  dataSchema: z.ZodType<Data>,
  toolName: string,
): McpToolEnvelope<Data> => {
  const schema = z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      data: dataSchema,
      state: mcpStateTokenSchema,
      warnings: z.array(warningSchema).max(64),
      replayed: z.boolean(),
      committedState: mcpStateTokenSchema.optional(),
    }),
    failureSchema,
  ]);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${toolName} returned an invalid authoritative envelope.`);
  }
  return parsed.data as McpToolEnvelope<Data>;
};
