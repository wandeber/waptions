import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    COORDINATOR_CONTROL_PROTOCOL_VERSION,
} from '../integration/control-protocol';
import {
    PACKAGED_AUTHORITY_ARGUMENT,
    createPackagedRuntimeProcess,
    isDirectPluginServerExecution,
    runPackagedPluginServerCli,
    type DetachedProcessSpawner,
} from './plugin-server';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('packaged runtime process launcher', () => {
    it('detaches the same static bundle with an explicit authority mode', async () => {
        const unref = vi.fn();
        const spawn = vi.fn(() => ({ unref }));
        const paths = fixturePaths();
        const processPort = createPackagedRuntimeProcess({
            ...paths,
            spawner: { spawn } as DetachedProcessSpawner,
        });

        await processPort.ensureRunning({
            dataRoot: resolve('/tmp/waptions-agent-data'),
            protocolVersion: COORDINATOR_CONTROL_PROTOCOL_VERSION,
        });

        expect(spawn).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledWith(
            process.execPath,
            [paths.executablePath, PACKAGED_AUTHORITY_ARGUMENT],
            expect.objectContaining({
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                cwd: paths.pluginRoot,
                env: expect.objectContaining({
                    WAPTIONS_AGENT_DATA_DIR: resolve('/tmp/waptions-agent-data'),
                    WAPTIONS_PLUGIN_ROOT: paths.pluginRoot,
                    WAPTIONS_RUNTIME_MANIFEST: paths.manifestPath,
                }),
            }),
        );
        expect(unref).toHaveBeenCalledOnce();
    });

    it('passes only the explicit non-secret environment to the authority', async () => {
        vi.stubEnv('PATH', '/tmp/malicious-prefix:/trusted/bin');
        vi.stubEnv('HOME', '/home/runtime');
        vi.stubEnv('LANG', 'en_US.UTF-8');
        vi.stubEnv(
            'NODE_OPTIONS',
            '--import=/tmp/preload.mjs --experimental-loader=/tmp/loader.mjs',
        );
        vi.stubEnv('NODE_PATH', '/tmp/injected-modules');
        vi.stubEnv('DYLD_INSERT_LIBRARIES', '/tmp/injected.dylib');
        vi.stubEnv('LD_PRELOAD', '/tmp/injected.so');
        vi.stubEnv('HTTPS_PROXY', 'http://proxy.invalid');
        vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-cloud-value');
        vi.stubEnv('OPENAI_API_KEY', 'secret-api-value');
        vi.stubEnv('WAPTIONS_TRANSCRIPTION_API_KEY', 'secret-runtime-value');
        vi.stubEnv(
            'OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS',
            'untrusted.example',
        );
        let launchedEnvironment: NodeJS.ProcessEnv | undefined;
        const spawn: DetachedProcessSpawner['spawn'] = (
            _executablePath,
            _args,
            options,
        ) => {
            launchedEnvironment = options.env;
            return { unref: vi.fn() };
        };
        const processPort = createPackagedRuntimeProcess({
            ...fixturePaths(),
            spawner: { spawn },
        });

        await processPort.ensureRunning({
            dataRoot: resolve('/tmp/waptions-agent-data'),
            protocolVersion: COORDINATOR_CONTROL_PROTOCOL_VERSION,
        });

        const environment = launchedEnvironment;
        expect(environment).toMatchObject({
            HOME: '/home/runtime',
            LANG: 'en_US.UTF-8',
            WAPTIONS_AGENT_DATA_DIR: resolve('/tmp/waptions-agent-data'),
        });
        expect(environment?.PATH).not.toContain('/tmp/malicious-prefix');
        if (process.platform === 'darwin') {
            expect(environment?.PATH?.split(':')).toContain(
                '/opt/homebrew/bin',
            );
        }
        expect(environment).not.toHaveProperty('NODE_OPTIONS');
        expect(environment).not.toHaveProperty('NODE_PATH');
        expect(environment).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
        expect(environment).not.toHaveProperty('LD_PRELOAD');
        expect(environment).not.toHaveProperty('HTTPS_PROXY');
        expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
        expect(environment).not.toHaveProperty('OPENAI_API_KEY');
        expect(environment).not.toHaveProperty(
            'WAPTIONS_TRANSCRIPTION_API_KEY',
        );
        expect(environment).not.toHaveProperty(
            'OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS',
        );
    });

    it('fails before spawning for an incompatible protocol or relative data root', async () => {
        const spawn = vi.fn(() => ({ unref: vi.fn() }));
        const processPort = createPackagedRuntimeProcess({
            ...fixturePaths(),
            spawner: { spawn } as DetachedProcessSpawner,
        });

        await expect(processPort.ensureRunning({
            dataRoot: resolve('/tmp/waptions-agent-data'),
            protocolVersion: (
                COORDINATOR_CONTROL_PROTOCOL_VERSION + 1
            ) as typeof COORDINATOR_CONTROL_PROTOCOL_VERSION,
        })).rejects.toThrow(/protocol/u);
        await expect(processPort.ensureRunning({
            dataRoot: 'relative-data-root',
            protocolVersion: COORDINATOR_CONTROL_PROTOCOL_VERSION,
        })).rejects.toThrow(/absolute path/u);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('refuses to launch an executable outside the verified plugin layout', () => {
        expect(() => createPackagedRuntimeProcess({
            ...fixturePaths(),
            executablePath: resolve('/tmp/other-server.mjs'),
            spawner: {
                spawn: vi.fn(() => ({ unref: vi.fn() })),
            },
        })).toThrow(/this packaged runtime bundle/u);
    });

    it('does not treat an imported module or unknown CLI argument as a server', async () => {
        expect(isDirectPluginServerExecution(
            import.meta.url,
            resolve('/tmp/not-this-module.mjs'),
        )).toBe(false);
        await expect(runPackagedPluginServerCli({
            argv: ['--unknown'],
            moduleUrl: import.meta.url,
        })).rejects.toThrow(/Unknown Waptions packaged runtime argument/u);
    });
});

function fixturePaths() {
    const pluginRoot = resolve('/tmp/waptions-packaged-plugin');
    return {
        executablePath: resolve(pluginRoot, 'mcp/server.mjs'),
        pluginRoot,
        manifestPath: resolve(pluginRoot, 'build-manifest.json'),
    };
}
