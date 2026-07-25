import type {
    EditorialDependentTargetV1,
    GlobalEditingMode,
    NarrativeBoundaryRefinementOriginV1,
    Sha256Digest,
} from '@/types/editorial';
import type { AnimationStyle } from '@/types/timeline';
import type {
    AudioClip,
    RenderProfile,
    VideoClipAudioSettings,
} from '@/types/video';
import { EditorCommandError } from './editor-command-errors';

export const EDITOR_ENGINE_API_VERSION = '2026-07-25' as const;
export const EDITOR_ENGINE_MAX_OPERATIONS = 256;
export const EDITOR_ENGINE_MAX_REQUEST_BYTES = 512 * 1024;
export const EDITOR_PLAN_TOOL_NAME = 'waptions_edit_plan' as const;
export const EDITOR_APPLY_TOOL_NAME = 'waptions_edit_apply' as const;
export const EDITOR_HISTORY_TOOL_NAME = 'waptions_history_apply' as const;
export const EDITOR_MEDIA_IMPORT_TOOL_NAME = 'waptions_media_import' as const;

export type EditorCommandToolName =
    | typeof EDITOR_PLAN_TOOL_NAME
    | typeof EDITOR_APPLY_TOOL_NAME;
export type EditorMutationToolName =
    | typeof EDITOR_APPLY_TOOL_NAME
    | typeof EDITOR_HISTORY_TOOL_NAME
    | typeof EDITOR_MEDIA_IMPORT_TOOL_NAME;

export interface EditorExpectedRevisions {
    sessionRevision: number;
    documentRevision: number;
    audioGraphRevision?: number;
    narrativeRevision?: number;
}

export interface EditorOperation<TType extends string, TPayload> {
    operationId: string;
    type: TType;
    payload: TPayload;
}

type TrackKind = 'video' | 'audio' | 'subtitle';
type OrderAnchor = { beforeId?: string; afterId?: string };

export interface SemanticSubtitleCue {
    id: string;
    startOutputSample: number;
    endOutputSample: number;
    text: string;
}

export type SemanticAudioSourceRange =
    | {
        domain: 'native-samples';
        audioSourceId: string;
        nativeSampleRateHz: number;
        startNativeSample: number;
        endNativeSample: number;
    }
    | {
        domain: 'seconds';
        videoSourceId: string;
        startSeconds: number;
        endSeconds: number;
    };

export type SemanticMarginBoundaryPolicy =
    | {
        kind: 'margin';
        mode: 'inherit-global';
        requestedSamples16k: null;
    }
    | {
        kind: 'margin';
        mode: 'explicit';
        requestedSamples16k: number;
    };

export type SemanticUnlinkedVideoEditPolicy =
    | 'preserve-absolute'
    | 'ripple-with-video-edit'
    | 'remove-with-deleted-video-range';

export type EditorSemanticOperation =
    | EditorOperation<'project.set-name', { name: string }>
    | EditorOperation<'render.set-profile', { profile: RenderProfile }>
    | EditorOperation<'render.set-background', { color: string }>
    | EditorOperation<'track.add', {
        trackKind: TrackKind;
        trackId?: string;
        name: string;
        beforeTrackId?: string;
    }>
    | EditorOperation<'track.rename', { trackKind: TrackKind; trackId: string; name: string }>
    | EditorOperation<'track.set-state', {
        trackKind: TrackKind;
        trackId: string;
        visible?: boolean;
        muted?: boolean;
        solo?: boolean;
        locked?: boolean;
    }>
    | EditorOperation<'audio-track.set-gain', { trackId: string; gainDb: number }>
    | EditorOperation<'subtitle-track.set-unlinked-video-policy', {
        trackId: string;
        policy: SemanticUnlinkedVideoEditPolicy;
    }>
    | EditorOperation<'track.reorder', { trackKind: TrackKind; trackId: string } & OrderAnchor>
    | EditorOperation<'track.reorder-clips', {
        trackKind: 'audio' | 'subtitle';
        trackId: string;
        clipId: string;
    } & OrderAnchor>
    | EditorOperation<'track.delete', {
        trackKind: TrackKind;
        trackId: string;
        policy: 'empty-only' | 'delete-contents' | 'rehome';
        rehomeTrackId?: string;
    }>
    | EditorOperation<'video-clip.insert', {
        clipId?: string;
        sourceId: string;
        trackId: string;
        timelineStartFrame: number;
        sourceStartSeconds: number;
        sourceEndSeconds: number;
        audio: VideoClipAudioSettings | null;
    }>
    | EditorOperation<'video-clip.move', {
        clipId: string;
        targetTrackId: string;
        timelineStartFrame: number;
    }>
    | EditorOperation<'video-clip.trim', {
        clipId: string;
        sourceStartSeconds: number;
        sourceEndSeconds: number;
        timelineStartFrame?: number;
    }>
    | EditorOperation<'video-clip.split', { clipId: string; atFrame: number; rightClipId?: string }>
    | EditorOperation<'video-clip.delete', { clipId: string }>
    | EditorOperation<'video-clip.duplicate', {
        clipId: string;
        duplicateId?: string;
        targetTrackId?: string;
        timelineStartFrame?: number;
    }>
    | EditorOperation<'video-clip.set-order', { clipId: string } & OrderAnchor>
    | EditorOperation<'video-clip.set-audio', { clipId: string; audio: VideoClipAudioSettings | null }>
    | EditorOperation<'video-clip.detach-audio', {
        clipId: string;
        audioTrackId: string;
        detachedClipId?: string;
    }>
    | EditorOperation<'video-clip.relink-audio', {
        videoClipId: string;
        audioTrackId: string;
        audioClipId: string;
    }>
    | EditorOperation<'audio-clip.insert', { trackId: string; clip: AudioClip }>
    | EditorOperation<'audio-clip.move', {
        clipId: string;
        targetTrackId: string;
        timelineStartFrame: number;
    }>
    | EditorOperation<'audio-clip.trim', { clipId: string; sourceRange: SemanticAudioSourceRange }>
    | EditorOperation<'audio-clip.split', { clipId: string; atOutputSample: number; rightClipId?: string }>
    | EditorOperation<'audio-clip.delete', { clipId: string }>
    | EditorOperation<'audio-clip.duplicate', {
        clipId: string;
        duplicateId?: string;
        targetTrackId?: string;
        timelineStartFrame?: number;
    }>
    | EditorOperation<'audio-clip.set-order', { trackId: string; clipId: string } & OrderAnchor>
    | EditorOperation<'audio-clip.set-gain', { clipId: string; gainDb: number }>
    | EditorOperation<'audio-clip.set-fades', {
        clipId: string;
        fadeInOutputSamples48k: number;
        fadeOutOutputSamples48k: number;
    }>
    | EditorOperation<'subtitle.insert', { trackId: string; subtitle: SemanticSubtitleCue }>
    | EditorOperation<'subtitle.update', {
        trackId: string;
        subtitleId: string;
        text: string;
    }>
    | EditorOperation<'subtitle.move', {
        trackId: string;
        subtitleId: string;
        startOutputSample: number;
    }>
    | EditorOperation<'subtitle.trim', {
        trackId: string;
        subtitleId: string;
        startOutputSample: number;
        endOutputSample: number;
    }>
    | EditorOperation<'subtitle.split', {
        trackId: string;
        subtitleId: string;
        atOutputSample: number;
        rightSubtitleId?: string;
    }>
    | EditorOperation<'subtitle.delete', { trackId: string; subtitleId: string }>
    | EditorOperation<'subtitle.set-order', { trackId: string; subtitleId: string } & OrderAnchor>
    | EditorOperation<'subtitle.bulk-replace', { trackId: string; subtitles: SemanticSubtitleCue[] }>
    | EditorOperation<'subtitle.set-track-style', { trackId: string; style: AnimationStyle }>
    | EditorOperation<'narrative.activate', {
        selectedTrackIds: string[];
        recordIdBySourceId: Record<string, Sha256Digest>;
        splitOnSpeakerChange?: boolean;
    }>
    | EditorOperation<'narrative.release-tracks', { trackIds: string[] }>
    | EditorOperation<'narrative.set-editing-mode', { mode: GlobalEditingMode }>
    | EditorOperation<'narrative.split-block', { blockId: string; splitSample16k: number }>
    | EditorOperation<'narrative.merge-blocks', { leftBlockId: string; rightBlockId: string }>
    | EditorOperation<'narrative.delete-words', {
        firstBlockId: string;
        firstWordId: string;
        lastBlockId: string;
        lastWordId: string;
        currentPlayheadFrame?: number;
    }>
    | EditorOperation<'narrative.delete-range', {
        start: { blockId: string; sample16k: number };
        end: { blockId: string; sample16k: number };
        currentPlayheadFrame?: number;
    }>
    | EditorOperation<'narrative.trim-block', {
        blockId: string;
        side: 'start' | 'end';
        sample16k: number;
    }>
    | EditorOperation<'narrative.reorder-blocks', {
        blockIds: string[];
        targetIndex?: number;
        targetStartFrame?: number;
    }>
    | EditorOperation<'narrative.insert-source-range' | 'narrative.recover-source-range', {
        recordId: Sha256Digest;
        sourceId: string;
        sourceRange: { startSample16k: number; endSample16k: number };
        destinationTrackId: string;
        targetIndex?: number;
        timelineStartFrame?: number;
        clipAudio: VideoClipAudioSettings | null;
    }>
    | EditorOperation<'narrative.extend-block', {
        blockId: string;
        newStartSample16k: number;
        newEndSample16k: number;
    }>
    | EditorOperation<'narrative.set-word-text', {
        blockId: string;
        wordId: string;
        text: string | null;
    }>
    | EditorOperation<'narrative.set-word-speaker', {
        blockId: string;
        wordId: string;
        speakerId: string | null;
    }>
    | EditorOperation<'narrative.set-speaker-visibility', { showSpeakers: boolean }>
    | EditorOperation<'narrative.change-block-margin', {
        blockId: string;
        side: 'pre' | 'post';
        policy: SemanticMarginBoundaryPolicy;
    }>
    | EditorOperation<'narrative.change-global-margins', {
        preSamples16k: number;
        postSamples16k: number;
    }>
    | EditorOperation<'narrative.refine-boundary', {
        blockId: string;
        side: 'start' | 'end';
        chosenSample16k: number;
        algorithmVersion: number;
        origin: NarrativeBoundaryRefinementOriginV1;
    }>
    | EditorOperation<'narrative.delete-all-silences', {
        scope?: { kind: 'document' } | { kind: 'track'; trackId: string };
        currentPlayheadFrame?: number;
    }>
    | EditorOperation<'link.discover-overlaps', Record<string, never>>
    | EditorOperation<'link.create-overlap', {
        target: EditorialDependentTargetV1;
        anchorBlockId: string;
        followPolicy?: 'none' | 'follow';
    }>
    | EditorOperation<'link.bind-target', {
        target: EditorialDependentTargetV1;
        anchorBlockId: string;
        activeStartSample16k: number;
        activeEndSample16k: number;
        followPolicy?: 'none' | 'follow';
    }>
    | EditorOperation<'link.unlink-target' | 'link.unbind-target', {
        target: EditorialDependentTargetV1;
    }>
    | EditorOperation<'link.reanchor', {
        target: EditorialDependentTargetV1;
        anchorBlockId: string;
    }>
    | EditorOperation<'link.set-follow-policy', {
        target: EditorialDependentTargetV1;
        followPolicy: 'none' | 'follow';
    }>;

export type EditorOperationType = EditorSemanticOperation['type'];

export interface EditorCommandBatchRequest {
    apiVersion: typeof EDITOR_ENGINE_API_VERSION;
    toolName: EditorCommandToolName;
    sessionEpoch: string;
    expected: EditorExpectedRevisions;
    idempotencyKey: string;
    operations?: EditorSemanticOperation[];
    planId?: string;
    history?: {
        label: string;
        category: string;
    };
}

const REQUEST_KEYS = new Set([
    'apiVersion',
    'toolName',
    'sessionEpoch',
    'expected',
    'idempotencyKey',
    'operations',
    'planId',
    'history',
]);
const EXPECTED_KEYS = new Set([
    'sessionRevision',
    'documentRevision',
    'audioGraphRevision',
    'narrativeRevision',
]);
const OPERATION_KEYS = new Set(['operationId', 'type', 'payload']);
const HISTORY_KEYS = new Set(['label', 'category']);

const PAYLOAD_KEYS: Readonly<Record<EditorOperationType, readonly string[]>> = {
    'project.set-name': ['name'],
    'render.set-profile': ['profile'],
    'render.set-background': ['color'],
    'track.add': ['trackKind', 'trackId', 'name', 'beforeTrackId'],
    'track.rename': ['trackKind', 'trackId', 'name'],
    'track.set-state': ['trackKind', 'trackId', 'visible', 'muted', 'solo', 'locked'],
    'audio-track.set-gain': ['trackId', 'gainDb'],
    'subtitle-track.set-unlinked-video-policy': ['trackId', 'policy'],
    'track.reorder': ['trackKind', 'trackId', 'beforeId', 'afterId'],
    'track.reorder-clips': ['trackKind', 'trackId', 'clipId', 'beforeId', 'afterId'],
    'track.delete': ['trackKind', 'trackId', 'policy', 'rehomeTrackId'],
    'video-clip.insert': [
        'clipId', 'sourceId', 'trackId', 'timelineStartFrame',
        'sourceStartSeconds', 'sourceEndSeconds', 'audio',
    ],
    'video-clip.move': ['clipId', 'targetTrackId', 'timelineStartFrame'],
    'video-clip.trim': ['clipId', 'sourceStartSeconds', 'sourceEndSeconds', 'timelineStartFrame'],
    'video-clip.split': ['clipId', 'atFrame', 'rightClipId'],
    'video-clip.delete': ['clipId'],
    'video-clip.duplicate': ['clipId', 'duplicateId', 'targetTrackId', 'timelineStartFrame'],
    'video-clip.set-order': ['clipId', 'beforeId', 'afterId'],
    'video-clip.set-audio': ['clipId', 'audio'],
    'video-clip.detach-audio': ['clipId', 'audioTrackId', 'detachedClipId'],
    'video-clip.relink-audio': ['videoClipId', 'audioTrackId', 'audioClipId'],
    'audio-clip.insert': ['trackId', 'clip'],
    'audio-clip.move': ['clipId', 'targetTrackId', 'timelineStartFrame'],
    'audio-clip.trim': ['clipId', 'sourceRange'],
    'audio-clip.split': ['clipId', 'atOutputSample', 'rightClipId'],
    'audio-clip.delete': ['clipId'],
    'audio-clip.duplicate': ['clipId', 'duplicateId', 'targetTrackId', 'timelineStartFrame'],
    'audio-clip.set-order': ['trackId', 'clipId', 'beforeId', 'afterId'],
    'audio-clip.set-gain': ['clipId', 'gainDb'],
    'audio-clip.set-fades': ['clipId', 'fadeInOutputSamples48k', 'fadeOutOutputSamples48k'],
    'subtitle.insert': ['trackId', 'subtitle'],
    'subtitle.update': ['trackId', 'subtitleId', 'text'],
    'subtitle.move': ['trackId', 'subtitleId', 'startOutputSample'],
    'subtitle.trim': ['trackId', 'subtitleId', 'startOutputSample', 'endOutputSample'],
    'subtitle.split': ['trackId', 'subtitleId', 'atOutputSample', 'rightSubtitleId'],
    'subtitle.delete': ['trackId', 'subtitleId'],
    'subtitle.set-order': ['trackId', 'subtitleId', 'beforeId', 'afterId'],
    'subtitle.bulk-replace': ['trackId', 'subtitles'],
    'subtitle.set-track-style': ['trackId', 'style'],
    'narrative.activate': ['selectedTrackIds', 'recordIdBySourceId', 'splitOnSpeakerChange'],
    'narrative.release-tracks': ['trackIds'],
    'narrative.set-editing-mode': ['mode'],
    'narrative.split-block': ['blockId', 'splitSample16k'],
    'narrative.merge-blocks': ['leftBlockId', 'rightBlockId'],
    'narrative.delete-words': ['firstBlockId', 'firstWordId', 'lastBlockId', 'lastWordId', 'currentPlayheadFrame'],
    'narrative.delete-range': ['start', 'end', 'currentPlayheadFrame'],
    'narrative.trim-block': ['blockId', 'side', 'sample16k'],
    'narrative.reorder-blocks': ['blockIds', 'targetIndex', 'targetStartFrame'],
    'narrative.insert-source-range': [
        'recordId', 'sourceId', 'sourceRange', 'destinationTrackId', 'targetIndex',
        'timelineStartFrame', 'clipAudio',
    ],
    'narrative.recover-source-range': [
        'recordId', 'sourceId', 'sourceRange', 'destinationTrackId', 'targetIndex',
        'timelineStartFrame', 'clipAudio',
    ],
    'narrative.extend-block': ['blockId', 'newStartSample16k', 'newEndSample16k'],
    'narrative.set-word-text': ['blockId', 'wordId', 'text'],
    'narrative.set-word-speaker': ['blockId', 'wordId', 'speakerId'],
    'narrative.set-speaker-visibility': ['showSpeakers'],
    'narrative.change-block-margin': ['blockId', 'side', 'policy'],
    'narrative.change-global-margins': ['preSamples16k', 'postSamples16k'],
    'narrative.refine-boundary': ['blockId', 'side', 'chosenSample16k', 'algorithmVersion', 'origin'],
    'narrative.delete-all-silences': ['scope', 'currentPlayheadFrame'],
    'link.discover-overlaps': [],
    'link.create-overlap': ['target', 'anchorBlockId', 'followPolicy'],
    'link.bind-target': [
        'target', 'anchorBlockId', 'activeStartSample16k', 'activeEndSample16k', 'followPolicy',
    ],
    'link.unlink-target': ['target'],
    'link.unbind-target': ['target'],
    'link.reanchor': ['target', 'anchorBlockId'],
    'link.set-follow-policy': ['target', 'followPolicy'],
};

const OPTIONAL_PAYLOAD_KEYS: Partial<Readonly<Record<EditorOperationType, readonly string[]>>> = {
    'track.add': ['trackId', 'beforeTrackId'],
    'track.set-state': ['visible', 'muted', 'solo', 'locked'],
    'track.reorder': ['beforeId', 'afterId'],
    'track.reorder-clips': ['beforeId', 'afterId'],
    'track.delete': ['rehomeTrackId'],
    'video-clip.insert': ['clipId'],
    'video-clip.trim': ['timelineStartFrame'],
    'video-clip.split': ['rightClipId'],
    'video-clip.duplicate': ['duplicateId', 'targetTrackId', 'timelineStartFrame'],
    'video-clip.set-order': ['beforeId', 'afterId'],
    'video-clip.detach-audio': ['detachedClipId'],
    'audio-clip.split': ['rightClipId'],
    'audio-clip.duplicate': ['duplicateId', 'targetTrackId', 'timelineStartFrame'],
    'audio-clip.set-order': ['beforeId', 'afterId'],
    'subtitle.split': ['rightSubtitleId'],
    'subtitle.set-order': ['beforeId', 'afterId'],
    'narrative.activate': ['splitOnSpeakerChange'],
    'narrative.delete-words': ['currentPlayheadFrame'],
    'narrative.delete-range': ['currentPlayheadFrame'],
    'narrative.reorder-blocks': ['targetIndex', 'targetStartFrame'],
    'narrative.insert-source-range': ['targetIndex', 'timelineStartFrame'],
    'narrative.recover-source-range': ['targetIndex', 'timelineStartFrame'],
    'narrative.delete-all-silences': ['scope', 'currentPlayheadFrame'],
    'link.create-overlap': ['followPolicy'],
    'link.bind-target': ['followPolicy'],
};

export const EDITOR_OPERATION_TYPES = Object.freeze(
    Object.keys(PAYLOAD_KEYS) as EditorOperationType[],
);

export function parseEditorCommandBatchRequest(value: unknown): EditorCommandBatchRequest {
    const encodedLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (encodedLength > EDITOR_ENGINE_MAX_REQUEST_BYTES) {
        throw new EditorCommandError('PAYLOAD_TOO_LARGE', 'Editor command request exceeds 512 KiB.');
    }
    const request = requireRecord(value, 'Editor command request');
    rejectUnknownKeys(request, REQUEST_KEYS, 'Editor command request');
    if (request.apiVersion !== EDITOR_ENGINE_API_VERSION) {
        throw new EditorCommandError('UNSUPPORTED_API_VERSION', 'Unsupported editor engine API version.');
    }
    requireNonEmptyString(request.toolName, 'toolName');
    requireNonEmptyString(request.sessionEpoch, 'sessionEpoch');
    requireNonEmptyString(request.idempotencyKey, 'idempotencyKey');
    const expected = requireRecord(request.expected, 'expected revisions');
    rejectUnknownKeys(expected, EXPECTED_KEYS, 'expected revisions');
    requireRevision(expected.sessionRevision, 'sessionRevision');
    requireRevision(expected.documentRevision, 'documentRevision');
    if (expected.audioGraphRevision !== undefined) {
        requireRevision(expected.audioGraphRevision, 'audioGraphRevision');
    }
    if (expected.narrativeRevision !== undefined) {
        requireRevision(expected.narrativeRevision, 'narrativeRevision');
    }
    const rawOperations = request.operations;
    const hasOperations = Array.isArray(rawOperations);
    const hasPlanId = request.planId !== undefined;
    if (hasOperations === hasPlanId) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            'Editor commands require exactly one of operations or planId.',
        );
    }
    if (hasPlanId) requireNonEmptyString(request.planId, 'planId');
    if (hasOperations && (rawOperations.length === 0
        || rawOperations.length > EDITOR_ENGINE_MAX_OPERATIONS)) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `Editor commands require between 1 and ${EDITOR_ENGINE_MAX_OPERATIONS} operations.`,
        );
    }
    const seen = new Set<string>();
    (hasOperations ? rawOperations : []).forEach((rawOperation: unknown, index: number) => {
        const operation = requireRecord(rawOperation, `operation ${index}`);
        rejectUnknownKeys(operation, OPERATION_KEYS, `operation ${index}`);
        const operationId = requireNonEmptyString(operation.operationId, `operations[${index}].operationId`);
        if (seen.has(operationId)) {
            throw new EditorCommandError('INVALID_REQUEST', 'Operation IDs must be unique.');
        }
        seen.add(operationId);
        const type = requireNonEmptyString(operation.type, `operations[${index}].type`);
        if (!Object.prototype.hasOwnProperty.call(PAYLOAD_KEYS, type)) {
            throw new EditorCommandError('INVALID_OPERATION', `Unknown editor operation "${type}".`, {
                details: { operationId },
            });
        }
        const payload = requireRecord(operation.payload, `operations[${index}].payload`);
        rejectUnknownKeys(
            payload,
            new Set(PAYLOAD_KEYS[type as EditorOperationType]),
            `operations[${index}].payload`,
        );
        const operationType = type as EditorOperationType;
        const optional = new Set(OPTIONAL_PAYLOAD_KEYS[operationType] ?? []);
        const missing = PAYLOAD_KEYS[operationType].find(
            (key) => !optional.has(key) && !Object.prototype.hasOwnProperty.call(payload, key),
        );
        if (missing) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                `operations[${index}].payload requires field "${missing}".`,
            );
        }
        validateTimeDomainPayload(operationType, payload, index);
    });
    if (request.history !== undefined) {
        const history = requireRecord(request.history, 'history');
        rejectUnknownKeys(history, HISTORY_KEYS, 'history');
        requireNonEmptyString(history.label, 'history.label');
        requireNonEmptyString(history.category, 'history.category');
    }
    return structuredClone(request) as unknown as EditorCommandBatchRequest;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new EditorCommandError('INVALID_REQUEST', `${label} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function rejectUnknownKeys(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    label: string,
): void {
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `${label} contains unsupported field "${unknown[0]}".`,
        );
    }
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
        throw new EditorCommandError('INVALID_REQUEST', `${label} must be a bounded non-empty string.`);
    }
    return value;
}

function requireRevision(value: unknown, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new EditorCommandError('INVALID_REQUEST', `${label} must be a non-negative safe integer.`);
    }
}

function requireNonNegativeInteger(value: unknown, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new EditorCommandError('INVALID_REQUEST', `${label} must be a non-negative safe integer.`);
    }
}

function validateTimeDomainPayload(
    type: EditorOperationType,
    payload: Record<string, unknown>,
    index: number,
): void {
    const label = `operations[${index}].payload`;
    if (type === 'project.set-name') {
        requireNonEmptyString(payload.name, `${label}.name`);
        return;
    }
    if (type === 'render.set-background') {
        if (typeof payload.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(payload.color)) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                `${label}.color must be a six-digit hexadecimal color.`,
            );
        }
        return;
    }
    if (type === 'subtitle-track.set-unlinked-video-policy') {
        if (payload.policy !== 'preserve-absolute'
            && payload.policy !== 'ripple-with-video-edit'
            && payload.policy !== 'remove-with-deleted-video-range') {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                `${label}.policy must be a supported unlinked-video policy.`,
            );
        }
        return;
    }
    if (type === 'video-clip.insert' || type === 'video-clip.trim') {
        requireFiniteNonNegative(payload.sourceStartSeconds, `${label}.sourceStartSeconds`);
        requireFiniteNonNegative(payload.sourceEndSeconds, `${label}.sourceEndSeconds`);
        if ((payload.sourceEndSeconds as number) <= (payload.sourceStartSeconds as number)) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                `${label} must have increasing source-second bounds.`,
            );
        }
    }
    if (type === 'audio-clip.trim') {
        const range = requireRecord(payload.sourceRange, `${label}.sourceRange`);
        if (range.domain === 'native-samples') {
            rejectUnknownKeys(range, new Set([
                'domain',
                'audioSourceId',
                'nativeSampleRateHz',
                'startNativeSample',
                'endNativeSample',
            ]), `${label}.sourceRange`);
            requireNonEmptyString(range.audioSourceId, `${label}.sourceRange.audioSourceId`);
            requireNonNegativeInteger(range.nativeSampleRateHz, `${label}.sourceRange.nativeSampleRateHz`);
            requireNonNegativeInteger(range.startNativeSample, `${label}.sourceRange.startNativeSample`);
            requireNonNegativeInteger(range.endNativeSample, `${label}.sourceRange.endNativeSample`);
            if ((range.nativeSampleRateHz as number) === 0
                || (range.endNativeSample as number) <= (range.startNativeSample as number)) {
                throw new EditorCommandError(
                    'INVALID_REQUEST',
                    `${label}.sourceRange must have a positive rate and increasing native-sample bounds.`,
                );
            }
            return;
        }
        if (range.domain === 'seconds') {
            rejectUnknownKeys(range, new Set([
                'domain',
                'videoSourceId',
                'startSeconds',
                'endSeconds',
            ]), `${label}.sourceRange`);
            requireNonEmptyString(range.videoSourceId, `${label}.sourceRange.videoSourceId`);
            requireFiniteNonNegative(range.startSeconds, `${label}.sourceRange.startSeconds`);
            requireFiniteNonNegative(range.endSeconds, `${label}.sourceRange.endSeconds`);
            if ((range.endSeconds as number) <= (range.startSeconds as number)) {
                throw new EditorCommandError(
                    'INVALID_REQUEST',
                    `${label}.sourceRange must have increasing second bounds.`,
                );
            }
            return;
        }
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `${label}.sourceRange requires an explicit native-samples or seconds domain.`,
        );
    }
    if (type === 'audio-clip.set-fades') {
        requireNonNegativeInteger(payload.fadeInOutputSamples48k, `${label}.fadeInOutputSamples48k`);
        requireNonNegativeInteger(payload.fadeOutOutputSamples48k, `${label}.fadeOutOutputSamples48k`);
        return;
    }
    if (type === 'subtitle.insert') {
        validateSemanticSubtitle(payload.subtitle, `${label}.subtitle`);
        return;
    }
    if (type === 'subtitle.bulk-replace') {
        if (!Array.isArray(payload.subtitles)) {
            throw new EditorCommandError('INVALID_REQUEST', `${label}.subtitles must be an array.`);
        }
        payload.subtitles.forEach((subtitle, subtitleIndex) => {
            validateSemanticSubtitle(subtitle, `${label}.subtitles[${subtitleIndex}]`);
        });
        return;
    }
    const outputSampleFields: Partial<Record<EditorOperationType, readonly string[]>> = {
        'subtitle.move': ['startOutputSample'],
        'subtitle.trim': ['startOutputSample', 'endOutputSample'],
        'subtitle.split': ['atOutputSample'],
        'audio-clip.split': ['atOutputSample'],
        'link.bind-target': ['activeStartSample16k', 'activeEndSample16k'],
    };
    const sample16kFields: Partial<Record<EditorOperationType, readonly string[]>> = {
        'narrative.split-block': ['splitSample16k'],
        'narrative.extend-block': ['newStartSample16k', 'newEndSample16k'],
        'narrative.change-global-margins': ['preSamples16k', 'postSamples16k'],
        'narrative.refine-boundary': ['chosenSample16k'],
        'narrative.trim-block': ['sample16k'],
    };
    [...(outputSampleFields[type] ?? []), ...(sample16kFields[type] ?? [])]
        .forEach((field) => requireNonNegativeInteger(payload[field], `${label}.${field}`));
    if (type === 'subtitle.trim'
        && (payload.endOutputSample as number) <= (payload.startOutputSample as number)) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `${label} must have increasing output-sample bounds.`,
        );
    }
    if (type === 'link.bind-target'
        && (payload.activeEndSample16k as number) <= (payload.activeStartSample16k as number)) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `${label} must have increasing active 16 kHz sample bounds.`,
        );
    }
    if (type === 'narrative.extend-block'
        && (payload.newEndSample16k as number) <= (payload.newStartSample16k as number)) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `${label} must have increasing 16 kHz sample bounds.`,
        );
    }
    if (type === 'narrative.delete-range') {
        validateNarrativePoint(payload.start, `${label}.start`);
        validateNarrativePoint(payload.end, `${label}.end`);
    } else if (type === 'narrative.insert-source-range'
        || type === 'narrative.recover-source-range') {
        const range = requireRecord(payload.sourceRange, `${label}.sourceRange`);
        rejectUnknownKeys(
            range,
            new Set(['startSample16k', 'endSample16k']),
            `${label}.sourceRange`,
        );
        requireNonNegativeInteger(range.startSample16k, `${label}.sourceRange.startSample16k`);
        requireNonNegativeInteger(range.endSample16k, `${label}.sourceRange.endSample16k`);
        if ((range.endSample16k as number) <= (range.startSample16k as number)) {
            throw new EditorCommandError(
                'INVALID_REQUEST',
                `${label}.sourceRange must have increasing 16 kHz sample bounds.`,
            );
        }
    } else if (type === 'narrative.change-block-margin') {
        const policy = requireRecord(payload.policy, `${label}.policy`);
        rejectUnknownKeys(
            policy,
            new Set(['kind', 'mode', 'requestedSamples16k']),
            `${label}.policy`,
        );
        if (policy.kind !== 'margin'
            || (policy.mode !== 'inherit-global' && policy.mode !== 'explicit')) {
            throw new EditorCommandError('INVALID_REQUEST', `${label}.policy is invalid.`);
        }
        if (policy.mode === 'inherit-global') {
            if (policy.requestedSamples16k !== null) {
                throw new EditorCommandError(
                    'INVALID_REQUEST',
                    `${label}.policy.requestedSamples16k must be null when inheriting.`,
                );
            }
        } else {
            requireNonNegativeInteger(
                policy.requestedSamples16k,
                `${label}.policy.requestedSamples16k`,
            );
        }
    }
}

function validateSemanticSubtitle(value: unknown, label: string): void {
    const subtitle = requireRecord(value, label);
    rejectUnknownKeys(
        subtitle,
        new Set(['id', 'startOutputSample', 'endOutputSample', 'text']),
        label,
    );
    requireNonEmptyString(subtitle.id, `${label}.id`);
    if (typeof subtitle.text !== 'string') {
        throw new EditorCommandError('INVALID_REQUEST', `${label}.text must be a string.`);
    }
    requireNonNegativeInteger(subtitle.startOutputSample, `${label}.startOutputSample`);
    requireNonNegativeInteger(subtitle.endOutputSample, `${label}.endOutputSample`);
    if ((subtitle.endOutputSample as number) <= (subtitle.startOutputSample as number)) {
        throw new EditorCommandError(
            'INVALID_REQUEST',
            `${label} must have increasing output-sample bounds.`,
        );
    }
}

function validateNarrativePoint(value: unknown, label: string): void {
    const point = requireRecord(value, label);
    rejectUnknownKeys(point, new Set(['blockId', 'sample16k']), label);
    requireNonEmptyString(point.blockId, `${label}.blockId`);
    requireNonNegativeInteger(point.sample16k, `${label}.sample16k`);
}

function requireFiniteNonNegative(value: unknown, label: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new EditorCommandError('INVALID_REQUEST', `${label} must be a finite non-negative number.`);
    }
}
