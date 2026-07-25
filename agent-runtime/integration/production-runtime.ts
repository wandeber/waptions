import type {
    ManagedCoordinatorAdapter,
} from '../server/coordinator-adapter';
import type {
    ManagedCoordinatorServiceAuthority,
    ManagedCoordinatorServiceOptions,
} from '../transport/managed-coordinator-service';
import {
    createProductionRuntimeComposition,
} from './production/runtime-composition';

export interface ProductionManagedRuntime {
    readonly authority: ManagedCoordinatorServiceAuthority;
    readonly adapter: ManagedCoordinatorAdapter;
    readonly serviceOptions?: ManagedCoordinatorServiceOptions;
}

export interface ProductionManagedRuntimeOptions {
    readonly dataRoot: string;
    readonly appResource: {
        readonly uri: string;
        readonly mimeType: 'text/html;profile=mcp-app';
        readonly buildHash: string;
    };
}

/**
 * Construct the persistent production authority used by the packaged CLI.
 *
 * All capability-owning services are installed through the coordinator's
 * pre-recovery hook so interrupted jobs never recover without their handler.
 */
export async function createProductionManagedRuntime(
    options: ProductionManagedRuntimeOptions,
): Promise<ProductionManagedRuntime> {
    return createProductionRuntimeComposition(options);
}
