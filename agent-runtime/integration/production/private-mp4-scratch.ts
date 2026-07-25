import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
    lstat,
    mkdir,
    open,
    readdir,
    rm,
    type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedRenderPlanV1 } from '../../../src/lib/render-plan';
import type {
    AcquiredNodeStagedOutputHandle,
    NodeStagedOutputHandleAccess,
    NodeStagedOutputHandleResolverPort,
} from '../../export/node-staged-output-handle';
import type {
    HeadlessRenderBackendPort,
    HeadlessStagedOutputCapability,
} from '../../render/contracts';
import {
    DEFAULT_HEADLESS_RENDER_LIMITS,
    HeadlessRenderError,
} from '../../render/contracts';
import type {
    Mp4ScratchRenderPort,
    RenderedMp4ScratchLease,
} from '../export/node-webm-renderer';

interface ScratchRecord {
    readonly capability: HeadlessStagedOutputCapability;
    readonly root: string;
    readonly path: string;
    readonly device: bigint;
    readonly inode: bigint;
    settled: boolean;
}

/**
 * Private, descriptor-only MP4 scratch authority used by WebM export. Paths
 * never leave this adapter and every terminal path removes the 0700 root.
 */
export class PrivateMp4ScratchAuthority
implements NodeStagedOutputHandleResolverPort, Mp4ScratchRenderPort {
    private readonly records = new Map<string, ScratchRecord>();
    private readonly ready: Promise<void>;

    constructor(
        private readonly root: string,
        private readonly renderer: () => HeadlessRenderBackendPort,
    ) {
        this.ready = this.sweepOrphans();
    }

    async initialize(): Promise<void> {
        await this.ready;
    }

    async close(): Promise<void> {
        await this.ready.catch(() => undefined);
        await Promise.allSettled(
            [...this.records.values()].map((record) => this.remove(record)),
        );
        await rm(this.root, { recursive: true, force: true });
    }

    async render(input: {
        readonly jobId: string;
        readonly plan: ResolvedRenderPlanV1;
        readonly signal?: AbortSignal;
    }): Promise<RenderedMp4ScratchLease> {
        await this.ready;
        const record = await this.create(input.jobId, input.signal);
        try {
            const result = await this.renderer().render({
                jobId: `${input.jobId}:mp4-scratch`,
                plan: input.plan,
                outputCapability: record.capability,
                limits: DEFAULT_HEADLESS_RENDER_LIMITS,
                signal: input.signal,
            });
            const retained = await this.acquire(
                record.capability,
                'read-only',
                input.signal,
            );
            return {
                fileDescriptor: retained.fileDescriptor,
                planId: input.plan.planId,
                backend: result.backend,
                warnings: [...result.warnings],
                sourceRangesRead: [...result.sourceRangesRead],
                diagnostics: result.diagnostics,
                assertCurrent: (signal) => retained.assertCurrent(signal),
                close: async () => {
                    await retained.close();
                    await this.remove(record);
                },
            };
        } catch (error) {
            await this.remove(record);
            throw error;
        }
    }

    async acquire(
        capability: HeadlessStagedOutputCapability,
        access: NodeStagedOutputHandleAccess,
        signal?: AbortSignal,
    ): Promise<AcquiredNodeStagedOutputHandle> {
        signal?.throwIfAborted();
        const record = this.records.get(capability.stagingId);
        if (
            !record
            || record.settled
            || JSON.stringify(record.capability) !== JSON.stringify(capability)
        ) {
            throw new HeadlessRenderError(
                'INVALID_OUTPUT',
                'The private scratch output capability is unavailable.',
            );
        }
        const file = await open(
            record.path,
            (access === 'read-only' ? constants.O_RDONLY : constants.O_RDWR)
                | constants.O_NONBLOCK
                | noFollowFlag(),
        );
        await assertIdentity(file, record);
        let closed = false;
        return {
            outputCapability: record.capability,
            fileDescriptor: file.fd,
            access,
            size: async (sizeSignal) => {
                sizeSignal?.throwIfAborted();
                assertOpen(closed);
                await assertIdentity(file, record);
                return Number((await file.stat({ bigint: true })).size);
            },
            assertCurrent: async (assertSignal) => {
                assertSignal?.throwIfAborted();
                assertOpen(closed);
                if (record.settled) {
                    throw new HeadlessRenderError(
                        'INVALID_OUTPUT',
                        'The private scratch output is already settled.',
                    );
                }
                await assertIdentity(file, record);
            },
            sync: async (syncSignal) => {
                syncSignal?.throwIfAborted();
                assertOpen(closed);
                await file.sync();
            },
            close: async () => {
                if (closed) return;
                closed = true;
                await file.close();
            },
        };
    }

    private async create(
        jobId: string,
        signal?: AbortSignal,
    ): Promise<ScratchRecord> {
        signal?.throwIfAborted();
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const id = randomUUID();
        const operationRoot = join(this.root, id);
        await mkdir(operationRoot, { mode: 0o700 });
        const path = join(operationRoot, 'render.mp4');
        const handle = await open(path, 'wx+', 0o600);
        const stat = await handle.stat({ bigint: true });
        await handle.close();
        const capability = Object.freeze({
            version: 1 as const,
            kind: 'create-only-staged-output' as const,
            capabilityId: `private-scratch:${id}`,
            grantId: 'private-runtime-scratch',
            stagingId: `private-scratch-stage:${id}`,
        });
        const record: ScratchRecord = {
            capability,
            root: operationRoot,
            path,
            device: stat.dev,
            inode: stat.ino,
            settled: false,
        };
        this.records.set(capability.stagingId, record);
        void jobId;
        return record;
    }

    private async remove(record: ScratchRecord): Promise<void> {
        if (record.settled) return;
        record.settled = true;
        this.records.delete(record.capability.stagingId);
        await rm(record.root, { recursive: true, force: true });
    }

    private async sweepOrphans(): Promise<void> {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const entries = await readdir(this.root, { withFileTypes: true });
        await Promise.all(entries.map(async (entry) => {
            // This authority never persists a live scratch lease. Anything present at startup is
            // an interrupted render and can be removed without touching a user destination.
            if (entry.isDirectory() && /^[a-f0-9-]{36}$/u.test(entry.name)) {
                await rm(join(this.root, entry.name), { recursive: true, force: true });
            }
        }));
    }
}

async function assertIdentity(
    file: FileHandle,
    expected: ScratchRecord,
): Promise<void> {
    const [descriptor, current] = await Promise.all([
        file.stat({ bigint: true }),
        lstat(expected.path, { bigint: true }),
    ]);
    if (
        !descriptor.isFile()
        || !current.isFile()
        || descriptor.dev !== expected.device
        || descriptor.ino !== expected.inode
        || current.dev !== expected.device
        || current.ino !== expected.inode
    ) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'The private scratch output identity changed.',
        );
    }
}

function assertOpen(closed: boolean): void {
    if (closed) {
        throw new HeadlessRenderError(
            'INVALID_OUTPUT',
            'The private scratch descriptor is closed.',
        );
    }
}

function noFollowFlag(): number {
    return typeof constants.O_NOFOLLOW === 'number'
        ? constants.O_NOFOLLOW
        : 0;
}
