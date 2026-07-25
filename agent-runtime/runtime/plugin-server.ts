import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
    attachOrStartMcpCoordinator,
    type PersistentRuntimeProcessPort,
} from '../integration/mcp-coordinator-client';
import { BoundedStdioServerTransport } from '../server/bounded-stdio-transport';
import { WaptionsMcpServer } from '../server/mcp-server';
import {
    loadVerifiedPackagedRuntime,
    type LoadPackagedRuntimeOptions,
    type VerifiedPackagedRuntime,
} from './packaged-runtime';

export const PACKAGED_RUNTIME_HOST_SEAM_VERSION = 1 as const;

export interface PackagedPluginServerOptions extends LoadPackagedRuntimeOptions {
    /**
     * Implemented by the authoritative runtime-host package. This is the only
     * production seam: it may launch or attach the persistent authority, but
     * it never returns that authority to the MCP process.
     */
    runtimeProcess: PersistentRuntimeProcessPort;
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
    const coordinator = await attachOrStartMcpCoordinator({
        dataRoot: options.dataRoot,
        runtimeProcess: options.runtimeProcess,
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

export function reportStartupFailure(error: unknown): void {
    const message = error instanceof Error
        ? error.message
        : 'Unknown MCP server startup error.';
    process.stderr.write(`Waptions MCP server failed: ${message}\n`);
    process.exitCode = 1;
}
