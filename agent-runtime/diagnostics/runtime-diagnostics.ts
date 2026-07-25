export interface DiagnosticLimits {
    queuedJobs: number;
    activeJobs: number;
    openFiles: number;
    subscriptions: number;
    artifactsInFlight: number;
    artifactBytesInFlight: number;
    sourceCopiesInFlight: number;
    sourceCopyBytesInFlight: number;
    renderStagesInFlight: number;
    renderStageBytesInFlight: number;
    ipcConnections: number;
    ipcInFlight: number;
    ipcQueuedBytes: number;
}

export interface DiagnosticSnapshot {
    sampledAt: string;
    filesystemDeadlineMode: 'cooperative-node-filesystem';
    current: Readonly<Record<keyof DiagnosticLimits, number>>;
    peak: Readonly<Record<keyof DiagnosticLimits, number>>;
    limits: DiagnosticLimits;
    assertions: readonly {
        name: keyof DiagnosticLimits;
        ok: boolean;
        current: number;
        limit: number;
    }[];
    counters: Readonly<Record<DiagnosticCounter, number>>;
}

export type DiagnosticCounter =
    | 'abortedOperations'
    | 'deadlineExceeded'
    | 'limitRejections'
    | 'observerFailures';

const DEFAULT_LIMITS: DiagnosticLimits = {
    queuedJobs: 1_000,
    activeJobs: 8,
    openFiles: 64,
    subscriptions: 64,
    artifactsInFlight: 8,
    artifactBytesInFlight: 4 * 1024 * 1024 * 1024,
    sourceCopiesInFlight: 2,
    sourceCopyBytesInFlight: 128 * 1024 * 1024 * 1024,
    renderStagesInFlight: 2,
    renderStageBytesInFlight: 128 * 1024 * 1024 * 1024,
    ipcConnections: 32,
    ipcInFlight: 128,
    ipcQueuedBytes: 8 * 1024 * 1024,
};

export class RuntimeDiagnostics {
    private readonly current: DiagnosticLimits = {
        queuedJobs: 0,
        activeJobs: 0,
        openFiles: 0,
        subscriptions: 0,
        artifactsInFlight: 0,
        artifactBytesInFlight: 0,
        sourceCopiesInFlight: 0,
        sourceCopyBytesInFlight: 0,
        renderStagesInFlight: 0,
        renderStageBytesInFlight: 0,
        ipcConnections: 0,
        ipcInFlight: 0,
        ipcQueuedBytes: 0,
    };
    private readonly peak: DiagnosticLimits = { ...this.current };
    private readonly counters: Record<DiagnosticCounter, number> = {
        abortedOperations: 0,
        deadlineExceeded: 0,
        limitRejections: 0,
        observerFailures: 0,
    };

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

    record(name: DiagnosticCounter, amount = 1): void {
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new Error('Diagnostic counters require a positive safe integer.');
        }
        this.counters[name] += amount;
    }

    snapshot(): DiagnosticSnapshot {
        return {
            sampledAt: new Date().toISOString(),
            filesystemDeadlineMode: 'cooperative-node-filesystem',
            current: { ...this.current },
            peak: { ...this.peak },
            limits: { ...this.limits },
            assertions: (Object.keys(this.limits) as (keyof DiagnosticLimits)[]).map((name) => ({
                name,
                ok: this.current[name] <= this.limits[name],
                current: this.current[name],
                limit: this.limits[name],
            })),
            counters: { ...this.counters },
        };
    }

    assertWithinLimits(): void {
        const failed = this.snapshot().assertions.filter((assertion) => !assertion.ok);
        if (failed.length > 0) {
            throw new Error(`Managed runtime resource limits exceeded: ${failed.map((item) => item.name).join(', ')}`);
        }
    }
}
