/** A canonical non-empty half-open integer interval. */
export interface HalfOpenInterval {
    start: number;
    end: number;
}

export interface ActivationIntervalCandidate extends HalfOpenInterval {
    id: string;
    trackId: string;
    /** Stable top-to-bottom order used only after overlap exclusion succeeds. */
    trackOrder: number;
}

export interface ExistingControlledInterval extends HalfOpenInterval {
    id: string;
}

export interface ActivationIntervalExclusion {
    candidateId: string;
    trackId: string;
    interval: HalfOpenInterval;
    /** Every other node in the overlap-connected component, in stable ID order. */
    conflictingIds: string[];
}

export interface ActivationIntervalClassification {
    accepted: ActivationIntervalCandidate[];
    excluded: ActivationIntervalExclusion[];
}

export interface TrackIntervalItem extends HalfOpenInterval {
    id: string;
    trackId: string;
}

export type OrdinaryIntervalAction =
    | { kind: 'delete'; itemId: string }
    | { kind: 'resize'; itemId: string; start: number; end: number }
    | { kind: 'move'; itemId: string; targetTrackId: string; targetStart: number };

export type OrdinaryIntervalPlanResult =
    | {
        kind: 'success';
        before: TrackIntervalItem[];
        after: TrackIntervalItem[];
        /** Per-item project-time translation, including zero for a pure resize. */
        translations: Readonly<Record<string, number>>;
    }
    | {
        kind: 'error';
        code: 'invalid-interval' | 'missing-item' | 'locked-track' | 'collision';
        itemIds: string[];
    };

/** Rejects negative, fractional, empty, or unsafe interval boundaries. */
export function isValidHalfOpenInterval(interval: HalfOpenInterval): boolean {
    return Number.isSafeInteger(interval.start)
        && interval.start >= 0
        && Number.isSafeInteger(interval.end)
        && interval.end > interval.start;
}

/** Half-open overlap deliberately treats adjacent intervals as non-overlapping. */
export function intervalsOverlap(left: HalfOpenInterval, right: HalfOpenInterval): boolean {
    return left.start < right.end && right.start < left.end;
}

export function intervalIntersection(
    left: HalfOpenInterval,
    right: HalfOpenInterval,
): HalfOpenInterval | null {
    const start = Math.max(left.start, right.start);
    const end = Math.min(left.end, right.end);
    return start < end ? { start, end } : null;
}

export function intervalOverlapLength(left: HalfOpenInterval, right: HalfOpenInterval): number {
    const intersection = intervalIntersection(left, right);
    return intersection ? intersection.end - intersection.start : 0;
}

/**
 * Subtracts already-normalized removals without merging or deduplicating caller identities.
 *
 * The output describes only geometric coverage. Occurrence IDs belong to the narrative layer and
 * must be allocated independently even when two retained ranges happen to be equal.
 */
export function subtractHalfOpenIntervals(
    interval: HalfOpenInterval,
    removals: readonly HalfOpenInterval[],
): HalfOpenInterval[] {
    if (!isValidHalfOpenInterval(interval)
        || removals.some(removal => !isValidHalfOpenInterval(removal))) {
        throw new RangeError('Interval subtraction requires safe non-empty half-open intervals.');
    }
    const clipped = removals
        .map(removal => intervalIntersection(interval, removal))
        .filter((value): value is HalfOpenInterval => value !== null)
        .sort(compareIntervals);
    const result: HalfOpenInterval[] = [];
    let cursor = interval.start;
    for (const removal of clipped) {
        if (removal.start > cursor) result.push({ start: cursor, end: removal.start });
        cursor = Math.max(cursor, removal.end);
        if (cursor >= interval.end) break;
    }
    if (cursor < interval.end) result.push({ start: cursor, end: interval.end });
    return result;
}

/**
 * Applies the frozen activation rule: any new candidate that participates in an overlap-connected
 * component is excluded. Existing controlled intervals are immutable component nodes, so a
 * transitive candidate chain cannot bypass a controlled occurrence merely because its last member
 * does not overlap that occurrence directly.
 */
export function classifyActivationIntervals(
    candidates: readonly ActivationIntervalCandidate[],
    existingControlled: readonly ExistingControlledInterval[],
): ActivationIntervalClassification {
    assertUniqueValidNodes(candidates, existingControlled);
    const nodes = [
        ...candidates.map(candidate => ({ ...candidate, candidate: true as const })),
        ...existingControlled.map(interval => ({ ...interval, candidate: false as const })),
    ];
    const adjacency = nodes.map(() => [] as number[]);
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
            if (!intervalsOverlap(nodes[leftIndex], nodes[rightIndex])) continue;
            adjacency[leftIndex].push(rightIndex);
            adjacency[rightIndex].push(leftIndex);
        }
    }

    const excludedById = new Map<string, ActivationIntervalExclusion>();
    const visited = new Set<number>();
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        if (visited.has(nodeIndex)) continue;
        const component: number[] = [];
        const pending = [nodeIndex];
        visited.add(nodeIndex);
        while (pending.length > 0) {
            const current = pending.pop()!;
            component.push(current);
            for (const neighbor of adjacency[current]) {
                if (visited.has(neighbor)) continue;
                visited.add(neighbor);
                pending.push(neighbor);
            }
        }
        // A singleton has no overlap edge. Every larger component contains at least one edge and
        // therefore excludes all of its new candidates, not an arbitrarily selected winner.
        if (component.length === 1) continue;
        const componentIds = component.map(index => nodes[index].id).sort(compareIds);
        for (const index of component) {
            const node = nodes[index];
            if (!node.candidate) continue;
            excludedById.set(node.id, {
                candidateId: node.id,
                trackId: node.trackId,
                interval: { start: node.start, end: node.end },
                conflictingIds: componentIds.filter(id => id !== node.id),
            });
        }
    }

    const accepted = candidates
        .filter(candidate => !excludedById.has(candidate.id))
        .map(candidate => ({ ...candidate }))
        .sort((left, right) => left.start - right.start
            || left.end - right.end
            || left.trackOrder - right.trackOrder
            || compareIds(left.id, right.id));
    const excluded = candidates
        .filter(candidate => excludedById.has(candidate.id))
        .map(candidate => excludedById.get(candidate.id)!)
        .sort((left, right) => left.interval.start - right.interval.start
            || left.interval.end - right.interval.end
            || compareIds(left.candidateId, right.candidateId));
    return { accepted, excluded };
}

/**
 * Plans the mode matrix shared by ordinary video, audio, and subtitle adapters.
 *
 * Ripple is intentionally track-local: a delete or resize shifts only later items on that track,
 * while a cross-track move closes only the source track and opens only the destination track.
 * Controlled narrative commands use a separate global planner because they are the deliberate
 * cross-track exception.
 */
export function planOrdinaryTrackIntervals(input: {
    mode: 'ripple' | 'absolute';
    items: readonly TrackIntervalItem[];
    action: OrdinaryIntervalAction;
    lockedTrackIds?: readonly string[];
    /** Subtitle adapters opt into overlap; video and audio leave this empty. */
    overlapAllowedTrackIds?: readonly string[];
}): OrdinaryIntervalPlanResult {
    if (input.items.some(item => !isValidHalfOpenInterval(item))) {
        return { kind: 'error', code: 'invalid-interval', itemIds: [] };
    }
    const ids = new Set<string>();
    for (const item of input.items) {
        if (ids.has(item.id)) return { kind: 'error', code: 'invalid-interval', itemIds: [item.id] };
        ids.add(item.id);
    }
    const selected = input.items.find(item => item.id === input.action.itemId);
    if (!selected) return { kind: 'error', code: 'missing-item', itemIds: [input.action.itemId] };
    const locked = new Set(input.lockedTrackIds ?? []);
    const requiredTracks = input.action.kind === 'move'
        ? new Set([selected.trackId, input.action.targetTrackId])
        : new Set([selected.trackId]);
    const lockedRequired = Array.from(requiredTracks).filter(trackId => locked.has(trackId));
    if (lockedRequired.length > 0) {
        return { kind: 'error', code: 'locked-track', itemIds: lockedRequired.sort(compareIds) };
    }

    const before = input.items.map(item => ({ ...item }));
    let after = input.items.map(item => ({ ...item }));
    try {
        if (input.action.kind === 'delete') {
            const duration = selected.end - selected.start;
            after = after.filter(item => item.id !== selected.id);
            if (input.mode === 'ripple') {
                after = after.map(item => item.trackId === selected.trackId && item.start >= selected.end
                    ? translateInterval(item, -duration)
                    : item);
            }
        } else if (input.action.kind === 'resize') {
            const action = input.action;
            if (!isValidHalfOpenInterval(action)) {
                return { kind: 'error', code: 'invalid-interval', itemIds: [selected.id] };
            }
            const oldDuration = selected.end - selected.start;
            const newDuration = action.end - action.start;
            after = after.map(item => item.id === selected.id
                ? { ...item, start: action.start, end: action.end }
                : input.mode === 'ripple'
                    && item.trackId === selected.trackId
                    && item.start >= selected.end
                    ? translateInterval(item, newDuration - oldDuration)
                    : item);
        } else {
            const action = input.action;
            if (!Number.isSafeInteger(action.targetStart) || action.targetStart < 0) {
                return { kind: 'error', code: 'invalid-interval', itemIds: [selected.id] };
            }
            const duration = selected.end - selected.start;
            after = after.filter(item => item.id !== selected.id);
            if (input.mode === 'ripple') {
                after = after.map(item => item.trackId === selected.trackId && item.start >= selected.end
                    ? translateInterval(item, -duration)
                    : item);
                after = after.map(item => item.trackId === action.targetTrackId
                    && item.start >= action.targetStart
                    ? translateInterval(item, duration)
                    : item);
            }
            after.push({
                ...selected,
                trackId: action.targetTrackId,
                start: action.targetStart,
                end: action.targetStart + duration,
            });
        }
    } catch {
        return { kind: 'error', code: 'invalid-interval', itemIds: [selected.id] };
    }
    const invalidIntervals = after.filter(item => !isValidHalfOpenInterval(item)).map(item => item.id);
    if (invalidIntervals.length > 0) {
        return { kind: 'error', code: 'invalid-interval', itemIds: invalidIntervals.sort(compareIds) };
    }

    const invalid = findTrackCollisions(after, new Set(input.overlapAllowedTrackIds ?? []));
    if (invalid.length > 0) return { kind: 'error', code: 'collision', itemIds: invalid };
    after.sort(compareTrackIntervals);
    const beforeById = new Map(before.map(item => [item.id, item]));
    const translations = Object.fromEntries(after.map(item => [
        item.id,
        item.start - (beforeById.get(item.id)?.start ?? item.start),
    ]));
    return { kind: 'success', before, after, translations };
}

export function findTrackCollisions(
    items: readonly TrackIntervalItem[],
    overlapAllowedTrackIds: ReadonlySet<string> = new Set(),
): string[] {
    const byTrack = new Map<string, TrackIntervalItem[]>();
    for (const item of items) {
        const list = byTrack.get(item.trackId) ?? [];
        list.push(item);
        byTrack.set(item.trackId, list);
    }
    const collisions = new Set<string>();
    byTrack.forEach((trackItems, trackId) => {
        if (overlapAllowedTrackIds.has(trackId)) return;
        trackItems.sort(compareIntervals);
        for (let index = 1; index < trackItems.length; index += 1) {
            if (!intervalsOverlap(trackItems[index - 1], trackItems[index])) continue;
            collisions.add(trackItems[index - 1].id);
            collisions.add(trackItems[index].id);
        }
    });
    return Array.from(collisions).sort(compareIds);
}

function assertUniqueValidNodes(
    candidates: readonly ActivationIntervalCandidate[],
    existing: readonly ExistingControlledInterval[],
): void {
    const ids = new Set<string>();
    for (const node of [...candidates, ...existing]) {
        if (!node.id || ids.has(node.id) || !isValidHalfOpenInterval(node)) {
            throw new RangeError('Activation intervals require unique IDs and safe non-empty ranges.');
        }
        ids.add(node.id);
    }
    for (const candidate of candidates) {
        if (!candidate.trackId || !Number.isSafeInteger(candidate.trackOrder) || candidate.trackOrder < 0) {
            throw new RangeError('Activation candidates require a track and stable track order.');
        }
    }
}

function translateInterval<T extends TrackIntervalItem>(item: T, delta: number): T {
    const start = item.start + delta;
    const end = item.end + delta;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end)) {
        throw new RangeError('Translated interval exceeds the safe project-time domain.');
    }
    return { ...item, start, end };
}

function compareIntervals(left: HalfOpenInterval, right: HalfOpenInterval): number {
    return left.start - right.start || left.end - right.end;
}

function compareTrackIntervals(left: TrackIntervalItem, right: TrackIntervalItem): number {
    return compareIds(left.trackId, right.trackId)
        || compareIntervals(left, right)
        || compareIds(left.id, right.id);
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
