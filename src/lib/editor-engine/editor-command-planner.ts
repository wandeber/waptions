import {
    clampFrameFades,
    clampSampleFades,
    findAudioClip,
    moveAudioClipInTracks,
    splitAudioClipInTracks,
} from '@/lib/audio-timeline';
import {
    AUDIO_OUTPUT_SAMPLE_RATE,
    nativeBoundaryToOutputSample,
    outputSampleToCoveringFrame,
    outputSampleToNearestNativeBoundary,
} from '@/lib/audio-timebase';
import {
    getEditorAudioGraphSignatureV4,
    validateEditorManifestV4,
    validateHydratedEditorDocumentV4,
} from '@/lib/editor-document-v4';
import {
    planBindEditorialTarget,
    planCreateManualOverlapLink,
    planDiscoverEditorialOverlapLinks,
    planEditorialLinksForAnchorTransforms,
    planEditorialLinksForTargetTransforms,
    planIntegrateDiscoveredEditorialOverlapLinks,
    planReanchorEditorialLink,
    planSetEditorialLinkFollowPolicy,
    planUnbindEditorialTarget,
    planUnlinkEditorialTarget,
    type EditorialDirectTargetTransform,
    type EditorialLinkCommandGuard,
    type EditorialLinkIdFactory,
    type EditorialLinkPlanResult,
} from '@/lib/editorial-links';
import {
    planActivateNarrative,
    planChangeBlockMargin,
    planChangeGlobalEditingMode,
    planChangeGlobalMargins,
    planDeleteAllSilences,
    planDeleteNarrativeRange,
    planDeleteNarrativeWords,
    planExtendNarrativeBlock,
    planInsertSourceRange,
    planMergeNarrativeBlocks,
    planRecoverSourceRange,
    planRefineNarrativeBoundary,
    planReleaseNarrativeTracks,
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
import { framesToSeconds } from '@/lib/render-profile';
import {
    buildVideoTrackPlacementsV4,
    getVideoClipDurationFramesV4,
    getVideoClipPlacementV4,
} from '@/lib/video-placement-v4';
import type { ResolvedEditorialTranscriptMapV1 } from '@/types/editorial';
import type { AnimationStyle, Subtitle, SubtitleTrackV4 } from '@/types/timeline';
import type {
    AudioClip,
    AudioTrack,
    EditorDocumentV4,
    EditorManifestV4,
    VideoClipV4,
    VideoSourceAudioClip,
} from '@/types/video';
import type { VerifiedMediaHandleV1 } from '@/types/waptions-agent-protocol';
import type {
    EditorSemanticOperation,
} from './editor-command';
import { EditorCommandError } from './editor-command-errors';
import type {
    EditorAssetHydration,
    EditorIdGenerator,
} from './editor-ports';

export interface EditorBatchPlanningResult {
    manifest: EditorManifestV4;
    aliases: Record<string, string>;
    affectedIds: string[];
    changed: boolean;
    noOpReason?: string;
    label: string;
    category: string;
    audioGraphChanged: boolean;
    narrativeChanged: boolean;
}

export interface EditorPlannerContext {
    commandScope: string;
    nowIso: string;
    ids: EditorIdGenerator;
    assets: EditorAssetHydration;
    bodies: ResolvedEditorialTranscriptMapV1;
    validationMode?: 'hydrated' | 'structural';
}

interface OperationResult {
    document: EditorDocumentV4;
    changed: boolean;
    noOpReason?: string;
    affectedIds: string[];
    label: string;
    category: string;
}

export function createDescriptorAssetHydration(manifest: EditorManifestV4): EditorAssetHydration {
    return {
        videoSources: manifest.videoSourceDescriptors.map((descriptor) => ({
            ...structuredClone(descriptor),
            handle: syntheticVerifiedHandle(descriptor.id, descriptor.fingerprint, descriptor.size),
            fileMetadata: {
                name: descriptor.originalName,
                type: descriptor.mimeType,
                size: descriptor.size,
                lastModified: descriptor.lastModified,
            },
        })),
        audioSources: manifest.audioSourceDescriptors.map((descriptor) => ({
            ...structuredClone(descriptor),
            handle: syntheticVerifiedHandle(descriptor.id, descriptor.fingerprint, descriptor.size),
            fileMetadata: {
                name: descriptor.originalName,
                type: descriptor.mimeType,
                size: descriptor.size,
                lastModified: descriptor.lastModified,
            },
        })),
    };
}

export function assertAssetHydration(
    manifest: EditorManifestV4,
    hydration: EditorAssetHydration,
    required: {
        videoSourceIds: readonly string[];
        audioSourceIds: readonly string[];
    } = {
        videoSourceIds: manifest.videoSourceDescriptors.map((source) => source.id),
        audioSourceIds: manifest.audioSourceDescriptors.map((source) => source.id),
    },
): void {
    const requiredVideo = new Set(required.videoSourceIds);
    const requiredAudio = new Set(required.audioSourceIds);
    assertHydratedCatalog(
        manifest.videoSourceDescriptors.filter((source) => requiredVideo.has(source.id)),
        hydration.videoSources,
        'video',
    );
    assertHydratedCatalog(
        manifest.audioSourceDescriptors.filter((source) => requiredAudio.has(source.id)),
        hydration.audioSources,
        'audio',
    );
}

export function applyEditorOperationBatch(
    manifest: EditorManifestV4,
    operations: readonly EditorSemanticOperation[],
    context: EditorPlannerContext,
): EditorBatchPlanningResult {
    assertAssetHydration(manifest, context.assets);
    let document = manifestToPlanningDocument(manifest, context.assets);
    const aliases: Record<string, string> = {};
    const affectedIds = new Set<string>();
    const labels: string[] = [];
    const categories = new Set<string>();
    let changed = false;
    let lastNoOpReason: string | undefined;

    for (const original of operations) {
        const operation = resolveOperationAliases(original, aliases);
        const result = applyOperation(document, operation, context, aliases);
        document = result.document;
        result.affectedIds.forEach((id) => affectedIds.add(id));
        if (result.changed) {
            changed = true;
            labels.push(result.label);
            categories.add(result.category);
        } else {
            lastNoOpReason = result.noOpReason ?? 'unchanged';
        }
    }

    const beforeAudioSignature = audioSignature(manifestToPlanningDocument(manifest, context.assets));
    if (!changed) {
        return {
            manifest: structuredClone(manifest),
            aliases,
            affectedIds: Array.from(affectedIds),
            changed: false,
            noOpReason: lastNoOpReason ?? 'unchanged',
            label: 'No changes',
            category: 'no-op',
            audioGraphChanged: false,
            narrativeChanged: false,
        };
    }

    const proposed = planningDocumentToManifest(document);
    if (sameManifestContent(manifest, proposed)) {
        return {
            manifest: structuredClone(manifest),
            aliases,
            affectedIds: Array.from(affectedIds).sort(),
            changed: false,
            noOpReason: lastNoOpReason ?? 'unchanged',
            label: 'No changes',
            category: 'no-op',
            audioGraphChanged: false,
            narrativeChanged: false,
        };
    }
    proposed.revision = manifest.revision + 1;
    const afterAudioSignature = audioSignature(document);
    const audioGraphChanged = beforeAudioSignature !== afterAudioSignature;
    proposed.audioGraphRevision = manifest.audioGraphRevision + (audioGraphChanged ? 1 : 0);
    const narrativeChanged = JSON.stringify(manifest.narrative) !== JSON.stringify(proposed.narrative);

    const structural = validateEditorManifestV4(proposed);
    if (!structural.valid) throw invalidDocument(structural.issues);
    if ((context.validationMode ?? 'hydrated') === 'hydrated') {
        const hydrated = validateHydratedEditorDocumentV4(
            manifestToPlanningDocument(proposed, context.assets),
            context.bodies,
        );
        if (!hydrated.valid) throw invalidDocument(hydrated.issues);
    }

    return {
        manifest: proposed,
        aliases,
        affectedIds: Array.from(affectedIds).sort(),
        changed: true,
        label: labels.length === 1 ? labels[0] : `Apply ${labels.length} editor operations`,
        category: categories.size === 1 ? Array.from(categories)[0] : 'compound-edit',
        audioGraphChanged,
        narrativeChanged,
    };
}

export function manifestToPlanningDocument(
    manifest: EditorManifestV4,
    hydration: EditorAssetHydration,
): EditorDocumentV4 {
    return {
        version: 4,
        revision: manifest.revision,
        audioGraphRevision: manifest.audioGraphRevision,
        renderProfile: structuredClone(manifest.renderProfile),
        renderBackgroundColor: manifest.renderBackgroundColor,
        subtitleTracks: structuredClone(manifest.subtitleTracks),
        videoSources: hydration.videoSources.map((source) => {
            const { fileMetadata, handle, ...descriptor } = source;
            void handle;
            return {
                ...structuredClone(descriptor),
                // Existing pure planners only read descriptor fields. The validator reads these
                // metadata fields, so no browser File or binary body crosses the engine boundary.
                file: structuredClone(fileMetadata),
            };
        }) as EditorDocumentV4['videoSources'],
        videoClips: structuredClone(manifest.videoClips),
        videoTracks: structuredClone(manifest.videoTracks),
        audioSources: hydration.audioSources.map((source) => {
            const { fileMetadata, handle, ...descriptor } = source;
            void handle;
            return {
                ...structuredClone(descriptor),
                file: structuredClone(fileMetadata),
            };
        }) as EditorDocumentV4['audioSources'],
        audioTracks: structuredClone(manifest.audioTracks),
        activeSubtitleTrackId: manifest.activeSubtitleTrackId,
        transientSelection: { kind: 'none' },
        transcriptionByTrackId: structuredClone(manifest.transcriptionByTrackId),
        globalEditingMode: manifest.globalEditingMode,
        editorialTranscriptDescriptors: structuredClone(manifest.editorialTranscriptDescriptors),
        narrative: structuredClone(manifest.narrative),
        dependentLinks: structuredClone(manifest.dependentLinks),
    };
}

export function planningDocumentToManifest(document: EditorDocumentV4): EditorManifestV4 {
    return {
        version: 4,
        revision: document.revision,
        audioGraphRevision: document.audioGraphRevision,
        renderProfile: structuredClone(document.renderProfile),
        renderBackgroundColor: document.renderBackgroundColor,
        subtitleTracks: structuredClone(document.subtitleTracks),
        videoSourceDescriptors: document.videoSources.map(({ file, ...descriptor }) => {
            void file;
            return structuredClone(descriptor);
        }),
        videoClips: structuredClone(document.videoClips),
        videoTracks: structuredClone(document.videoTracks),
        audioSourceDescriptors: document.audioSources.map(({ file, ...descriptor }) => {
            void file;
            return structuredClone(descriptor);
        }),
        audioTracks: structuredClone(document.audioTracks),
        activeSubtitleTrackId: document.activeSubtitleTrackId,
        transcriptionByTrackId: structuredClone(document.transcriptionByTrackId),
        globalEditingMode: document.globalEditingMode,
        editorialTranscriptDescriptors: structuredClone(document.editorialTranscriptDescriptors),
        narrative: structuredClone(document.narrative),
        dependentLinks: structuredClone(document.dependentLinks),
    };
}

function applyOperation(
    document: EditorDocumentV4,
    operation: EditorSemanticOperation,
    context: EditorPlannerContext,
    aliases: Record<string, string>,
): OperationResult {
    if (operation.type.startsWith('narrative.')) {
        return applyNarrativeOperation(
            document,
            operation as Extract<EditorSemanticOperation, { type: `narrative.${string}` }>,
            context,
            aliases,
        );
    }
    if (operation.type.startsWith('link.')) {
        return applyLinkOperation(
            document,
            operation as Extract<EditorSemanticOperation, { type: `link.${string}` }>,
            context,
            aliases,
        );
    }
    return applyOrdinaryOperation(
        document,
        operation as Exclude<EditorSemanticOperation, { type: `narrative.${string}` | `link.${string}` }>,
        context,
        aliases,
    );
}

function applyOrdinaryOperation(
    document: EditorDocumentV4,
    operation: Exclude<EditorSemanticOperation, { type: `narrative.${string}` | `link.${string}` }>,
    context: EditorPlannerContext,
    aliases: Record<string, string>,
): OperationResult {
    const before = document;
    let after = structuredClone(document);
    let transforms: EditorialDirectTargetTransform[] = [];
    let label: string = operation.type;
    let category: string = operation.type.split('.')[0];
    const affectedIds: string[] = [];

    switch (operation.type) {
        case 'project.set-name':
            return noop(document, 'handled-by-engine', 'Set project name', 'project');
        case 'render.set-background': {
            const color = operation.payload.color.toLowerCase();
            if (after.renderBackgroundColor === color) {
                return noop(document, 'unchanged', 'Set render background', 'render');
            }
            after.renderBackgroundColor = color;
            label = 'Set render background';
            category = 'render';
            break;
        }
        case 'render.set-profile':
            if (same(after.renderProfile, operation.payload.profile)) {
                return noop(document, 'unchanged', 'Set render profile', 'render');
            }
            after.renderProfile = structuredClone(operation.payload.profile);
            label = 'Set render profile';
            category = 'render';
            break;
        case 'track.add': {
            const trackId = operation.payload.trackId
                ?? context.ids.generate('track', `${context.commandScope}:${operation.operationId}:track`);
            assertUniqueId(after, trackId, operation);
            aliases[`$${operation.operationId}.trackId`] = trackId;
            const index = resolveInsertIndex(
                getTrackIds(after, operation.payload.trackKind),
                operation.payload.beforeTrackId,
            );
            if (operation.payload.trackKind === 'video') {
                after.videoTracks.splice(index, 0, {
                    id: trackId,
                    name: operation.payload.name,
                    visible: true,
                    locked: false,
                });
            } else if (operation.payload.trackKind === 'audio') {
                after.audioTracks.splice(index, 0, {
                    id: trackId,
                    name: operation.payload.name,
                    muted: false,
                    solo: false,
                    locked: false,
                    gainDb: 0,
                    clips: [],
                });
            } else {
                after.subtitleTracks.splice(index, 0, {
                    id: trackId,
                    name: operation.payload.name,
                    style: defaultSubtitleStyle(),
                    subtitles: [],
                    isVisible: true,
                    isLocked: false,
                    unlinkedVideoEditResponse: 'follow-project-ripple',
                });
                after.activeSubtitleTrackId ??= trackId;
            }
            affectedIds.push(trackId);
            label = 'Add track';
            category = 'track';
            break;
        }
        case 'track.rename': {
            const track = requireTrack(after, operation.payload.trackKind, operation.payload.trackId, operation);
            if (track.name === operation.payload.name) return noop(document, 'unchanged', 'Rename track', 'track');
            track.name = operation.payload.name;
            affectedIds.push(track.id);
            label = 'Rename track';
            category = 'track';
            break;
        }
        case 'track.set-state': {
            const track = requireTrack(after, operation.payload.trackKind, operation.payload.trackId, operation);
            const previous = JSON.stringify(track);
            if (operation.payload.trackKind === 'video') {
                const videoTrack = track as EditorDocumentV4['videoTracks'][number];
                if (operation.payload.visible !== undefined) videoTrack.visible = operation.payload.visible;
                if (operation.payload.locked !== undefined) videoTrack.locked = operation.payload.locked;
            } else if (operation.payload.trackKind === 'audio') {
                const audioTrack = track as AudioTrack;
                if (operation.payload.muted !== undefined) audioTrack.muted = operation.payload.muted;
                if (operation.payload.solo !== undefined) audioTrack.solo = operation.payload.solo;
                if (operation.payload.locked !== undefined) audioTrack.locked = operation.payload.locked;
            } else {
                const subtitleTrack = track as SubtitleTrackV4;
                if (operation.payload.visible !== undefined) subtitleTrack.isVisible = operation.payload.visible;
                if (operation.payload.locked !== undefined) subtitleTrack.isLocked = operation.payload.locked;
            }
            if (previous === JSON.stringify(track)) return noop(document, 'unchanged', 'Set track state', 'track');
            affectedIds.push(track.id);
            label = 'Set track state';
            category = 'track';
            break;
        }
        case 'audio-track.set-gain': {
            const track = requireAudioTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.locked, operation, track.id);
            if (track.gainDb === operation.payload.gainDb) {
                return noop(document, 'unchanged', 'Set audio track gain', 'audio');
            }
            track.gainDb = operation.payload.gainDb;
            affectedIds.push(track.id);
            label = 'Set audio track gain';
            category = 'audio';
            break;
        }
        case 'subtitle-track.set-unlinked-video-policy': {
            const track = requireSubtitleTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            const durablePolicy = operation.payload.policy === 'preserve-absolute'
                ? 'stay-absolute'
                : operation.payload.policy === 'ripple-with-video-edit'
                    ? 'follow-project-ripple'
                    : 'remove-with-deleted-video-range';
            if (track.unlinkedVideoEditResponse === durablePolicy) {
                return noop(document, 'unchanged', 'Set subtitle video policy', 'subtitle');
            }
            track.unlinkedVideoEditResponse = durablePolicy;
            affectedIds.push(track.id);
            label = 'Set subtitle video policy';
            category = 'subtitle';
            break;
        }
        case 'track.reorder': {
            const tracks = getTracks(after, operation.payload.trackKind);
            reorderByAnchor(tracks, operation.payload.trackId, operation.payload, operation);
            affectedIds.push(operation.payload.trackId);
            label = 'Reorder tracks';
            category = 'track';
            break;
        }
        case 'track.reorder-clips':
            if (operation.payload.trackKind === 'audio') {
                const track = requireAudioTrack(after, operation.payload.trackId, operation);
                assertUnlocked(track.locked, operation, track.id);
                reorderByAnchor(track.clips, operation.payload.clipId, operation.payload, operation);
            } else {
                const track = requireSubtitleTrack(after, operation.payload.trackId, operation);
                assertUnlocked(track.isLocked, operation, track.id);
                reorderByAnchor(track.subtitles, operation.payload.clipId, operation.payload, operation);
            }
            affectedIds.push(operation.payload.clipId);
            label = 'Reorder track items';
            category = 'track';
            break;
        case 'track.delete':
            after = deleteTrack(after, operation, transforms, affectedIds);
            label = 'Delete track';
            category = 'track';
            break;
        case 'video-clip.insert': {
            const track = requireVideoTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.locked, operation, track.id);
            requireVideoSource(after, operation.payload.sourceId, operation);
            const clipId = operation.payload.clipId
                ?? context.ids.generate('clip', `${context.commandScope}:${operation.operationId}:clip`);
            assertUniqueId(after, clipId, operation);
            aliases[`$${operation.operationId}.clipId`] = clipId;
            after.videoClips.push({
                id: clipId,
                sourceId: operation.payload.sourceId,
                trackId: operation.payload.trackId,
                timelineStartFrame: operation.payload.timelineStartFrame,
                sourceStart: operation.payload.sourceStartSeconds,
                sourceEnd: operation.payload.sourceEndSeconds,
                audio: structuredClone(operation.payload.audio),
            });
            affectedIds.push(clipId, track.id);
            label = 'Insert video clip';
            category = 'video';
            break;
        }
        case 'video-clip.move': {
            const clip = requireOrdinaryVideoClip(after, operation.payload.clipId, operation);
            const currentTrack = requireVideoTrack(after, clip.trackId, operation);
            const targetTrack = requireVideoTrack(after, operation.payload.targetTrackId, operation);
            assertUnlocked(currentTrack.locked || targetTrack.locked, operation, currentTrack.locked ? currentTrack.id : targetTrack.id);
            if (clip.trackId === targetTrack.id && clip.timelineStartFrame === operation.payload.timelineStartFrame) {
                return noop(document, 'unchanged', 'Move video clip', 'video');
            }
            clip.trackId = targetTrack.id;
            clip.timelineStartFrame = operation.payload.timelineStartFrame;
            transforms = [{
                kind: 'moved',
                target: { kind: 'video-clip', clipId: clip.id },
            }];
            affectedIds.push(clip.id, targetTrack.id);
            label = 'Move video clip';
            category = 'video';
            break;
        }
        case 'video-clip.trim': {
            const clip = requireOrdinaryVideoClip(after, operation.payload.clipId, operation);
            const track = requireVideoTrack(after, clip.trackId, operation);
            assertUnlocked(track.locked, operation, track.id);
            if (clip.sourceStart === operation.payload.sourceStartSeconds
                && clip.sourceEnd === operation.payload.sourceEndSeconds
                && (operation.payload.timelineStartFrame === undefined
                    || clip.timelineStartFrame === operation.payload.timelineStartFrame)) {
                return noop(document, 'unchanged', 'Trim video clip', 'video');
            }
            clip.sourceStart = operation.payload.sourceStartSeconds;
            clip.sourceEnd = operation.payload.sourceEndSeconds;
            if (operation.payload.timelineStartFrame !== undefined) {
                clip.timelineStartFrame = operation.payload.timelineStartFrame;
            }
            transforms = [{ kind: 'trimmed', target: { kind: 'video-clip', clipId: clip.id } }];
            affectedIds.push(clip.id);
            label = 'Trim video clip';
            category = 'video';
            break;
        }
        case 'video-clip.split': {
            const clip = requireOrdinaryVideoClip(after, operation.payload.clipId, operation);
            const track = requireVideoTrack(after, clip.trackId, operation);
            assertUnlocked(track.locked, operation, track.id);
            const placement = getVideoClipPlacementV4(after, clip);
            if (operation.payload.atFrame <= placement.startFrame
                || operation.payload.atFrame >= placement.endFrame) {
                throw invalidOperation(operation, 'Video split frame must be inside the clip.');
            }
            const rightClipId = operation.payload.rightClipId
                ?? context.ids.generate('clip', `${context.commandScope}:${operation.operationId}:right`);
            assertUniqueId(after, rightClipId, operation);
            aliases[`$${operation.operationId}.leftClipId`] = clip.id;
            aliases[`$${operation.operationId}.rightClipId`] = rightClipId;
            const sourceSplit = clip.sourceStart + framesToSeconds(
                operation.payload.atFrame - placement.startFrame,
                after.renderProfile.fps,
            );
            const right: VideoClipV4 = {
                ...structuredClone(clip),
                id: rightClipId,
                timelineStartFrame: operation.payload.atFrame,
                sourceStart: sourceSplit,
            };
            clip.sourceEnd = sourceSplit;
            after.videoClips.splice(after.videoClips.indexOf(clip) + 1, 0, right);
            transforms = [{
                kind: 'split',
                target: { kind: 'video-clip', clipId: clip.id },
                childTargets: [
                    { kind: 'video-clip', clipId: clip.id },
                    { kind: 'video-clip', clipId: right.id },
                ],
            }];
            affectedIds.push(clip.id, right.id);
            label = 'Split video clip';
            category = 'video';
            break;
        }
        case 'video-clip.delete': {
            const clip = requireOrdinaryVideoClip(after, operation.payload.clipId, operation);
            const track = requireVideoTrack(after, clip.trackId, operation);
            assertUnlocked(track.locked, operation, track.id);
            after.videoClips = after.videoClips.filter((value) => value.id !== clip.id);
            transforms = [{ kind: 'deleted', target: { kind: 'video-clip', clipId: clip.id } }];
            affectedIds.push(clip.id);
            label = 'Delete video clip';
            category = 'video';
            break;
        }
        case 'video-clip.duplicate': {
            const clip = requireOrdinaryVideoClip(after, operation.payload.clipId, operation);
            const targetTrack = requireVideoTrack(after, operation.payload.targetTrackId ?? clip.trackId, operation);
            assertUnlocked(targetTrack.locked, operation, targetTrack.id);
            const duplicateId = operation.payload.duplicateId
                ?? context.ids.generate('clip', `${context.commandScope}:${operation.operationId}:duplicate`);
            assertUniqueId(after, duplicateId, operation);
            aliases[`$${operation.operationId}.clipId`] = duplicateId;
            after.videoClips.push({
                ...structuredClone(clip),
                id: duplicateId,
                trackId: targetTrack.id,
                timelineStartFrame: operation.payload.timelineStartFrame
                    ?? clip.timelineStartFrame + getVideoClipDurationFramesV4(clip, after.renderProfile),
            });
            affectedIds.push(duplicateId);
            label = 'Duplicate video clip';
            category = 'video';
            break;
        }
        case 'video-clip.set-order':
            return noop(document, 'order-not-meaningful', 'Set video clip order', 'video');
        case 'video-clip.set-audio': {
            const clip = requireOrdinaryVideoClip(after, operation.payload.clipId, operation);
            const track = requireVideoTrack(after, clip.trackId, operation);
            assertUnlocked(track.locked, operation, track.id);
            if (same(clip.audio, operation.payload.audio)) {
                return noop(document, 'unchanged', 'Set video clip audio', 'audio');
            }
            clip.audio = structuredClone(operation.payload.audio);
            affectedIds.push(clip.id);
            label = 'Set video clip audio';
            category = 'audio';
            break;
        }
        case 'video-clip.detach-audio': {
            const clip = requireOrdinaryVideoClip(after, operation.payload.clipId, operation);
            const videoTrack = requireVideoTrack(after, clip.trackId, operation);
            const audioTrack = requireAudioTrack(after, operation.payload.audioTrackId, operation);
            assertUnlocked(
                videoTrack.locked || audioTrack.locked,
                operation,
                videoTrack.locked ? videoTrack.id : audioTrack.id,
            );
            if (!clip.audio || clip.audio.linkState === 'detached') {
                return noop(document, 'unchanged', 'Detach video audio', 'audio');
            }
            const detachedClipId = operation.payload.detachedClipId
                ?? context.ids.generate('clip', `${context.commandScope}:${operation.operationId}:audio`);
            assertUniqueId(after, detachedClipId, operation);
            const detached: VideoSourceAudioClip = {
                id: detachedClipId,
                timelineStartFrame: clip.timelineStartFrame,
                muted: clip.audio.muted,
                gainDb: clip.audio.gainDb,
                source: { kind: 'video-source-audio', videoSourceId: clip.sourceId },
                sourceStart: clip.sourceStart,
                sourceEnd: clip.sourceEnd,
                fadeInFrames: clip.audio.fadeInFrames,
                fadeOutFrames: clip.audio.fadeOutFrames,
            };
            audioTrack.clips.push(detached);
            clip.audio = { ...clip.audio, linkState: 'detached', muted: true };
            aliases[`$${operation.operationId}.audioClipId`] = detachedClipId;
            affectedIds.push(clip.id, detachedClipId, audioTrack.id);
            label = 'Detach video audio';
            category = 'audio';
            break;
        }
        case 'video-clip.relink-audio': {
            const clip = requireOrdinaryVideoClip(after, operation.payload.videoClipId, operation);
            const track = requireAudioTrack(after, operation.payload.audioTrackId, operation);
            const detached = track.clips.find((value) => value.id === operation.payload.audioClipId);
            if (!detached || detached.source.kind !== 'video-source-audio'
                || detached.source.videoSourceId !== clip.sourceId) {
                throw invalidOperation(operation, 'Relink requires detached audio from the same source.');
            }
            const detachedVideoAudio = detached as VideoSourceAudioClip;
            const videoTrack = requireVideoTrack(after, clip.trackId, operation);
            assertUnlocked(
                videoTrack.locked || track.locked,
                operation,
                videoTrack.locked ? videoTrack.id : track.id,
            );
            track.clips = track.clips.filter((value) => value.id !== detachedVideoAudio.id);
            clip.audio = {
                linkState: 'linked',
                muted: detachedVideoAudio.muted,
                gainDb: detachedVideoAudio.gainDb,
                fadeInFrames: detachedVideoAudio.fadeInFrames,
                fadeOutFrames: detachedVideoAudio.fadeOutFrames,
            };
            affectedIds.push(clip.id, detachedVideoAudio.id, track.id);
            label = 'Relink video audio';
            category = 'audio';
            break;
        }
        case 'audio-clip.insert': {
            const track = requireAudioTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.locked, operation, track.id);
            assertUniqueId(after, operation.payload.clip.id, operation);
            track.clips.push(structuredClone(operation.payload.clip));
            track.clips.sort(compareTimelineItems);
            aliases[`$${operation.operationId}.clipId`] = operation.payload.clip.id;
            affectedIds.push(operation.payload.clip.id, track.id);
            label = 'Insert audio clip';
            category = 'audio';
            break;
        }
        case 'audio-clip.move': {
            const located = requireAudioClip(after, operation.payload.clipId, operation);
            if (located.clip.timelineStartFrame === operation.payload.timelineStartFrame
                && located.track.id === operation.payload.targetTrackId) {
                return noop(document, 'unchanged', 'Move audio clip', 'audio');
            }
            const tracks = moveAudioClipInTracks(
                after.audioTracks,
                audioSources(after),
                after.renderProfile,
                operation.payload.clipId,
                operation.payload.targetTrackId,
                operation.payload.timelineStartFrame,
            );
            if (!tracks) throw overlapOrLocked(operation, located.track.locked, located.clip.id);
            after.audioTracks = tracks;
            transforms = [{
                kind: 'moved',
                target: { kind: 'audio-clip', trackId: located.track.id, clipId: located.clip.id },
                afterTarget: {
                    kind: 'audio-clip',
                    trackId: operation.payload.targetTrackId,
                    clipId: located.clip.id,
                },
            }];
            affectedIds.push(located.clip.id, operation.payload.targetTrackId);
            label = 'Move audio clip';
            category = 'audio';
            break;
        }
        case 'audio-clip.trim': {
            const located = requireAudioClip(after, operation.payload.clipId, operation);
            assertUnlocked(located.track.locked, operation, located.track.id);
            if (located.clip.source.kind === 'audio-source') {
                const imported = located.clip as Extract<AudioClip, { source: { kind: 'audio-source' } }>;
                const range = operation.payload.sourceRange;
                const source = after.audioSources.find(
                    (candidate) => candidate.id === imported.source.audioSourceId,
                );
                if (!source) throw notFound(operation, imported.source.audioSourceId, 'audio source');
                if (range.domain !== 'native-samples'
                    || range.audioSourceId !== source.id
                    || range.nativeSampleRateHz !== source.nativeSampleRate) {
                    throw invalidOperation(
                        operation,
                        'Imported-audio trims require matching native-samples source identity and rate.',
                    );
                }
                if (imported.sourceStartSample === range.startNativeSample
                    && imported.sourceEndSample === range.endNativeSample) {
                    return noop(document, 'unchanged', 'Trim audio clip', 'audio');
                }
                imported.sourceStartSample = range.startNativeSample;
                imported.sourceEndSample = range.endNativeSample;
                imported.timelineDurationSamples = nativeBoundaryToOutputSample(
                    imported.sourceEndSample,
                    source.nativeSampleRate,
                ) - nativeBoundaryToOutputSample(
                    imported.sourceStartSample,
                    source.nativeSampleRate,
                );
                Object.assign(imported, clampSampleFades(
                    imported,
                    imported.sourceEndSample - imported.sourceStartSample,
                ));
            } else {
                const videoAudio = located.clip as VideoSourceAudioClip;
                const range = operation.payload.sourceRange;
                if (range.domain !== 'seconds'
                    || range.videoSourceId !== videoAudio.source.videoSourceId) {
                    throw invalidOperation(
                        operation,
                        'Detached-video-audio trims require the matching seconds source identity.',
                    );
                }
                if (videoAudio.sourceStart === range.startSeconds
                    && videoAudio.sourceEnd === range.endSeconds) {
                    return noop(document, 'unchanged', 'Trim audio clip', 'audio');
                }
                videoAudio.sourceStart = range.startSeconds;
                videoAudio.sourceEnd = range.endSeconds;
                Object.assign(videoAudio, clampFrameFades(
                    videoAudio,
                    getVideoClipDurationFramesV4(videoAudio, after.renderProfile),
                ));
            }
            transforms = [{
                kind: 'trimmed',
                target: { kind: 'audio-clip', trackId: located.track.id, clipId: located.clip.id },
            }];
            affectedIds.push(located.clip.id);
            label = 'Trim audio clip';
            category = 'audio';
            break;
        }
        case 'audio-clip.split': {
            const located = requireAudioClip(after, operation.payload.clipId, operation);
            const rightClipId = operation.payload.rightClipId
                ?? context.ids.generate('clip', `${context.commandScope}:${operation.operationId}:right`);
            const tracks = splitAudioClipInTracks(
                after.audioTracks,
                audioSources(after),
                after.renderProfile,
                located.clip.id,
                outputSampleToCoveringFrame(operation.payload.atOutputSample, after.renderProfile.fps),
                rightClipId,
            );
            if (!tracks) throw invalidOperation(operation, 'Audio split boundary is invalid or locked.');
            after.audioTracks = tracks;
            aliases[`$${operation.operationId}.leftClipId`] = located.clip.id;
            aliases[`$${operation.operationId}.rightClipId`] = rightClipId;
            transforms = [{
                kind: 'split',
                target: { kind: 'audio-clip', trackId: located.track.id, clipId: located.clip.id },
                childTargets: [
                    { kind: 'audio-clip', trackId: located.track.id, clipId: located.clip.id },
                    { kind: 'audio-clip', trackId: located.track.id, clipId: rightClipId },
                ],
            }];
            affectedIds.push(located.clip.id, rightClipId);
            label = 'Split audio clip';
            category = 'audio';
            break;
        }
        case 'audio-clip.delete': {
            const located = requireAudioClip(after, operation.payload.clipId, operation);
            assertUnlocked(located.track.locked, operation, located.track.id);
            located.track.clips = located.track.clips.filter((clip) => clip.id !== located.clip.id);
            transforms = [{
                kind: 'deleted',
                target: { kind: 'audio-clip', trackId: located.track.id, clipId: located.clip.id },
            }];
            affectedIds.push(located.clip.id);
            label = 'Delete audio clip';
            category = 'audio';
            break;
        }
        case 'audio-clip.duplicate': {
            const located = requireAudioClip(after, operation.payload.clipId, operation);
            const target = requireAudioTrack(after, operation.payload.targetTrackId ?? located.track.id, operation);
            assertUnlocked(target.locked, operation, target.id);
            const duplicateId = operation.payload.duplicateId
                ?? context.ids.generate('clip', `${context.commandScope}:${operation.operationId}:duplicate`);
            assertUniqueId(after, duplicateId, operation);
            target.clips.push({
                ...structuredClone(located.clip),
                id: duplicateId,
                timelineStartFrame: operation.payload.timelineStartFrame ?? located.clip.timelineStartFrame,
            });
            target.clips.sort(compareTimelineItems);
            aliases[`$${operation.operationId}.clipId`] = duplicateId;
            affectedIds.push(duplicateId, target.id);
            label = 'Duplicate audio clip';
            category = 'audio';
            break;
        }
        case 'audio-clip.set-order': {
            const track = requireAudioTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.locked, operation, track.id);
            reorderByAnchor(track.clips, operation.payload.clipId, operation.payload, operation);
            affectedIds.push(operation.payload.clipId);
            label = 'Set audio clip order';
            category = 'audio';
            break;
        }
        case 'audio-clip.set-gain': {
            const located = requireAudioClip(after, operation.payload.clipId, operation);
            assertUnlocked(located.track.locked, operation, located.track.id);
            if (located.clip.gainDb === operation.payload.gainDb) {
                return noop(document, 'unchanged', 'Set audio clip gain', 'audio');
            }
            located.clip.gainDb = operation.payload.gainDb;
            affectedIds.push(located.clip.id);
            label = 'Set audio clip gain';
            category = 'audio';
            break;
        }
        case 'audio-clip.set-fades': {
            const located = requireAudioClip(after, operation.payload.clipId, operation);
            assertUnlocked(located.track.locked, operation, located.track.id);
            const previous = JSON.stringify(located.clip);
            if (located.clip.source.kind === 'audio-source') {
                const imported = located.clip as Extract<AudioClip, { source: { kind: 'audio-source' } }>;
                const source = after.audioSources.find(
                    (candidate) => candidate.id === imported.source.audioSourceId,
                );
                if (!source) throw notFound(operation, imported.source.audioSourceId, 'audio source');
                imported.fadeInSamples = outputSampleToNearestNativeBoundary(
                    operation.payload.fadeInOutputSamples48k,
                    source.nativeSampleRate,
                    AUDIO_OUTPUT_SAMPLE_RATE,
                );
                imported.fadeOutSamples = outputSampleToNearestNativeBoundary(
                    operation.payload.fadeOutOutputSamples48k,
                    source.nativeSampleRate,
                    AUDIO_OUTPUT_SAMPLE_RATE,
                );
                Object.assign(imported, clampSampleFades(
                    imported,
                    imported.sourceEndSample - imported.sourceStartSample,
                ));
            } else {
                const videoAudio = located.clip as VideoSourceAudioClip;
                videoAudio.fadeInFrames = outputSampleToCoveringFrame(
                    operation.payload.fadeInOutputSamples48k,
                    after.renderProfile.fps,
                );
                videoAudio.fadeOutFrames = outputSampleToCoveringFrame(
                    operation.payload.fadeOutOutputSamples48k,
                    after.renderProfile.fps,
                );
                Object.assign(videoAudio, clampFrameFades(
                    videoAudio,
                    getVideoClipDurationFramesV4(videoAudio, after.renderProfile),
                ));
            }
            if (previous === JSON.stringify(located.clip)) {
                return noop(document, 'unchanged', 'Set audio clip fades', 'audio');
            }
            affectedIds.push(located.clip.id);
            label = 'Set audio clip fades';
            category = 'audio';
            break;
        }
        case 'subtitle.insert': {
            const track = requireSubtitleTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            assertUniqueId(after, operation.payload.subtitle.id, operation);
            track.subtitles.push({
                id: operation.payload.subtitle.id,
                startTime: operation.payload.subtitle.startOutputSample / AUDIO_OUTPUT_SAMPLE_RATE,
                endTime: operation.payload.subtitle.endOutputSample / AUDIO_OUTPUT_SAMPLE_RATE,
                text: operation.payload.subtitle.text,
            });
            track.subtitles.sort(compareSubtitles);
            aliases[`$${operation.operationId}.subtitleId`] = operation.payload.subtitle.id;
            affectedIds.push(track.id, operation.payload.subtitle.id);
            label = 'Insert subtitle';
            category = 'subtitle';
            break;
        }
        case 'subtitle.update': {
            const { track, subtitle } = requireSubtitle(after, operation.payload.trackId, operation.payload.subtitleId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            if (subtitle.text === operation.payload.text) {
                return noop(document, 'unchanged', 'Update subtitle', 'subtitle');
            }
            subtitle.text = operation.payload.text;
            affectedIds.push(subtitle.id);
            label = 'Update subtitle';
            category = 'subtitle';
            break;
        }
        case 'subtitle.move': {
            const { track, subtitle } = requireSubtitle(after, operation.payload.trackId, operation.payload.subtitleId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            const duration = subtitle.endTime - subtitle.startTime;
            const startTime = operation.payload.startOutputSample / AUDIO_OUTPUT_SAMPLE_RATE;
            if (subtitle.startTime === startTime) return noop(document, 'unchanged', 'Move subtitle', 'subtitle');
            subtitle.startTime = startTime;
            subtitle.endTime = startTime + duration;
            track.subtitles.sort(compareSubtitles);
            transforms = [{
                kind: 'moved',
                target: { kind: 'subtitle', trackId: track.id, subtitleId: subtitle.id },
            }];
            affectedIds.push(subtitle.id);
            label = 'Move subtitle';
            category = 'subtitle';
            break;
        }
        case 'subtitle.trim': {
            const { track, subtitle } = requireSubtitle(after, operation.payload.trackId, operation.payload.subtitleId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            const start = operation.payload.startOutputSample / AUDIO_OUTPUT_SAMPLE_RATE;
            const end = operation.payload.endOutputSample / AUDIO_OUTPUT_SAMPLE_RATE;
            if (subtitle.startTime === start && subtitle.endTime === end) {
                return noop(document, 'unchanged', 'Trim subtitle', 'subtitle');
            }
            subtitle.startTime = start;
            subtitle.endTime = end;
            transforms = [{
                kind: 'trimmed',
                target: { kind: 'subtitle', trackId: track.id, subtitleId: subtitle.id },
            }];
            affectedIds.push(subtitle.id);
            label = 'Trim subtitle';
            category = 'subtitle';
            break;
        }
        case 'subtitle.split': {
            const { track, subtitle } = requireSubtitle(after, operation.payload.trackId, operation.payload.subtitleId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            const split = operation.payload.atOutputSample / AUDIO_OUTPUT_SAMPLE_RATE;
            if (split <= subtitle.startTime || split >= subtitle.endTime) {
                throw invalidOperation(operation, 'Subtitle split boundary must be inside the cue.');
            }
            const rightId = operation.payload.rightSubtitleId
                ?? context.ids.generate('subtitle', `${context.commandScope}:${operation.operationId}:right`);
            assertUniqueId(after, rightId, operation);
            const right = { ...structuredClone(subtitle), id: rightId, startTime: split };
            subtitle.endTime = split;
            track.subtitles.splice(track.subtitles.indexOf(subtitle) + 1, 0, right);
            aliases[`$${operation.operationId}.leftSubtitleId`] = subtitle.id;
            aliases[`$${operation.operationId}.rightSubtitleId`] = right.id;
            transforms = [{
                kind: 'split',
                target: { kind: 'subtitle', trackId: track.id, subtitleId: subtitle.id },
                childTargets: [
                    { kind: 'subtitle', trackId: track.id, subtitleId: subtitle.id },
                    { kind: 'subtitle', trackId: track.id, subtitleId: right.id },
                ],
            }];
            affectedIds.push(subtitle.id, right.id);
            label = 'Split subtitle';
            category = 'subtitle';
            break;
        }
        case 'subtitle.delete': {
            const { track, subtitle } = requireSubtitle(after, operation.payload.trackId, operation.payload.subtitleId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            track.subtitles = track.subtitles.filter((value) => value.id !== subtitle.id);
            transforms = [{
                kind: 'deleted',
                target: { kind: 'subtitle', trackId: track.id, subtitleId: subtitle.id },
            }];
            affectedIds.push(subtitle.id);
            label = 'Delete subtitle';
            category = 'subtitle';
            break;
        }
        case 'subtitle.set-order': {
            const track = requireSubtitleTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            reorderByAnchor(track.subtitles, operation.payload.subtitleId, operation.payload, operation);
            affectedIds.push(operation.payload.subtitleId);
            label = 'Set subtitle order';
            category = 'subtitle';
            break;
        }
        case 'subtitle.bulk-replace': {
            const track = requireSubtitleTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            const subtitles = operation.payload.subtitles.map((subtitle) => ({
                id: subtitle.id,
                startTime: subtitle.startOutputSample / AUDIO_OUTPUT_SAMPLE_RATE,
                endTime: subtitle.endOutputSample / AUDIO_OUTPUT_SAMPLE_RATE,
                text: subtitle.text,
            }));
            if (same(track.subtitles, subtitles)) {
                return noop(document, 'unchanged', 'Replace subtitles', 'subtitle');
            }
            track.subtitles = subtitles;
            affectedIds.push(track.id, ...track.subtitles.map((subtitle) => subtitle.id));
            label = 'Replace subtitles';
            category = 'subtitle';
            break;
        }
        case 'subtitle.set-track-style': {
            const track = requireSubtitleTrack(after, operation.payload.trackId, operation);
            assertUnlocked(track.isLocked, operation, track.id);
            if (same(track.style, operation.payload.style)) {
                return noop(document, 'unchanged', 'Set subtitle style', 'subtitle');
            }
            track.style = structuredClone(operation.payload.style);
            affectedIds.push(track.id);
            label = 'Set subtitle style';
            category = 'subtitle';
            break;
        }
        default:
            return assertNever(operation);
    }

    after.revision = before.revision + 1;
    const subtitleResponse = applyUnlinkedSubtitleVideoResponse(
        before,
        after,
        operation,
        context,
    );
    after = subtitleResponse.document;
    subtitleResponse.affectedIds.forEach((id) => affectedIds.push(id));
    if (transforms.length > 0 && before.narrative) {
        const integrated = planEditorialLinksForTargetTransforms({
            before,
            afterTargetCommand: after,
            guard: linkGuard(before),
            targetTransforms: transforms,
        });
        after = requireLinkSuccess(integrated, operation).document;
    }
    preflightDocument(after, operation);
    return { document: after, changed: true, affectedIds, label, category };
}

type SubtitleTimelineEdit =
    | { kind: 'delete'; startFrame: number; endFrame: number }
    | { kind: 'insert'; atFrame: number; durationFrames: number };

function applyUnlinkedSubtitleVideoResponse(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    operation: Exclude<EditorSemanticOperation, { type: `narrative.${string}` | `link.${string}` }>,
    context: EditorPlannerContext,
): { document: EditorDocumentV4; affectedIds: string[] } {
    if (before.globalEditingMode !== 'ripple'
        || (operation.type !== 'video-clip.move'
            && operation.type !== 'video-clip.trim'
            && operation.type !== 'video-clip.delete')) {
        return { document: after, affectedIds: [] };
    }
    const beforeClip = requireOrdinaryVideoClip(before, operation.payload.clipId, operation);
    const beforePlacement = getVideoClipPlacementV4(before, beforeClip);
    const movedVideo = operation.type === 'video-clip.move'
        ? {
            before: {
                start: beforePlacement.startFrame,
                end: beforePlacement.endFrame,
            },
            after: (() => {
                const afterClip = requireOrdinaryVideoClip(after, beforeClip.id, operation);
                const placement = getVideoClipPlacementV4(after, afterClip);
                return { start: placement.startFrame, end: placement.endFrame };
            })(),
        }
        : null;
    if (movedVideo && movedVideo.before.start === movedVideo.after.start) {
        return { document: after, affectedIds: [] };
    }
    const edits: SubtitleTimelineEdit[] = [];
    if (operation.type === 'video-clip.delete') {
        edits.push({
            kind: 'delete',
            startFrame: beforePlacement.startFrame,
            endFrame: beforePlacement.endFrame,
        });
    } else if (operation.type === 'video-clip.trim') {
        const afterClip = requireOrdinaryVideoClip(after, beforeClip.id, operation);
        const afterPlacement = getVideoClipPlacementV4(after, afterClip);
        const oldDuration = beforePlacement.endFrame - beforePlacement.startFrame;
        const newDuration = afterPlacement.endFrame - afterPlacement.startFrame;
        if (newDuration < oldDuration) {
            edits.push({
                kind: 'delete',
                startFrame: beforePlacement.startFrame + newDuration,
                endFrame: beforePlacement.endFrame,
            });
        } else if (newDuration > oldDuration) {
            edits.push({
                kind: 'insert',
                atFrame: beforePlacement.endFrame,
                durationFrames: newDuration - oldDuration,
            });
        }
    }
    if (!movedVideo && edits.length === 0) {
        return { document: after, affectedIds: [] };
    }

    const explicitlyLinked = new Set(before.dependentLinks.flatMap((link) => (
        link.target.kind === 'subtitle'
            ? [`${link.target.trackId}\u0000${link.target.subtitleId}`]
            : []
    )));
    const affectedIds = new Set<string>();
    const lockedChangedTracks: string[] = [];
    const subtitleTracks = before.subtitleTracks.map((track) => {
        if (track.unlinkedVideoEditResponse === 'stay-absolute') return structuredClone(track);
        let fragmentOrdinal = 0;
        const subtitles = track.subtitles.flatMap((subtitle) => {
            if (explicitlyLinked.has(`${track.id}\u0000${subtitle.id}`)) {
                return [structuredClone(subtitle)];
            }
            let next: Subtitle[];
            if (track.unlinkedVideoEditResponse === 'remove-with-deleted-video-range') {
                next = edits.some((edit) => edit.kind === 'delete'
                    && subtitleOverlapsDeletedVideoRange(subtitle, edit, before))
                    ? []
                    : [structuredClone(subtitle)];
            } else if (movedVideo) {
                next = [applySubtitleVideoMove(
                    subtitle,
                    movedVideo.before,
                    movedVideo.after,
                    before,
                )];
            } else {
                next = edits.reduce(
                    (fragments, edit) => fragments.flatMap((fragment) => (
                        applySubtitleTimelineEdit(fragment, edit, before, () => {
                            fragmentOrdinal += 1;
                            return context.ids.generate(
                                'subtitle',
                                `${context.commandScope}:${operation.operationId}`
                                    + `:${track.id}:${subtitle.id}:fragment:${fragmentOrdinal}`,
                            );
                        })
                    )),
                    [structuredClone(subtitle)],
                );
            }
            if (!same([subtitle], next)) {
                affectedIds.add(track.id);
                affectedIds.add(subtitle.id);
                next.forEach((value) => affectedIds.add(value.id));
            }
            return next;
        }).sort(compareSubtitles);
        if (track.isLocked && !same(track.subtitles, subtitles)) {
            lockedChangedTracks.push(track.id);
        }
        return { ...structuredClone(track), subtitles };
    });
    if (lockedChangedTracks.length > 0) {
        throw new EditorCommandError(
            'LOCKED_TARGET',
            'A locked subtitle track cannot apply its video-edit response.',
            { details: { operationId: operation.operationId, ids: lockedChangedTracks.sort() } },
        );
    }
    return {
        document: { ...after, subtitleTracks },
        affectedIds: Array.from(affectedIds).sort(),
    };
}

function subtitleOverlapsDeletedVideoRange(
    subtitle: Subtitle,
    edit: Extract<SubtitleTimelineEdit, { kind: 'delete' }>,
    document: EditorDocumentV4,
): boolean {
    const start = framesToSeconds(edit.startFrame, document.renderProfile.fps);
    const end = framesToSeconds(edit.endFrame, document.renderProfile.fps);
    return subtitle.startTime < end && subtitle.endTime > start;
}

function applySubtitleVideoMove(
    subtitle: Subtitle,
    before: { start: number; end: number },
    after: { start: number; end: number },
    document: EditorDocumentV4,
): Subtitle {
    const sourceStart = framesToSeconds(before.start, document.renderProfile.fps);
    const sourceEnd = framesToSeconds(before.end, document.renderProfile.fps);
    const destinationStart = framesToSeconds(after.start, document.renderProfile.fps);
    const duration = sourceEnd - sourceStart;
    if (subtitle.startTime < sourceEnd && subtitle.endTime > sourceStart) {
        const delta = destinationStart - sourceStart;
        return delta === 0
            ? structuredClone(subtitle)
            : {
                ...structuredClone(subtitle),
                startTime: subtitle.startTime + delta,
                endTime: subtitle.endTime + delta,
            };
    }
    let delta = 0;
    if (subtitle.startTime >= sourceEnd) delta -= duration;
    if (subtitle.startTime + delta >= destinationStart) delta += duration;
    return delta === 0
        ? structuredClone(subtitle)
        : {
            ...structuredClone(subtitle),
            startTime: subtitle.startTime + delta,
            endTime: subtitle.endTime + delta,
        };
}

function applySubtitleTimelineEdit(
    subtitle: Subtitle,
    edit: SubtitleTimelineEdit,
    document: EditorDocumentV4,
    createFragmentId: () => string,
): Subtitle[] {
    const toSeconds = (frame: number) => framesToSeconds(frame, document.renderProfile.fps);
    if (edit.kind === 'insert') {
        const at = toSeconds(edit.atFrame);
        const duration = toSeconds(edit.durationFrames);
        if (subtitle.endTime <= at) return [subtitle];
        if (subtitle.startTime >= at) {
            return [{
                ...subtitle,
                startTime: subtitle.startTime + duration,
                endTime: subtitle.endTime + duration,
            }];
        }
        return [
            { ...subtitle, endTime: at },
            {
                ...subtitle,
                id: createFragmentId(),
                startTime: at + duration,
                endTime: subtitle.endTime + duration,
            },
        ];
    }
    const start = toSeconds(edit.startFrame);
    const end = toSeconds(edit.endFrame);
    const duration = end - start;
    const fragments: Subtitle[] = [];
    if (subtitle.startTime < start) {
        fragments.push({ ...subtitle, endTime: Math.min(subtitle.endTime, start) });
    }
    if (subtitle.endTime > end) {
        fragments.push({
            ...subtitle,
            id: fragments.length === 0 ? subtitle.id : createFragmentId(),
            startTime: Math.max(subtitle.startTime, end) - duration,
            endTime: subtitle.endTime - duration,
        });
    }
    return fragments.filter((fragment) => fragment.endTime > fragment.startTime);
}

function applyNarrativeOperation(
    document: EditorDocumentV4,
    operation: Extract<EditorSemanticOperation, { type: `narrative.${string}` }>,
    context: EditorPlannerContext,
    aliases: Record<string, string>,
): OperationResult {
    const common = {
        document,
        guard: narrativeGuard(document),
        bodies: context.bodies,
        idFactory: narrativeIdFactory(operation, context, aliases),
        nowIso: context.nowIso,
    };
    let result: NarrativeCommandResult;
    switch (operation.type) {
        case 'narrative.activate':
            result = planActivateNarrative({
                ...common,
                selectedTrackIds: operation.payload.selectedTrackIds,
                recordIdBySourceId: operation.payload.recordIdBySourceId,
                ...(operation.payload.splitOnSpeakerChange === undefined
                    ? {}
                    : { splitOnSpeakerChange: operation.payload.splitOnSpeakerChange }),
            });
            break;
        case 'narrative.release-tracks':
            result = planReleaseNarrativeTracks({
                document,
                guard: common.guard,
                trackIds: operation.payload.trackIds,
                nowIso: context.nowIso,
            });
            break;
        case 'narrative.set-editing-mode':
            result = planChangeGlobalEditingMode({
                document,
                expectedDocumentRevision: document.revision,
                mode: operation.payload.mode,
            });
            break;
        case 'narrative.split-block':
            result = planSplitNarrativeBlock({
                ...common,
                blockId: operation.payload.blockId,
                splitSample: operation.payload.splitSample16k,
            });
            break;
        case 'narrative.merge-blocks':
            result = planMergeNarrativeBlocks({
                document,
                guard: common.guard,
                idFactory: common.idFactory,
                nowIso: context.nowIso,
                ...operation.payload,
            });
            break;
        case 'narrative.delete-words':
            result = planDeleteNarrativeWords({ ...common, ...operation.payload });
            break;
        case 'narrative.delete-range':
            result = planDeleteNarrativeRange({
                ...common,
                selection: {
                    start: {
                        blockId: operation.payload.start.blockId,
                        sample: operation.payload.start.sample16k,
                    },
                    end: {
                        blockId: operation.payload.end.blockId,
                        sample: operation.payload.end.sample16k,
                    },
                },
                ...(operation.payload.currentPlayheadFrame === undefined
                    ? {}
                    : { currentPlayheadFrame: operation.payload.currentPlayheadFrame }),
            });
            break;
        case 'narrative.trim-block':
            result = planTrimNarrativeBlock({
                ...common,
                blockId: operation.payload.blockId,
                side: operation.payload.side,
                sample: operation.payload.sample16k,
            });
            break;
        case 'narrative.reorder-blocks':
            result = planReorderNarrativeBlocks({
                document,
                guard: common.guard,
                nowIso: context.nowIso,
                ...operation.payload,
            });
            break;
        case 'narrative.insert-source-range':
            result = planInsertSourceRange({
                ...common,
                ...operation.payload,
                sourceRange: {
                    start: operation.payload.sourceRange.startSample16k,
                    end: operation.payload.sourceRange.endSample16k,
                },
            });
            break;
        case 'narrative.recover-source-range':
            result = planRecoverSourceRange({
                ...common,
                ...operation.payload,
                sourceRange: {
                    start: operation.payload.sourceRange.startSample16k,
                    end: operation.payload.sourceRange.endSample16k,
                },
            });
            break;
        case 'narrative.extend-block':
            result = planExtendNarrativeBlock({
                ...common,
                blockId: operation.payload.blockId,
                newStartSample: operation.payload.newStartSample16k,
                newEndSample: operation.payload.newEndSample16k,
            });
            break;
        case 'narrative.set-word-text':
            result = planSetNarrativeWordText({
                document,
                guard: common.guard,
                bodies: common.bodies,
                nowIso: context.nowIso,
                ...operation.payload,
            });
            break;
        case 'narrative.set-word-speaker':
            result = planSetNarrativeWordSpeaker({
                document,
                guard: common.guard,
                bodies: common.bodies,
                nowIso: context.nowIso,
                ...operation.payload,
            });
            break;
        case 'narrative.set-speaker-visibility':
            result = planSetNarrativeSpeakerVisibility({
                document,
                guard: common.guard,
                nowIso: context.nowIso,
                ...operation.payload,
            });
            break;
        case 'narrative.change-block-margin':
            result = planChangeBlockMargin({
                document,
                guard: common.guard,
                nowIso: context.nowIso,
                blockId: operation.payload.blockId,
                side: operation.payload.side,
                policy: {
                    kind: 'margin',
                    mode: operation.payload.policy.mode,
                    requestedSamples: operation.payload.policy.requestedSamples16k,
                },
            });
            break;
        case 'narrative.change-global-margins':
            result = planChangeGlobalMargins({
                document,
                guard: common.guard,
                nowIso: context.nowIso,
                preSamples: operation.payload.preSamples16k,
                postSamples: operation.payload.postSamples16k,
            });
            break;
        case 'narrative.refine-boundary':
            result = planRefineNarrativeBoundary({
                ...common,
                blockId: operation.payload.blockId,
                side: operation.payload.side,
                chosenSample: operation.payload.chosenSample16k,
                algorithmVersion: operation.payload.algorithmVersion,
                origin: operation.payload.origin,
            });
            break;
        case 'narrative.delete-all-silences':
            result = planDeleteAllSilences({
                document,
                guard: common.guard,
                nowIso: context.nowIso,
                ...operation.payload,
            });
            break;
        default:
            return assertNever(operation);
    }
    if (result.kind === 'error') throw plannerError(operation, result.error);
    if (result.kind === 'noop') {
        return noop(document, result.code, operation.type, 'narrative');
    }

    let after = result.document;
    if (document.narrative && result.anchorTransforms.length > 0) {
        const integrated = planEditorialLinksForAnchorTransforms({
            before: document,
            afterNarrativeCommand: after,
            guard: linkGuard(document),
            anchorTransforms: result.anchorTransforms,
        });
        after = requireLinkSuccess(integrated, operation).document;
    }
    if (operation.type === 'narrative.activate' && after.narrative) {
        const discovered = planIntegrateDiscoveredEditorialOverlapLinks({
            document: after,
            guard: linkGuard(after),
            idFactory: linkIdFactory(operation, context, aliases),
        });
        if (discovered.kind === 'error') throw plannerError(operation, discovered.error);
        if (discovered.kind === 'success') after = discovered.document;
    }
    preflightDocument(after, operation);
    return {
        document: after,
        changed: true,
        affectedIds: narrativeAffectedIds(result),
        label: result.history.label ?? operation.type,
        category: 'narrative',
    };
}

function applyLinkOperation(
    document: EditorDocumentV4,
    operation: Extract<EditorSemanticOperation, { type: `link.${string}` }>,
    context: EditorPlannerContext,
    aliases: Record<string, string>,
): OperationResult {
    const guard = linkGuard(document);
    const idFactory = linkIdFactory(operation, context, aliases);
    let result: EditorialLinkPlanResult;
    switch (operation.type) {
        case 'link.discover-overlaps':
            result = planDiscoverEditorialOverlapLinks({ document, guard, idFactory });
            break;
        case 'link.create-overlap':
            result = planCreateManualOverlapLink({
                document,
                guard,
                idFactory,
                ...operation.payload,
            });
            break;
        case 'link.bind-target':
            result = planBindEditorialTarget({
                document,
                guard,
                idFactory,
                target: operation.payload.target,
                anchorBlockId: operation.payload.anchorBlockId,
                activeStartSample: operation.payload.activeStartSample16k,
                activeEndSample: operation.payload.activeEndSample16k,
                ...(operation.payload.followPolicy === undefined
                    ? {}
                    : { followPolicy: operation.payload.followPolicy }),
            });
            break;
        case 'link.unlink-target':
            result = planUnlinkEditorialTarget({ document, guard, ...operation.payload });
            break;
        case 'link.unbind-target':
            result = planUnbindEditorialTarget({ document, guard, ...operation.payload });
            break;
        case 'link.reanchor':
            result = planReanchorEditorialLink({ document, guard, ...operation.payload });
            break;
        case 'link.set-follow-policy':
            result = planSetEditorialLinkFollowPolicy({ document, guard, ...operation.payload });
            break;
        default:
            return assertNever(operation);
    }
    if (result.kind === 'error') throw plannerError(operation, result.error);
    if (result.kind === 'noop') return noop(document, result.code, operation.type, 'link');
    result.linkMutations.forEach((mutation) => {
        if (mutation.kind === 'created') {
            aliases[`$${operation.operationId}.linkId`] = mutation.link.id;
        }
    });
    preflightDocument(result.document, operation);
    return {
        document: result.document,
        changed: true,
        affectedIds: result.linkMutations.flatMap((mutation) => (
            mutation.kind === 'updated'
                ? [mutation.after.id]
                : [mutation.link.id]
        )),
        label: result.history.label ?? operation.type,
        category: 'link',
    };
}

function deleteTrack(
    document: EditorDocumentV4,
    operation: Extract<EditorSemanticOperation, { type: 'track.delete' }>,
    transforms: EditorialDirectTargetTransform[],
    affectedIds: string[],
): EditorDocumentV4 {
    const after = document;
    const { trackKind, trackId, policy, rehomeTrackId } = operation.payload;
    const track = requireTrack(after, trackKind, trackId, operation);
    const locked = trackKind === 'video'
        ? (track as EditorDocumentV4['videoTracks'][number]).locked
        : trackKind === 'audio'
            ? (track as AudioTrack).locked
            : (track as SubtitleTrackV4).isLocked;
    assertUnlocked(locked, operation, trackId);

    if (trackKind === 'video') {
        const clips = after.videoClips.filter((clip) => clip.trackId === trackId);
        if (after.videoTracks.length === 1) {
            throw invalidOperation(operation, 'The final video track cannot be deleted.');
        }
        if (after.narrative?.controlledTrackIds.includes(trackId)) {
            throw invalidOperation(operation, 'Narrative-controlled tracks must be released first.');
        }
        handleTrackContents(policy, clips.length, operation);
        if (policy === 'rehome') {
            const target = requireVideoTrack(
                after,
                requireDistinctRehome(rehomeTrackId, trackId, operation),
                operation,
            );
            assertUnlocked(target.locked, operation, target.id);
            clips.forEach((clip) => {
                clip.trackId = target.id;
                transforms.push({
                    kind: 'moved',
                    target: { kind: 'video-clip', clipId: clip.id },
                });
            });
        } else if (policy === 'delete-contents') {
            after.videoClips = after.videoClips.filter((clip) => clip.trackId !== trackId);
            clips.forEach((clip) => transforms.push({
                kind: 'deleted',
                target: { kind: 'video-clip', clipId: clip.id },
            }));
        }
        after.videoTracks = after.videoTracks.filter((value) => value.id !== trackId);
        affectedIds.push(trackId, ...clips.map((clip) => clip.id));
        return after;
    }

    if (trackKind === 'audio') {
        const source = track as AudioTrack;
        handleTrackContents(policy, source.clips.length, operation);
        if (policy === 'rehome') {
            const target = requireAudioTrack(
                after,
                requireDistinctRehome(rehomeTrackId, trackId, operation),
                operation,
            );
            assertUnlocked(target.locked, operation, target.id);
            source.clips.forEach((clip) => {
                target.clips.push(clip);
                transforms.push({
                    kind: 'moved',
                    target: { kind: 'audio-clip', trackId, clipId: clip.id },
                    afterTarget: { kind: 'audio-clip', trackId: target.id, clipId: clip.id },
                });
            });
            target.clips.sort(compareTimelineItems);
        } else if (policy === 'delete-contents') {
            source.clips.forEach((clip) => transforms.push({
                kind: 'deleted',
                target: { kind: 'audio-clip', trackId, clipId: clip.id },
            }));
        }
        after.audioTracks = after.audioTracks.filter((value) => value.id !== trackId);
        affectedIds.push(trackId, ...source.clips.map((clip) => clip.id));
        return after;
    }

    const source = track as SubtitleTrackV4;
    handleTrackContents(policy, source.subtitles.length, operation);
    if (policy === 'rehome') {
        const target = requireSubtitleTrack(
            after,
            requireDistinctRehome(rehomeTrackId, trackId, operation),
            operation,
        );
        assertUnlocked(target.isLocked, operation, target.id);
        source.subtitles.forEach((subtitle) => {
            target.subtitles.push(subtitle);
            transforms.push({
                kind: 'moved',
                target: { kind: 'subtitle', trackId, subtitleId: subtitle.id },
                afterTarget: { kind: 'subtitle', trackId: target.id, subtitleId: subtitle.id },
            });
        });
        target.subtitles.sort(compareSubtitles);
    } else if (policy === 'delete-contents') {
        source.subtitles.forEach((subtitle) => transforms.push({
            kind: 'deleted',
            target: { kind: 'subtitle', trackId, subtitleId: subtitle.id },
        }));
    }
    after.subtitleTracks = after.subtitleTracks.filter((value) => value.id !== trackId);
    if (after.activeSubtitleTrackId === trackId) {
        after.activeSubtitleTrackId = after.subtitleTracks[0]?.id ?? null;
    }
    affectedIds.push(trackId, ...source.subtitles.map((subtitle) => subtitle.id));
    return after;
}

function narrativeGuard(document: EditorDocumentV4): NarrativeCommandGuard {
    return {
        expectedDocumentRevision: document.revision,
        expectedMode: document.globalEditingMode,
        ...(document.narrative ? { expectedNarrativeRevision: document.narrative.revision } : {}),
    };
}

function linkGuard(document: EditorDocumentV4): EditorialLinkCommandGuard {
    return {
        expectedDocumentRevision: document.revision,
        expectedMode: document.globalEditingMode,
        ...(document.narrative ? { expectedNarrativeRevision: document.narrative.revision } : {}),
    };
}

function narrativeIdFactory(
    operation: EditorSemanticOperation,
    context: EditorPlannerContext,
    aliases: Record<string, string>,
): NarrativeIdFactory {
    const counts = new Map<string, number>();
    return (kind) => {
        const ordinal = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, ordinal);
        const id = context.ids.generate(
            kind,
            `${context.commandScope}:${operation.operationId}:${kind}:${ordinal}`,
        );
        aliases[`$${operation.operationId}.${kind}Id${ordinal === 1 ? '' : ordinal}`] = id;
        return id;
    };
}

function linkIdFactory(
    operation: EditorSemanticOperation,
    context: EditorPlannerContext,
    aliases: Record<string, string>,
): EditorialLinkIdFactory {
    const counts = new Map<string, number>();
    return (kind) => {
        const ordinal = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, ordinal);
        const id = context.ids.generate(
            kind,
            `${context.commandScope}:${operation.operationId}:${kind}:${ordinal}`,
        );
        aliases[`$${operation.operationId}.${kind}Id${ordinal === 1 ? '' : ordinal}`] = id;
        return id;
    };
}

function requireLinkSuccess(
    result: EditorialLinkPlanResult,
    operation: EditorSemanticOperation,
): Extract<EditorialLinkPlanResult, { kind: 'success' }> {
    if (result.kind === 'error') throw plannerError(operation, result.error);
    if (result.kind === 'noop') {
        throw invalidOperation(operation, 'Dependent link integration unexpectedly produced no proposal.');
    }
    return result;
}

function plannerError(
    operation: EditorSemanticOperation,
    error: { code: string; message: string; ids: string[] },
): EditorCommandError {
    const code = error.code.includes('locked')
        ? 'LOCKED_TARGET'
        : error.code.includes('collision') || error.code.includes('overlap')
            ? 'OVERLAP_CONFLICT'
            : error.code.includes('stale')
                ? 'REVISION_CONFLICT'
                : error.code.includes('missing')
                    ? 'NOT_FOUND'
                    : 'INVALID_OPERATION';
    return new EditorCommandError(code, error.message, {
        details: { operationId: operation.operationId, ids: [...error.ids] },
    });
}

function preflightDocument(document: EditorDocumentV4, operation: EditorSemanticOperation): void {
    try {
        buildVideoTrackPlacementsV4(document);
    } catch (error) {
        throw new EditorCommandError('OVERLAP_CONFLICT', 'The operation creates an invalid video placement.', {
            details: { operationId: operation.operationId },
            cause: error,
        });
    }
}

function resolveOperationAliases(
    operation: EditorSemanticOperation,
    aliases: Readonly<Record<string, string>>,
): EditorSemanticOperation {
    const resolve = (value: unknown, field?: string): unknown => {
        if (typeof value === 'string'
            && field !== undefined
            && ALIAS_REFERENCE_FIELDS.has(field)
            && EDITOR_ALIAS_PATTERN.test(value)) {
            const resolved = aliases[value];
            if (!resolved) {
                throw new EditorCommandError('INVALID_OPERATION', `Alias "${value}" is unresolved.`, {
                    details: { operationId: operation.operationId },
                });
            }
            return resolved;
        }
        if (Array.isArray(value)) {
            return value.map((nested) => resolve(nested, field));
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                    .map(([key, nested]) => [key, resolve(nested, key)]),
            );
        }
        return value;
    };
    return {
        ...structuredClone(operation),
        payload: resolve(operation.payload),
    } as EditorSemanticOperation;
}

const EDITOR_ALIAS_PATTERN = /^\$[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z][A-Za-z0-9_-]*$/;

// This set mirrors fields using OpaqueIdOrAlias in operations.schema.json. Content fields such as
// names and text remain opaque even when their value happens to look like an alias.
const ALIAS_REFERENCE_FIELDS = new Set([
    'afterId',
    'anchorBlockId',
    'audioClipId',
    'audioSourceId',
    'audioTrackId',
    'beforeId',
    'beforeTrackId',
    'blockId',
    'blockIds',
    'clipId',
    'destinationTrackId',
    'detachedClipId',
    'duplicateId',
    'firstBlockId',
    'firstWordId',
    'id',
    'lastBlockId',
    'lastWordId',
    'leftBlockId',
    'rehomeTrackId',
    'rightBlockId',
    'rightClipId',
    'rightSubtitleId',
    'selectedTrackIds',
    'sourceId',
    'speakerId',
    'subtitleId',
    'targetTrackId',
    'trackId',
    'trackIds',
    'videoClipId',
    'videoSourceId',
    'wordId',
]);

function assertHydratedCatalog<
    TDescriptor extends { id: string; originalName: string; mimeType: string; size: number; lastModified: number },
>(
    descriptors: readonly TDescriptor[],
    hydrated: readonly (TDescriptor & {
        handle: VerifiedMediaHandleV1;
        fileMetadata: { name: string; type: string; size: number; lastModified: number };
    })[],
    kind: string,
): void {
    if (descriptors.length !== hydrated.length) {
        throw new EditorCommandError('INVALID_DOCUMENT', `${kind} asset hydration is incomplete.`);
    }
    const byId = new Map(hydrated.map((value) => [value.id, value]));
    descriptors.forEach((descriptor) => {
        const value = byId.get(descriptor.id);
        if (!value
            || !same(descriptor, omitFileMetadata(value))
            || value.fileMetadata.name !== descriptor.originalName
            || value.fileMetadata.type !== descriptor.mimeType
            || value.fileMetadata.size !== descriptor.size
            || value.fileMetadata.lastModified !== descriptor.lastModified
            || value.handle.identity.byteLength !== descriptor.size
            || value.handle.identity.descriptorFingerprint !== (
                'fingerprint' in descriptor ? String(descriptor.fingerprint) : ''
            )
            || !/^sha256:[a-f0-9]{64}$/.test(value.handle.identity.contentDigest)) {
            throw new EditorCommandError('INVALID_DOCUMENT', `${kind} asset identity changed during hydration.`);
        }
    });
}

function omitFileMetadata<T extends object>(
    value: T & { fileMetadata: unknown; handle: unknown },
): Omit<T, 'fileMetadata' | 'handle'> {
    const { fileMetadata, handle, ...descriptor } = value;
    void fileMetadata;
    void handle;
    return descriptor;
}

function requireTrack(
    document: EditorDocumentV4,
    kind: 'video' | 'audio' | 'subtitle',
    id: string,
    operation: EditorSemanticOperation,
): EditorDocumentV4['videoTracks'][number] | AudioTrack | SubtitleTrackV4 {
    if (kind === 'video') return requireVideoTrack(document, id, operation);
    if (kind === 'audio') return requireAudioTrack(document, id, operation);
    return requireSubtitleTrack(document, id, operation);
}

function getTracks(
    document: EditorDocumentV4,
    kind: 'video' | 'audio' | 'subtitle',
): Array<{ id: string; name: string }> {
    return (kind === 'video'
        ? document.videoTracks
        : kind === 'audio'
            ? document.audioTracks
            : document.subtitleTracks) as Array<{ id: string; name: string }>;
}

function getTrackIds(document: EditorDocumentV4, kind: 'video' | 'audio' | 'subtitle'): string[] {
    return getTracks(document, kind).map((track) => track.id);
}

function requireVideoTrack(
    document: EditorDocumentV4,
    id: string,
    operation: EditorSemanticOperation,
): EditorDocumentV4['videoTracks'][number] {
    const track = document.videoTracks.find((value) => value.id === id);
    if (!track) throw notFound(operation, id, 'video track');
    return track;
}

function requireAudioTrack(
    document: EditorDocumentV4,
    id: string,
    operation: EditorSemanticOperation,
): AudioTrack {
    const track = document.audioTracks.find((value) => value.id === id);
    if (!track) throw notFound(operation, id, 'audio track');
    return track;
}

function requireSubtitleTrack(
    document: EditorDocumentV4,
    id: string,
    operation: EditorSemanticOperation,
): SubtitleTrackV4 {
    const track = document.subtitleTracks.find((value) => value.id === id);
    if (!track) throw notFound(operation, id, 'subtitle track');
    return track;
}

function requireVideoSource(
    document: EditorDocumentV4,
    id: string,
    operation: EditorSemanticOperation,
): EditorDocumentV4['videoSources'][number] {
    const source = document.videoSources.find((value) => value.id === id);
    if (!source) throw notFound(operation, id, 'video source');
    return source;
}

function requireOrdinaryVideoClip(
    document: EditorDocumentV4,
    id: string,
    operation: EditorSemanticOperation,
): VideoClipV4 {
    if (Object.values(document.narrative?.blocks ?? {}).some((block) => block.clipId === id)) {
        throw invalidOperation(operation, 'Narrative-owned video must use a narrative operation.');
    }
    const clip = document.videoClips.find((value) => value.id === id);
    if (!clip) throw notFound(operation, id, 'video clip');
    return clip;
}

function requireAudioClip(
    document: EditorDocumentV4,
    id: string,
    operation: EditorSemanticOperation,
): { track: AudioTrack; clip: AudioClip } {
    const located = findAudioClip(document.audioTracks, audioSources(document), id);
    if (!located) throw notFound(operation, id, 'audio clip');
    return { track: located.track, clip: located.clip };
}

function requireSubtitle(
    document: EditorDocumentV4,
    trackId: string,
    subtitleId: string,
    operation: EditorSemanticOperation,
): { track: SubtitleTrackV4; subtitle: SubtitleTrackV4['subtitles'][number] } {
    const track = requireSubtitleTrack(document, trackId, operation);
    const subtitle = track.subtitles.find((value) => value.id === subtitleId);
    if (!subtitle) throw notFound(operation, subtitleId, 'subtitle');
    return { track, subtitle };
}

function assertUniqueId(
    document: EditorDocumentV4,
    id: string,
    operation: EditorSemanticOperation,
): void {
    const ids = [
        ...document.videoTracks.map((value) => value.id),
        ...document.audioTracks.map((value) => value.id),
        ...document.subtitleTracks.map((value) => value.id),
        ...document.videoClips.map((value) => value.id),
        ...document.audioTracks.flatMap((track) => track.clips.map((value) => value.id)),
        ...document.subtitleTracks.flatMap((track) => track.subtitles.map((value) => value.id)),
    ];
    if (ids.includes(id)) throw invalidOperation(operation, `ID "${id}" already exists.`);
}

function assertUnlocked(locked: boolean, operation: EditorSemanticOperation, id: string): void {
    if (locked) {
        throw new EditorCommandError('LOCKED_TARGET', 'The editor target is locked.', {
            details: { operationId: operation.operationId, ids: [id] },
        });
    }
}

function reorderByAnchor<T extends { id: string }>(
    values: T[],
    id: string,
    anchor: { beforeId?: string; afterId?: string },
    operation: EditorSemanticOperation,
): void {
    if ((anchor.beforeId === undefined) === (anchor.afterId === undefined)) {
        throw invalidOperation(operation, 'Ordering requires exactly one beforeId or afterId anchor.');
    }
    const currentIndex = values.findIndex((value) => value.id === id);
    const anchorId = anchor.beforeId ?? anchor.afterId!;
    const anchorIndex = values.findIndex((value) => value.id === anchorId);
    if (currentIndex < 0 || anchorIndex < 0 || id === anchorId) {
        throw invalidOperation(operation, 'Ordering target or anchor is unavailable.');
    }
    const [value] = values.splice(currentIndex, 1);
    const resolvedAnchor = values.findIndex((candidate) => candidate.id === anchorId);
    const insertAt = anchor.beforeId === undefined ? resolvedAnchor + 1 : resolvedAnchor;
    values.splice(insertAt, 0, value);
}

function resolveInsertIndex(ids: readonly string[], beforeId?: string): number {
    if (!beforeId) return ids.length;
    const index = ids.indexOf(beforeId);
    if (index < 0) throw new EditorCommandError('NOT_FOUND', 'Track insertion anchor does not exist.');
    return index;
}

function handleTrackContents(
    policy: 'empty-only' | 'delete-contents' | 'rehome',
    count: number,
    operation: EditorSemanticOperation,
): void {
    if (policy === 'empty-only' && count > 0) {
        throw invalidOperation(operation, 'The track must be empty before deletion.');
    }
}

function requireRehome(value: string | undefined, operation: EditorSemanticOperation): string {
    if (!value) throw invalidOperation(operation, 'Rehome policy requires rehomeTrackId.');
    return value;
}

function requireDistinctRehome(
    value: string | undefined,
    sourceTrackId: string,
    operation: EditorSemanticOperation,
): string {
    const targetTrackId = requireRehome(value, operation);
    if (targetTrackId === sourceTrackId) {
        throw invalidOperation(operation, 'A track cannot rehome its contents into itself.');
    }
    return targetTrackId;
}

function defaultSubtitleStyle(): AnimationStyle {
    return {
        fadeInDuration: 0,
        fadeOutDuration: 0,
        initialScale: 1,
        bounceStrength: 0,
        useElasticEffect: false,
        fontSize: 48,
        textColor: '#ffffff',
        strokeWidth: 0,
        strokeColor: '#000000',
        fontWeight: 600,
        textCase: 'normal',
        textAlign: 'center',
        hidePunctuation: false,
        punctuationChars: '',
        removeAccents: false,
        fontFamily: 'Arial',
        numberOfLines: 2,
        position: { x: 50, y: 85 },
        backgroundColor: '#000000',
        backgroundOpacity: 0,
        backgroundBorderColor: '#000000',
        backgroundBorderWidth: 0,
        backgroundMarginVertical: 0,
        backgroundMarginHorizontal: 0,
        backgroundBorderRadius: 0,
        backgroundOffsetX: 0,
        backgroundOffsetY: 0,
    };
}

function audioSources(document: EditorDocumentV4): {
    videoSources: EditorDocumentV4['videoSources'];
    audioSources: EditorDocumentV4['audioSources'];
} {
    return { videoSources: document.videoSources, audioSources: document.audioSources };
}

function audioSignature(document: EditorDocumentV4): string {
    return getEditorEngineAudioGraphSignature(document);
}

export function getEditorEngineAudioGraphSignature(
    document: EditorDocumentV4,
): string {
    return JSON.stringify({
        structure: getEditorAudioGraphSignatureV4(document),
        videoMix: document.videoClips.map((clip) => ({
            id: clip.id,
            audio: clip.audio,
        })),
        independentMix: document.audioTracks.map((track) => ({
            id: track.id,
            gainDb: track.gainDb,
            muted: track.muted,
            solo: track.solo,
            clips: track.clips,
        })),
    });
}

function compareTimelineItems(left: { timelineStartFrame: number; id: string }, right: { timelineStartFrame: number; id: string }): number {
    return left.timelineStartFrame - right.timelineStartFrame || left.id.localeCompare(right.id);
}

function compareSubtitles(
    left: { startTime: number; endTime: number; id: string },
    right: { startTime: number; endTime: number; id: string },
): number {
    return left.startTime - right.startTime || left.endTime - right.endTime || left.id.localeCompare(right.id);
}

function same(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function sameManifestContent(leftValue: EditorManifestV4, rightValue: EditorManifestV4): boolean {
    const left = structuredClone(leftValue);
    const right = structuredClone(rightValue);
    right.revision = left.revision;
    right.audioGraphRevision = left.audioGraphRevision;
    if (left.narrative && right.narrative) {
        right.narrative.revision = left.narrative.revision;
    }
    return same(left, right);
}

function noop(
    document: EditorDocumentV4,
    reason: string,
    label: string,
    category: string,
): OperationResult {
    return {
        document,
        changed: false,
        noOpReason: reason,
        affectedIds: [],
        label,
        category,
    };
}

function notFound(
    operation: EditorSemanticOperation,
    id: string,
    label: string,
): EditorCommandError {
    return new EditorCommandError('NOT_FOUND', `The requested ${label} does not exist.`, {
        details: { operationId: operation.operationId, ids: [id] },
    });
}

function invalidOperation(
    operation: EditorSemanticOperation,
    message: string,
): EditorCommandError {
    return new EditorCommandError('INVALID_OPERATION', message, {
        details: { operationId: operation.operationId },
    });
}

function overlapOrLocked(
    operation: EditorSemanticOperation,
    locked: boolean,
    id: string,
): EditorCommandError {
    return new EditorCommandError(
        locked ? 'LOCKED_TARGET' : 'OVERLAP_CONFLICT',
        locked ? 'The audio target is locked.' : 'The audio edit overlaps another clip.',
        { details: { operationId: operation.operationId, ids: [id] } },
    );
}

function invalidDocument(
    issues: Array<{ code: string; path: string; message: string }>,
): EditorCommandError {
    return new EditorCommandError('INVALID_DOCUMENT', 'The editor proposal failed V4 validation.', {
        details: { issues: structuredClone(issues.slice(0, 50)) },
    });
}

function narrativeAffectedIds(result: Extract<NarrativeCommandResult, { kind: 'success' }>): string[] {
    return Array.from(new Set([
        ...result.anchorTransforms.flatMap((transform) => Object.values(transform)
            .filter((value): value is string => typeof value === 'string')),
        ...result.pinDelta.addRecordIds,
        ...result.pinDelta.removeRecordIds,
    ]));
}

function assertNever(value: never): never {
    throw new EditorCommandError(
        'INVALID_OPERATION',
        `Unsupported editor operation "${(value as { type?: string }).type ?? 'unknown'}".`,
    );
}

function syntheticVerifiedHandle(id: string, fingerprint: string, size: number): VerifiedMediaHandleV1 {
    return {
        schemaVersion: 1,
        handleId: `descriptor-${id}`,
        capabilityId: `descriptor-${id}`,
        identity: {
            schemaVersion: 1,
            contentDigest: normalizeDigest(fingerprint),
            descriptorFingerprint: fingerprint,
            byteLength: size,
            immutableVersion: fingerprint,
            streamMetadataRefs: [],
        },
        verifiedAt: '1970-01-01T00:00:00.000Z',
    };
}

function normalizeDigest(value: string): `sha256:${string}` {
    const normalized = value.startsWith('sha256:') ? value.slice(7) : value;
    const digest = /^[a-f0-9]{64}$/i.test(normalized)
        ? normalized.toLowerCase()
        : new TextEncoder().encode(value).reduce(
            (hex, byte) => `${hex}${byte.toString(16).padStart(2, '0')}`,
            '',
        ).padEnd(64, '0').slice(0, 64);
    return `sha256:${digest}`;
}
