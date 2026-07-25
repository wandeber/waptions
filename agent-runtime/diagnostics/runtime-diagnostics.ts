export interface DiagnosticLimits {
    queuedJobs: number;
    activeJobs: number;
    openFiles: number;
    subscriptions: number;
    artifactBytesInFlight: number;
}

export interface DiagnosticSnapshot {
    sampledAt: string;
    current: Readonly<Record<keyof DiagnosticLimits, number>>;
    peak: Readonly<Record<keyof DiagnosticLimits, number>>;
    limits: DiagnosticLimits;
    assertions: readonly {
        name: keyof DiagnosticLimits;
        ok: boolean;
        current: number;
        limit: number;
    }[];
}

const DEFAULT_LIMITS: DiagnosticLimits = {
    queuedJobs: 1_000,
    activeJobs: 8,
    openFiles: 64,
    subscriptions: 64,
    artifactBytesInFlight: 8 * 1024 * 1024,
};

export class RuntimeDiagnostics {
    private readonly current: DiagnosticLimits = {
        queuedJobs: 0,
        activeJobs: 0,
        openFiles: 0,
        subscriptions: 0,
        artifactBytesInFlight: 0,
    };
    private readonly peak: DiagnosticLimits = { ...this.current };

    constructor(readonly limits: DiagnosticLimits = DEFAULT_LIMITS) {}

    set(name: keyof DiagnosticLimits, value: number): void {
        if (!Number.isFinite(value) || value < 0) throw new Error('Diagnostic gauges cannot be negative.');
        this.current[name] = value;
        this.peak[name] = Math.max(this.peak[name], value);
    }

    increment(name: keyof DiagnosticLimits, amount = 1): () => void {
        this.set(name, this.current[name] + amount);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.set(name, Math.max(0, this.current[name] - amount));
        };
    }

    snapshot(): DiagnosticSnapshot {
        return {
            sampledAt: new Date().toISOString(),
            current: { ...this.current },
            peak: { ...this.peak },
            limits: { ...this.limits },
            assertions: (Object.keys(this.limits) as (keyof DiagnosticLimits)[]).map((name) => ({
                name,
                ok: this.current[name] <= this.limits[name],
                current: this.current[name],
                limit: this.limits[name],
            })),
        };
    }

    assertWithinLimits(): void {
        const failed = this.snapshot().assertions.filter((assertion) => !assertion.ok);
        if (failed.length > 0) {
            throw new Error(`Managed runtime resource limits exceeded: ${failed.map((item) => item.name).join(', ')}`);
        }
    }
}
