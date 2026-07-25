import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
    attachOrStartMcpCoordinator,
    resolveWaptionsAgentDataRoot,
    type PersistentRuntimeProcessPort,
} from '../integration/mcp-coordinator-client';
import { createProductionManagedRuntime } from '../integration/production-runtime';
import {
    COORDINATOR_CONTROL_PROTOCOL_VERSION,
    createCoordinatorControlHandler,
} from '../integration/control-protocol';
import { BoundedStdioServerTransport } from '../server/bounded-stdio-transport';
import type { WindowsNamedPipeSecurityPort } from '../server/control-endpoint';
import { WaptionsMcpServer } from '../server/mcp-server';
import {
    runManagedCoordinatorService,
} from '../transport/managed-coordinator-service';
import {
    loadVerifiedPackagedRuntime,
    type LoadPackagedRuntimeOptions,
    type VerifiedPackagedRuntime,
} from './packaged-runtime';

export const PACKAGED_RUNTIME_HOST_SEAM_VERSION = 1 as const;
export const PACKAGED_AUTHORITY_ARGUMENT = '--waptions-authority' as const;
const AUTHORITY_ENVIRONMENT_ALLOWLIST = [
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
] as const;
const POSIX_AUTHORITY_EXECUTABLE_PATH = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
].join(':');

interface SpawnedDetachedProcess {
    unref(): void;
}

export interface DetachedProcessSpawner {
    spawn(
        executablePath: string,
        args: readonly string[],
        options: {
            detached: true;
            stdio: 'ignore';
            cwd: string;
            env: NodeJS.ProcessEnv;
            windowsHide: true;
        },
    ): SpawnedDetachedProcess;
}

export interface PackagedRuntimeProcessOptions {
    executablePath: string;
    pluginRoot: string;
    manifestPath: string;
    windowsNamedPipeSecurity?: WindowsNamedPipeSecurityPort;
    spawner?: DetachedProcessSpawner;
}

export interface PackagedPluginServerOptions extends LoadPackagedRuntimeOptions {
    /**
     * Injectable for tests and embedded hosts. Direct package execution uses
     * the static detached launcher below and never returns the authority to the
     * MCP process.
     */
    runtimeProcess?: PersistentRuntimeProcessPort;
    dataRoot?: string;
    transport?: Transport;
    installSignalHandlers?: boolean;
}

export interface RunningPackagedPluginServer {
    readonly verifiedRuntime: VerifiedPackagedRuntime;
    readonly runtime: WaptionsMcpServer;
    close(): Promise<void>;
}

/**
 * Start the static packaged MCP server. There is no checkout adapter, dynamic
 * module path, placeholder resource, or in-process project authority here.
 */
export async function startPackagedPluginServer(
    options: PackagedPluginServerOptions,
): Promise<RunningPackagedPluginServer> {
    const verifiedRuntime = await loadVerifiedPackagedRuntime(options);
    const runtimeProcess = options.runtimeProcess
        ?? createPackagedRuntimeProcess({
            executablePath: resolve(
                verifiedRuntime.pluginRoot,
                'mcp',
                'server.mjs',
            ),
            pluginRoot: verifiedRuntime.pluginRoot,
            manifestPath: verifiedRuntime.manifestPath,
        });
    const coordinator = await attachOrStartMcpCoordinator({
        dataRoot: options.dataRoot,
        runtimeProcess,
    });
    const runtime = new WaptionsMcpServer({
        coordinator,
        semanticSchemas: verifiedRuntime.semanticSchemas,
        appResource: verifiedRuntime.appResource,
    });
    const transport = options.transport
        ?? new BoundedStdioServerTransport(process.stdin, process.stdout);
    let closed = false;
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const close = async () => {
        if (closed) return;
        closed = true;
        for (const [signal, handler] of signalHandlers) {
            process.off(signal, handler);
        }
        signalHandlers.clear();
        await runtime.close();
    };
    if (options.installSignalHandlers !== false) {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
            const handler = () => {
                void close().catch((error: unknown) => {
                    reportStartupFailure(error);
                });
            };
            signalHandlers.set(signal, handler);
            process.once(signal, handler);
        }
        if (!options.transport) {
            process.stdin.once('end', () => {
                void close().catch((error: unknown) => {
                    reportStartupFailure(error);
                });
            });
        }
    }
    try {
        await runtime.connect(transport);
    } catch (error) {
        await close().catch(() => undefined);
        throw error;
    }
    return {
        verifiedRuntime,
        runtime,
        close,
    };
}

/**
 * The stdio process only launches the same verified static bundle in authority
 * mode. The child is detached before this method returns, so closing a Codex
 * MCP connection cannot terminate durable jobs or invalidate session state.
 */
export function createPackagedRuntimeProcess(
    options: PackagedRuntimeProcessOptions,
): PersistentRuntimeProcessPort {
    const executablePath = validateAbsolutePath(
        options.executablePath,
        'Packaged runtime executable',
    );
    const pluginRoot = validateAbsolutePath(
        options.pluginRoot,
        'Packaged plugin root',
    );
    const manifestPath = validateAbsolutePath(
        options.manifestPath,
        'Packaged runtime manifest',
    );
    if (
        executablePath !== resolve(pluginRoot, 'mcp', 'server.mjs')
        || manifestPath !== resolve(pluginRoot, 'build-manifest.json')
    ) {
        throw new Error(
            'The authority launcher must use this packaged runtime bundle.',
        );
    }
    const spawner = options.spawner ?? nodeDetachedProcessSpawner;
    return {
        ...(options.windowsNamedPipeSecurity
            ? { windowsNamedPipeSecurity: options.windowsNamedPipeSecurity }
            : {}),
        async ensureRunning(input) {
            if (
                input.protocolVersion
                !== COORDINATOR_CONTROL_PROTOCOL_VERSION
            ) {
                throw new Error(
                    'The packaged runtime control protocol is incompatible.',
                );
            }
            if (
                process.platform === 'win32'
                && !options.windowsNamedPipeSecurity
            ) {
                // Node does not expose the connected pipe DACL. Production
                // Windows builds must inject the native handle verifier rather
                // than silently falling back to an unauthenticated pipe.
                throw new Error(
                    'A native Windows named-pipe DACL verifier is required.',
                );
            }
            const dataRoot = validateAbsolutePath(
                input.dataRoot,
                'Waptions agent data root',
            );
            const child = spawner.spawn(
                process.execPath,
                [executablePath, PACKAGED_AUTHORITY_ARGUMENT],
                {
                    detached: true,
                    stdio: 'ignore',
                    cwd: pluginRoot,
                    windowsHide: true,
                    env: {
                        ...allowedAuthorityEnvironment(process.env),
                        WAPTIONS_AGENT_DATA_DIR: dataRoot,
                        WAPTIONS_PLUGIN_ROOT: pluginRoot,
                        WAPTIONS_RUNTIME_MANIFEST: manifestPath,
                    },
                },
            );
            child.unref();
        },
    };
}

export interface RunPackagedPluginServerCliOptions {
    argv?: readonly string[];
    moduleUrl?: string;
    dataRoot?: string;
    runtimeProcess?: PersistentRuntimeProcessPort;
    transport?: Transport;
    installSignalHandlers?: boolean;
}

/**
 * Executable package entrypoint. Authority mode owns the coordinator and IPC;
 * the default mode is a disposable MCP stdio client of that authority.
 */
export async function main(
    options: RunPackagedPluginServerCliOptions = {},
): Promise<void> {
    const argv = options.argv ?? process.argv.slice(2);
    const moduleUrl = options.moduleUrl ?? import.meta.url;
    if (argv.length === 1 && argv[0] === PACKAGED_AUTHORITY_ARGUMENT) {
        const verifiedRuntime = await loadVerifiedPackagedRuntime({ moduleUrl });
        const dataRoot = resolveWaptionsAgentDataRoot(options.dataRoot);
        await runManagedCoordinatorService(async () => {
            const production = await createProductionManagedRuntime({
                dataRoot,
                appResource: {
                    uri: verifiedRuntime.appResource.uri,
                    mimeType: verifiedRuntime.appResource.mimeType,
                    buildHash: verifiedRuntime.appResource.buildHash,
                },
            });
            return {
                dataRoot,
                authority: production.authority,
                handler: createCoordinatorControlHandler(production.adapter),
                ...(production.serviceOptions
                    ? { options: production.serviceOptions }
                    : {}),
            };
        });
        return;
    }
    if (argv.length !== 0) {
        throw new Error('Unknown Waptions packaged runtime argument.');
    }
    await startPackagedPluginServer({
        moduleUrl,
        dataRoot: options.dataRoot,
        ...(options.runtimeProcess
            ? { runtimeProcess: options.runtimeProcess }
            : {}),
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.installSignalHandlers === undefined
            ? {}
            : { installSignalHandlers: options.installSignalHandlers }),
    });
}

export const runPackagedPluginServerCli = main;

export function isDirectPluginServerExecution(
    moduleUrl = import.meta.url,
    argvEntry = process.argv[1],
): boolean {
    if (!argvEntry) return false;
    try {
        return realpathSync(fileURLToPath(moduleUrl))
            === realpathSync(resolve(argvEntry));
    } catch {
        return false;
    }
}

export function reportStartupFailure(error: unknown): void {
    const message = error instanceof Error
        ? error.message
        : 'Unknown MCP server startup error.';
    process.stderr.write(`Waptions MCP server failed: ${message}\n`);
    process.exitCode = 1;
}

const nodeDetachedProcessSpawner: DetachedProcessSpawner = {
    spawn(executablePath, args, options) {
        return spawn(executablePath, [...args], options);
    },
};

function validateAbsolutePath(value: string, label: string): string {
    if (
        !isAbsolute(value)
        || value.includes('\0')
        || value.length > 2_048
    ) {
        throw new Error(`${label} must be a valid absolute path.`);
    }
    return resolve(value);
}

function allowedAuthorityEnvironment(
    source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        PATH: fixedAuthorityExecutablePath(source),
    };
    for (const name of AUTHORITY_ENVIRONMENT_ALLOWLIST) {
        const value = source[name];
        if (value !== undefined && !value.includes('\0')) {
            environment[name] = value;
        }
    }
    return environment;
}

function fixedAuthorityExecutablePath(source: NodeJS.ProcessEnv): string {
    if (process.platform !== 'win32') {
        return POSIX_AUTHORITY_EXECUTABLE_PATH;
    }
    const systemRoot = source.SystemRoot ?? source.SYSTEMROOT;
    if (
        typeof systemRoot !== 'string'
        || !/^[A-Za-z]:\\[^;\0]{1,240}$/u.test(systemRoot)
    ) {
        return 'C:\\Windows\\System32;C:\\Windows';
    }
    return `${systemRoot}\\System32;${systemRoot}`;
}

if (isDirectPluginServerExecution()) {
    void main().catch(reportStartupFailure);
}
