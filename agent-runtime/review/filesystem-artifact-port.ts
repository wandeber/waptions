import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    link,
    mkdir,
    mkdtemp,
    rm,
    stat,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaBudgetManager } from '../../src/lib/media-byte-source/budget-manager';
import { throwIfAborted } from '../../src/lib/media-byte-source/types';
import { canonicalJson } from './artifact-key';
import type {
    ReviewArtifactDescriptor,
    ReviewArtifactPort,
    ReviewKind,
    StagedReviewArtifact,
    VerifiedArtifactStagingGrant,
} from './contracts';

const ARTIFACT_HASH_CHUNK_BYTES = 8 * 1024 * 1024;

export class FilesystemReviewArtifactPort implements ReviewArtifactPort {
    constructor(
        private readonly stagingGrant: VerifiedArtifactStagingGrant,
        private readonly compressedBudget: MediaBudgetManager,
    ) {
        if (stagingGrant.ownership !== 'coordinator-owned-private-directory') {
            throw new Error('Review artifacts require a coordinator-owned private staging root.');
        }
    }

    async stage(request: {
        contentKey: string;
        kind: ReviewKind;
        extension: string;
        mediaType: string;
        maximumBytes: number;
        signal?: AbortSignal;
    }): Promise<StagedReviewArtifact> {
        throwIfAborted(request.signal);
        await this.stagingGrant.assertCurrent(request.signal);
        validateContentKey(request.contentKey);
        const artifactRoot = this.stagingGrant.canonicalDirectory;
        const stagingRoot = join(artifactRoot, '.staging');
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        const temporaryDirectory = await mkdtemp(join(stagingRoot, 'review-'));
        const stagingPath = join(temporaryDirectory, `artifact.${request.extension}`);
        const artifactId = createHash('sha256')
            .update(`${request.contentKey}:${request.kind}`)
            .digest('hex');
        const finalDirectory = join(artifactRoot, 'objects', artifactId.slice(0, 2));
        const finalPath = join(finalDirectory, `${artifactId}.${request.extension}`);
        let terminal: Promise<ReviewArtifactDescriptor> | null = null;
        let discarded = false;

        const discard = async () => {
            if (discarded) return;
            discarded = true;
            await rm(temporaryDirectory, { recursive: true, force: true });
        };
        const commit = async (signal?: AbortSignal): Promise<ReviewArtifactDescriptor> => {
            if (terminal) return terminal;
            terminal = (async () => {
                throwIfAborted(signal);
                const stagedStat = await stat(stagingPath);
                if (!stagedStat.isFile() || stagedStat.size > request.maximumBytes) {
                    throw new Error('The review artifact is missing or exceeds its hard file-size limit.');
                }
                const stagedDigest = await hashArtifact(
                    stagingPath,
                    this.compressedBudget,
                    signal,
                );
                throwIfAborted(signal);
                await this.stagingGrant.assertCurrent(signal);
                await mkdir(finalDirectory, { recursive: true, mode: 0o700 });
                throwIfAborted(signal);
                let published = false;
                try {
                    await link(stagingPath, finalPath);
                    published = true;
                } catch (error) {
                    if (!isAlreadyExists(error)) throw error;
                }
                let finalStat;
                let digest = stagedDigest;
                if (!published) {
                    finalStat = await stat(finalPath);
                    if (!finalStat.isFile() || finalStat.size !== stagedStat.size) {
                        throw new Error('The existing content-addressed artifact does not match the staged output.');
                    }
                    digest = await hashArtifact(finalPath, this.compressedBudget, signal);
                    if (digest !== stagedDigest) {
                        throw new Error('The existing content-addressed artifact failed digest verification.');
                    }
                } else {
                    finalStat = await stat(finalPath);
                }
                await unlink(stagingPath).catch(() => undefined);
                await discard();
                return Object.freeze({
                    artifactId,
                    contentKey: request.contentKey,
                    kind: request.kind,
                    mediaType: request.mediaType,
                    byteLength: finalStat.size,
                    sha256: digest,
                });
            })();
            try {
                return await terminal;
            } catch (error) {
                terminal = null;
                throw error;
            }
        };
        return {
            stagingPath,
            writeJson: async (value, signal) => {
                throwIfAborted(signal);
                const bytes = Buffer.from(canonicalJson(value));
                if (bytes.byteLength > request.maximumBytes) {
                    throw new Error('The JSON review artifact exceeds its hard file-size limit.');
                }
                await writeFile(stagingPath, bytes, { flag: 'wx' });
                throwIfAborted(signal);
            },
            commit,
            discard,
        };
    }
}

async function hashArtifact(
    path: string,
    budget: MediaBudgetManager,
    signal?: AbortSignal,
): Promise<string> {
    const reservation = await budget.reserve(ARTIFACT_HASH_CHUNK_BYTES, {
        label: 'managed-artifact-hash',
        signal,
    });
    const lease = reservation.commit();
    try {
        const hash = createHash('sha256');
        const stream = createReadStream(path, {
            highWaterMark: ARTIFACT_HASH_CHUNK_BYTES,
            signal,
        });
        for await (const chunk of stream) {
            throwIfAborted(signal);
            hash.update(chunk as Buffer);
        }
        return hash.digest('hex');
    } finally {
        lease.release();
    }
}

function validateContentKey(value: string): void {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
        throw new Error('Review artifact content keys must be canonical SHA-256 identifiers.');
    }
}

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}
