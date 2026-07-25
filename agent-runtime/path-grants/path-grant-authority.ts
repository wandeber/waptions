import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
    link,
    lstat,
    open,
    realpath,
    rename,
    rm,
    stat,
    type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { managedError } from '../coordinator/errors';

export type PathGrantKind = 'read-root' | 'create-only-destination' | 'exact-overwrite';

export interface FileIdentity {
    device: string;
    inode: string;
    size: number;
    modifiedMilliseconds: number;
}

export interface SessionPathGrantRecord {
    schemaVersion: 1;
    grantId: string;
    sessionId: string;
    kind: PathGrantKind;
    canonicalPath: string;
    createdAt: string;
    revokedAt?: string;
    overwriteConfirmedAt?: string;
    identity?: FileIdentity;
    rootIdentity?: Pick<FileIdentity, 'device' | 'inode'>;
    parentIdentity?: Pick<FileIdentity, 'device' | 'inode'>;
}

export interface VerifiedReadHandle {
    capabilityType: 'verified-read-handle';
    grantId: string;
    handle: FileHandle;
    identity: FileIdentity;
    verifyUnchanged(): Promise<void>;
    close(): Promise<void>;
}

export interface StagedDestination {
    capabilityType: 'validated-staged-destination';
    grantId: string;
    handle: FileHandle;
    commit(): Promise<void>;
    abort(): Promise<void>;
}

export class PathGrantAuthority {
    private readonly revokedGrantIds = new Set<string>();

    async create(
        sessionId: string,
        kind: PathGrantKind,
        requestedPath: string,
        overwriteConfirmed = false,
    ): Promise<SessionPathGrantRecord> {
        validateAbsolutePath(requestedPath);
        const requestedMetadata = await lstatOrNull(requestedPath);
        if (requestedMetadata?.isSymbolicLink()) {
            throw managedError('PATH_NOT_GRANTED', 'A symbolic link cannot be the granted path.');
        }
        let canonicalPath: string;
        let identity: FileIdentity | undefined;
        let rootIdentity: Pick<FileIdentity, 'device' | 'inode'> | undefined;
        let parentIdentity: Pick<FileIdentity, 'device' | 'inode'> | undefined;
        if (kind === 'create-only-destination') {
            const destination = await canonicalizeFutureDestination(requestedPath);
            canonicalPath = destination.canonicalPath;
            parentIdentity = destination.parentIdentity;
        } else {
            canonicalPath = await realpath(requestedPath);
        }
        if (kind === 'read-root') {
            const metadata = await lstat(canonicalPath, { bigint: true });
            if (!metadata.isDirectory() && !metadata.isFile()) {
                throw managedError('PATH_NOT_GRANTED', 'Read grants require a regular file or directory.');
            }
            if (metadata.isSymbolicLink()) {
                throw managedError('PATH_NOT_GRANTED', 'Symbolic links cannot be grant roots.');
            }
            rootIdentity = {
                device: metadata.dev.toString(),
                inode: metadata.ino.toString(),
            };
            if (metadata.isFile()) identity = fileIdentity(metadata);
        } else if (kind === 'exact-overwrite') {
            if (!overwriteConfirmed) {
                throw managedError(
                    'OVERWRITE_NOT_AUTHORIZED',
                    'Exact overwrite requires an explicit user confirmation.',
                );
            }
            identity = await identityForRegularPath(canonicalPath);
            parentIdentity = await directoryIdentity(dirname(canonicalPath));
        } else {
            const targetMetadata = await lstatOrNull(canonicalPath);
            if (targetMetadata) {
                throw managedError(
                    'WRITE_DESTINATION_NOT_GRANTED',
                    'Create-only destinations must not already exist.',
                );
            }
        }
        return {
            schemaVersion: 1,
            grantId: randomUUID(),
            sessionId,
            kind,
            canonicalPath,
            createdAt: new Date().toISOString(),
            ...(overwriteConfirmed ? { overwriteConfirmedAt: new Date().toISOString() } : {}),
            ...(identity ? { identity } : {}),
            ...(rootIdentity ? { rootIdentity } : {}),
            ...(parentIdentity ? { parentIdentity } : {}),
        };
    }

    revoke(grant: SessionPathGrantRecord): SessionPathGrantRecord {
        this.revokedGrantIds.add(grant.grantId);
        return grant.revokedAt ? grant : { ...grant, revokedAt: new Date().toISOString() };
    }

    async openRead(grant: SessionPathGrantRecord, requestedPath: string): Promise<VerifiedReadHandle> {
        this.assertActive(grant, 'read-root');
        validateAbsolutePath(requestedPath);
        await validateReadRootIdentity(grant);
        const canonicalPath = await realpath(requestedPath);
        assertContained(grant.canonicalPath, canonicalPath);
        const handle = await openNoFollow(canonicalPath, constants.O_RDONLY);
        try {
            const opened = await handle.stat({ bigint: true });
            validateRegularFile(opened);
            const pathMetadata = await lstat(canonicalPath, { bigint: true });
            validateSameIdentity(opened, pathMetadata);
            const identity = fileIdentity(opened);
            if (grant.identity && canonicalPath === grant.canonicalPath) {
                validateStoredIdentity(grant.identity, identity);
            }
            return {
                capabilityType: 'verified-read-handle',
                grantId: grant.grantId,
                handle,
                identity,
                verifyUnchanged: async () => {
                    this.assertActive(grant, 'read-root');
                    await validateReadRootIdentity(grant);
                    const [descriptor, pathState] = await Promise.all([
                        handle.stat({ bigint: true }),
                        lstat(canonicalPath, { bigint: true }),
                    ]);
                    validateSameIdentity(descriptor, pathState);
                    validateStoredIdentity(identity, fileIdentity(descriptor));
                },
                close: () => handle.close(),
            };
        } catch (error) {
            await handle.close().catch(() => undefined);
            throw error;
        }
    }

    async stageCreate(grant: SessionPathGrantRecord): Promise<StagedDestination> {
        this.assertActive(grant, 'create-only-destination');
        return stageDestination(
            grant,
            false,
            () => this.assertActive(grant, 'create-only-destination'),
        );
    }

    async stageOverwrite(grant: SessionPathGrantRecord): Promise<StagedDestination> {
        this.assertActive(grant, 'exact-overwrite');
        if (!grant.identity || !grant.overwriteConfirmedAt) {
            throw managedError('OVERWRITE_NOT_AUTHORIZED', 'The overwrite grant is incomplete.');
        }
        return stageDestination(
            grant,
            true,
            () => this.assertActive(grant, 'exact-overwrite'),
        );
    }

    private assertActive(grant: SessionPathGrantRecord, expected: PathGrantKind): void {
        if (
            grant.kind !== expected
            || grant.revokedAt
            || this.revokedGrantIds.has(grant.grantId)
        ) {
            throw managedError('PATH_NOT_GRANTED', 'The requested path capability is not active.');
        }
    }
}

export async function hashVerifiedRead(
    verified: VerifiedReadHandle,
    maxBufferBytes = 8 * 1024 * 1024,
): Promise<{ digest: string; bytes: number }> {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(maxBufferBytes, 8 * 1024 * 1024)));
    let position = 0;
    while (true) {
        const { bytesRead } = await verified.handle.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
    }
    await verified.verifyUnchanged();
    return { digest: `sha256:${hash.digest('hex')}`, bytes: position };
}

async function stageDestination(
    grant: SessionPathGrantRecord,
    overwrite: boolean,
    ensureActive: () => void,
): Promise<StagedDestination> {
    ensureActive();
    const targetPath = grant.canonicalPath;
    const parent = await realpath(dirname(targetPath));
    if (join(parent, basename(targetPath)) !== targetPath) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The destination parent changed after granting.');
    }
    if (!grant.parentIdentity) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The destination grant has no parent identity.');
    }
    const parentHandle = await openNoFollow(parent, constants.O_RDONLY);
    let targetHandle: FileHandle | null = null;
    try {
        await validateOpenedParent(parent, parentHandle, grant.parentIdentity);
        if (overwrite) {
            targetHandle = await openNoFollow(targetPath, constants.O_RDONLY);
            const targetMetadata = await targetHandle.stat({ bigint: true });
            validateRegularFile(targetMetadata);
            validateStoredIdentity(grant.identity!, fileIdentity(targetMetadata));
            const targetPathMetadata = await lstat(targetPath, { bigint: true });
            validateSameIdentity(targetMetadata, targetPathMetadata);
        }
    } catch (error) {
        await Promise.all([
            parentHandle.close().catch(() => undefined),
            targetHandle?.close().catch(() => undefined),
        ]);
        throw error;
    }
    const temporary = join(parent, `.${basename(targetPath)}.${randomUUID()}.partial`);
    let handle: FileHandle;
    try {
        handle = await open(
            temporary,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
        );
        await validateOpenedParent(parent, parentHandle, grant.parentIdentity);
    } catch (error) {
        await Promise.all([
            parentHandle.close().catch(() => undefined),
            targetHandle?.close().catch(() => undefined),
        ]);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
    let settled = false;
    const abort = async () => {
        if (settled) return;
        settled = true;
        await Promise.all([
            handle.close().catch(() => undefined),
            parentHandle.close().catch(() => undefined),
            targetHandle?.close().catch(() => undefined),
        ]);
        await rm(temporary, { force: true });
    };
    const commit = async () => {
        if (settled) return;
        ensureActive();
        await handle.sync();
        await handle.close();
        await validateOpenedParent(parent, parentHandle, grant.parentIdentity!);
        ensureActive();
        if (overwrite) {
            const current = await identityForRegularPath(targetPath);
            validateStoredIdentity(grant.identity!, current);
            const descriptor = await targetHandle!.stat({ bigint: true });
            validateStoredIdentity(grant.identity!, fileIdentity(descriptor));
            validateSameIdentity(descriptor, await lstat(targetPath, { bigint: true }));
            // The target descriptor identity is checked immediately before atomic rename. Node
            // does not expose renameat2 on macOS, so grants are exact-file capabilities and any
            // subsequent identity change is rejected at the next checked boundary.
            await rename(temporary, targetPath);
        } else {
            try {
                // link(2) is the portable no-replace publication primitive on Node POSIX hosts.
                await link(temporary, targetPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                    throw managedError(
                        'WRITE_DESTINATION_NOT_GRANTED',
                        'The create-only destination now exists.',
                    );
                }
                throw error;
            }
            await rm(temporary);
        }
        await validateOpenedParent(parent, parentHandle, grant.parentIdentity!);
        await syncDirectoryHandle(parentHandle);
        await validateOpenedParent(parent, parentHandle, grant.parentIdentity!);
        await Promise.all([
            parentHandle.close(),
            targetHandle?.close(),
        ]);
        settled = true;
    };
    return {
        capabilityType: 'validated-staged-destination',
        grantId: grant.grantId,
        handle,
        commit,
        abort,
    };
}

async function canonicalizeFutureDestination(requestedPath: string): Promise<{
    canonicalPath: string;
    parentIdentity: Pick<FileIdentity, 'device' | 'inode'>;
}> {
    const requestedParent = dirname(requestedPath);
    const requestedParentMetadata = await lstat(requestedParent, { bigint: true });
    if (requestedParentMetadata.isSymbolicLink()) {
        throw managedError('PATH_NOT_GRANTED', 'A symbolic link cannot be the granted destination parent.');
    }
    const parent = await realpath(requestedParent);
    return {
        canonicalPath: join(parent, basename(requestedPath)),
        parentIdentity: await directoryIdentity(parent),
    };
}

function validateAbsolutePath(path: string): void {
    if (!path || path.includes('\0') || resolve(path) !== path) {
        throw managedError('PATH_NOT_GRANTED', 'Path grants require an absolute local path.');
    }
}

function assertContained(root: string, candidate: string): void {
    const nested = relative(root, candidate);
    if (nested === '..' || nested.startsWith(`..${sep}`) || resolve(nested) === nested) {
        throw managedError('PATH_NOT_GRANTED', 'The path is outside the granted read root.');
    }
}

async function openNoFollow(path: string, flags: number): Promise<FileHandle> {
    try {
        return await open(path, flags | constants.O_NOFOLLOW);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (['ELOOP', 'EMLINK'].includes(code ?? '')) {
            throw managedError('PATH_IDENTITY_CHANGED', 'A symbolic link replaced the granted source.');
        }
        throw error;
    }
}

async function identityForRegularPath(path: string): Promise<FileIdentity> {
    const metadata = await lstat(path, { bigint: true });
    validateRegularFile(metadata);
    return fileIdentity(metadata);
}

async function validateReadRootIdentity(grant: SessionPathGrantRecord): Promise<void> {
    if (!grant.rootIdentity) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The read grant has no captured root identity.');
    }
    const metadata = await lstat(grant.canonicalPath, { bigint: true });
    if (
        metadata.isSymbolicLink()
        || metadata.dev.toString() !== grant.rootIdentity.device
        || metadata.ino.toString() !== grant.rootIdentity.inode
    ) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The granted read root was replaced.');
    }
}

function validateRegularFile(metadata: Awaited<ReturnType<typeof stat>>): void {
    if (!metadata.isFile() || metadata.isSymbolicLink() || Number(metadata.nlink) !== 1) {
        throw managedError(
            'SOURCE_UNREADABLE',
            'Managed sources and destinations must be unlinked regular files.',
        );
    }
    toSafeNumber(metadata.size, 'file size');
}

function validateSameIdentity(
    left: Awaited<ReturnType<typeof stat>>,
    right: Awaited<ReturnType<typeof stat>>,
): void {
    if (left.dev !== right.dev || left.ino !== right.ino || !right.isFile() || right.isSymbolicLink()) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The filesystem object changed during access.');
    }
}

function validateStoredIdentity(expected: FileIdentity, actual: FileIdentity): void {
    if (
        expected.device !== actual.device
        || expected.inode !== actual.inode
        || expected.size !== actual.size
        || expected.modifiedMilliseconds !== actual.modifiedMilliseconds
    ) {
        throw managedError('SOURCE_CHANGED', 'The granted filesystem object no longer matches.');
    }
}

function fileIdentity(
    metadata: Awaited<ReturnType<typeof stat>> | Awaited<ReturnType<typeof lstat>>,
): FileIdentity {
    return {
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
        size: toSafeNumber(metadata.size, 'file size'),
        modifiedMilliseconds: finiteNumber(metadata.mtimeMs, 'file modification time'),
    };
}

async function directoryIdentity(
    path: string,
): Promise<Pick<FileIdentity, 'device' | 'inode'>> {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The destination parent is not a directory.');
    }
    return { device: metadata.dev.toString(), inode: metadata.ino.toString() };
}

async function validateOpenedParent(
    path: string,
    handle: FileHandle,
    expected: Pick<FileIdentity, 'device' | 'inode'>,
): Promise<void> {
    const [descriptor, pathMetadata] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
    ]);
    if (
        !descriptor.isDirectory()
        || !pathMetadata.isDirectory()
        || pathMetadata.isSymbolicLink()
        || descriptor.dev.toString() !== expected.device
        || descriptor.ino.toString() !== expected.inode
        || pathMetadata.dev.toString() !== expected.device
        || pathMetadata.ino.toString() !== expected.inode
    ) {
        throw managedError('PATH_IDENTITY_CHANGED', 'The granted destination parent was replaced.');
    }
}

function toSafeNumber(value: number | bigint, field: string): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw managedError('SOURCE_UNREADABLE', `The ${field} is outside the supported range.`);
    }
    return number;
}

function finiteNumber(value: number | bigint, field: string): number {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw managedError('SOURCE_UNREADABLE', `The ${field} is outside the supported range.`);
    }
    return number;
}

async function syncDirectoryHandle(handle: FileHandle): Promise<void> {
    try {
        await handle.sync();
    } catch (error) {
        if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EACCES'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
        )) {
            throw error;
        }
    }
}

async function lstatOrNull(path: string) {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
