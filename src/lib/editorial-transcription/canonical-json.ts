import type { Sha256Digest } from '@/types/editorial';

const SHA256_PREFIX = 'sha256:';

/**
 * JSON values accepted by the editorial content-addressing boundary.
 *
 * RFC 8785 delegates string and finite-number rendering to ECMAScript's JSON serialization,
 * while requiring recursively sorted object properties. Editorial records additionally reject
 * unsafe integers so a value cannot have already lost precision before it reaches the canonical
 * encoder. Undefined values, sparse arrays, custom prototypes and `toJSON` hooks are rejected
 * instead of being silently dropped or rewritten by JSON.stringify.
 */
export type CanonicalJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly CanonicalJsonValue[]
    | { readonly [key: string]: CanonicalJsonValue };

export class CanonicalJsonError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CanonicalJsonError';
    }
}

export function canonicalizeJson(value: unknown): string {
    return serializeCanonicalValue(value, '$', new Set<object>());
}

export function canonicalizeJsonBytes(value: unknown): Uint8Array {
    return new TextEncoder().encode(canonicalizeJson(value));
}

export async function sha256Bytes(value: BufferSource): Promise<Sha256Digest> {
    if (!globalThis.crypto?.subtle) {
        throw new Error('Web Crypto SHA-256 is unavailable.');
    }

    const bytes = value instanceof ArrayBuffer
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `${SHA256_PREFIX}${Array.from(new Uint8Array(digest), byte => (
        byte.toString(16).padStart(2, '0')
    )).join('')}` as Sha256Digest;
}

export async function sha256Utf8(value: string): Promise<Sha256Digest> {
    return sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256CanonicalJson(value: unknown): Promise<Sha256Digest> {
    return sha256Bytes(canonicalizeJsonBytes(value));
}

function serializeCanonicalValue(
    value: unknown,
    path: string,
    ancestors: Set<object>,
): string {
    if (value === null) return 'null';

    switch (typeof value) {
        case 'boolean':
            return value ? 'true' : 'false';
        case 'string':
            assertUnicodeScalarString(value, path);
            return JSON.stringify(value);
        case 'number':
            if (!Number.isFinite(value)) {
                throw new CanonicalJsonError(`${path} must be a finite JSON number.`);
            }
            if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
                throw new CanonicalJsonError(`${path} must not contain an unsafe integer.`);
            }
            // JSON.stringify follows ECMAScript NumberToString, including canonical -0 => 0.
            return JSON.stringify(value);
        case 'object':
            return serializeCanonicalContainer(value, path, ancestors);
        default:
            throw new CanonicalJsonError(`${path} contains an unsupported JSON value.`);
    }
}

function serializeCanonicalContainer(
    value: object,
    path: string,
    ancestors: Set<object>,
): string {
    if (ancestors.has(value)) {
        throw new CanonicalJsonError(`${path} contains a cyclic reference.`);
    }
    ancestors.add(value);

    try {
        if (Array.isArray(value)) {
            if (Object.getOwnPropertySymbols(value).length > 0) {
                throw new CanonicalJsonError(`${path} must not contain symbol properties.`);
            }
            const descriptors = Object.getOwnPropertyDescriptors(value);
            for (const [key, descriptor] of Object.entries(descriptors)) {
                if (key === 'length') continue;
                const index = Number(key);
                if (!Number.isSafeInteger(index)
                    || index < 0
                    || index >= value.length
                    || String(index) !== key
                    || !descriptor.enumerable
                    || descriptor.get
                    || descriptor.set) {
                    throw new CanonicalJsonError(`${path} contains a non-JSON array property.`);
                }
            }
            const serialized: string[] = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) {
                    throw new CanonicalJsonError(`${path}[${index}] is a sparse array entry.`);
                }
                serialized.push(serializeCanonicalValue(value[index], `${path}[${index}]`, ancestors));
            }
            return `[${serialized.join(',')}]`;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new CanonicalJsonError(`${path} must be a plain JSON object.`);
        }
        if ('toJSON' in value) {
            throw new CanonicalJsonError(`${path} must not define a toJSON hook.`);
        }

        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new CanonicalJsonError(`${path} must not contain symbol properties.`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (!descriptor.enumerable || descriptor.get || descriptor.set) {
                throw new CanonicalJsonError(`${path}.${key} must be an enumerable data property.`);
            }
        }

        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);
        keys.forEach(key => assertUnicodeScalarString(key, `${path} property name`));
        const serialized = keys
            // RFC 8785 sorts property names by raw UTF-16 code units. JavaScript's default string
            // sort has exactly that ordering and must not be replaced with localeCompare.
            .sort()
            .map((key) => `${JSON.stringify(key)}:${serializeCanonicalValue(
                record[key],
                `${path}.${key}`,
                ancestors,
            )}`);
        return `{${serialized.join(',')}}`;
    } finally {
        ancestors.delete(value);
    }
}

function assertUnicodeScalarString(value: string, path: string): void {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const following = value.charCodeAt(index + 1);
            if (!(following >= 0xdc00 && following <= 0xdfff)) {
                throw new CanonicalJsonError(`${path} contains an unpaired UTF-16 surrogate.`);
            }
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw new CanonicalJsonError(`${path} contains an unpaired UTF-16 surrogate.`);
        }
    }
}
