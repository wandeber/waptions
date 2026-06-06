import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthEnabled, shouldShowPaidTranscriptionModels } from './feature-flags';

describe('feature flags', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('keeps auth and paid transcription models disabled by default', () => {
        expect(isAuthEnabled()).toBe(false);
        expect(shouldShowPaidTranscriptionModels()).toBe(false);
    });

    it('enables auth from either server or public environment flag', () => {
        vi.stubEnv('AUTH_ENABLED', 'true');
        expect(isAuthEnabled()).toBe(true);

        vi.unstubAllEnvs();
        vi.stubEnv('NEXT_PUBLIC_AUTH_ENABLED', '1');
        expect(isAuthEnabled()).toBe(true);
    });

    it('enables paid transcription models from either server or public environment flag', () => {
        vi.stubEnv('SHOW_PAID_TRANSCRIPTION_MODELS', 'yes');
        expect(shouldShowPaidTranscriptionModels()).toBe(true);

        vi.unstubAllEnvs();
        vi.stubEnv('NEXT_PUBLIC_SHOW_PAID_TRANSCRIPTION_MODELS', 'on');
        expect(shouldShowPaidTranscriptionModels()).toBe(true);
    });
});
