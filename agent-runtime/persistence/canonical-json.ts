import { createHash, timingSafeEqual } from 'node:crypto';
import { managedError } from '../coordinator/errors';

export type CanonicalJson =
    | null
    | boolean
    | number
    | string
    | readonly CanonicalJson[]
    | { readonly [key: string]: CanonicalJson };

export function canonicalJson(value: unknown, maxBytes = 512 * 1024): string {
    const seen = new Set<object>();

    const visit = (candidate: unknown, path: string): string => {
        if (candidate === null) return 'null';
        if (typeof candidate === 'string') return JSON.stringify(candidate);
        if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
        if (typeof candidate === 'number') {
            if (!Number.isFinite(candidate)) {
                throw managedError('INVALID_REQUEST', `${path} must contain a finite number.`);
            }
            return Object.is(candidate, -0) ? '0' : JSON.stringify(candidate);
        }
        if (typeof candidate !== 'object') {
            throw managedError('INVALID_REQUEST', `${path} is not canonical JSON.`);
        }
        if (seen.has(candidate)) {
            throw managedError('INVALID_REQUEST', `${path} contains a cycle.`);
        }
        seen.add(candidate);
        try {
            if (Array.isArray(candidate)) {
                return `[${candidate.map((entry, index) => visit(entry, `${path}[${index}]`)).join(',')}]`;
            }
            const prototype = Object.getPrototypeOf(candidate);
            if (prototype !== Object.prototype && prototype !== null) {
                throw managedError('INVALID_REQUEST', `${path} contains a non-JSON object.`);
            }
            const record = candidate as Record<string, unknown>;
            const keys = Object.keys(record).sort();
            return `{${keys.map((key) => {
                if (record[key] === undefined) {
                    throw managedError('INVALID_REQUEST', `${path}.${key} is undefined.`);
                }
                return `${JSON.stringify(key)}:${visit(record[key], `${path}.${key}`)}`;
            }).join(',')}}`;
        } finally {
            seen.delete(candidate);
        }
    };

    const serialized = visit(value, '$');
    if (Buffer.byteLength(serialized) > maxBytes) {
        throw managedError('PAYLOAD_TOO_LARGE', 'The structured request exceeds the managed runtime limit.');
    }
    return serialized;
}

export function sha256(value: string | Uint8Array): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function canonicalDigest(value: unknown, maxBytes?: number): string {
    return sha256(canonicalJson(value, maxBytes));
}

export function constantTimeStringEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.byteLength === rightBytes.byteLength
        && timingSafeEqual(leftBytes, rightBytes);
}
