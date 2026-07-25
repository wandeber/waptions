import type {
    ProductionRuntimeAuthorities,
    ProductionRuntimeAuthorityPorts,
} from './contracts.js';
import { createProductionProjectValidationAuthority } from './deep-project-validation.js';
import { createProductionRuntimeDiagnosticsAuthority } from './runtime-diagnostics.js';

/**
 * Composition should call this during runtime configuration, before it starts recovery. The
 * returned seams are intentionally inert until managed-tool-handlers invokes them for a request.
 */
export function createProductionRuntimeAuthorities(
    ports: ProductionRuntimeAuthorityPorts,
): ProductionRuntimeAuthorities {
    return Object.freeze({
        projectValidation: createProductionProjectValidationAuthority(ports.validation),
        diagnostics: createProductionRuntimeDiagnosticsAuthority(ports.diagnostics),
    });
}
