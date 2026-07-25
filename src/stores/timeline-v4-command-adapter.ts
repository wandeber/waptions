import { validateHydratedEditorDocumentV4 } from '@/lib/editor-document-v4';
import {
    planBindEditorialTarget,
    planCreateManualOverlapLink,
    planDiscoverEditorialOverlapLinks,
    planEditorialLinksForAnchorTransforms,
    planIntegrateDiscoveredEditorialOverlapLinks,
    planReanchorEditorialLink,
    planSetEditorialLinkFollowPolicy,
    planUnbindEditorialTarget,
    planUnlinkEditorialTarget,
    type EditorialLinkCommandGuard,
    type EditorialLinkIdFactory,
    type EditorialLinkPlanResult,
} from '@/lib/editorial-links';
import {
    planChangeBlockMargin,
    planChangeGlobalMargins,
    planDeleteAllSilences,
    planDeleteNarrativeRange,
    planDeleteNarrativeWords,
    planExtendNarrativeBlock,
    planInsertSourceRange,
    planMergeNarrativeBlocks,
    planRecoverSourceRange,
    planRefineNarrativeBoundary,
    planReorderNarrativeBlocks,
    planSetNarrativeSpeakerVisibility,
    planSetNarrativeWordSpeaker,
    planSetNarrativeWordText,
    planSplitNarrativeBlock,
    planTrimNarrativeBlock,
    type NarrativeCommandGuard,
    type NarrativeCommandResult,
    type NarrativeIdFactory,
} from '@/lib/narrative/commands';
import type { ResolvedEditorialTranscriptMapV1 } from '@/types/editorial';
import type { EditorDocumentV4 } from '@/types/video';
import {
    buildTimelineVideoTrackMirrors,
    projectTransientSelectionMirrorsV4,
} from './timeline-v4-compat';
import type { TimelineStore } from './timeline-store-types';
import type {
    TimelineEditorialLinkCommand,
    TimelineNarrativeCommand,
    TimelineV4CommandResult,
} from './timeline-v4-command-types';

export const createNarrativeCommandGuard = (document: EditorDocumentV4): NarrativeCommandGuard => ({
    expectedDocumentRevision: document.revision,
    expectedMode: document.globalEditingMode,
    ...(document.narrative ? { expectedNarrativeRevision: document.narrative.revision } : {}),
});

export const createEditorialLinkCommandGuard = (document: EditorDocumentV4): EditorialLinkCommandGuard => ({
    expectedDocumentRevision: document.revision,
    expectedMode: document.globalEditingMode,
    ...(document.narrative ? { expectedNarrativeRevision: document.narrative.revision } : {}),
});

/** Allocates readable safe IDs while leaving collision rejection to the pure planners. */
export const createTimelineNarrativeIdFactory = (): NarrativeIdFactory => (
    (kind) => `${kind}-${crypto.randomUUID()}`
);

const createTimelineEditorialLinkIdFactory = (): EditorialLinkIdFactory => (
    (kind) => `${kind}-${crypto.randomUUID()}`
);

export function planTimelineNarrativeCommand(input: {
    document: EditorDocumentV4;
    bodies: ResolvedEditorialTranscriptMapV1;
    request: TimelineNarrativeCommand;
    nowIso: string;
}): NarrativeCommandResult {
    const common = {
        document: input.document,
        guard: createNarrativeCommandGuard(input.document),
        bodies: input.bodies,
        idFactory: createTimelineNarrativeIdFactory(),
        nowIso: input.nowIso,
    };
    switch (input.request.type) {
        case 'split-block':
            return planSplitNarrativeBlock({ ...common, ...input.request });
        case 'merge-blocks':
            return planMergeNarrativeBlocks({ ...common, ...input.request });
        case 'delete-words':
            return planDeleteNarrativeWords({ ...common, ...input.request });
        case 'delete-range':
            return planDeleteNarrativeRange({ ...common, ...input.request });
        case 'trim-block':
            return planTrimNarrativeBlock({ ...common, ...input.request });
        case 'reorder-blocks':
            return planReorderNarrativeBlocks({ ...common, ...input.request });
        case 'insert-source-range':
            return planInsertSourceRange({ ...common, ...input.request });
        case 'recover-source-range':
            return planRecoverSourceRange({ ...common, ...input.request });
        case 'extend-block':
            return planExtendNarrativeBlock({ ...common, ...input.request });
        case 'set-word-text':
            return planSetNarrativeWordText({ ...common, ...input.request });
        case 'set-word-speaker':
            return planSetNarrativeWordSpeaker({ ...common, ...input.request });
        case 'set-speaker-visibility':
            return planSetNarrativeSpeakerVisibility({ ...common, ...input.request });
        case 'change-block-margin':
            return planChangeBlockMargin({ ...common, ...input.request });
        case 'change-global-margins':
            return planChangeGlobalMargins({ ...common, ...input.request });
        case 'refine-boundary':
            return planRefineNarrativeBoundary({ ...common, ...input.request });
        case 'delete-all-silences':
            return planDeleteAllSilences({ ...common, ...input.request });
    }
}

export function planTimelineEditorialLinkCommand(input: {
    document: EditorDocumentV4;
    request: TimelineEditorialLinkCommand;
}): EditorialLinkPlanResult {
    const common = {
        document: input.document,
        guard: createEditorialLinkCommandGuard(input.document),
    };
    switch (input.request.type) {
        case 'discover-overlaps':
            return planDiscoverEditorialOverlapLinks({
                ...common,
                idFactory: createTimelineEditorialLinkIdFactory(),
            });
        case 'create-overlap-link':
            return planCreateManualOverlapLink({
                ...common,
                ...input.request,
                idFactory: createTimelineEditorialLinkIdFactory(),
            });
        case 'bind-target':
            return planBindEditorialTarget({
                ...common,
                ...input.request,
                idFactory: createTimelineEditorialLinkIdFactory(),
            });
        case 'unlink-target':
            return planUnlinkEditorialTarget({ ...common, ...input.request });
        case 'unbind-target':
            return planUnbindEditorialTarget({ ...common, ...input.request });
        case 'reanchor-link':
            return planReanchorEditorialLink({ ...common, ...input.request });
        case 'set-follow-policy':
            return planSetEditorialLinkFollowPolicy({ ...common, ...input.request });
    }
}

/**
 * Runs WP5 after WP4 against the still-detached proposal. Neither planner publishes history or
 * persistence here; the caller commits the returned complete graph exactly once.
 */
export function integrateNarrativeCommandLinks(input: {
    before: EditorDocumentV4;
    narrativeResult: Extract<NarrativeCommandResult, { kind: 'success' }>;
    discoverNewOverlaps: boolean;
}): { kind: 'success'; document: EditorDocumentV4 } | Exclude<EditorialLinkPlanResult, { kind: 'success' }> {
    let document = input.narrativeResult.document;
    if (input.before.narrative) {
        const integrated = planEditorialLinksForAnchorTransforms({
            before: input.before,
            afterNarrativeCommand: document,
            guard: createEditorialLinkCommandGuard(input.before),
            anchorTransforms: input.narrativeResult.anchorTransforms,
        });
        if (integrated.kind === 'error') return integrated;
        if (integrated.kind === 'success') document = integrated.document;
    }
    if (input.discoverNewOverlaps && document.narrative) {
        const discovered = planIntegrateDiscoveredEditorialOverlapLinks({
            document,
            guard: createEditorialLinkCommandGuard(document),
            idFactory: createTimelineEditorialLinkIdFactory(),
        });
        if (discovered.kind === 'error') return discovered;
        if (discovered.kind === 'success') document = discovered.document;
    }
    return { kind: 'success', document };
}

/** Converts a validated planner document into the complete serializable Timeline-store patch. */
export function createTimelinePatchFromV4Document(
    document: EditorDocumentV4,
    bodies: ResolvedEditorialTranscriptMapV1,
): Partial<TimelineStore> {
    const validation = validateHydratedEditorDocumentV4(document, bodies);
    if (!validation.valid) {
        const firstIssue = validation.issues[0];
        throw new Error(firstIssue
            ? `V4 command proposal is invalid at ${firstIssue.path}: ${firstIssue.message}`
            : 'V4 command proposal is invalid.');
    }
    const selectionMirrors = projectTransientSelectionMirrorsV4(
        document.transientSelection,
        document.narrative,
    );
    return {
        renderProfile: structuredClone(document.renderProfile),
        renderBackgroundColor: document.renderBackgroundColor,
        tracks: document.subtitleTracks.map((track) => ({
            ...structuredClone(track),
            timingDomain: track.unlinkedVideoEditResponse === 'stay-absolute'
                ? 'absolute' as const
                : 'video-ripple' as const,
        })),
        videoClips: structuredClone(document.videoClips),
        videoTracks: buildTimelineVideoTrackMirrors(document.videoTracks, document.videoClips),
        audioTracks: structuredClone(document.audioTracks),
        activeTrackId: document.activeSubtitleTrackId,
        transientSelection: structuredClone(document.transientSelection),
        ...selectionMirrors,
        transcriptionByTrackId: structuredClone(document.transcriptionByTrackId),
        globalEditingMode: document.globalEditingMode,
        editorialTranscriptDescriptors: structuredClone(document.editorialTranscriptDescriptors),
        narrative: structuredClone(document.narrative),
        dependentLinks: structuredClone(document.dependentLinks),
    };
}

export function toTimelineCommandSuccess(
    result: Extract<NarrativeCommandResult, { kind: 'success' }>,
): TimelineV4CommandResult {
    return {
        kind: 'success',
        command: result.command,
        playhead: structuredClone(result.playhead),
        ...(result.activationReport ? { activationReport: structuredClone(result.activationReport) } : {}),
        ...(result.silenceDeletionReport
            ? { silenceDeletionReport: structuredClone(result.silenceDeletionReport) }
            : {}),
    };
}
