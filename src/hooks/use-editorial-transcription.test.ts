import {
    createElement,
    createRef,
    forwardRef,
    useImperativeHandle,
} from 'react';
import {
    act,
    create,
    type ReactTestRenderer,
} from 'react-test-renderer';
import { beforeAll, describe, expect, it } from 'vitest';
import { useEditorialTranscription } from './use-editorial-transcription';

type EditorialTranscriptionSession = ReturnType<typeof useEditorialTranscription>;

const SessionConsumer = forwardRef<EditorialTranscriptionSession>(function SessionConsumer(_, ref) {
    const session = useEditorialTranscription();
    useImperativeHandle(ref, () => session, [session]);
    return null;
});

beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

describe('useEditorialTranscription Text consumer lifecycle', () => {
    it('keeps the API key in the mounted session and aborts its active operation on unmount', async () => {
        const ref = createRef<EditorialTranscriptionSession>();
        let renderer!: ReactTestRenderer;
        await act(async () => {
            renderer = create(createElement(SessionConsumer, { ref }));
        });
        act(() => ref.current!.setApiKey(' session-only-key '));

        let capturedApiKey: string | undefined;
        let capturedSignal!: AbortSignal;
        let runPromise!: Promise<string>;
        act(() => {
            runPromise = ref.current!.run(({ apiKey, signal }) => {
                capturedApiKey = apiKey;
                capturedSignal = signal;
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(new DOMException('Unmounted Text setup.', 'AbortError'));
                    }, { once: true });
                });
            });
        });

        expect(capturedApiKey).toBe('session-only-key');
        expect(capturedSignal.aborted).toBe(false);
        expect(ref.current?.state.running).toBe(true);

        act(() => renderer.unmount());
        expect(capturedSignal.aborted).toBe(true);
        await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });

        const remountedRef = createRef<EditorialTranscriptionSession>();
        await act(async () => {
            renderer = create(createElement(SessionConsumer, { ref: remountedRef }));
        });
        let remountedApiKey = 'not-observed';
        await act(async () => {
            await remountedRef.current!.run(async ({ apiKey }) => {
                remountedApiKey = apiKey ?? '';
                return 'done';
            });
        });
        expect(remountedApiKey).toBe('');
        act(() => renderer.unmount());
    });

    it('reports an explicit user cancellation without retaining the operation', async () => {
        const ref = createRef<EditorialTranscriptionSession>();
        let renderer!: ReactTestRenderer;
        await act(async () => {
            renderer = create(createElement(SessionConsumer, { ref }));
        });
        let runPromise!: Promise<void>;
        act(() => {
            runPromise = ref.current!.run(({ signal }) => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    reject(new DOMException('Cancelled.', 'AbortError'));
                }, { once: true });
            }));
        });

        act(() => ref.current!.cancel());
        await act(async () => {
            await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
        });
        expect(ref.current?.state).toEqual({
            running: false,
            error: 'cancelled',
        });
        act(() => renderer.unmount());
    });
});
