import { execFile } from 'node:child_process';
import {
    cp,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
    CoordinatorResult,
} from '../mcp/contracts';
import type {
    ManagedCoordinatorAdapter,
} from '../server/coordinator-adapter';
import { ManagedCoordinatorService } from '../transport/managed-coordinator-service';
import { createCoordinatorControlHandler } from '../integration/control-protocol';
import type { PersistentRuntimeProcessPort } from '../integration/mcp-coordinator-client';
import { loadVerifiedPackagedRuntime } from './packaged-runtime';

const execFileAsync = promisify(execFile);
const checkoutRoot = resolve(import.meta.dirname, '..', '..');
let fixtureRoot = '';

beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'waptions-package-fixture-'));
    await execFileAsync(process.execPath, ['scripts/build-agent-plugin.mjs'], {
        cwd: checkoutRoot,
        env: {
            ...process.env,
            WAPTIONS_AGENT_PLUGIN_OUTPUT_DIR: fixtureRoot,
            WAPTIONS_AGENT_SOURCE_COMMIT: 'a'.repeat(40),
            WAPTIONS_AGENT_SOURCE_TREE: 'b'.repeat(40),
            SOURCE_DATE_EPOCH: '1',
        },
        maxBuffer: 10 * 1024 * 1024,
    });
}, 30_000);

afterAll(async () => {
    if (fixtureRoot) {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

describe('packaged runtime verification', () => {
    it('verifies the manifest, every file, the content-addressed app, and exactly 29 tools', async () => {
        const verified = await loadVerifiedPackagedRuntime({
            pluginRoot: fixtureRoot,
            manifestPath: join(fixtureRoot, 'build-manifest.json'),
        });
        expect(verified.manifest.files.length).toBeGreaterThan(8);
        expect(verified.semanticSchemas.toolNames).toHaveLength(29);
        expect(verified.appResource.uri).toBe(
            verified.manifest.app.resourceUri,
        );
    });

    it('fails closed when packaged app bytes are modified', async () => {
        const copy = await packageCopy();
        try {
            const manifest = JSON.parse(
                await readFile(join(copy, 'build-manifest.json'), 'utf8'),
            ) as { app: { buildHash: string } };
            const appPath = join(
                copy,
                'mcp',
                'app',
                manifest.app.buildHash,
                'index.html',
            );
            await writeFile(appPath, '<!doctype html>tampered', 'utf8');
            await expect(loadVerifiedPackagedRuntime({
                pluginRoot: copy,
                manifestPath: join(copy, 'build-manifest.json'),
            })).rejects.toThrow(/identity|hash|bytes/u);
        } finally {
            await rm(copy, { recursive: true, force: true });
        }
    });

    it('fails closed when the packaged manifest identity is modified', async () => {
        const copy = await packageCopy();
        try {
            const manifestPath = join(copy, 'build-manifest.json');
            const manifest = JSON.parse(
                await readFile(manifestPath, 'utf8'),
            ) as { app: { resourceUri: string } };
            manifest.app.resourceUri =
                'ui://waptions/editor/v1/'
                + `${'0'.repeat(64)}/index.html`;
            await writeFile(
                manifestPath,
                `${JSON.stringify(manifest, null, 2)}\n`,
                'utf8',
            );
            await expect(loadVerifiedPackagedRuntime({
                pluginRoot: copy,
                manifestPath,
            })).rejects.toThrow(/manifest contract|resource|identity/u);
        } finally {
            await rm(copy, { recursive: true, force: true });
        }
    });

    it('fails closed when the packaged server bundle is modified', async () => {
        const copy = await packageCopy();
        try {
            await writeFile(
                join(copy, 'mcp', 'server.mjs'),
                'tampered server\n',
                'utf8',
            );
            await expect(loadVerifiedPackagedRuntime({
                pluginRoot: copy,
                manifestPath: join(copy, 'build-manifest.json'),
            })).rejects.toThrow(/identity|hash/u);
        } finally {
            await rm(copy, { recursive: true, force: true });
        }
    });
});

describe('static packaged plugin server', () => {
    it('serves the verified 29-tool inventory and exact app through a fake injected runtime endpoint', async () => {
        const dataRoot = await mkdtemp(join(tmpdir(), 'waptions-package-data-'));
        const coordinatorRoot = join(dataRoot, 'coordinator');
        await mkdir(coordinatorRoot, { recursive: true, mode: 0o700 });
        const adapter = new NoopCoordinatorAdapter();
        let service: ManagedCoordinatorService | undefined;
        const runtimeProcess: PersistentRuntimeProcessPort = {
            ensureRunning: vi.fn(async () => {
                if (service) return;
                service = await ManagedCoordinatorService.start(
                    dataRoot,
                    {
                        epoch: 'packaged-test-epoch',
                        canGracefullyShutdown: () => false,
                        close: async () => undefined,
                    },
                    createCoordinatorControlHandler(adapter),
                );
            }),
        };
        const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
        const packagedModule = await import(
            `${pathToFileURL(join(fixtureRoot, 'mcp', 'server.mjs')).href}`
            + `?smoke=${Date.now()}`
        ) as typeof import('./plugin-server');
        const running = await packagedModule.startPackagedPluginServer({
            pluginRoot: fixtureRoot,
            manifestPath: join(fixtureRoot, 'build-manifest.json'),
            dataRoot,
            runtimeProcess,
            transport: serverTransport,
            installSignalHandlers: false,
        });
        const client = new Client(
            { name: 'packaged-runtime-test', version: '1.0.0' },
            {
                capabilities: {
                    extensions: {
                        'io.modelcontextprotocol/ui': {
                            mimeTypes: ['text/html;profile=mcp-app'],
                        },
                    },
                },
            },
        );
        try {
            await client.connect(clientTransport);
            const tools = await client.listTools();
            expect(tools.tools).toHaveLength(29);
            expect(tools.tools.map((tool) => tool.name)).toEqual(
                running.verifiedRuntime.semanticSchemas.toolNames,
            );
            expect(
                tools.tools.filter((tool) => tool._meta?.ui),
            ).toHaveLength(1);
            const resources = await client.listResources();
            expect(resources.resources).toEqual([
                expect.objectContaining({
                    uri: running.verifiedRuntime.manifest.app.resourceUri,
                    mimeType: 'text/html;profile=mcp-app',
                }),
            ]);
            const app = await client.readResource({
                uri: running.verifiedRuntime.manifest.app.resourceUri,
            });
            expect(app.contents[0]).toMatchObject({
                text: running.verifiedRuntime.appResource.html,
            });
            expect(runtimeProcess.ensureRunning).toHaveBeenCalledOnce();
        } finally {
            await client.close();
            await running.close();
            await service?.close();
            await rm(dataRoot, { recursive: true, force: true });
        }
    });
});

class NoopCoordinatorAdapter implements ManagedCoordinatorAdapter {
    async executeRead(): Promise<CoordinatorResult> {
        return {
            ok: false,
            error: {
                code: 'NOT_FOUND',
                message: 'Not used by the packaged inventory smoke.',
                retryable: false,
            },
        };
    }

    async resolveReceiptScope() {
        return {
            ok: false as const,
            error: {
                code: 'NOT_FOUND' as const,
                message: 'Not used by the packaged inventory smoke.',
                retryable: false,
            },
        };
    }

    async executeMutation(): Promise<CoordinatorResult> {
        return this.executeRead();
    }

    async executeSessionOpen(): Promise<CoordinatorResult> {
        return this.executeRead();
    }
}

async function packageCopy(): Promise<string> {
    const destination = await mkdtemp(
        join(tmpdir(), 'waptions-package-copy-'),
    );
    await cp(fixtureRoot, destination, { recursive: true, force: false });
    return destination;
}
