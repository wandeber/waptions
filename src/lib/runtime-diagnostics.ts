export interface AudioRuntimeCounters {
    decodedBlocks: number;
    cacheHits: number;
    cacheMisses: number;
    underruns: number;
    sessionRebuilds: number;
    queueResets: number;
    sessionOpens: number;
    sessionDisposals: number;
    staleBlocks: number;
    endedEvents: number;
    contextSuspends: number;
    clockEvents: number;
}

export interface VideoRuntimeCounters {
    decodedFrames: number;
    cacheHits: number;
    cacheMisses: number;
    evictions: number;
    visibleRequests: number;
    warmupRequests: number;
    exportRequests: number;
    sessionOpens: number;
    sessionDisposals: number;
    staleFrames: number;
    oversizedRejects: number;
}

export interface WaveformRuntimeCounters {
    requests: number;
    cacheHits: number;
    cacheMisses: number;
    failures: number;
    decoderStarts: number;
    aborts: number;
    persistentHits: number;
}

export interface ExportRuntimeCounters {
    started: number;
    completed: number;
    failed: number;
    aborted: number;
    streamed: number;
    memoryFallback: number;
    framesRendered: number;
    audioBlocksRendered: number;
}

export interface RuntimeDiagnosticCounters {
    audio: AudioRuntimeCounters;
    video: VideoRuntimeCounters;
    waveform: WaveformRuntimeCounters;
    export: ExportRuntimeCounters;
}

export interface AudioRuntimeGauges {
    queuedBlocks: number;
}

export interface VideoRuntimeGauges {
    cacheBytes: number;
    cacheEntries: number;
    activeSessions: number;
}

export interface WaveformRuntimeGauges {
    memoryBytes: number;
    persistentBytes: number;
    inFlight: number;
}

export interface ExportRuntimeGauges {
    bufferedBytes: number;
}

export interface RuntimeDiagnosticGauges {
    audio: AudioRuntimeGauges;
    video: VideoRuntimeGauges;
    waveform: WaveformRuntimeGauges;
    export: ExportRuntimeGauges;
}

export interface RuntimeTimingSummary {
    count: number;
    totalMs: number;
    maxMs: number;
}

export interface RuntimeDiagnosticTimings {
    audio: {
        prime: RuntimeTimingSummary;
        decode: RuntimeTimingSummary;
        mix: RuntimeTimingSummary;
    };
    video: {
        decode: RuntimeTimingSummary;
        render: RuntimeTimingSummary;
    };
    waveform: {
        lookup: RuntimeTimingSummary;
        extraction: RuntimeTimingSummary;
    };
    export: {
        duration: RuntimeTimingSummary;
        write: RuntimeTimingSummary;
    };
}

export type RuntimeDiagnosticDomain = keyof RuntimeDiagnosticCounters;
export type RuntimeDiagnosticCounter<D extends RuntimeDiagnosticDomain> = keyof RuntimeDiagnosticCounters[D];
export type RuntimeDiagnosticGauge<D extends RuntimeDiagnosticDomain> = keyof RuntimeDiagnosticGauges[D];
export type RuntimeDiagnosticTiming<D extends RuntimeDiagnosticDomain> = keyof RuntimeDiagnosticTimings[D];

export interface RuntimeDiagnosticsSnapshot {
    readonly sequence: number;
    readonly capturedAtMs: number;
    readonly counters: Readonly<{
        [D in RuntimeDiagnosticDomain]: Readonly<RuntimeDiagnosticCounters[D]>;
    }>;
    readonly gauges: Readonly<{
        [D in RuntimeDiagnosticDomain]: Readonly<RuntimeDiagnosticGauges[D]>;
    }>;
    readonly timings: Readonly<{
        [D in RuntimeDiagnosticDomain]: Readonly<{
            [T in RuntimeDiagnosticTiming<D>]: Readonly<RuntimeDiagnosticTimings[D][T]>;
        }>;
    }>;
}

interface RuntimeDiagnosticsRegistryOptions {
    now?: () => number;
}

interface RuntimeGaugeUpdates {
    audio: Partial<AudioRuntimeGauges>;
    video: Partial<VideoRuntimeGauges>;
    waveform: Partial<WaveformRuntimeGauges>;
    export: Partial<ExportRuntimeGauges>;
}

const emptyTiming = (): RuntimeTimingSummary => ({ count: 0, totalMs: 0, maxMs: 0 });

function createEmptyCounters(): RuntimeDiagnosticCounters {
    return {
        audio: {
            decodedBlocks: 0, cacheHits: 0, cacheMisses: 0, underruns: 0, sessionRebuilds: 0,
            queueResets: 0, sessionOpens: 0, sessionDisposals: 0, staleBlocks: 0, endedEvents: 0,
            contextSuspends: 0, clockEvents: 0,
        },
        video: {
            decodedFrames: 0, cacheHits: 0, cacheMisses: 0, evictions: 0, visibleRequests: 0,
            warmupRequests: 0, exportRequests: 0, sessionOpens: 0, sessionDisposals: 0,
            staleFrames: 0, oversizedRejects: 0,
        },
        waveform: {
            requests: 0, cacheHits: 0, cacheMisses: 0, failures: 0, decoderStarts: 0,
            aborts: 0, persistentHits: 0,
        },
        export: {
            started: 0, completed: 0, failed: 0, aborted: 0, streamed: 0,
            memoryFallback: 0, framesRendered: 0, audioBlocksRendered: 0,
        },
    };
}

function createEmptyGauges(): RuntimeDiagnosticGauges {
    return {
        audio: { queuedBlocks: 0 },
        video: { cacheBytes: 0, cacheEntries: 0, activeSessions: 0 },
        waveform: { memoryBytes: 0, persistentBytes: 0, inFlight: 0 },
        export: { bufferedBytes: 0 },
    };
}

function createGaugeUpdates(): RuntimeGaugeUpdates {
    return { audio: {}, video: {}, waveform: {}, export: {} };
}

function createEmptyTimings(): RuntimeDiagnosticTimings {
    return {
        audio: { prime: emptyTiming(), decode: emptyTiming(), mix: emptyTiming() },
        video: { decode: emptyTiming(), render: emptyTiming() },
        waveform: { lookup: emptyTiming(), extraction: emptyTiming() },
        export: { duration: emptyTiming(), write: emptyTiming() },
    };
}

function assertNonNegativeFinite(value: number, label: string): void {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number.`);
    }
    if (value < 0) {
        throw new RangeError(`${label} must be non-negative.`);
    }
}

function addCounter<D extends RuntimeDiagnosticDomain>(
    counters: RuntimeDiagnosticCounters,
    domain: D,
    counter: RuntimeDiagnosticCounter<D>,
    delta: number,
): void {
    // TypeScript cannot preserve the correlation between a generic domain and its corresponding
    // metric after indexing a mapped object. Public generic signatures keep callers strict; these
    // local records only implement the numeric mutations shared by every diagnostics domain.
    const domainCounters = counters[domain] as Record<RuntimeDiagnosticCounter<D>, number>;
    domainCounters[counter] += delta;
}

function setGaugeValue<D extends RuntimeDiagnosticDomain>(
    gauges: RuntimeDiagnosticGauges,
    domain: D,
    gauge: RuntimeDiagnosticGauge<D>,
    value: number,
): void {
    const domainGauges = gauges[domain] as Record<RuntimeDiagnosticGauge<D>, number>;
    domainGauges[gauge] = value;
}

function setGaugeUpdate<D extends RuntimeDiagnosticDomain>(
    gauges: RuntimeGaugeUpdates,
    domain: D,
    gauge: RuntimeDiagnosticGauge<D>,
    value: number,
): void {
    const domainGauges = gauges[domain] as Partial<Record<RuntimeDiagnosticGauge<D>, number>>;
    domainGauges[gauge] = value;
}

function addTiming<D extends RuntimeDiagnosticDomain>(
    timings: RuntimeDiagnosticTimings,
    domain: D,
    timing: RuntimeDiagnosticTiming<D>,
    durationMs: number,
): void {
    const domainTimings = timings[domain] as Record<RuntimeDiagnosticTiming<D>, RuntimeTimingSummary>;
    const summary = domainTimings[timing];
    summary.count += 1;
    summary.totalMs += durationMs;
    summary.maxMs = Math.max(summary.maxMs, durationMs);
}

function freezeTiming(summary: RuntimeTimingSummary): Readonly<RuntimeTimingSummary> {
    return Object.freeze({ ...summary });
}

function freezeSnapshot(
    sequence: number,
    capturedAtMs: number,
    counters: RuntimeDiagnosticCounters,
    gauges: RuntimeDiagnosticGauges,
    timings: RuntimeDiagnosticTimings,
): RuntimeDiagnosticsSnapshot {
    const immutableCounters = Object.freeze({
        audio: Object.freeze({ ...counters.audio }),
        video: Object.freeze({ ...counters.video }),
        waveform: Object.freeze({ ...counters.waveform }),
        export: Object.freeze({ ...counters.export }),
    });
    const immutableGauges = Object.freeze({
        audio: Object.freeze({ ...gauges.audio }),
        video: Object.freeze({ ...gauges.video }),
        waveform: Object.freeze({ ...gauges.waveform }),
        export: Object.freeze({ ...gauges.export }),
    });
    const immutableTimings = Object.freeze({
        audio: Object.freeze({
            prime: freezeTiming(timings.audio.prime),
            decode: freezeTiming(timings.audio.decode),
            mix: freezeTiming(timings.audio.mix),
        }),
        video: Object.freeze({
            decode: freezeTiming(timings.video.decode),
            render: freezeTiming(timings.video.render),
        }),
        waveform: Object.freeze({
            lookup: freezeTiming(timings.waveform.lookup),
            extraction: freezeTiming(timings.waveform.extraction),
        }),
        export: Object.freeze({
            duration: freezeTiming(timings.export.duration),
            write: freezeTiming(timings.export.write),
        }),
    });
    return Object.freeze({
        sequence,
        capturedAtMs,
        counters: immutableCounters,
        gauges: immutableGauges,
        timings: immutableTimings,
    });
}

export class RuntimeDiagnosticsBatch {
    private counters = createEmptyCounters();
    private gauges = createGaugeUpdates();
    private timings = createEmptyTimings();
    private hasUpdates = false;

    constructor(private readonly registry: RuntimeDiagnosticsRegistry) {}

    increment<D extends RuntimeDiagnosticDomain>(
        domain: D,
        counter: RuntimeDiagnosticCounter<D>,
        delta = 1,
    ): void {
        assertNonNegativeFinite(delta, 'Runtime diagnostic counter delta');
        if (delta === 0) return;
        addCounter(this.counters, domain, counter, delta);
        this.hasUpdates = true;
    }

    setGauge<D extends RuntimeDiagnosticDomain>(
        domain: D,
        gauge: RuntimeDiagnosticGauge<D>,
        value: number,
    ): void {
        assertNonNegativeFinite(value, 'Runtime diagnostic gauge');
        setGaugeUpdate(this.gauges, domain, gauge, value);
        this.hasUpdates = true;
    }

    observeTiming<D extends RuntimeDiagnosticDomain>(
        domain: D,
        timing: RuntimeDiagnosticTiming<D>,
        durationMs: number,
    ): void {
        assertNonNegativeFinite(durationMs, 'Runtime diagnostic timing');
        addTiming(this.timings, domain, timing, durationMs);
        this.hasUpdates = true;
    }

    /**
     * Merges counters, latest gauges, and bounded timing aggregates as one registry revision.
     * Callers choose the cadence at a block boundary or infrequent diagnostics poll, so recording
     * a frame or sample never creates reactive work, timers, raw-sample arrays, or network traffic.
     */
    flush(): boolean {
        if (!this.hasUpdates) return false;
        this.registry.commit(this.counters, this.gauges, this.timings);
        this.counters = createEmptyCounters();
        this.gauges = createGaugeUpdates();
        this.timings = createEmptyTimings();
        this.hasUpdates = false;
        return true;
    }
}

export class RuntimeDiagnosticsRegistry {
    private counters = createEmptyCounters();
    private gauges = createEmptyGauges();
    private timings = createEmptyTimings();
    private sequence = 0;
    private snapshotDirty = false;
    private publishedSnapshot: RuntimeDiagnosticsSnapshot;
    private readonly now: () => number;

    constructor(options: RuntimeDiagnosticsRegistryOptions = {}) {
        this.now = options.now ?? Date.now;
        this.publishedSnapshot = freezeSnapshot(
            this.sequence,
            this.now(),
            this.counters,
            this.gauges,
            this.timings,
        );
    }

    createBatch(): RuntimeDiagnosticsBatch {
        return new RuntimeDiagnosticsBatch(this);
    }

    increment<D extends RuntimeDiagnosticDomain>(
        domain: D,
        counter: RuntimeDiagnosticCounter<D>,
        delta = 1,
    ): void {
        assertNonNegativeFinite(delta, 'Runtime diagnostic counter delta');
        if (delta === 0) return;
        addCounter(this.counters, domain, counter, delta);
        this.markChanged();
    }

    setGauge<D extends RuntimeDiagnosticDomain>(
        domain: D,
        gauge: RuntimeDiagnosticGauge<D>,
        value: number,
    ): void {
        assertNonNegativeFinite(value, 'Runtime diagnostic gauge');
        if (this.gauges[domain][gauge] === value) return;
        setGaugeValue(this.gauges, domain, gauge, value);
        this.markChanged();
    }

    observeTiming<D extends RuntimeDiagnosticDomain>(
        domain: D,
        timing: RuntimeDiagnosticTiming<D>,
        durationMs: number,
    ): void {
        assertNonNegativeFinite(durationMs, 'Runtime diagnostic timing');
        addTiming(this.timings, domain, timing, durationMs);
        this.markChanged();
    }

    /**
     * Materializes a deeply frozen copy only when requested and after metrics changed. Returning
     * the previous object for an unchanged registry keeps a low-frequency debug panel cheap without
     * turning diagnostics into a hot-loop application-state subscription.
     */
    snapshot(): RuntimeDiagnosticsSnapshot {
        if (this.snapshotDirty) {
            this.publishedSnapshot = freezeSnapshot(
                this.sequence,
                this.now(),
                this.counters,
                this.gauges,
                this.timings,
            );
            this.snapshotDirty = false;
        }
        return this.publishedSnapshot;
    }

    reset(): void {
        this.counters = createEmptyCounters();
        this.gauges = createEmptyGauges();
        this.timings = createEmptyTimings();
        this.markChanged();
    }

    /** @internal Batches use this method to publish one revision regardless of observation count. */
    commit(
        counterUpdates: RuntimeDiagnosticCounters,
        gaugeUpdates: RuntimeGaugeUpdates,
        timingUpdates: RuntimeDiagnosticTimings,
    ): void {
        for (const domain of Object.keys(counterUpdates) as RuntimeDiagnosticDomain[]) {
            for (const counter of Object.keys(counterUpdates[domain]) as RuntimeDiagnosticCounter<typeof domain>[]) {
                const delta = counterUpdates[domain][counter];
                if (delta > 0) addCounter(this.counters, domain, counter, delta);
            }
            for (const gauge of Object.keys(gaugeUpdates[domain]) as RuntimeDiagnosticGauge<typeof domain>[]) {
                const value = gaugeUpdates[domain][gauge];
                if (value !== undefined) setGaugeValue(this.gauges, domain, gauge, value);
            }
            for (const timing of Object.keys(timingUpdates[domain]) as RuntimeDiagnosticTiming<typeof domain>[]) {
                const update = timingUpdates[domain][timing] as RuntimeTimingSummary;
                if (update.count === 0) continue;
                const current = (this.timings[domain] as Record<string, RuntimeTimingSummary>)[timing];
                current.count += update.count;
                current.totalMs += update.totalMs;
                current.maxMs = Math.max(current.maxMs, update.maxMs);
            }
        }
        this.markChanged();
    }

    private markChanged(): void {
        this.sequence += 1;
        this.snapshotDirty = true;
    }
}

export function createRuntimeDiagnosticsRegistry(
    options: RuntimeDiagnosticsRegistryOptions = {},
): RuntimeDiagnosticsRegistry {
    return new RuntimeDiagnosticsRegistry(options);
}

/** Shared local registry; it is inert until runtime code records or explicitly reads metrics. */
export const runtimeDiagnostics = createRuntimeDiagnosticsRegistry();
