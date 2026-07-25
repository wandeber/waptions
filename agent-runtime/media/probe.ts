import { createHash } from 'node:crypto';
import {
  addReadRange,
  combineReadAccounting,
  createReadAccounting,
  freezeReadAccounting,
  type MediaReadAccounting,
} from './accounting';
import { BoundedConcurrencyGate } from './concurrency';
import type {
  MediaByteSource,
  MediaByteSourceFactoryPort,
  VerifiedMediaGrantPort,
} from './contracts';
import {
  ManagedMediaError,
  throwIfAborted,
  toManagedMediaError,
} from './errors';
import { MEDIA_JOB_LIMITS } from './limits';
import type { MediaDiagnosticsPort } from './ports';
import type {
  BoundedMediaProcessPort,
  ProbeProcessResult,
} from './process-port';
import { executeBoundedMediaProcess } from './process-execution';
import { AsyncResourceScope } from './resource-scope';
import type {
  MediaAudioStreamMetadata,
  MediaProbeMetadata,
  MediaRational,
  MediaVideoStreamMetadata,
  OpenMediaSnapshot,
  RegisteredImmutableMediaIdentity,
  Sha256Digest,
} from '../source-registry/contracts';

interface FfprobeStream {
  readonly index?: unknown;
  readonly codec_type?: unknown;
  readonly codec_name?: unknown;
  readonly profile?: unknown;
  readonly pix_fmt?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly avg_frame_rate?: unknown;
  readonly r_frame_rate?: unknown;
  readonly duration?: unknown;
  readonly bit_rate?: unknown;
  readonly sample_rate?: unknown;
  readonly channels?: unknown;
  readonly channel_layout?: unknown;
}

interface FfprobeDocument {
  readonly streams?: unknown;
  readonly format?: unknown;
}

interface FfprobeFormat {
  readonly format_name?: unknown;
  readonly format_long_name?: unknown;
  readonly duration?: unknown;
  readonly start_time?: unknown;
  readonly bit_rate?: unknown;
  readonly size?: unknown;
}

export interface ManagedMediaProbeResult {
  readonly sourceCapabilityId: string;
  readonly displayName: string;
  readonly identity: RegisteredImmutableMediaIdentity;
  readonly metadata: MediaProbeMetadata;
  readonly readAccounting: MediaReadAccounting;
}

export interface ManagedMediaProbePort {
  probeCapability(
    sourceCapabilityId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ManagedMediaProbeResult>;
}

function readOptionalString(value: unknown, maximumLength = 256): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    return undefined;
  }
  return value;
}

function readRequiredInteger(value: unknown, label: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', `Media ${label} is invalid.`);
  }
  return number;
}

function readOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    return undefined;
  }
  return number;
}

function secondsToMicroseconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '' || value === 'N/A') {
    return undefined;
  }
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  const microseconds = Math.round(seconds * 1_000_000);
  return Number.isSafeInteger(microseconds) ? microseconds : undefined;
}

function parseFrameRate(value: unknown): MediaRational | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^([0-9]+)\/([0-9]+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (
    !Number.isSafeInteger(numerator)
    || !Number.isSafeInteger(denominator)
    || numerator <= 0
    || denominator <= 0
  ) {
    return undefined;
  }
  return { numerator, denominator };
}

function parseVideoStream(stream: FfprobeStream): MediaVideoStreamMetadata | undefined {
  if (stream.codec_type !== 'video') {
    return undefined;
  }
  const codec = readOptionalString(stream.codec_name);
  const frameRate = parseFrameRate(stream.avg_frame_rate)
    ?? parseFrameRate(stream.r_frame_rate);
  if (!codec || !frameRate) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Video stream metadata is incomplete.');
  }
  const width = readRequiredInteger(stream.width, 'video width');
  const height = readRequiredInteger(stream.height, 'video height');
  if (width === 0 || height === 0) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Video dimensions must be positive.');
  }
  return {
    index: readRequiredInteger(stream.index, 'video stream index'),
    codec,
    profile: readOptionalString(stream.profile),
    pixelFormat: readOptionalString(stream.pix_fmt),
    width,
    height,
    frameRate,
    durationUs: secondsToMicroseconds(stream.duration),
    bitRate: readOptionalInteger(stream.bit_rate),
  };
}

function parseAudioStream(stream: FfprobeStream): MediaAudioStreamMetadata | undefined {
  if (stream.codec_type !== 'audio') {
    return undefined;
  }
  const codec = readOptionalString(stream.codec_name);
  if (!codec) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Audio stream metadata is incomplete.');
  }
  const sampleRate = readRequiredInteger(stream.sample_rate, 'audio sample rate');
  const channels = readRequiredInteger(stream.channels, 'audio channel count');
  if (sampleRate === 0 || channels === 0) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Audio stream shape must be positive.');
  }
  return {
    index: readRequiredInteger(stream.index, 'audio stream index'),
    codec,
    profile: readOptionalString(stream.profile),
    sampleRate,
    channels,
    channelLayout: readOptionalString(stream.channel_layout),
    durationUs: secondsToMicroseconds(stream.duration),
    bitRate: readOptionalInteger(stream.bit_rate),
  };
}

export function parseFfprobeMetadata(stdout: Uint8Array, expectedBytes: number): MediaProbeMetadata {
  if (stdout.byteLength > MEDIA_JOB_LIMITS.maxProbeStdoutBytes) {
    throw new ManagedMediaError('PAYLOAD_TOO_LARGE', 'ffprobe metadata exceeded its byte limit.');
  }

  let document: FfprobeDocument;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)) as FfprobeDocument;
  } catch (error) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'ffprobe returned invalid metadata.', {
      cause: error,
    });
  }
  if (!document || typeof document !== 'object') {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'ffprobe metadata is not an object.');
  }
  if (!Array.isArray(document.streams) || !document.format || typeof document.format !== 'object') {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'ffprobe metadata is incomplete.');
  }

  const streams = document.streams.filter(
    (stream): stream is FfprobeStream => Boolean(stream && typeof stream === 'object'),
  );
  const videoStreams = streams
    .map(parseVideoStream)
    .filter((stream): stream is MediaVideoStreamMetadata => Boolean(stream));
  const audioStreams = streams
    .map(parseAudioStream)
    .filter((stream): stream is MediaAudioStreamMetadata => Boolean(stream));
  if (videoStreams.length === 0) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Media contains no video stream.');
  }

  const format = document.format as FfprobeFormat;
  const declaredSize = readOptionalInteger(format.size);
  if (declaredSize !== undefined && declaredSize !== expectedBytes) {
    throw new ManagedMediaError('SOURCE_CHANGED', 'ffprobe observed a different source size.', {
      retryable: true,
    });
  }
  const streamDurations = [...videoStreams, ...audioStreams]
    .map((stream) => stream.durationUs)
    .filter((duration): duration is number => duration !== undefined);
  const durationUs = secondsToMicroseconds(format.duration)
    ?? (streamDurations.length > 0 ? Math.max(...streamDurations) : undefined);
  if (!durationUs || durationUs <= 0) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Media duration is missing or invalid.');
  }

  const containerFormats = (readOptionalString(format.format_name) ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (containerFormats.length === 0) {
    throw new ManagedMediaError('UNSUPPORTED_MEDIA', 'Media container format is missing.');
  }

  return {
    containerFormats: Array.from(new Set(containerFormats)),
    containerLongName: readOptionalString(format.format_long_name),
    durationUs,
    startTimeUs: secondsToMicroseconds(format.start_time),
    bitRate: readOptionalInteger(format.bit_rate),
    videoStreams,
    audioStreams,
    primaryVideoStreamIndex: videoStreams[0].index,
    primaryAudioStreamIndex: audioStreams[0]?.index,
  };
}

function snapshotsMatch(left: OpenMediaSnapshot, right: OpenMediaSnapshot): boolean {
  return (
    left.byteLength === right.byteLength
    && left.statIdentity === right.statIdentity
    && (!left.sha256 || !right.sha256 || left.sha256 === right.sha256)
  );
}

async function hashSource(
  source: MediaByteSource,
  expectedIdentity: OpenMediaSnapshot,
  operationId: string,
  diagnostics: MediaDiagnosticsPort,
  signal?: AbortSignal,
): Promise<{ readonly digest: Sha256Digest; readonly accounting: MediaReadAccounting }> {
  const size = await source.size();
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ManagedMediaError('SOURCE_UNREADABLE', 'Media source size is invalid.');
  }
  if (size !== expectedIdentity.byteLength) {
    throw new ManagedMediaError('SOURCE_CHANGED', 'Media source size changed before hashing.', {
      retryable: true,
    });
  }
  const accounting = createReadAccounting();
  const stream = source.stream({ start: 0, endExclusive: size }, signal);
  const reader = stream.getReader();
  const hash = createHash('sha256');
  let totalBytes = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new ManagedMediaError('SOURCE_UNREADABLE', 'Media source returned an invalid chunk.');
      }
      if (value.byteLength > MEDIA_JOB_LIMITS.hashChunkBytes) {
        throw new ManagedMediaError(
          'RESOURCE_LIMIT_EXCEEDED',
          'Media source exceeded the maximum streamed hash chunk.',
        );
      }
      totalBytes += value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > size) {
        throw new ManagedMediaError('SOURCE_CHANGED', 'Media source length changed while hashing.');
      }
      accounting.maxChunkBytes = Math.max(accounting.maxChunkBytes, value.byteLength);
      hash.update(value);
      diagnostics.record({
        name: 'media.hash.chunk-bytes',
        operationId,
        value: value.byteLength,
      });
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throwIfAborted(signal);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (totalBytes !== size) {
    throw new ManagedMediaError('SOURCE_CHANGED', 'Media source length changed while hashing.');
  }
  addReadRange(
    accounting,
    { start: 0, endExclusive: size },
    totalBytes,
    MEDIA_JOB_LIMITS.maxReadAccountingRanges,
  );
  return {
    digest: `sha256:${hash.digest('hex')}`,
    accounting: freezeReadAccounting(accounting),
  };
}

function assertDigestMatches(
  digest: Sha256Digest,
  snapshots: readonly OpenMediaSnapshot[],
): void {
  if (snapshots.some((snapshot) => snapshot.sha256 && snapshot.sha256 !== digest)) {
    throw new ManagedMediaError('SOURCE_CHANGED', 'Media source digest changed during probing.', {
      retryable: true,
    });
  }
}

export class ManagedMediaProbeService implements ManagedMediaProbePort {
  private readonly gate: BoundedConcurrencyGate;

  constructor(
    private readonly grants: VerifiedMediaGrantPort,
    private readonly byteSources: MediaByteSourceFactoryPort,
    private readonly processes: BoundedMediaProcessPort,
    private readonly diagnostics: MediaDiagnosticsPort,
  ) {
    this.gate = new BoundedConcurrencyGate(
      MEDIA_JOB_LIMITS.maxProbeConcurrency,
      'media.probe.concurrency',
      diagnostics,
    );
  }

  async probeCapability(
    sourceCapabilityId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ManagedMediaProbeResult> {
    const release = await this.gate.acquire(operationId, signal);
    try {
      return await this.probeExclusive(sourceCapabilityId, operationId, signal);
    } finally {
      release();
    }
  }

  private async probeExclusive(
    sourceCapabilityId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ManagedMediaProbeResult> {
    throwIfAborted(signal);
    const scope = new AsyncResourceScope(operationId, this.diagnostics);
    let primaryError: unknown;

    try {
      const handle = await this.grants.openSource(sourceCapabilityId, signal);
      scope.defer(() => handle.close());
      const source = await this.byteSources.open(handle, signal);
      scope.defer(() => source.close());

      const beforeSource = await source.verify(signal);
      const beforeGrant = await this.grants.revalidateOpenSource(handle, signal);
      if (
        !snapshotsMatch(handle.snapshot, beforeSource)
        || !snapshotsMatch(handle.snapshot, beforeGrant)
      ) {
        throw new ManagedMediaError('PATH_IDENTITY_CHANGED', 'Open source identity changed.', {
          retryable: true,
        });
      }

      const hashed = await hashSource(
        source,
        handle.snapshot,
        operationId,
        this.diagnostics,
        signal,
      );
      assertDigestMatches(hashed.digest, [
        handle.snapshot,
        beforeSource,
        beforeGrant,
      ]);
      const processResult = await executeBoundedMediaProcess(this.processes, {
        operationId,
        source: handle,
        operation: { kind: 'probe' },
        limits: {
          timeoutMs: MEDIA_JOB_LIMITS.probeTimeoutMs,
          killGraceMs: MEDIA_JOB_LIMITS.processKillGraceMs,
          maxInputBytes: MEDIA_JOB_LIMITS.maxProbeInputBytes,
          maxOutputBytes: 0,
          maxStdoutBytes: MEDIA_JOB_LIMITS.maxProbeStdoutBytes,
          maxStderrBytes: MEDIA_JOB_LIMITS.maxProbeStderrBytes,
          maxBufferedBytes: MEDIA_JOB_LIMITS.processStreamBufferBytes,
          maxResidentBytes: 128 * 1024 * 1024,
        },
      }, signal) as ProbeProcessResult;
      const metadata = parseFfprobeMetadata(processResult.stdout, handle.snapshot.byteLength);

      const afterSource = await source.verify(signal);
      const afterGrant = await this.grants.revalidateOpenSource(handle, signal);
      if (
        !snapshotsMatch(handle.snapshot, afterSource)
        || !snapshotsMatch(handle.snapshot, afterGrant)
      ) {
        throw new ManagedMediaError('SOURCE_CHANGED', 'Media source changed during probing.', {
          retryable: true,
        });
      }
      assertDigestMatches(hashed.digest, [afterSource, afterGrant]);
      const identity: RegisteredImmutableMediaIdentity = {
        version: 1,
        sha256: hashed.digest,
        byteLength: handle.snapshot.byteLength,
        statIdentity: handle.snapshot.statIdentity,
      };
      const readAccounting = combineReadAccounting(
        [hashed.accounting, processResult.accounting.input],
        MEDIA_JOB_LIMITS.maxReadAccountingRanges,
      );
      this.diagnostics.record({
        name: 'media.probe.completed',
        operationId,
        readAccounting,
        attributes: {
          hasAudio: metadata.audioStreams.length > 0,
          videoStreams: metadata.videoStreams.length,
          audioStreams: metadata.audioStreams.length,
        },
      });

      await scope.dispose();
      return {
        sourceCapabilityId,
        displayName: handle.displayName,
        identity,
        metadata,
        readAccounting,
      };
    } catch (error) {
      primaryError = signal?.aborted
        ? new ManagedMediaError('ABORTED', 'Managed media probe was cancelled.', {
          retryable: true,
          cause: signal.reason ?? error,
        })
        : toManagedMediaError(error);
      throw primaryError;
    } finally {
      if (primaryError !== undefined) {
        await scope.dispose().catch((cleanupError) => {
          this.diagnostics.record({
            name: 'media.resources.cleanup-failed',
            operationId,
            attributes: {
              cleanupError: cleanupError instanceof Error
                ? cleanupError.name
                : 'UnknownCleanupError',
            },
          });
        });
      }
    }
  }
}
