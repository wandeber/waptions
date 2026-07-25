'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorialSessionApiKey } from '@/lib/editorial-transcription/preferences';

export interface UseEditorialTranscriptionState {
    running: boolean;
    error: 'cancelled' | 'stale' | 'failed' | null;
}

export interface EditorialTranscriptionSessionContext {
    apiKey?: string;
    signal: AbortSignal;
}

/**
 * Session-only lifecycle adapter for the production Text setup consumer.
 *
 * The timeline store remains the acquisition/publication authority. This hook only owns the
 * mounted form's credential and cancellation lifetime, so neither value enters React state,
 * project history, persisted preferences, or diagnostics.
 */
export function useEditorialTranscription() {
    const credentialRef = useRef<EditorialSessionApiKey | null>(null);
    if (!credentialRef.current) credentialRef.current = new EditorialSessionApiKey();
    const activeControllerRef = useRef<AbortController | null>(null);
    const operationGenerationRef = useRef(0);
    const [state, setState] = useState<UseEditorialTranscriptionState>({
        running: false,
        error: null,
    });
    const [hasApiKey, setHasApiKey] = useState(false);

    const cancel = useCallback(() => {
        activeControllerRef.current?.abort();
    }, []);

    useEffect(() => () => {
        activeControllerRef.current?.abort();
        activeControllerRef.current = null;
        operationGenerationRef.current += 1;
        credentialRef.current?.dispose();
    }, []);

    const setApiKey = useCallback((apiKey: string) => {
        credentialRef.current?.set(apiKey);
        setHasApiKey(credentialRef.current?.hasValue() ?? false);
    }, []);
    const clearApiKey = useCallback(() => {
        credentialRef.current?.clear();
        setHasApiKey(false);
    }, []);

    const run = useCallback(async <Result,>(
        operation: (context: EditorialTranscriptionSessionContext) => Promise<Result>,
    ): Promise<Result> => {
        activeControllerRef.current?.abort();
        const controller = new AbortController();
        activeControllerRef.current = controller;
        const operationGeneration = ++operationGenerationRef.current;
        setState({ running: true, error: null });
        try {
            const result = await operation({
                apiKey: credentialRef.current?.get(),
                signal: controller.signal,
            });
            if (operationGeneration === operationGenerationRef.current) {
                setState({ running: false, error: null });
            }
            return result;
        } catch (error) {
            if (operationGeneration === operationGenerationRef.current) {
                const aborted = error instanceof DOMException && error.name === 'AbortError';
                setState({
                    running: false,
                    error: aborted
                        ? (controller.signal.aborted ? 'cancelled' : 'stale')
                        : 'failed',
                });
            }
            throw error;
        } finally {
            if (activeControllerRef.current === controller) activeControllerRef.current = null;
        }
    }, []);

    return {
        state,
        run,
        cancel,
        setApiKey,
        clearApiKey,
        hasApiKey,
    };
}
