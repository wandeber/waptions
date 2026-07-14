/** A keyed path segment keeps patches stable when sibling array items are reordered. */
export type SerializablePatchPathSegment = string | number | { id: string };

export type SerializablePatch =
    | { op: 'set'; path: SerializablePatchPathSegment[]; value: unknown }
    | { op: 'remove'; path: SerializablePatchPathSegment[] }
    | {
        op: 'splice';
        path: SerializablePatchPathSegment[];
        index: number;
        deleteCount: number;
        items: unknown[];
    };

export interface SerializablePatchPair {
    patches: SerializablePatch[];
    inversePatches: SerializablePatch[];
}

const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'length']);

/**
 * Produces forward and inverse patches without mutating either input.
 *
 * Arrays whose members have stable `id` fields are traversed through keyed path segments when
 * their membership and order stay unchanged. Structural changes use one middle splice, which is
 * both compact and deterministic. Every value stored in a patch is cloned so later edits cannot
 * mutate history through a shared object reference.
 */
export function createSerializablePatches(
    before: unknown,
    after: unknown,
    allowedRoots: ReadonlySet<string>,
): SerializablePatchPair {
    const patches: SerializablePatch[] = [];
    const inversePatches: SerializablePatch[] = [];
    diffValue(before, after, [], patches, inversePatches);
    patches.forEach((patch) => validatePatch(patch, allowedRoots, false));
    inversePatches.forEach((patch) => validatePatch(patch, allowedRoots, false));
    return { patches, inversePatches };
}

/** Applies a patch list with copy-on-write cloning along only the paths that are touched. */
export function applySerializablePatches<T>(
    value: T,
    patches: readonly SerializablePatch[],
    allowedRoots: ReadonlySet<string>,
): T {
    return patches.reduce<T>((current, patch) => {
        validatePatch(patch, allowedRoots, false);
        return applyOne(current, patch) as T;
    }, value);
}

/**
 * Estimates retained history bytes without requiring JSON-compatible values.
 *
 * JSON gives a stable, cheap estimate for the editor's normal plain-data graph. The guarded
 * structured fallback handles valid values such as `undefined` without making history recording
 * fail merely because the estimator cannot stringify them.
 */
export function estimateSerializableBytes(value: unknown): number {
    try {
        const serialized = JSON.stringify(value);
        if (serialized !== undefined) return serialized.length * 2;
    } catch {
        // Fall through to the cycle-safe structured estimate below.
    }
    return estimateStructuredBytes(value, new WeakSet<object>());
}

export function validateSerializablePatches(
    patches: readonly SerializablePatch[],
    allowedRoots: ReadonlySet<string>,
): void {
    patches.forEach((patch) => validatePatch(patch, allowedRoots));
}

function diffValue(
    before: unknown,
    after: unknown,
    path: SerializablePatchPathSegment[],
    patches: SerializablePatch[],
    inversePatches: SerializablePatch[],
): void {
    if (Object.is(before, after)) return;

    if (Array.isArray(before) && Array.isArray(after)) {
        diffArray(before, after, path, patches, inversePatches);
        return;
    }
    if (isPlainObject(before) && isPlainObject(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        Array.from(keys).sort().forEach((key) => {
            assertSafeKey(key);
            const hadBefore = Object.prototype.hasOwnProperty.call(before, key);
            const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
            const childPath = [...path, key];
            if (!hasAfter) {
                patches.push({ op: 'remove', path: childPath });
                inversePatches.unshift({ op: 'set', path: childPath, value: clonePatchValue(before[key]) });
            } else if (!hadBefore) {
                patches.push({ op: 'set', path: childPath, value: clonePatchValue(after[key]) });
                inversePatches.unshift({ op: 'remove', path: childPath });
            } else {
                diffValue(before[key], after[key], childPath, patches, inversePatches);
            }
        });
        return;
    }

    patches.push({ op: 'set', path, value: clonePatchValue(after) });
    inversePatches.unshift({ op: 'set', path, value: clonePatchValue(before) });
}

function diffArray(
    before: unknown[],
    after: unknown[],
    path: SerializablePatchPathSegment[],
    patches: SerializablePatch[],
    inversePatches: SerializablePatch[],
): void {
    const beforeIds = getUniqueIds(before);
    const afterIds = getUniqueIds(after);
    if (beforeIds && afterIds && arraysEqual(beforeIds, afterIds)) {
        beforeIds.forEach((id, index) => {
            diffValue(before[index], after[index], [...path, { id }], patches, inversePatches);
        });
        return;
    }

    if (!beforeIds || !afterIds) {
        if (before.length !== after.length) {
            createArraySplice(before, after, path, patches, inversePatches);
            return;
        }
        before.forEach((item, index) => {
            diffValue(item, after[index], [...path, index], patches, inversePatches);
        });
        return;
    }

    // Keyed arrays use one structural splice whenever membership or order changes, including a
    // same-length reorder. Emitting one scalar patch per index would clone the complete array for
    // every application and can turn a normal reorder into quadratic Undo/Redo work.
    createArraySplice(before, after, path, patches, inversePatches);
}

function createArraySplice(
    before: unknown[],
    after: unknown[],
    path: SerializablePatchPathSegment[],
    patches: SerializablePatch[],
    inversePatches: SerializablePatch[],
): void {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && deepEqual(before[prefix], after[prefix])) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < before.length - prefix
        && suffix < after.length - prefix
        && deepEqual(before[before.length - 1 - suffix], after[after.length - 1 - suffix])
    ) suffix += 1;

    const removed = before.slice(prefix, before.length - suffix);
    const inserted = after.slice(prefix, after.length - suffix);
    patches.push({
        op: 'splice',
        path,
        index: prefix,
        deleteCount: removed.length,
        items: clonePatchValue(inserted) as unknown[],
    });
    inversePatches.unshift({
        op: 'splice',
        path,
        index: prefix,
        deleteCount: inserted.length,
        items: clonePatchValue(removed) as unknown[],
    });
}

function applyOne(root: unknown, patch: SerializablePatch): unknown {
    if (patch.path.length === 0) {
        if (patch.op === 'set') return clonePatchValue(patch.value);
        if (patch.op === 'splice') {
            if (!Array.isArray(root)) throw new Error('A root splice requires an array target.');
            const clone = [...root];
            clone.splice(patch.index, patch.deleteCount, ...clonePatchValue(patch.items) as unknown[]);
            return clone;
        }
        throw new Error('The history root cannot be removed.');
    }

    const applyAt = (current: unknown, depth: number): unknown => {
        const segment = patch.path[depth];
        const isLeaf = depth === patch.path.length - 1;
        const container = cloneContainer(current);
        const key = resolvePathKey(container, segment);

        if (isLeaf) {
            if (patch.op === 'set') setChild(container, key, clonePatchValue(patch.value));
            else if (patch.op === 'remove') removeChild(container, key);
            else {
                const target = getChild(container, key);
                if (!Array.isArray(target)) throw new Error('A history splice requires an array target.');
                const clone = [...target];
                clone.splice(patch.index, patch.deleteCount, ...clonePatchValue(patch.items) as unknown[]);
                setChild(container, key, clone);
            }
            return container;
        }

        setChild(container, key, applyAt(getChild(container, key), depth + 1));
        return container;
    };
    return applyAt(root, 0);
}

function validatePatch(
    patch: SerializablePatch,
    allowedRoots: ReadonlySet<string>,
    validateValue = true,
): void {
    if (patch.op !== 'set' && patch.op !== 'remove' && patch.op !== 'splice') {
        throw new Error('Unknown history patch operation.');
    }
    if (!Array.isArray(patch.path) || patch.path.length === 0) {
        throw new Error('History patches must target an allowlisted projection root.');
    }
    const root = patch.path[0];
    if (typeof root !== 'string' || !allowedRoots.has(root)) {
        throw new Error(`History patch root "${String(root)}" is not allowed.`);
    }
    patch.path.forEach((segment) => {
        if (typeof segment === 'string') assertSafeKey(segment);
        else if (typeof segment === 'number') {
            if (!Number.isSafeInteger(segment) || segment < 0) throw new Error('Invalid history array index.');
        } else if (
            !segment
            || typeof segment !== 'object'
            || typeof segment.id !== 'string'
            || segment.id.length === 0
        ) throw new Error('Invalid keyed history path segment.');
    });
    if (patch.op === 'splice') {
        if (!Number.isSafeInteger(patch.index) || patch.index < 0
            || !Number.isSafeInteger(patch.deleteCount) || patch.deleteCount < 0
            || !Array.isArray(patch.items)) throw new Error('Invalid history splice.');
        if (validateValue) assertStructuredCloneable(patch.items);
    } else if (patch.op === 'set' && validateValue) {
        assertStructuredCloneable(patch.value);
    }
}

function assertStructuredCloneable(value: unknown): void {
    try {
        if (typeof structuredClone === 'function') structuredClone(value);
        else clonePatchValue(value);
    } catch {
        throw new Error('History patch values must be structured-cloneable.');
    }
}

function assertSafeKey(key: string): void {
    if (FORBIDDEN_PATH_KEYS.has(key)) throw new Error(`Unsafe history path segment "${key}".`);
}

function resolvePathKey(container: unknown, segment: SerializablePatchPathSegment): string | number {
    if (typeof segment !== 'object') {
        // Arrays may only be traversed by a numeric index or a stable keyed segment. Allowing
        // arbitrary property names here would let persisted data mutate internals such as length.
        if (Array.isArray(container) && typeof segment === 'string') {
            throw new Error('History arrays cannot be traversed with string path segments.');
        }
        return segment;
    }
    if (!Array.isArray(container)) throw new Error('A keyed history segment requires an array.');
    const index = container.findIndex((item) => isPlainObject(item) && item.id === segment.id);
    if (index < 0) throw new Error(`History item "${segment.id}" no longer exists.`);
    return index;
}

function cloneContainer(value: unknown): Record<string, unknown> | unknown[] {
    if (Array.isArray(value)) return [...value];
    if (isPlainObject(value)) return { ...value };
    throw new Error('History patch traversed a non-container value.');
}

function getChild(container: Record<string, unknown> | unknown[], key: string | number): unknown {
    return (container as Record<string | number, unknown>)[key];
}

function setChild(container: Record<string, unknown> | unknown[], key: string | number, value: unknown): void {
    (container as Record<string | number, unknown>)[key] = value;
}

function removeChild(container: Record<string, unknown> | unknown[], key: string | number): void {
    if (Array.isArray(container) && typeof key === 'number') container.splice(key, 1);
    else delete (container as Record<string | number, unknown>)[key];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function getUniqueIds(value: unknown[]): string[] | null {
    const ids = value.map((item) => isPlainObject(item) && typeof item.id === 'string' ? item.id : null);
    if (ids.some((id) => id === null)) return null;
    const concrete = ids as string[];
    return new Set(concrete).size === concrete.length ? concrete : null;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

function deepEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
    }
    if (isPlainObject(left) && isPlainObject(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        return leftKeys.length === rightKeys.length
            && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
                && deepEqual(left[key], right[key]));
    }
    return false;
}

function clonePatchValue<T>(value: T): T {
    if (typeof structuredClone === 'function') return structuredClone(value);
    if (Array.isArray(value)) return value.map((item) => clonePatchValue(item)) as T;
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePatchValue(item)])) as T;
    }
    return value;
}

function estimateStructuredBytes(value: unknown, seen: WeakSet<object>): number {
    if (value === null || value === undefined) return 4;
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number' || typeof value === 'bigint') return 8;
    if (typeof value === 'boolean') return 4;
    if (typeof value !== 'object') return 16;
    if (seen.has(value)) return 8;
    seen.add(value);
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof Blob) return value.size;
    if (value instanceof Date) return 16;
    if (Array.isArray(value)) {
        return 16 + value.reduce((sum, item) => sum + estimateStructuredBytes(item, seen), 0);
    }
    return 24 + Object.entries(value).reduce((sum, [key, item]) => (
        sum + key.length * 2 + estimateStructuredBytes(item, seen)
    ), 0);
}
