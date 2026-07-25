import { Agent } from 'undici';
import { MediaBudgetManager, type MediaBudgetLease } from '../../../src/lib/media-byte-source/budget-manager';
import {
    createServerTranscriptionTransport,
    type ServerTranscriptionTransport,
} from '../../../src/lib/ai/openai-compatible-transcription-server';
import { parseEditMaxEditorialTranscript } from '../../../src/lib/editorial-transcription/edit-max-parser';
import {
    EDITORIAL_TRANSCRIPTION_MODEL,
    EditorialTranscriptionResponseTooLargeError,
    buildEditorialTranscriptionProviderMultipart,
    classifyEditorialTranscriptionProviderStatus,
} from '../../../src/lib/editorial-transcription/request';
import {
    EDITORIAL_PROVIDER_BODY_TIMEOUT_MS,
    EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS,
    EditorialProviderTimeoutError,
    requestEditorialTranscriptionProvider,
} from '../../../src/lib/editorial-transcription/server-provider-transport';
import type {
    ManagedProviderRequest,
    ManagedProviderTranscript,
    ManagedTranscriptionProviderPort,
    ResolvedManagedEndpointCapability,
} from './contracts';
import {
    ManagedTranscriptionError,
    throwIfManagedTranscriptionAborted,
} from './errors';
import { MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES } from './streaming-pcm-window-decoder';

// A deliberately conservative admission factor covers response bytes, UTF-16 decoding,
// JSON object overhead, the canonical parser body and the final bounded chunk projection.
const RESPONSE_ACCOUNTING_FACTOR = 32;
const MANAGED_PROVIDER_RESPONSE_HARD_MAX_BYTES = 256 * 1024;
const MIN_PROVIDER_RESPONSE_BYTES = 64 * 1024;

type ProviderFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ManagedTranscriptionProviderOptions {
    readonly memoryBudget?: MediaBudgetManager;
    /** Test-only seam. Production must retain the policy-owned Undici dispatcher. */
    readonly fetchImpl?: ProviderFetch;
}

/**
 * Managed provider adapter with status-only failures and an aggregate 8 MiB memory budget.
 *
 * The response reservation covers the streamed bytes, UTF-8 string, parsed object and one-window
 * canonical parser output. It is released as soon as the bounded chunk projection is complete.
 */
export class ManagedTranscriptionProvider implements ManagedTranscriptionProviderPort {
    readonly memoryBudget: MediaBudgetManager;
    private readonly fetchImpl?: ProviderFetch;

    constructor(options: ManagedTranscriptionProviderOptions = {}) {
        this.memoryBudget = options.memoryBudget ?? new MediaBudgetManager(
            'managed-transcription-total-bytes',
            MANAGED_TRANSCRIPTION_MEMORY_MAX_BYTES,
        );
        this.fetchImpl = options.fetchImpl;
    }

    async transcribe(request: ManagedProviderRequest): Promise<ManagedProviderTranscript> {
        throwIfManagedTranscriptionAborted(request.signal);
        const expectedBytes = 44
            + (request.window.decoded.endSample - request.window.decoded.startSample) * 2;
        if (!request.wav || request.wav.size !== expectedBytes) {
            throw new ManagedTranscriptionError(
                'INVALID_INPUT',
                false,
                'The managed transcription WAV does not match its window.',
            );
        }
        const available = this.memoryBudget.maxBytes - this.memoryBudget.snapshot().currentBytes;
        const responseMaxBytes = Math.min(
            MANAGED_PROVIDER_RESPONSE_HARD_MAX_BYTES,
            Math.floor(available / RESPONSE_ACCOUNTING_FACTOR),
        );
        if (responseMaxBytes < MIN_PROVIDER_RESPONSE_BYTES) {
            throw new ManagedTranscriptionError(
                'MEMORY_LIMIT_EXCEEDED',
                false,
                'The managed transcription memory budget cannot admit a provider response.',
            );
        }
        const responseReservation = await this.memoryBudget.reserve(
            responseMaxBytes * RESPONSE_ACCOUNTING_FACTOR,
            { label: 'managed-transcription-provider-response', signal: request.signal },
        );
        let responseLease: MediaBudgetLease | null = null;
        let responseOwnershipTransferred = false;
        let transport: ServerTranscriptionTransport | null = null;
        try {
            transport = await this.createTransport(request.endpoint);
            const form = buildEditorialTranscriptionProviderMultipart({
                wav: request.wav,
                language: request.language,
                speakerMode: request.speakerMode,
            });
            const headers = new Headers();
            const secret = request.credential?.secret.trim();
            if (secret) headers.set('Authorization', `Bearer ${secret}`);
            const result = await requestEditorialTranscriptionProvider({
                endpoint: request.endpoint.endpoint,
                body: form,
                headers,
                signal: request.signal,
                responseMaxBytes,
                fetchImpl: transport.fetch,
            });
            throwIfManagedTranscriptionAborted(request.signal);
            if (result.kind === 'rejected') {
                const classification = classifyEditorialTranscriptionProviderStatus(result.status);
                throw new ManagedTranscriptionError(
                    'PROVIDER_REJECTED',
                    classification === 'provider-rate-limited'
                        || classification === 'provider-unavailable',
                    'The managed transcription provider rejected the request.',
                );
            }
            responseLease = responseReservation.commit(
                Math.min(
                    responseMaxBytes * RESPONSE_ACCOUNTING_FACTOR,
                    Math.max(result.bytes.byteLength * RESPONSE_ACCOUNTING_FACTOR, 1),
                ),
            );
            let providerValue: unknown;
            try {
                providerValue = JSON.parse(new TextDecoder().decode(result.bytes));
            } catch {
                throw new ManagedTranscriptionError(
                    'PROVIDER_REJECTED',
                    false,
                    'The managed transcription provider returned invalid JSON.',
                );
            }
            const parsed = await parseEditMaxEditorialTranscript(providerValue, {
                sourceFingerprint: request.sourceFingerprint,
                sampleCount: request.window.decoded.endSample
                    - request.window.decoded.startSample,
                language: request.language,
                speakerMode: request.speakerMode,
            });
            throwIfManagedTranscriptionAborted(request.signal);
            const speakerLabels = new Map(
                parsed.body.speakers.map(speaker => [speaker.id, speaker.label]),
            );
            let released = false;
            const projected: ManagedProviderTranscript = {
                canonicalModel: parsed.body.canonicalModel,
                words: parsed.body.words.map(word => ({
                    text: word.text,
                    startSample: word.alignedStartSample,
                    endSample: word.alignedEndSample,
                    probability: word.probability,
                    speaker: word.speakerId === null ? null : {
                        providerSpeakerId: requireSpeakerLabel(
                            speakerLabels,
                            word.speakerId,
                        ),
                        // Provider labels are request-local. Overlap evidence in the streaming
                        // merger is the only authority allowed to alias them across windows.
                        evidenceKey: `${request.window.windowId}:${
                            requireSpeakerLabel(speakerLabels, word.speakerId)
                        }`,
                    },
                })),
                release: () => {
                    if (released) return;
                    released = true;
                    responseLease?.release();
                    responseLease = null;
                },
            };
            responseOwnershipTransferred = true;
            return projected;
        } catch (error) {
            if (request.signal.aborted) {
                throw new DOMException('Managed transcription was cancelled.', 'AbortError');
            }
            if (error instanceof ManagedTranscriptionError) throw error;
            if (error instanceof EditorialProviderTimeoutError) {
                throw new ManagedTranscriptionError(
                    'PROVIDER_TIMEOUT',
                    true,
                    'The managed transcription provider timed out.',
                );
            }
            if (error instanceof EditorialTranscriptionResponseTooLargeError) {
                throw new ManagedTranscriptionError(
                    'PROVIDER_RESPONSE_TOO_LARGE',
                    false,
                    'The managed transcription provider response exceeded its bound.',
                );
            }
            // No provider-controlled exception detail or URL crosses this boundary.
            throw new ManagedTranscriptionError(
                'PROVIDER_UNREACHABLE',
                true,
                'The managed transcription provider is unreachable.',
            );
        } finally {
            if (!responseOwnershipTransferred) responseLease?.release();
            responseReservation.release();
            await transport?.dispose().catch(() => undefined);
        }
    }

    private async createTransport(
        endpoint: ResolvedManagedEndpointCapability,
    ): Promise<ServerTranscriptionTransport> {
        if (endpoint.kind === 'server') {
            return createServerTranscriptionTransport(
                endpoint.endpoint,
                this.fetchImpl as typeof fetch | undefined,
            );
        }
        if (this.fetchImpl) {
            return {
                fetch: this.fetchImpl as typeof fetch,
                dispose: async () => undefined,
            };
        }
        if (!endpoint.pinnedLoopbackAddress || !endpoint.pinnedLoopbackFamily) {
            throw new ManagedTranscriptionError(
                'ENDPOINT_POLICY_REJECTED',
                false,
                'The local endpoint capability has no pinned loopback address.',
            );
        }
        const agent = new Agent({
            headersTimeout: EDITORIAL_PROVIDER_HEADERS_TIMEOUT_MS,
            bodyTimeout: EDITORIAL_PROVIDER_BODY_TIMEOUT_MS,
            connect: {
                lookup: (
                    hostname: string,
                    _options: unknown,
                    callback: (error: Error | null, address: string, family: number) => void,
                ) => {
                    if (hostname !== 'localhost') {
                        callback(new Error('Managed local endpoint host drifted.'), '', 0);
                        return;
                    }
                    callback(
                        null,
                        endpoint.pinnedLoopbackAddress as string,
                        endpoint.pinnedLoopbackFamily as number,
                    );
                },
            },
        });
        return {
            fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, {
                ...init,
                dispatcher: agent,
                redirect: 'error',
            } as RequestInit)) as typeof fetch,
            dispose: async () => { await agent.close(); },
        };
    }
}

function requireSpeakerLabel(
    labels: ReadonlyMap<string, string>,
    speakerId: string,
): string {
    const label = labels.get(speakerId);
    if (!label) {
        throw new ManagedTranscriptionError(
            'PROVIDER_REJECTED',
            false,
            'The managed provider omitted diarization provenance.',
        );
    }
    return label;
}

export { EDITORIAL_TRANSCRIPTION_MODEL };
