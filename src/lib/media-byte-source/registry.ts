import { createMediaByteStream } from './stream';
import {
    assertMediaRange,
    freezeMediaIdentity,
    MediaByteSourceError,
    type CoreMediaIdentity,
    type MediaByteRange,
    type MediaByteSource,
    type MediaReadGrant,
} from './types';

interface RegistryEntry {
    readonly source: MediaByteSource;
    readonly sourceId: string;
    readonly identity: CoreMediaIdentity;
    leases: number;
    invalidated: boolean;
    closed: boolean;
    closing: Promise<void> | null;
    readonly closeWaiters: Array<() => void>;
}

export interface MediaByteSourceRegistrySnapshot {
    readonly registeredSources: number;
    readonly retiredSources: number;
    readonly activeLeases: number;
    readonly peakLeases: number;
    readonly invalidations: number;
    readonly closes: number;
}

export interface MediaByteSourceLease extends MediaByteSource {
    readonly grant: MediaReadGrant;
}

function normalizeGrant(
    sourceId: string,
    identity: CoreMediaIdentity,
    ranges?: readonly MediaByteRange[],
): MediaReadGrant {
    const normalizedRanges = (ranges ?? [{ start: 0, endExclusive: identity.sizeBytes }]).map((range) => {
        assertMediaRange(range, identity.sizeBytes, identity.sizeBytes);
        return Object.freeze({ ...range });
    });
    return Object.freeze({
        sourceId,
        immutableVersion: identity.fingerprint,
        ranges: Object.freeze(normalizedRanges),
    });
}

export class MediaByteSourceRegistry {
    private readonly current = new Map<string, RegistryEntry>();
    private readonly retired = new Set<RegistryEntry>();
    private activeLeases = 0;
    private peakLeases = 0;
    private invalidations = 0;
    private closes = 0;
    private closed = false;

    async register(source: MediaByteSource): Promise<CoreMediaIdentity> {
        if (this.closed) throw new Error('The media byte source registry is closed.');
        const identity = freezeMediaIdentity(source.identity);
        const previous = this.current.get(source.sourceId);
        if (previous?.source === source) return previous.identity;
        if (previous?.identity.fingerprint === identity.fingerprint) {
            if (previous.identity.sizeBytes !== identity.sizeBytes) {
                await source.close();
                throw new MediaByteSourceError(
                    'SOURCE_CHANGED',
                    'A source reused immutableVersion with a different byte length.',
                );
            }
            await source.close();
            return previous.identity;
        }

        if (previous) {
            previous.invalidated = true;
            this.current.delete(source.sourceId);
            this.retired.add(previous);
            this.invalidations++;
            await this.closeIfUnused(previous);
        }
        this.current.set(source.sourceId, {
            source,
            sourceId: source.sourceId,
            identity,
            leases: 0,
            invalidated: false,
            closed: false,
            closing: null,
            closeWaiters: [],
        });
        return identity;
    }

    issueGrant(sourceId: string, ranges?: readonly MediaByteRange[]): MediaReadGrant {
        const entry = this.requireCurrent(sourceId);
        return normalizeGrant(entry.sourceId, entry.identity, ranges);
    }

    acquire(grant: MediaReadGrant): MediaByteSourceLease {
        const entry = this.requireCurrent(grant.sourceId);
        if (entry.identity.fingerprint !== grant.immutableVersion) {
            throw new MediaByteSourceError('GRANT_MISMATCH', 'The read grant targets a stale immutable version.');
        }
        const normalizedGrant = normalizeGrant(entry.sourceId, entry.identity, grant.ranges);
        entry.leases++;
        this.activeLeases++;
        this.peakLeases = Math.max(this.peakLeases, this.activeLeases);

        let released = false;
        const assertLeaseCurrent = () => {
            if (released) {
                throw new MediaByteSourceError('SOURCE_CLOSED', 'The media source lease is closed.');
            }
            if (entry.invalidated || this.current.get(entry.sourceId) !== entry) {
                throw new MediaByteSourceError('SOURCE_CHANGED', 'The media source lease was invalidated.');
            }
        };
        const assertGranted = (range: MediaByteRange) => {
            assertMediaRange(range, entry.identity.sizeBytes);
            if (!normalizedGrant.ranges.some(
                (allowed) => allowed.start <= range.start && range.endExclusive <= allowed.endExclusive,
            )) {
                throw new MediaByteSourceError('RANGE_NOT_GRANTED', 'The requested bytes are outside the read grant.');
            }
        };
        const lease: MediaByteSourceLease = {
            sourceId: entry.sourceId,
            identity: entry.identity,
            grant: normalizedGrant,
            async size() {
                assertLeaseCurrent();
                return entry.source.size();
            },
            async read(range, signal) {
                assertLeaseCurrent();
                assertGranted(range);
                return entry.source.read(range, signal);
            },
            stream(range, signal) {
                assertLeaseCurrent();
                const boundedRange = range ?? {
                    start: normalizedGrant.ranges[0]?.start ?? 0,
                    endExclusive: normalizedGrant.ranges[0]?.endExclusive ?? 0,
                };
                assertGranted(boundedRange);
                return createMediaByteStream(lease, boundedRange, signal);
            },
            verify: async (signal) => {
                assertLeaseCurrent();
                const verified = await entry.source.verify(signal);
                if (
                    verified.fingerprint !== entry.identity.fingerprint
                    || verified.sizeBytes !== entry.identity.sizeBytes
                ) {
                    entry.invalidated = true;
                    this.current.delete(entry.sourceId);
                    this.retired.add(entry);
                    this.invalidations++;
                    await this.closeIfUnused(entry);
                    throw new MediaByteSourceError('SOURCE_CHANGED', 'The leased source changed on verification.');
                }
                return entry.identity;
            },
            close: async () => {
                if (released) return;
                released = true;
                entry.leases--;
                this.activeLeases--;
                await this.closeIfUnused(entry);
            },
        };
        return lease;
    }

    snapshot(): MediaByteSourceRegistrySnapshot {
        return Object.freeze({
            registeredSources: this.current.size,
            retiredSources: this.retired.size,
            activeLeases: this.activeLeases,
            peakLeases: this.peakLeases,
            invalidations: this.invalidations,
            closes: this.closes,
        });
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const entries = [
            ...Array.from(this.current.values()),
            ...Array.from(this.retired),
        ];
        for (const entry of Array.from(this.current.values())) {
            entry.invalidated = true;
            this.retired.add(entry);
            this.closeIfUnused(entry);
        }
        this.current.clear();
        await Promise.all(entries.map((entry) => this.whenEntryClosed(entry)));
    }

    private requireCurrent(sourceId: string): RegistryEntry {
        if (this.closed) throw new Error('The media byte source registry is closed.');
        const entry = this.current.get(sourceId);
        if (!entry || entry.invalidated) {
            throw new MediaByteSourceError('SOURCE_NOT_FOUND', `No current source is registered as "${sourceId}".`);
        }
        return entry;
    }

    private closeIfUnused(entry: RegistryEntry): Promise<void> | null {
        if (!entry.invalidated || entry.leases > 0) return null;
        if (entry.closing) return entry.closing;
        entry.closed = true;
        this.retired.delete(entry);
        this.closes++;
        entry.closing = entry.source.close().finally(() => {
            for (const resolve of entry.closeWaiters.splice(0)) resolve();
        });
        return entry.closing;
    }

    private async whenEntryClosed(entry: RegistryEntry): Promise<void> {
        if (entry.closing) return entry.closing;
        await new Promise<void>((resolve) => entry.closeWaiters.push(resolve));
        await entry.closing;
    }
}
