import type { FileHandle } from 'node:fs/promises';
import type {
    CoreMediaIdentity,
    MediaByteRange,
} from '../../src/lib/media-byte-source/types';
import type { FilesystemStatToken } from '../../src/lib/media-byte-source/filesystem-source';

export const MANAGED_MEDIA_ALGORITHM_VERSION = 'managed-media-v1';
export const MANAGED_MEDIA_HASH_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_MEDIA_CANDIDATES = 500;
export const DEFAULT_MEDIA_CANDIDATES = 200;

export interface MediaCandidate {
    readonly candidateId: string;
    readonly displayName: string;
    readonly extension: string;
}

/** Capability returned only after a path-grant adapter has opened and verified one regular file. */
export interface VerifiedOpenMediaHandle {
    readonly candidateId: string;
    readonly sourceId: string;
    readonly grantId: string;
    readonly canonicalPath: string;
    readonly displayName: string;
    readonly handle: FileHandle;
    readonly statToken: FilesystemStatToken;
    readonly sizeBytes: number;
}

export interface VerifiedMediaAccessPort {
    listCandidates(request: {
        grantId: string;
        directory?: string;
        maximumCandidates: number;
        signal?: AbortSignal;
    }): Promise<readonly MediaCandidate[]>;
    openCandidate(request: {
        grantId: string;
        candidateId: string;
        signal?: AbortSignal;
    }): Promise<VerifiedOpenMediaHandle>;
}

export interface ProbedVideoStream {
    readonly streamIndex: number;
    readonly codec: string | null;
    readonly width: number;
    readonly height: number;
    readonly frameRate: number | null;
    readonly durationSeconds: number | null;
}

export interface ProbedAudioStream {
    readonly streamIndex: number;
    readonly codec: string | null;
    readonly sampleRate: number | null;
    readonly channelCount: number | null;
    readonly durationSeconds: number | null;
}

export interface ProbedMediaMetadata {
    readonly container: string | null;
    readonly durationSeconds: number;
    readonly bitrate: number | null;
    readonly video: ProbedVideoStream | null;
    readonly audio: ProbedAudioStream | null;
}

export interface ManagedMediaDescriptor {
    readonly sourceId: string;
    readonly displayName: string;
    readonly identity: CoreMediaIdentity;
    readonly metadata: ProbedMediaMetadata;
}

export interface ManagedProcessSpec {
    readonly executable: string;
    readonly args: readonly string[];
    readonly inputHandle?: FileHandle;
    readonly stdoutLimitBytes: number;
    readonly stderrLimitBytes: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

export interface ManagedProcessResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface ManagedProcessPort {
    run(spec: ManagedProcessSpec): Promise<ManagedProcessResult>;
}

export interface MediaProbePort {
    probe(handle: VerifiedOpenMediaHandle, signal?: AbortSignal): Promise<ProbedMediaMetadata>;
}

export interface ManagedSourceLease {
    readonly descriptor: ManagedMediaDescriptor;
    readonly handle: FileHandle;
    readonly replacementSignal: AbortSignal;
    assertCurrent(signal?: AbortSignal): Promise<void>;
    read(range: MediaByteRange, signal?: AbortSignal): Promise<Uint8Array>;
    close(): Promise<void>;
}

export interface ManagedSourceRegistryPort {
    register(
        handle: VerifiedOpenMediaHandle,
        identity: CoreMediaIdentity,
        metadata: ProbedMediaMetadata,
    ): Promise<ManagedMediaDescriptor>;
    /** Consumes every supplied handle and publishes the complete batch in one synchronous swap. */
    registerBatch(entries: readonly {
        handle: VerifiedOpenMediaHandle;
        identity: CoreMediaIdentity;
        metadata: ProbedMediaMetadata;
    }[]): Promise<readonly ManagedMediaDescriptor[]>;
    acquire(sourceId: string, signal?: AbortSignal): Promise<ManagedSourceLease>;
}
