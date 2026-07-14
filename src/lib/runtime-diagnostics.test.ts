import { describe, expect, it } from 'vitest';
import { createRuntimeDiagnosticsRegistry } from './runtime-diagnostics';

describe('runtime diagnostics registry', () => {
    it('publishes deeply immutable pull snapshots and reuses them while metrics are unchanged', () => {
        const registry = createRuntimeDiagnosticsRegistry({ now: () => 1_234 });

        const initial = registry.snapshot();
        expect(initial).toMatchObject({
            sequence: 0,
            capturedAtMs: 1_234,
            counters: {
                audio: { underruns: 0 },
                video: { decodedFrames: 0 },
                waveform: { requests: 0 },
                export: { started: 0 },
            },
            gauges: {
                audio: { queuedBlocks: 0 },
                video: { cacheBytes: 0 },
                waveform: { inFlight: 0 },
                export: { bufferedBytes: 0 },
            },
            timings: {
                audio: { prime: { count: 0, totalMs: 0, maxMs: 0 } },
                video: { decode: { count: 0, totalMs: 0, maxMs: 0 } },
                waveform: { lookup: { count: 0, totalMs: 0, maxMs: 0 } },
                export: { duration: { count: 0, totalMs: 0, maxMs: 0 } },
            },
        });
        expect(Object.isFrozen(initial)).toBe(true);
        expect(Object.isFrozen(initial.counters)).toBe(true);
        expect(Object.isFrozen(initial.counters.audio)).toBe(true);
        expect(Object.isFrozen(initial.gauges.video)).toBe(true);
        expect(Object.isFrozen(initial.timings.audio)).toBe(true);
        expect(Object.isFrozen(initial.timings.audio.decode)).toBe(true);
        expect(registry.snapshot()).toBe(initial);
    });

    it('keeps hot-path batch updates private until one explicit flush', () => {
        let now = 100;
        const registry = createRuntimeDiagnosticsRegistry({ now: () => now });
        const initial = registry.snapshot();
        const batch = registry.createBatch();

        batch.increment('audio', 'decodedBlocks', 2);
        batch.increment('audio', 'cacheHits');
        batch.increment('audio', 'queueResets');
        batch.increment('video', 'cacheMisses', 3);
        batch.increment('video', 'oversizedRejects');
        batch.increment('waveform', 'aborts');
        batch.increment('export', 'memoryFallback');
        batch.setGauge('audio', 'queuedBlocks', 3);
        batch.setGauge('audio', 'queuedBlocks', 5);
        batch.observeTiming('audio', 'decode', 3);
        batch.observeTiming('audio', 'decode', 7);

        expect(registry.snapshot()).toBe(initial);
        now = 200;
        expect(batch.flush()).toBe(true);

        const published = registry.snapshot();
        expect(published).toMatchObject({
            sequence: 1,
            capturedAtMs: 200,
            counters: {
                audio: { decodedBlocks: 2, cacheHits: 1, queueResets: 1 },
                video: { cacheMisses: 3, oversizedRejects: 1 },
                waveform: { aborts: 1 },
                export: { memoryFallback: 1 },
            },
            gauges: { audio: { queuedBlocks: 5 } },
            timings: { audio: { decode: { count: 2, totalMs: 10, maxMs: 7 } } },
        });
        expect(batch.flush()).toBe(false);
        expect(registry.snapshot()).toBe(published);
    });

    it('merges counters, latest gauges, and bounded timings across independent batches', () => {
        const registry = createRuntimeDiagnosticsRegistry({ now: () => 10 });
        const playback = registry.createBatch();
        const rendering = registry.createBatch();

        playback.increment('audio', 'underruns');
        playback.setGauge('video', 'cacheBytes', 100);
        playback.observeTiming('video', 'decode', 4);
        rendering.increment('waveform', 'cacheHits', 4);
        rendering.increment('export', 'framesRendered', 12);
        rendering.setGauge('video', 'cacheBytes', 80);
        rendering.setGauge('waveform', 'persistentBytes', 1_024);
        rendering.observeTiming('video', 'decode', 9);
        rendering.observeTiming('export', 'write', 2);
        playback.flush();
        rendering.flush();

        expect(registry.snapshot()).toMatchObject({
            counters: {
                audio: { underruns: 1 },
                waveform: { cacheHits: 4 },
                export: { framesRendered: 12 },
            },
            gauges: {
                video: { cacheBytes: 80 },
                waveform: { persistentBytes: 1_024 },
            },
            timings: {
                video: { decode: { count: 2, totalMs: 13, maxMs: 9 } },
                export: { write: { count: 1, totalMs: 2, maxMs: 2 } },
            },
        });
    });

    it('resets counters, gauges, and timing aggregates as one revision', () => {
        const registry = createRuntimeDiagnosticsRegistry({ now: () => 10 });
        const batch = registry.createBatch();
        batch.increment('audio', 'sessionDisposals');
        batch.setGauge('waveform', 'memoryBytes', 2_048);
        batch.observeTiming('waveform', 'extraction', 12);
        batch.flush();

        registry.reset();
        expect(registry.snapshot()).toMatchObject({
            sequence: 2,
            counters: {
                audio: { sessionDisposals: 0 },
            },
            gauges: { waveform: { memoryBytes: 0 } },
            timings: { waveform: { extraction: { count: 0, totalMs: 0, maxMs: 0 } } },
        });
    });

    it('supports low-frequency direct increments without publishing until a snapshot is pulled', () => {
        const registry = createRuntimeDiagnosticsRegistry({ now: () => 50 });
        const initial = registry.snapshot();

        registry.increment('export', 'completed', 2);
        registry.increment('waveform', 'failures', 0);
        registry.setGauge('export', 'bufferedBytes', 4_096);
        registry.setGauge('export', 'bufferedBytes', 4_096);
        registry.observeTiming('export', 'duration', 25);

        expect(initial.counters.export.completed).toBe(0);
        expect(registry.snapshot()).toMatchObject({
            sequence: 3,
            capturedAtMs: 50,
            counters: {
                export: { completed: 2 },
                waveform: { failures: 0 },
            },
            gauges: { export: { bufferedBytes: 4_096 } },
            timings: { export: { duration: { count: 1, totalMs: 25, maxMs: 25 } } },
        });
    });

    it('rejects invalid counters, gauges, and timings before a batch can be published', () => {
        const registry = createRuntimeDiagnosticsRegistry();
        const batch = registry.createBatch();

        expect(() => batch.increment('audio', 'decodedBlocks', -1)).toThrow(/non-negative/);
        expect(() => batch.increment('video', 'decodedFrames', Number.NaN)).toThrow(/finite/);
        expect(() => batch.setGauge('video', 'activeSessions', -1)).toThrow(/non-negative/);
        expect(() => batch.setGauge('waveform', 'inFlight', Number.NaN)).toThrow(/finite/);
        expect(() => batch.observeTiming('audio', 'prime', -0.1)).toThrow(/non-negative/);
        expect(() => batch.observeTiming('export', 'write', Number.POSITIVE_INFINITY)).toThrow(/finite/);
        expect(batch.flush()).toBe(false);
    });
});
