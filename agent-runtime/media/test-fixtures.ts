import type { ByteRange } from './accounting';
import type {
  MediaByteSource,
  MediaByteSourceFactoryPort,
  VerifiedDirectoryCapability,
  VerifiedMediaCandidate,
  VerifiedMediaGrantPort,
  ManagedJobOpenMediaHandle,
} from './contracts';
import { ManagedMediaError, throwIfAborted } from './errors';
import type {
  MediaDiagnosticsEvent,
  MediaDiagnosticsPort,
} from './ports';
import type { OpenMediaSnapshot } from '../source-registry/contracts';

export class RecordingDiagnostics implements MediaDiagnosticsPort {
  readonly events: MediaDiagnosticsEvent[] = [];

  record(event: MediaDiagnosticsEvent): void {
    this.events.push(event);
  }
}

export class FakeVerifiedMediaGrantPort implements VerifiedMediaGrantPort {
  readonly closeCounts = new Map<string, number>();
  readonly openCounts = new Map<string, number>();
  private readonly snapshots = new Map<string, OpenMediaSnapshot>();

  constructor(
    private readonly candidates: readonly VerifiedMediaCandidate[],
    snapshots: Readonly<Record<string, OpenMediaSnapshot>>,
  ) {
    for (const [capabilityId, snapshot] of Object.entries(snapshots)) {
      this.snapshots.set(capabilityId, { ...snapshot });
    }
  }

  async *listDirectory(
    _directory: VerifiedDirectoryCapability,
    options: { readonly maxEntries: number },
    signal?: AbortSignal,
  ): AsyncIterable<VerifiedMediaCandidate> {
    if (this.candidates.length > options.maxEntries) {
      throw new ManagedMediaError(
        'RESOURCE_LIMIT_EXCEEDED',
        'Fixture directory exceeded its entry limit.',
      );
    }
    for (const candidate of this.candidates) {
      throwIfAborted(signal);
      yield candidate;
    }
  }

  async openSource(
    sourceCapabilityId: string,
    signal?: AbortSignal,
  ): Promise<ManagedJobOpenMediaHandle> {
    throwIfAborted(signal);
    const snapshot = this.snapshots.get(sourceCapabilityId);
    if (!snapshot) {
      throw new ManagedMediaError('PATH_NOT_GRANTED', 'Fixture capability is unavailable.');
    }
    this.openCounts.set(sourceCapabilityId, (this.openCounts.get(sourceCapabilityId) ?? 0) + 1);
    let closed = false;
    return {
      handleId: `handle:${sourceCapabilityId}:${this.openCounts.get(sourceCapabilityId)}`,
      sourceCapabilityId,
      displayName: this.candidates.find(
        (candidate) => candidate.sourceCapabilityId === sourceCapabilityId,
      )?.displayName ?? `${sourceCapabilityId}.mp4`,
      snapshot: { ...snapshot },
      processInputCapabilityId: `process:${sourceCapabilityId}`,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        this.closeCounts.set(
          sourceCapabilityId,
          (this.closeCounts.get(sourceCapabilityId) ?? 0) + 1,
        );
      },
    };
  }

  async revalidateOpenSource(
    handle: ManagedJobOpenMediaHandle,
    signal?: AbortSignal,
  ): Promise<OpenMediaSnapshot> {
    throwIfAborted(signal);
    const snapshot = this.snapshots.get(handle.sourceCapabilityId);
    if (!snapshot) {
      throw new ManagedMediaError('SOURCE_UNREADABLE', 'Fixture source disappeared.');
    }
    return { ...snapshot };
  }

  mutate(sourceCapabilityId: string, snapshot: OpenMediaSnapshot): void {
    this.snapshots.set(sourceCapabilityId, { ...snapshot });
  }

  currentSnapshot(sourceCapabilityId: string): OpenMediaSnapshot {
    const snapshot = this.snapshots.get(sourceCapabilityId);
    if (!snapshot) {
      throw new Error('Missing fixture snapshot.');
    }
    return { ...snapshot };
  }
}

export class InMemoryMediaByteSource implements MediaByteSource {
  closeCount = 0;
  maximumChunkBytes = 0;
  private closed = false;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly snapshot: () => OpenMediaSnapshot,
    private readonly chunkBytes = 1024 * 1024,
  ) {}

  get identity(): OpenMediaSnapshot {
    return this.snapshot();
  }

  async size(): Promise<number> {
    this.assertOpen();
    return this.bytes.byteLength;
  }

  async read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen();
    throwIfAborted(signal);
    if (
      range.start < 0
      || range.endExclusive < range.start
      || range.endExclusive > this.bytes.byteLength
    ) {
      throw new ManagedMediaError('INVALID_REQUEST', 'Fixture range is invalid.');
    }
    return this.bytes.slice(range.start, range.endExclusive);
  }

  stream(range?: ByteRange, signal?: AbortSignal): ReadableStream<Uint8Array> {
    this.assertOpen();
    const selected = range ?? { start: 0, endExclusive: this.bytes.byteLength };
    let offset = selected.start;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        throwIfAborted(signal);
        this.assertOpen();
        if (offset >= selected.endExclusive) {
          controller.close();
          return;
        }
        const end = Math.min(selected.endExclusive, offset + this.chunkBytes);
        const chunk = this.bytes.slice(offset, end);
        this.maximumChunkBytes = Math.max(this.maximumChunkBytes, chunk.byteLength);
        offset = end;
        controller.enqueue(chunk);
      },
    });
  }

  async verify(signal?: AbortSignal): Promise<OpenMediaSnapshot> {
    this.assertOpen();
    throwIfAborted(signal);
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeCount += 1;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ManagedMediaError('SOURCE_UNREADABLE', 'Fixture source is closed.');
    }
  }
}

export class FakeMediaByteSourceFactory implements MediaByteSourceFactoryPort {
  readonly opened: InMemoryMediaByteSource[] = [];

  constructor(
    private readonly grants: FakeVerifiedMediaGrantPort,
    private readonly bytes: Readonly<Record<string, Uint8Array>>,
    private readonly chunkBytes = 1024 * 1024,
  ) {}

  async open(handle: ManagedJobOpenMediaHandle): Promise<InMemoryMediaByteSource> {
    const bytes = this.bytes[handle.sourceCapabilityId];
    if (!bytes) {
      throw new ManagedMediaError('SOURCE_UNREADABLE', 'Fixture bytes are unavailable.');
    }
    const source = new InMemoryMediaByteSource(
      bytes,
      () => this.grants.currentSnapshot(handle.sourceCapabilityId),
      this.chunkBytes,
    );
    this.opened.push(source);
    return source;
  }
}

export class LogicalSparseMediaByteSource implements MediaByteSource {
  closeCount = 0;
  maximumResidentChunkBytes = 0;
  private closed = false;

  constructor(
    readonly identity: OpenMediaSnapshot,
    private readonly chunkBytes: number,
  ) {}

  async size(): Promise<number> {
    this.assertOpen();
    return this.identity.byteLength;
  }

  async read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertOpen();
    throwIfAborted(signal);
    this.assertRange(range);
    const length = range.endExclusive - range.start;
    if (length > this.chunkBytes) {
      throw new ManagedMediaError(
        'RESOURCE_LIMIT_EXCEEDED',
        'Logical sparse fixture read exceeded its chunk bound.',
      );
    }
    const bytes = new Uint8Array(length);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (range.start + index) % 251;
    }
    this.maximumResidentChunkBytes = Math.max(this.maximumResidentChunkBytes, bytes.byteLength);
    return bytes;
  }

  stream(range?: ByteRange, signal?: AbortSignal): ReadableStream<Uint8Array> {
    this.assertOpen();
    const selected = range ?? { start: 0, endExclusive: this.identity.byteLength };
    this.assertRange(selected);
    let offset = selected.start;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        throwIfAborted(signal);
        if (offset >= selected.endExclusive) {
          controller.close();
          return;
        }
        const endExclusive = Math.min(selected.endExclusive, offset + this.chunkBytes);
        const chunk = await this.read({ start: offset, endExclusive }, signal);
        offset = endExclusive;
        controller.enqueue(chunk);
      },
    }, {
      highWaterMark: 1,
      size: () => 1,
    });
  }

  async verify(signal?: AbortSignal): Promise<OpenMediaSnapshot> {
    this.assertOpen();
    throwIfAborted(signal);
    return { ...this.identity };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeCount += 1;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ManagedMediaError('SOURCE_UNREADABLE', 'Logical sparse fixture is closed.');
    }
  }

  private assertRange(range: ByteRange): void {
    if (
      !Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.endExclusive)
      || range.start < 0
      || range.endExclusive < range.start
      || range.endExclusive > this.identity.byteLength
    ) {
      throw new ManagedMediaError('INVALID_REQUEST', 'Logical sparse fixture range is invalid.');
    }
  }
}

export function ffprobeJson(input: {
  readonly size: number;
  readonly durationSeconds?: number;
  readonly audio?: boolean;
  readonly format?: string;
}): Uint8Array {
  const document = {
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        profile: 'High',
        pix_fmt: 'yuv420p',
        width: 1920,
        height: 1080,
        avg_frame_rate: '30000/1001',
        duration: String(input.durationSeconds ?? 12),
        bit_rate: '2000000',
      },
      ...(input.audio === false
        ? []
        : [{
          index: 1,
          codec_type: 'audio',
          codec_name: 'aac',
          sample_rate: '48000',
          channels: 2,
          channel_layout: 'stereo',
          duration: String(input.durationSeconds ?? 12),
          bit_rate: '128000',
        }]),
    ],
    format: {
      format_name: input.format ?? 'mov,mp4,m4a,3gp,3g2,mj2',
      format_long_name: 'QuickTime / MOV',
      duration: String(input.durationSeconds ?? 12),
      bit_rate: '2128000',
      size: String(input.size),
    },
  };
  return new TextEncoder().encode(JSON.stringify(document));
}
