import {
    EDITOR_OPERATION_TYPES,
    type EditorOperationType,
    type EditorSemanticOperation,
} from '@/lib/editor-engine/editor-command';
import type { EditorDocumentV4 } from '@/types/video';
import type { GlobalEditingMode } from '@/types/editorial';
import type {
    TimelineEditorialLinkCommand,
    TimelineNarrativeCommand,
    TimelineOrdinaryCommand,
    TimelineV4CommandResult,
} from './timeline-v4-command-types';
import type { TimelineOrdinaryPlanSuccess } from './timeline-ordinary-v4-command-adapter';

export type StandaloneOperationCompatibility =
    | 'supported'
    | 'stable-noop'
    | 'typed-coordinator-boundary';

/**
 * Compile-time complete compatibility audit for Core's frozen semantic vocabulary.
 *
 * Coordinator boundaries are deliberately not emulated with generic patches. Their setup data
 * must enter a future typed engine transaction before an active engine can publish it.
 */
export const STANDALONE_EDITOR_OPERATION_COMPATIBILITY = Object.freeze({
    'project.set-name': 'supported',
    'render.set-profile': 'supported',
    'render.set-background': 'supported',
    'track.add': 'supported',
    'track.rename': 'supported',
    'track.set-state': 'supported',
    'audio-track.set-gain': 'supported',
    'subtitle-track.set-unlinked-video-policy': 'supported',
    'track.reorder': 'supported',
    'track.reorder-clips': 'supported',
    'track.delete': 'supported',
    'video-clip.insert': 'typed-coordinator-boundary',
    'video-clip.move': 'supported',
    'video-clip.trim': 'supported',
    'video-clip.split': 'supported',
    'video-clip.delete': 'supported',
    'video-clip.duplicate': 'supported',
    'video-clip.set-order': 'stable-noop',
    'video-clip.set-audio': 'supported',
    'video-clip.detach-audio': 'supported',
    'video-clip.relink-audio': 'supported',
    'audio-clip.insert': 'typed-coordinator-boundary',
    'audio-clip.move': 'supported',
    'audio-clip.trim': 'supported',
    'audio-clip.split': 'supported',
    'audio-clip.delete': 'supported',
    'audio-clip.duplicate': 'supported',
    'audio-clip.set-order': 'supported',
    'audio-clip.set-gain': 'supported',
    'audio-clip.set-fades': 'supported',
    'subtitle.insert': 'supported',
    'subtitle.update': 'supported',
    'subtitle.move': 'supported',
    'subtitle.trim': 'supported',
    'subtitle.split': 'supported',
    'subtitle.delete': 'supported',
    'subtitle.set-order': 'supported',
    'subtitle.bulk-replace': 'supported',
    'subtitle.set-track-style': 'supported',
    'narrative.activate': 'typed-coordinator-boundary',
    'narrative.release-tracks': 'supported',
    'narrative.set-editing-mode': 'supported',
    'narrative.split-block': 'supported',
    'narrative.merge-blocks': 'supported',
    'narrative.delete-words': 'supported',
    'narrative.delete-range': 'supported',
    'narrative.trim-block': 'supported',
    'narrative.reorder-blocks': 'supported',
    'narrative.insert-source-range': 'supported',
    'narrative.recover-source-range': 'supported',
    'narrative.extend-block': 'supported',
    'narrative.set-word-text': 'supported',
    'narrative.set-word-speaker': 'supported',
    'narrative.set-speaker-visibility': 'supported',
    'narrative.change-block-margin': 'supported',
    'narrative.change-global-margins': 'supported',
    'narrative.refine-boundary': 'supported',
    'narrative.delete-all-silences': 'supported',
    'link.discover-overlaps': 'supported',
    'link.create-overlap': 'supported',
    'link.bind-target': 'supported',
    'link.unlink-target': 'supported',
    'link.unbind-target': 'supported',
    'link.reanchor': 'supported',
    'link.set-follow-policy': 'supported',
} satisfies Record<EditorOperationType, StandaloneOperationCompatibility>);

export function assertStandaloneOperationCompatibilityComplete(): void {
    const mapped = Object.keys(STANDALONE_EDITOR_OPERATION_COMPATIBILITY).sort();
    const frozen = [...EDITOR_OPERATION_TYPES].sort();
    if (mapped.length !== frozen.length || mapped.some((value, index) => value !== frozen[index])) {
        throw new Error('Standalone editor operation compatibility is incomplete.');
    }
}

export function mapStandaloneOrdinaryCommand(input: {
    before: EditorDocumentV4;
    planned: TimelineOrdinaryPlanSuccess;
    request: TimelineOrdinaryCommand;
}): EditorSemanticOperation[] | TimelineV4CommandResult {
    const { request } = input;
    if (hasUnsupportedOrdinaryCascade(input.before, input.planned.document, request)) {
        return standaloneUnsupportedBoundary({
            code: 'unsupported-ripple-cascade',
            message: 'Core does not yet expose the complete cross-media ripple cascade as one semantic operation.',
            ids: ordinaryTargetIds(request),
        });
    }
    if (request.target.kind === 'video-clip') {
        const target = request.target;
        switch (request.action.kind) {
            case 'delete':
                return [
                    operation('video-clip.delete', { clipId: target.clipId }),
                    ...removedVideoTrackOperations(input.before, input.planned.document),
                ];
            case 'move': {
                const clip = input.planned.document.videoClips.find(
                    (value) => value.id === target.clipId,
                );
                if (!clip) return unsupported('missing-target', target.clipId);
                return [
                    operation('video-clip.move', {
                        clipId: clip.id,
                        targetTrackId: clip.trackId,
                        timelineStartFrame: clip.timelineStartFrame,
                    }),
                    ...removedVideoTrackOperations(input.before, input.planned.document),
                ];
            }
            case 'resize': {
                const clip = input.planned.document.videoClips.find(
                    (value) => value.id === target.clipId,
                );
                if (!clip) return unsupported('missing-target', target.clipId);
                return [operation('video-clip.trim', {
                    clipId: clip.id,
                    sourceStartSeconds: clip.sourceStart,
                    sourceEndSeconds: clip.sourceEnd,
                    timelineStartFrame: clip.timelineStartFrame,
                })];
            }
            case 'split':
                return [operation('video-clip.split', {
                    clipId: target.clipId,
                    atFrame: request.action.at,
                    rightClipId: request.action.childId,
                })];
        }
    }
    if (request.target.kind === 'audio-clip') {
        const target = request.target;
        switch (request.action.kind) {
            case 'delete':
                return [operation('audio-clip.delete', { clipId: target.clipId })];
            case 'move': {
                const located = findAudioClip(input.planned.document, target.clipId);
                if (!located) return unsupported('missing-target', target.clipId);
                return [operation('audio-clip.move', {
                    clipId: located.clip.id,
                    targetTrackId: located.trackId,
                    timelineStartFrame: located.clip.timelineStartFrame,
                })];
            }
            case 'resize': {
                const located = findAudioClip(input.planned.document, target.clipId);
                if (!located) return unsupported('missing-target', target.clipId);
                return [operation('audio-clip.trim', {
                    clipId: located.clip.id,
                    sourceRange: audioSourceRange(input.planned.document, located.clip),
                })];
            }
            case 'split':
                return [operation('audio-clip.split', {
                    clipId: target.clipId,
                    atOutputSample: request.action.at,
                    rightClipId: request.action.childId,
                })];
        }
    }
    switch (request.action.kind) {
        case 'delete':
            return [operation('subtitle.delete', {
                trackId: request.target.trackId,
                subtitleId: request.target.subtitleId,
            })];
        case 'move': {
            if (request.action.targetTrackId !== request.target.trackId) {
                return unsupported(
                    'unsupported-cross-track-subtitle-move',
                    request.target.subtitleId,
                    'Core has no semantics-preserving cross-track subtitle move operation.',
                );
            }
            const subtitle = findSubtitle(input.planned.document, request.target.subtitleId);
            if (!subtitle) return unsupported('missing-target', request.target.subtitleId);
            return [operation('subtitle.move', {
                trackId: request.target.trackId,
                subtitleId: request.target.subtitleId,
                startOutputSample: Math.round(subtitle.startTime * 48_000),
            })];
        }
        case 'resize': {
            const subtitle = findSubtitle(input.planned.document, request.target.subtitleId);
            if (!subtitle) return unsupported('missing-target', request.target.subtitleId);
            return [operation('subtitle.trim', {
                trackId: request.target.trackId,
                subtitleId: request.target.subtitleId,
                startOutputSample: Math.round(subtitle.startTime * 48_000),
                endOutputSample: Math.round(subtitle.endTime * 48_000),
            })];
        }
        case 'split':
            return [operation('subtitle.split', {
                trackId: request.target.trackId,
                subtitleId: request.target.subtitleId,
                atOutputSample: request.action.at,
                rightSubtitleId: request.action.childId,
            })];
    }
}

export function mapStandaloneSubtitleReplacement(input: {
    before: EditorDocumentV4;
    planned: TimelineOrdinaryPlanSuccess;
    requestedSubtitleTracks?: EditorDocumentV4['subtitleTracks'];
}): EditorSemanticOperation[] | TimelineV4CommandResult {
    if (input.before.activeSubtitleTrackId !== input.planned.document.activeSubtitleTrackId) {
        return standaloneUnsupportedBoundary({
            code: 'unsupported-active-subtitle-track',
            message: 'Core has no durable active subtitle track operation.',
            ids: [
                input.before.activeSubtitleTrackId,
                input.planned.document.activeSubtitleTrackId,
            ].filter((value): value is string => Boolean(value)),
        });
    }
    const beforeTrackBySubtitle = new Map(input.before.subtitleTracks.flatMap((track) => (
        track.subtitles.map((subtitle) => [subtitle.id, track.id] as const)
    )));
    const afterTrackBySubtitle = new Map(input.planned.document.subtitleTracks.flatMap((track) => (
        track.subtitles.map((subtitle) => [subtitle.id, track.id] as const)
    )));
    const movedId = Array.from(beforeTrackBySubtitle).find(([subtitleId, trackId]) => (
        afterTrackBySubtitle.has(subtitleId)
        && afterTrackBySubtitle.get(subtitleId) !== trackId
    ))?.[0];
    if (movedId) {
        return standaloneUnsupportedBoundary({
            code: 'unsupported-cross-track-subtitle-move',
            message: 'Core has no semantics-preserving cross-track subtitle move operation.',
            ids: [movedId],
        });
    }
    return input.planned.document.subtitleTracks.flatMap((track) => {
        const before = input.before.subtitleTracks.find((value) => value.id === track.id);
        if (!before) return [];
        const operations: EditorSemanticOperation[] = [];
        if (before.isVisible !== track.isVisible || (before.isLocked && !track.isLocked)) {
            operations.push(operation('track.set-state', {
                trackKind: 'subtitle',
                trackId: track.id,
                ...(before.isVisible === track.isVisible ? {} : { visible: track.isVisible }),
                ...(before.isLocked && !track.isLocked ? { locked: false } : {}),
            }));
        }
        if (before.name !== track.name) {
            operations.push(operation('track.rename', {
                trackKind: 'subtitle',
                trackId: track.id,
                name: track.name,
            }));
        }
        if (JSON.stringify(before.style) !== JSON.stringify(track.style)) {
            operations.push(operation('subtitle.set-track-style', {
                trackId: track.id,
                style: structuredClone(track.style),
            }));
        }
        if (before.unlinkedVideoEditResponse !== track.unlinkedVideoEditResponse) {
            operations.push(operation('subtitle-track.set-unlinked-video-policy', {
                trackId: track.id,
                policy: track.unlinkedVideoEditResponse === 'stay-absolute'
                    ? 'preserve-absolute'
                    : track.unlinkedVideoEditResponse === 'follow-project-ripple'
                        ? 'ripple-with-video-edit'
                        : 'remove-with-deleted-video-range',
            }));
        }
        const afterById = new Map(track.subtitles.map((subtitle) => [subtitle.id, subtitle]));
        const beforeById = new Map(before.subtitles.map((subtitle) => [subtitle.id, subtitle]));
        const splitParentIds = new Set<string>();
        const splitChildIds = new Set<string>();
        track.subtitles
            .filter((subtitle) => !beforeById.has(subtitle.id))
            .forEach((child) => {
                const parent = before.subtitles.find((candidate) => (
                    !splitParentIds.has(candidate.id)
                    && isExactSubtitleSplit(candidate, afterById.get(candidate.id), child)
                ));
                if (!parent) return;
                operations.push(operation('subtitle.split', {
                    trackId: track.id,
                    subtitleId: parent.id,
                    atOutputSample: Math.round(child.startTime * 48_000),
                    rightSubtitleId: child.id,
                }));
                splitParentIds.add(parent.id);
                splitChildIds.add(child.id);
                if (child.text !== parent.text) {
                    operations.push(operation('subtitle.update', {
                        trackId: track.id,
                        subtitleId: child.id,
                        text: child.text,
                    }));
                }
            });
        before.subtitles
            .filter((subtitle) => !afterById.has(subtitle.id))
            .forEach((subtitle) => operations.push(operation('subtitle.delete', {
                trackId: track.id,
                subtitleId: subtitle.id,
            })));
        track.subtitles.forEach((subtitle) => {
            const previous = beforeById.get(subtitle.id);
            if (!previous) {
                if (splitChildIds.has(subtitle.id)) return;
                operations.push(operation('subtitle.insert', {
                    trackId: track.id,
                    subtitle: semanticSubtitle(subtitle),
                }));
                return;
            }
            if (previous.text !== subtitle.text) {
                operations.push(operation('subtitle.update', {
                    trackId: track.id,
                    subtitleId: subtitle.id,
                    text: subtitle.text,
                }));
            }
            if (previous.startTime === subtitle.startTime
                && previous.endTime === subtitle.endTime) return;
            if (splitParentIds.has(subtitle.id)) return;
            const previousDuration = previous.endTime - previous.startTime;
            const nextDuration = subtitle.endTime - subtitle.startTime;
            if (Math.abs(previousDuration - nextDuration) < 1 / 48_000) {
                operations.push(operation('subtitle.move', {
                    trackId: track.id,
                    subtitleId: subtitle.id,
                    startOutputSample: Math.round(subtitle.startTime * 48_000),
                }));
            } else {
                operations.push(operation('subtitle.trim', {
                    trackId: track.id,
                    subtitleId: subtitle.id,
                    startOutputSample: Math.round(subtitle.startTime * 48_000),
                    endOutputSample: Math.round(subtitle.endTime * 48_000),
                }));
            }
        });
        const beforeOrder = before.subtitles.map((subtitle) => subtitle.id);
        const requestedTrack = input.requestedSubtitleTracks?.find((value) => value.id === track.id);
        const afterOrder = (requestedTrack ?? track).subtitles.map((subtitle) => subtitle.id);
        const sameCatalog = beforeOrder.length === afterOrder.length
            && beforeOrder.every((id) => afterById.has(id));
        if (sameCatalog && beforeOrder.some((id, index) => id !== afterOrder[index])) {
            afterOrder.slice(1).forEach((subtitleId, index) => {
                operations.push(operation('subtitle.set-order', {
                    trackId: track.id,
                    subtitleId,
                    afterId: afterOrder[index],
                }));
            });
        }
        if (!before.isLocked && track.isLocked) {
            operations.push(operation('track.set-state', {
                trackKind: 'subtitle',
                trackId: track.id,
                locked: true,
            }));
        }
        return operations;
    });
}

export function mapStandaloneSubtitleOrderReplacement(
    before: EditorDocumentV4,
    requestedSubtitleTracks: EditorDocumentV4['subtitleTracks'],
): EditorSemanticOperation[] {
    return requestedSubtitleTracks.flatMap((requestedTrack) => {
        const beforeTrack = before.subtitleTracks.find((track) => track.id === requestedTrack.id);
        if (!beforeTrack) return [];
        const beforeOrder = beforeTrack.subtitles.map((subtitle) => subtitle.id);
        const requestedOrder = requestedTrack.subtitles.map((subtitle) => subtitle.id);
        const requestedIds = new Set(requestedOrder);
        if (
            beforeOrder.length !== requestedOrder.length
            || beforeOrder.some((id) => !requestedIds.has(id))
            || beforeOrder.every((id, index) => id === requestedOrder[index])
        ) return [];
        return requestedOrder.slice(1).map((subtitleId, index) => operation(
            'subtitle.set-order',
            {
                trackId: requestedTrack.id,
                subtitleId,
                afterId: requestedOrder[index],
            },
        ));
    });
}

export function mapStandaloneNarrativeCommand(
    request: TimelineNarrativeCommand,
): EditorSemanticOperation[] {
    switch (request.type) {
        case 'split-block':
            return [operation('narrative.split-block', {
                blockId: request.blockId,
                splitSample16k: request.splitSample,
            })];
        case 'merge-blocks':
            return [operation('narrative.merge-blocks', stripType(request))];
        case 'delete-words':
            return [operation('narrative.delete-words', stripType(request))];
        case 'delete-range':
            return [operation('narrative.delete-range', {
                start: {
                    blockId: request.selection.start.blockId,
                    sample16k: request.selection.start.sample,
                },
                end: {
                    blockId: request.selection.end.blockId,
                    sample16k: request.selection.end.sample,
                },
                ...(request.currentPlayheadFrame === undefined
                    ? {}
                    : { currentPlayheadFrame: request.currentPlayheadFrame }),
            })];
        case 'trim-block':
            return [operation('narrative.trim-block', {
                blockId: request.blockId,
                side: request.side,
                sample16k: request.sample,
            })];
        case 'reorder-blocks':
            return [operation('narrative.reorder-blocks', {
                ...stripType(request),
                blockIds: [...request.blockIds],
            })];
        case 'insert-source-range':
        case 'recover-source-range':
            return [operation(`narrative.${request.type}`, {
                ...stripType(request),
                sourceRange: {
                    startSample16k: request.sourceRange.start,
                    endSample16k: request.sourceRange.end,
                },
            })];
        case 'extend-block':
            return [operation('narrative.extend-block', {
                blockId: request.blockId,
                newStartSample16k: request.newStartSample,
                newEndSample16k: request.newEndSample,
            })];
        case 'set-word-text':
            return [operation('narrative.set-word-text', stripType(request))];
        case 'set-word-speaker':
            return [operation('narrative.set-word-speaker', stripType(request))];
        case 'set-speaker-visibility':
            return [operation('narrative.set-speaker-visibility', stripType(request))];
        case 'change-block-margin':
            return [operation('narrative.change-block-margin', {
                blockId: request.blockId,
                side: request.side,
                policy: {
                    kind: 'margin',
                    mode: request.policy.mode,
                    requestedSamples16k: request.policy.requestedSamples,
                },
            })];
        case 'change-global-margins':
            return [operation('narrative.change-global-margins', {
                preSamples16k: request.preSamples,
                postSamples16k: request.postSamples,
            })];
        case 'refine-boundary':
            return [operation('narrative.refine-boundary', {
                blockId: request.blockId,
                side: request.side,
                chosenSample16k: request.chosenSample,
                algorithmVersion: request.algorithmVersion,
                origin: request.origin,
            })];
        case 'delete-all-silences':
            return [operation('narrative.delete-all-silences', stripType(request))];
    }
}

export function mapStandaloneLinkCommand(
    request: TimelineEditorialLinkCommand,
): EditorSemanticOperation[] {
    switch (request.type) {
        case 'discover-overlaps':
            return [operation('link.discover-overlaps', {})];
        case 'create-overlap-link':
            return [operation('link.create-overlap', stripType(request))];
        case 'bind-target':
            return [operation('link.bind-target', {
                target: request.target,
                anchorBlockId: request.anchorBlockId,
                activeStartSample16k: request.activeStartSample,
                activeEndSample16k: request.activeEndSample,
                ...(request.followPolicy ? { followPolicy: request.followPolicy } : {}),
            })];
        case 'unlink-target':
            return [operation('link.unlink-target', stripType(request))];
        case 'unbind-target':
            return [operation('link.unbind-target', stripType(request))];
        case 'reanchor-link':
            return [operation('link.reanchor', stripType(request))];
        case 'set-follow-policy':
            return [operation('link.set-follow-policy', stripType(request))];
    }
}

export function mapStandaloneGlobalEditingMode(
    mode: GlobalEditingMode,
): EditorSemanticOperation[] {
    return [operation('narrative.set-editing-mode', { mode })];
}

export function mapStandaloneProjectName(name: string): EditorSemanticOperation[] {
    return [operation('project.set-name', { name })];
}

export function standaloneUnsupportedBoundary(input: {
    code: string;
    message: string;
    ids?: string[];
}): TimelineV4CommandResult {
    return {
        kind: 'error',
        error: {
            code: input.code,
            message: input.message,
            ids: input.ids ?? [],
        },
    };
}

export function createStandaloneSemanticOperation<T extends EditorOperationType>(
    type: T,
    payload: unknown,
): EditorSemanticOperation {
    return {
        operationId: `standalone-${type}-${crypto.randomUUID()}`,
        type,
        payload,
    } as EditorSemanticOperation;
}

const operation = createStandaloneSemanticOperation;

function stripType<T extends { type: string }>(value: T): Omit<T, 'type'> {
    const payload = { ...value } as Partial<T>;
    delete payload.type;
    return payload as Omit<T, 'type'>;
}

function findAudioClip(document: EditorDocumentV4, clipId: string) {
    for (const track of document.audioTracks) {
        const clip = track.clips.find((value) => value.id === clipId);
        if (clip) return { trackId: track.id, clip };
    }
    return null;
}

function findSubtitle(document: EditorDocumentV4, subtitleId: string) {
    return document.subtitleTracks
        .flatMap((track) => track.subtitles)
        .find((subtitle) => subtitle.id === subtitleId);
}

function requireAudioSourceRate(document: EditorDocumentV4, sourceId: string): number {
    const source = document.audioSources.find((value) => value.id === sourceId);
    if (!source) throw new Error(`Audio source "${sourceId}" is unavailable.`);
    return source.nativeSampleRate;
}

function removedVideoTrackOperations(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
): EditorSemanticOperation[] {
    const retained = new Set(after.videoTracks.map((track) => track.id));
    return before.videoTracks
        .filter((track) => !retained.has(track.id))
        .map((track) => operation('track.delete', {
            trackKind: 'video',
            trackId: track.id,
            policy: 'empty-only',
        }));
}

function audioSourceRange(
    document: EditorDocumentV4,
    clip: EditorDocumentV4['audioTracks'][number]['clips'][number],
) {
    if ('sourceStartSample' in clip) {
        return {
            domain: 'native-samples' as const,
            audioSourceId: clip.source.audioSourceId,
            nativeSampleRateHz: requireAudioSourceRate(document, clip.source.audioSourceId),
            startNativeSample: clip.sourceStartSample,
            endNativeSample: clip.sourceEndSample,
        };
    }
    return {
        domain: 'seconds' as const,
        videoSourceId: clip.source.videoSourceId,
        startSeconds: clip.sourceStart,
        endSeconds: clip.sourceEnd,
    };
}

function unsupported(code: string, id: string, message?: string): TimelineV4CommandResult {
    return standaloneUnsupportedBoundary({
        code,
        message: message ?? `Standalone operation target "${id}" is unavailable.`,
        ids: [id],
    });
}

function hasUnsupportedOrdinaryCascade(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    request: TimelineOrdinaryCommand,
): boolean {
    if (request.target.kind === 'video-clip') {
        const targetIds = new Set([
            request.target.clipId,
            ...(request.action.kind === 'split' ? [request.action.childId] : []),
        ]);
        return !sameById(
            before.videoClips.filter((clip) => !targetIds.has(clip.id)),
            after.videoClips.filter((clip) => !targetIds.has(clip.id)),
        ) || JSON.stringify(before.audioTracks) !== JSON.stringify(after.audioTracks);
    }
    if (request.target.kind === 'audio-clip') {
        const targetIds = new Set([
            request.target.clipId,
            ...(request.action.kind === 'split' ? [request.action.childId] : []),
        ]);
        return JSON.stringify(before.videoClips) !== JSON.stringify(after.videoClips)
            || !sameAudioTracksWithoutClips(before, after, targetIds)
            || JSON.stringify(before.subtitleTracks) !== JSON.stringify(after.subtitleTracks);
    }
    const targetIds = new Set([
        request.target.subtitleId,
        ...(request.action.kind === 'split' ? [request.action.childId] : []),
    ]);
    return JSON.stringify(before.videoClips) !== JSON.stringify(after.videoClips)
        || JSON.stringify(before.audioTracks) !== JSON.stringify(after.audioTracks)
        || !sameSubtitleTracksWithoutCues(
            before,
            after,
            targetIds,
        );
}

function sameById<T extends { id: string }>(left: readonly T[], right: readonly T[]): boolean {
    const sorted = (values: readonly T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function sameAudioTracksWithoutClips(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    clipIds: ReadonlySet<string>,
): boolean {
    const without = (document: EditorDocumentV4) => document.audioTracks.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => !clipIds.has(clip.id)),
    }));
    return JSON.stringify(without(before)) === JSON.stringify(without(after));
}

function sameSubtitleTracksWithoutCues(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    subtitleIds: ReadonlySet<string>,
): boolean {
    const without = (document: EditorDocumentV4) => document.subtitleTracks.map((track) => ({
        ...track,
        subtitles: track.subtitles.filter((subtitle) => !subtitleIds.has(subtitle.id)),
    }));
    return JSON.stringify(without(before)) === JSON.stringify(without(after));
}

function ordinaryTargetIds(request: TimelineOrdinaryCommand): string[] {
    if (request.target.kind === 'video-clip' || request.target.kind === 'audio-clip') {
        return [request.target.clipId];
    }
    return [request.target.trackId, request.target.subtitleId];
}

function semanticSubtitle(
    subtitle: EditorDocumentV4['subtitleTracks'][number]['subtitles'][number],
) {
    return {
        id: subtitle.id,
        startOutputSample: Math.round(subtitle.startTime * 48_000),
        endOutputSample: Math.round(subtitle.endTime * 48_000),
        text: subtitle.text,
    };
}

function isExactSubtitleSplit(
    beforeParent: EditorDocumentV4['subtitleTracks'][number]['subtitles'][number],
    afterParent: EditorDocumentV4['subtitleTracks'][number]['subtitles'][number] | undefined,
    child: EditorDocumentV4['subtitleTracks'][number]['subtitles'][number],
): boolean {
    if (!afterParent) return false;
    const toSample = (seconds: number) => Math.round(seconds * 48_000);
    const oldStart = toSample(beforeParent.startTime);
    const oldEnd = toSample(beforeParent.endTime);
    const parentStart = toSample(afterParent.startTime);
    const parentEnd = toSample(afterParent.endTime);
    const childStart = toSample(child.startTime);
    const childEnd = toSample(child.endTime);
    return parentStart === oldStart
        && parentEnd === childStart
        && childEnd === oldEnd
        && parentEnd > parentStart;
}
