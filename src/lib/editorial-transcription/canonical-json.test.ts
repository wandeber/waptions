import { describe, expect, it } from 'vitest';
import {
    canonicalizeJson,
    canonicalizeJsonBytes,
    sha256CanonicalJson,
} from './canonical-json';

describe('RFC 8785-compatible editorial canonical JSON', () => {
    it('sorts object keys recursively while preserving semantic array order', () => {
        expect(canonicalizeJson({ z: 1, a: [{ b: 2, a: 1 }, 'kept'] })).toBe(
            '{"a":[{"a":1,"b":2},"kept"],"z":1}',
        );
    });

    it('uses ECMAScript canonical string and number rendering', () => {
        expect(canonicalizeJson({ negativeZero: -0, escaped: '\n\u000f\\"' })).toBe(
            '{"escaped":"\\n\\u000f\\\\\\\"","negativeZero":0}',
        );
        expect(new TextDecoder().decode(canonicalizeJsonBytes(['€', 1e-7]))).toBe(
            '["€",1e-7]',
        );
    });

    it('rejects values JSON.stringify would silently erase or coerce', () => {
        expect(() => canonicalizeJson({ value: undefined })).toThrow('unsupported JSON value');
        expect(() => canonicalizeJson([, 1])).toThrow('sparse array');
        expect(() => canonicalizeJson(Number.NaN)).toThrow('finite JSON number');
        expect(() => canonicalizeJson(Number.MAX_SAFE_INTEGER + 1)).toThrow('unsafe integer');
        expect(() => canonicalizeJson(new Date())).toThrow('plain JSON object');
        expect(() => canonicalizeJson('\ud800')).toThrow('unpaired UTF-16 surrogate');

        const extended = [1] as number[] & { apiKey?: string };
        extended.apiKey = 'sentinel-secret';
        expect(() => canonicalizeJson(extended)).toThrow('non-JSON array property');

        const accessor: unknown[] = [];
        Object.defineProperty(accessor, '0', { enumerable: true, get: () => 1 });
        expect(() => canonicalizeJson(accessor)).toThrow('non-JSON array property');
    });

    it('produces stable SHA-256 content addresses', async () => {
        await expect(sha256CanonicalJson({ b: 2, a: 1 })).resolves.toBe(
            'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
        );
    });
});
