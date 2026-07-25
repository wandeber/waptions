import { open, mkdtemp, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaBudgetManager } from '../../src/lib/media-byte-source/budget-manager';
import type { FilesystemStatToken } from '../../src/lib/media-byte-source/filesystem-source';
import { ImmutableSourceRegistry } from '../source-registry/immutable-source-registry';
import type {
    MediaCandidate,
    MediaProbePort,
    ProbedMediaMetadata,
    VerifiedMediaAccessPort,
    VerifiedOpenMediaHandle,
} from './contracts';
import { BoundedConcurrency } from './concurrency';
import { MediaProbeImportService, hashVerifiedHandle } from './probe-import-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
        recursive: true,
        force: true,
    })));
});

describe('MediaProbeImportService', () => {
    it('natural-sorts candidates, streams hashes, filters non-video media, and transfers handles once', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-probe-'));
        temporaryDirectories.push(directory);
        const paths = new Map<string, string>();
        for (const [id, name] of [
            ['ten', 'Clip 10.mp4'],
            ['two', 'Clip 2.mp4'],
            ['one', 'Clip 1.mp4'],
            ['audio', 'Audio 1.wav'],
        ]) {
            const path = join(directory, name);
            await writeFile(path, new Uint8Array([id.length, 2, 3, 4]));
            paths.set(id, path);
        }
        const candidates: MediaCandidate[] = [
            { candidateId: 'ten', displayName: 'Clip 10.mp4', extension: '.mp4' },
            { candidateId: 'audio', displayName: 'Audio 1.wav', extension: '.wav' },
            { candidateId: 'two', displayName: 'Clip 2.mp4', extension: '.mp4' },
            { candidateId: 'one', displayName: 'Clip 1.mp4', extension: '.mp4' },
        ];
        const opened = new Map<string, FileHandle>();
        const access: VerifiedMediaAccessPort = {
            listCandidates: vi.fn(async () => candidates),
            openCandidate: vi.fn(async ({ grantId, candidateId }) => {
                const path = paths.get(candidateId);
                if (!path) throw new Error('unknown candidate');
                const handle = await open(path, 'r');
                opened.set(candidateId, handle);
                return capability({
                    candidateId,
                    grantId,
                    path,
                    displayName: candidates.find((item) => item.candidateId === candidateId)!.displayName,
                    handle,
                });
            }),
        };
        const probe: MediaProbePort = {
            probe: vi.fn(async (handle) => ({
                ...baseMetadata(),
                video: handle.candidateId === 'audio' ? null : baseMetadata().video,
                audio: handle.candidateId === 'audio' ? baseMetadata().audio : null,
            })),
        };
        const registry = new ImmutableSourceRegistry();
        const budget = new MediaBudgetManager('managed-probe', 8 * 1024 * 1024);
        const service = new MediaProbeImportService(
            access,
            probe,
            registry,
            budget,
            new BoundedConcurrency(2),
        );

        const imported = await service.import({
            grantId: 'read-root',
            maximumResults: 3,
        });
        expect(imported.map((item) => item.displayName)).toEqual([
            'Clip 1.mp4',
            'Clip 2.mp4',
            'Clip 10.mp4',
        ]);
        expect(imported.every((item) => !('canonicalPath' in item))).toBe(true);
        expect(access.openCandidate).toHaveBeenCalledTimes(4);
        expect(probe.probe).toHaveBeenCalledTimes(4);
        expect(budget.snapshot().peakBytes).toBe(8);
        expect(service.diagnostics()).toMatchObject({
            probed: 4,
            imported: 3,
            skippedUnsupported: 1,
            hashBytes: 16,
        });
        await registry.close();
        registry.assertDrained();
        service.assertDrained();
        budget.assertDrained();
        expect(opened.size).toBe(4);
    });

    it('invalidates active leases on same-id source replacement without reopening either path', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-replace-'));
        temporaryDirectories.push(directory);
        const oldPath = join(directory, 'old.mp4');
        const newPath = join(directory, 'new.mp4');
        await writeFile(oldPath, new Uint8Array([1, 2, 3]));
        await writeFile(newPath, new Uint8Array([4, 5, 6]));
        const budget = new MediaBudgetManager('replace-hash', 1024);
        const oldCapability = await openCapability(oldPath, 'stable-source', 'old');
        const newCapability = await openCapability(newPath, 'stable-source', 'new');
        const oldIdentity = await hashVerifiedHandle(oldCapability, budget);
        const newIdentity = await hashVerifiedHandle(newCapability, budget);
        const registry = new ImmutableSourceRegistry();
        await registry.register(oldCapability, oldIdentity, baseMetadata());
        const oldLease = await registry.acquire('stable-source');
        await registry.register(newCapability, newIdentity, baseMetadata());

        expect(oldLease.replacementSignal.aborted).toBe(true);
        await expect(oldLease.read({ start: 0, endExclusive: 1 }))
            .rejects.toMatchObject({ name: 'MediaByteSourceError' });
        await oldLease.close();
        const current = await registry.acquire('stable-source');
        expect(await current.read({ start: 0, endExclusive: 1 })).toEqual(new Uint8Array([4]));
        await current.close();
        expect(registry.diagnostics()).toMatchObject({
            replacements: 1,
            invalidations: 1,
            closes: 1,
            activeLeases: 0,
        });
        await registry.close();
        registry.assertDrained();
        budget.assertDrained();
    });

    it('retains ownership when a probe-only handle cleanup rejects', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-probe-cleanup-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'Audio.wav');
        await writeFile(path, new Uint8Array([1, 2, 3]));
        const access: VerifiedMediaAccessPort = {
            listCandidates: async () => [{
                candidateId: 'audio',
                displayName: 'Audio.wav',
                extension: '.wav',
            }],
            openCandidate: async ({ candidateId, grantId }) => {
                const capabilityValue = await openCapability(path, 'audio-source', candidateId);
                const transferred = { ...capabilityValue, grantId, displayName: 'Audio.wav' };
                const physicalClose = transferred.handle.close.bind(transferred.handle);
                vi.spyOn(transferred.handle, 'close').mockImplementationOnce(async () => {
                    await physicalClose();
                    throw new Error('simulated probe cleanup failure');
                });
                return transferred;
            },
        };
        const probe: MediaProbePort = {
            probe: async () => ({
                ...baseMetadata(),
                video: null,
                audio: baseMetadata().audio,
            }),
        };
        const registry = new ImmutableSourceRegistry();
        const budget = new MediaBudgetManager('probe-cleanup-failure', 1024);
        const service = new MediaProbeImportService(
            access,
            probe,
            registry,
            budget,
            new BoundedConcurrency(2),
        );

        await expect(service.probe({
            grantId: 'grant',
            maximumResults: 1,
        })).rejects.toThrow('simulated probe cleanup failure');
        expect(service.diagnostics()).toMatchObject({
            cleanupFailures: 1,
            failedOwnedHandles: 1,
        });
        await expect(service.close()).rejects.toThrow('retained handles');
        expect(() => service.assertDrained()).toThrow('leaked resources');
        await registry.close();
        registry.assertDrained();
        budget.assertDrained();
    });

    it('closes every transferred handle when registration reaches a closed registry', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-closed-registry-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'Clip 1.mp4');
        await writeFile(path, new Uint8Array([1, 2, 3]));
        const incoming = await openCapability(path, 'closed-source', 'closed');
        const budget = new MediaBudgetManager('closed-registry-hash', 1024);
        const identity = await hashVerifiedHandle(incoming, budget);
        const registry = new ImmutableSourceRegistry();
        await registry.close();

        await expect(registry.registerBatch([{
            handle: incoming,
            identity,
            metadata: baseMetadata(),
        }])).rejects.toThrow('registry is closed');
        await expect(incoming.handle.stat()).rejects.toThrow();
        registry.assertDrained();
        budget.assertDrained();
    });

    it('closes a duplicated transferred handle exactly once', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-duplicate-handle-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'Clip 1.mp4');
        await writeFile(path, new Uint8Array([1, 2, 3]));
        const incoming = await openCapability(path, 'duplicate-source', 'duplicate');
        const close = vi.spyOn(incoming.handle, 'close');
        const registry = new ImmutableSourceRegistry();
        const entry = {
            handle: incoming,
            identity: {
                fingerprint: `sha256:${'f'.repeat(64)}`,
                sizeBytes: incoming.sizeBytes,
            },
            metadata: baseMetadata(),
        };

        await expect(registry.registerBatch([entry, entry]))
            .rejects.toThrow('duplicate source IDs or handles');
        expect(close).toHaveBeenCalledTimes(1);
        await registry.close();
        registry.assertDrained();
    });

    it('keeps a published duplicate registration successful while accounting cleanup failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-cleanup-failure-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'Clip 1.mp4');
        await writeFile(path, new Uint8Array([1, 2, 3]));
        const budget = new MediaBudgetManager('cleanup-failure-hash', 1024);
        const original = await openCapability(path, 'stable-source', 'original');
        const duplicate = await openCapability(path, 'stable-source', 'duplicate');
        const identity = await hashVerifiedHandle(original, budget);
        const registry = new ImmutableSourceRegistry();
        const first = await registry.register(original, identity, baseMetadata());
        const physicalClose = duplicate.handle.close.bind(duplicate.handle);
        const close = vi.spyOn(duplicate.handle, 'close')
            .mockImplementationOnce(async () => {
                await physicalClose();
                throw new Error('simulated close failure');
            });

        await expect(registry.registerBatch([{
            handle: duplicate,
            identity,
            metadata: baseMetadata(),
        }])).resolves.toEqual([first]);
        expect(registry.diagnostics()).toMatchObject({
            cleanupFailures: 1,
            retiredSources: 1,
        });
        close.mockRestore();
        await expect(registry.close()).rejects.toThrow('retained resources');
        expect(() => registry.assertDrained()).toThrow('leaked resources');
        budget.assertDrained();
    });

    it('closes a transferred capability exactly once when verified-handle adoption fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-adoption-failure-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'Clip 1.mp4');
        await writeFile(path, new Uint8Array([1, 2, 3]));
        const incoming = await openCapability(path, 'bad-source', 'bad');
        const close = vi.spyOn(incoming.handle, 'close');
        const registry = new ImmutableSourceRegistry();

        await expect(registry.registerBatch([{
            handle: incoming,
            identity: {
                fingerprint: `sha256:${'f'.repeat(64)}`,
                sizeBytes: incoming.sizeBytes + 1,
            },
            metadata: baseMetadata(),
        }])).rejects.toThrow('does not match');
        expect(close).toHaveBeenCalledTimes(1);
        expect(registry.diagnostics()).toMatchObject({
            currentSources: 0,
            cleanupFailures: 0,
        });
        await registry.close();
        registry.assertDrained();
    });

    it('retains ownership and fails the leak gate when adoption cleanup rejects', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-adoption-cleanup-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'Clip 1.mp4');
        await writeFile(path, new Uint8Array([1, 2, 3]));
        const incoming = await openCapability(path, 'bad-cleanup-source', 'bad-cleanup');
        const physicalClose = incoming.handle.close.bind(incoming.handle);
        vi.spyOn(incoming.handle, 'close').mockImplementationOnce(async () => {
            await physicalClose();
            throw new Error('simulated adoption cleanup failure');
        });
        const registry = new ImmutableSourceRegistry();

        await expect(registry.registerBatch([{
            handle: incoming,
            identity: {
                fingerprint: `sha256:${'f'.repeat(64)}`,
                sizeBytes: incoming.sizeBytes + 1,
            },
            metadata: baseMetadata(),
        }])).rejects.toThrow('failed adoption and cleanup');
        expect(registry.diagnostics()).toMatchObject({
            currentSources: 0,
            cleanupFailures: 1,
            failedOwnedHandles: 1,
        });
        await expect(registry.close()).rejects.toThrow('retained resources');
        expect(() => registry.assertDrained()).toThrow('leaked resources');
    });

    it('keeps concurrent streamed hashes under one hard 8 MiB staging cap', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-large-hash-'));
        temporaryDirectories.push(directory);
        const bytes = new Uint8Array(8 * 1024 * 1024 + 1);
        bytes.fill(7);
        const firstPath = join(directory, 'first.mp4');
        const secondPath = join(directory, 'second.mp4');
        await Promise.all([writeFile(firstPath, bytes), writeFile(secondPath, bytes)]);
        const first = await openCapability(firstPath, 'first', 'first');
        const second = await openCapability(secondPath, 'second', 'second');
        const budget = new MediaBudgetManager('large-managed-hash', 8 * 1024 * 1024);
        const identities = await Promise.all([
            hashVerifiedHandle(first, budget),
            hashVerifiedHandle(second, budget),
        ]);
        expect(identities[0]).toEqual(identities[1]);
        expect(budget.snapshot().peakBytes).toBe(8 * 1024 * 1024);
        await Promise.all([first.handle.close(), second.handle.close()]);
        budget.assertDrained();
    });

    it('publishes no partial registry batch when one concurrent probe fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'waptions-managed-atomic-import-'));
        temporaryDirectories.push(directory);
        const firstPath = join(directory, 'Clip 1.mp4');
        const secondPath = join(directory, 'Clip 2.mp4');
        await writeFile(firstPath, new Uint8Array([1]));
        await writeFile(secondPath, new Uint8Array([2]));
        const handles: FileHandle[] = [];
        const access: VerifiedMediaAccessPort = {
            listCandidates: async () => [
                { candidateId: 'one', displayName: 'Clip 1.mp4', extension: '.mp4' },
                { candidateId: 'two', displayName: 'Clip 2.mp4', extension: '.mp4' },
            ],
            openCandidate: async ({ candidateId, grantId }) => {
                const path = candidateId === 'one' ? firstPath : secondPath;
                const handle = await open(path, 'r');
                handles.push(handle);
                return capability({
                    candidateId,
                    grantId,
                    path,
                    displayName: candidateId === 'one' ? 'Clip 1.mp4' : 'Clip 2.mp4',
                    handle,
                });
            },
        };
        const probe: MediaProbePort = {
            probe: vi.fn(async (handle) => {
                if (handle.candidateId === 'two') throw new Error('probe failed');
                return baseMetadata();
            }),
        };
        const registry = new ImmutableSourceRegistry();
        const budget = new MediaBudgetManager('atomic-import', 1024);
        const service = new MediaProbeImportService(
            access,
            probe,
            registry,
            budget,
            new BoundedConcurrency(2),
        );
        await expect(service.import({
            grantId: 'grant',
            maximumResults: 2,
        })).rejects.toThrow('probe failed');
        expect(registry.diagnostics().currentSources).toBe(0);
        for (const handle of handles) {
            await expect(handle.stat()).rejects.toThrow();
        }
        await registry.close();
        registry.assertDrained();
        service.assertDrained();
        budget.assertDrained();
    });
});

async function openCapability(
    path: string,
    sourceId: string,
    candidateId: string,
): Promise<VerifiedOpenMediaHandle> {
    const handle = await open(path, 'r');
    return capability({
        candidateId,
        grantId: 'grant',
        path,
        displayName: `${candidateId}.mp4`,
        handle,
        sourceId,
    });
}

async function capability(input: {
    candidateId: string;
    grantId: string;
    path: string;
    displayName: string;
    handle: FileHandle;
    sourceId?: string;
}): Promise<VerifiedOpenMediaHandle> {
    const value = await input.handle.stat({ bigint: true });
    return {
        candidateId: input.candidateId,
        sourceId: input.sourceId ?? `source-${input.candidateId}`,
        grantId: input.grantId,
        canonicalPath: input.path,
        displayName: input.displayName,
        handle: input.handle,
        statToken: statToken(value),
        sizeBytes: Number(value.size),
    };
}

function statToken(value: Awaited<ReturnType<FileHandle['stat']>>): FilesystemStatToken {
    const bigint = value as typeof value & {
        dev: bigint;
        ino: bigint;
        size: bigint;
        mtimeNs: bigint;
        ctimeNs: bigint;
    };
    return {
        dev: String(bigint.dev),
        ino: String(bigint.ino),
        size: String(bigint.size),
        mtimeNs: String(bigint.mtimeNs),
        ctimeNs: String(bigint.ctimeNs),
    };
}

function baseMetadata(): ProbedMediaMetadata {
    return {
        container: 'mov,mp4',
        durationSeconds: 10,
        bitrate: 1_000_000,
        video: {
            streamIndex: 0,
            codec: 'h264',
            width: 640,
            height: 360,
            frameRate: 30,
            durationSeconds: 10,
        },
        audio: {
            streamIndex: 1,
            codec: 'aac',
            sampleRate: 48_000,
            channelCount: 2,
            durationSeconds: 10,
        },
    };
}
