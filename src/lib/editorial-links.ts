import {
    EDITORIAL_PROJECT_OUTPUT_SAMPLE_RATE_HZ,
    isSha256Digest,
    type EditorialDependentLinkV1,
    type EditorialDependentTargetV1,
    type EditorialLinkAssociationV1,
    type GlobalEditingMode,
    type NarrativeBlockV1,
    type TranscriptFragmentBindingV1,
} from '@/types/editorial';
import type {
    AudioClip,
    EditorDocumentV4,
    ImportedAudioClip,
    VideoSourceAudioClip,
} from '@/types/video';
import {
    frameToOutputSample,
    nativeBoundaryToOutputSample,
} from './audio-timebase';
import { isSafeEditorId } from './editor-document-v3';
import { validateEditorDocumentV4 } from './editor-document-v4';
import { secondsToFrames } from './render-profile';
import {
    buildVideoTrackPlacementsV4,
    getVideoClipPlacementV4,
} from './video-placement-v4';
import type { NarrativeAnchorTransform } from './narrative/commands';
import {
    intervalOverlapLength,
    intervalsOverlap,
    type HalfOpenInterval,
} from './narrative/interval-algebra';

/** Fixed project-time interval used by every persisted dependent-link offset. */
export type EditorialOutputSampleInterval = HalfOpenInterval;

export interface EditorialLinkCommandGuard {
    expectedDocumentRevision: number;
    expectedMode: GlobalEditingMode;
    expectedNarrativeRevision?: number;
}

export type EditorialLinkIdKind = 'link' | 'binding';

/** Callers inject safe, durable IDs; tests can inject a deterministic allocator. */
export type EditorialLinkIdFactory = (kind: EditorialLinkIdKind) => string;

export type EditorialLinkErrorCode =
    | 'stale-document'
    | 'stale-mode'
    | 'stale-narrative'
    | 'missing-narrative'
    | 'missing-anchor'
    | 'missing-target'
    | 'owned-target'
    | 'target-already-linked'
    | 'link-not-found'
    | 'association-mismatch'
    | 'invalid-binding'
    | 'lineage-mismatch'
    | 'invalid-id'
    | 'invalid-bounds'
    | 'locked-target'
    | 'collision'
    | 'duplicate-link-id'
    | 'duplicate-target'
    | 'dangling-link'
    | 'stale-offset'
    | 'invalid-transform'
    | 'invalid-proposal';

export interface EditorialLinkError {
    code: EditorialLinkErrorCode;
    message: string;
    ids: string[];
}

export interface EditorialLinkValidationIssue extends EditorialLinkError {
    path: string;
}

export interface EditorialLinkValidationResult {
    valid: boolean;
    issues: EditorialLinkValidationIssue[];
}

export type EditorialTargetClassification =
    | {
        kind: 'owned';
        target: EditorialDependentTargetV1;
        targetKey: string;
        ownerBlockId: string;
    }
    | {
        kind: 'transcript-bound';
        target: EditorialDependentTargetV1;
        targetKey: string;
        link: EditorialDependentLinkV1;
    }
    | {
        kind: 'overlap-linked';
        target: EditorialDependentTargetV1;
        targetKey: string;
        link: EditorialDependentLinkV1;
    }
    | {
        kind: 'unbound';
        target: EditorialDependentTargetV1;
        targetKey: string;
    };

export type EditorialTargetClassificationResult =
    | { kind: 'success'; classifications: EditorialTargetClassification[] }
    | { kind: 'error'; error: EditorialLinkError };

export interface EditorialOverlapDiscoveryEntry {
    target: EditorialDependentTargetV1;
    targetKey: string;
    outcome: 'linked' | 'ambiguous' | 'no-overlap';
    anchorBlockId?: string;
    overlapOutputSamples?: number;
    tiedBlockIds?: string[];
}

export type EditorialOverlapDiscoveryResult =
    | { kind: 'success'; entries: EditorialOverlapDiscoveryEntry[] }
    | { kind: 'error'; error: EditorialLinkError };

export type EditorialLinkMutation =
    | { kind: 'created'; link: EditorialDependentLinkV1 }
    | { kind: 'updated'; before: EditorialDependentLinkV1; after: EditorialDependentLinkV1 }
    | { kind: 'deleted'; link: EditorialDependentLinkV1 };

export type EditorialTargetMutation =
    | {
        kind: 'translated';
        target: EditorialDependentTargetV1;
        before: EditorialOutputSampleInterval;
        after: EditorialOutputSampleInterval;
    }
    | {
        kind: 'moved';
        target: EditorialDependentTargetV1;
        afterTarget: EditorialDependentTargetV1;
        before: EditorialOutputSampleInterval;
        after: EditorialOutputSampleInterval;
    }
    | {
        kind: 'trimmed';
        target: EditorialDependentTargetV1;
        before: EditorialOutputSampleInterval;
        after: EditorialOutputSampleInterval;
    }
    | {
        kind: 'split';
        target: EditorialDependentTargetV1;
        before: EditorialOutputSampleInterval;
        children: Array<{
            target: EditorialDependentTargetV1;
            interval: EditorialOutputSampleInterval;
        }>;
    }
    | {
        kind: 'deleted';
        target: EditorialDependentTargetV1;
        before: EditorialOutputSampleInterval;
    };

export interface EditorialLinkPlanSuccess {
    kind: 'success';
    command: string;
    /** Complete graph proposal. The function never mutates the input document. */
    document: EditorDocumentV4;
    dependentLinks: EditorialDependentLinkV1[];
    linkMutations: EditorialLinkMutation[];
    targetMutations: EditorialTargetMutation[];
    /** Integrated plans piggyback on the WP4/WP6 command and must not create a second entry. */
    history: { createEntry: boolean; label: string | null };
    persistence: { enqueue: boolean };
    impact: { content: true; audioGraph: boolean };
    discovery?: EditorialOverlapDiscoveryEntry[];
}

export interface EditorialLinkPlanNoop {
    kind: 'noop';
    code: 'unchanged' | 'no-linkable-overlap';
    history: { createEntry: false; label: null };
    persistence: { enqueue: false };
    discovery?: EditorialOverlapDiscoveryEntry[];
}

export type EditorialLinkPlanResult =
    | EditorialLinkPlanSuccess
    | EditorialLinkPlanNoop
    | { kind: 'error'; error: EditorialLinkError };

export type EditorialDirectTargetTransform =
    | {
        kind: 'moved';
        target: EditorialDependentTargetV1;
        /** Required when track identity is part of the persisted target key and changes. */
        afterTarget?: EditorialDependentTargetV1;
    }
    | { kind: 'trimmed'; target: EditorialDependentTargetV1 }
    | { kind: 'deleted'; target: EditorialDependentTargetV1 }
    | {
        kind: 'split';
        target: EditorialDependentTargetV1;
        childTargets: readonly EditorialDependentTargetV1[];
    };

interface TargetSnapshot {
    target: EditorialDependentTargetV1;
    key: string;
    trackId: string;
    interval: EditorialOutputSampleInterval;
    locked: boolean;
    order: number;
}

interface AnchorSnapshot {
    block: NarrativeBlockV1;
    interval: EditorialOutputSampleInterval;
}

interface AnchorResolution {
    touched: boolean;
    anchor: NarrativeBlockV1 | null;
    association: EditorialLinkAssociationV1;
}

interface AnchorTransformIndex {
    byOldBlockId: Map<string, NarrativeAnchorTransform>;
}

/** Stable persisted-identity key. Track identity is part of audio/subtitle identity by contract. */
export function getEditorialTargetKey(target: EditorialDependentTargetV1): string {
    if (target.kind === 'video-clip') return `video:${target.clipId}`;
    if (target.kind === 'audio-clip') return `audio:${target.trackId}:${target.clipId}`;
    return `subtitle:${target.trackId}:${target.subtitleId}`;
}

/** Converts one concrete target into the canonical 48 kHz half-open project interval. */
export function getEditorialTargetInterval(
    document: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): { kind: 'success'; interval: EditorialOutputSampleInterval } | { kind: 'error'; error: EditorialLinkError } {
    const resolved = resolveTarget(document, target);
    return resolved.kind === 'error'
        ? resolved
        : { kind: 'success', interval: { ...resolved.snapshot.interval } };
}

/**
 * Validates the durable link graph independently from store/history concerns.
 *
 * The check is intentionally stricter than a lookup: it proves one-target-one-link, exact target
 * existence, current relative offsets, and exact transcript occurrence lineage/sample bounds.
 * This prevents WP6 from ever publishing a dangling or silently re-associated dependent.
 */
export function validateEditorialLinkGraph(document: EditorDocumentV4): EditorialLinkValidationResult {
    const issues: EditorialLinkValidationIssue[] = [];
    const targetGraph = validateTargetGraph(document);
    if (targetGraph.kind === 'error') {
        issues.push({ ...targetGraph.error, path: 'targets' });
    }
    if (!document.narrative && document.dependentLinks.length > 0) {
        issues.push(issue('dangling-link', 'dependentLinks',
            'Dependent links require an active narrative.', []));
        return { valid: false, issues };
    }

    const orderedBlockIds = new Set<string>();
    const ownedClipIds = new Set<string>();
    document.narrative?.blockIds.forEach((blockId, index) => {
        const path = `narrative.blockIds[${index}]`;
        const block = document.narrative!.blocks[blockId];
        if (!isSafeEditorId(blockId) || orderedBlockIds.has(blockId) || !block || block.id !== blockId) {
            issues.push(issue('invalid-proposal', path,
                'Narrative order must contain unique existing safe block identities.', [blockId]));
            return;
        }
        orderedBlockIds.add(blockId);
        const anchor = resolveAnchor(document, block);
        if (anchor.kind === 'error') issues.push({ ...anchor.error, path });
        if (ownedClipIds.has(block.clipId)) {
            issues.push(issue('duplicate-target', `${path}.clipId`,
                'A controlled video occurrence must be owned by exactly one block.', [block.clipId]));
        }
        ownedClipIds.add(block.clipId);
    });
    Object.keys(document.narrative?.blocks ?? {}).forEach(blockId => {
        if (!orderedBlockIds.has(blockId)) {
            issues.push(issue('invalid-proposal', `narrative.blocks.${blockId}`,
                'Narrative block map cannot contain an orphan ownership record.', [blockId]));
        }
    });

    const linkIds = new Set<string>();
    const targetKeys = new Set<string>();
    const bindingIds = new Set<string>();
    document.dependentLinks.forEach((link, index) => {
        const path = `dependentLinks[${index}]`;
        if (link.version !== 1 || !isSafeEditorId(link.id)
            || !Number.isSafeInteger(link.revision) || link.revision < 0
            || link.revision > document.revision) {
            issues.push(issue('invalid-proposal', path,
                'Dependent link identity, version, or revision is invalid.', [link.id]));
        }
        if (linkIds.has(link.id)) {
            issues.push(issue('duplicate-link-id', `${path}.id`,
                'Dependent link IDs must be unique.', [link.id]));
        }
        linkIds.add(link.id);

        const targetKey = getEditorialTargetKey(link.target);
        if (targetKeys.has(targetKey)) {
            issues.push(issue('duplicate-target', `${path}.target`,
                'A dependent target may be referenced by only one link.', [targetKey]));
        }
        targetKeys.add(targetKey);

        const anchor = document.narrative?.blocks[link.anchorBlockId];
        if (!isSafeEditorId(link.anchorBlockId)
            || !anchor || !document.narrative?.blockIds.includes(link.anchorBlockId)) {
            issues.push(issue('missing-anchor', `${path}.anchorBlockId`,
                'Dependent anchor does not exist in narrative order.', [link.anchorBlockId]));
        }
        const target = resolveTarget(document, link.target);
        if (target.kind === 'error') {
            issues.push({ ...target.error, path: `${path}.target` });
        } else {
            const owner = findVideoOwner(document, link.target);
            if (owner) {
                issues.push(issue('owned-target', `${path}.target`,
                    'A narrative-owned video occurrence cannot also be a dependent target.', [owner.id]));
            }
            if (anchor) {
                const anchorInterval = resolveAnchor(document, anchor);
                if (anchorInterval.kind === 'error') {
                    issues.push({ ...anchorInterval.error, path: `${path}.anchorBlockId` });
                } else {
                    const relativeStart = target.snapshot.interval.start - anchorInterval.snapshot.interval.start;
                    const relativeEnd = target.snapshot.interval.end - anchorInterval.snapshot.interval.start;
                    if (link.relativeStartOutputSample !== relativeStart
                        || link.relativeEndOutputSample !== relativeEnd) {
                        issues.push(issue('stale-offset', path,
                            'Dependent offsets do not match current anchor and target placements.', [link.id]));
                    }
                }
            }
        }
        if (link.followPolicy !== 'none' && link.followPolicy !== 'follow') {
            issues.push(issue('invalid-proposal', `${path}.followPolicy`,
                'Follow policy must be none or follow.', [link.id]));
        }
        if (!Number.isSafeInteger(link.relativeStartOutputSample)
            || !Number.isSafeInteger(link.relativeEndOutputSample)
            || link.relativeEndOutputSample <= link.relativeStartOutputSample) {
            issues.push(issue('invalid-bounds', path,
                'Relative offsets must form a safe non-empty half-open interval.', [link.id]));
        }
        validateAssociation(document, link, anchor, bindingIds, path, issues);
    });
    return { valid: issues.length === 0, issues };
}

/** Classifies every persisted target by exact ownership/link identity. */
export function classifyEditorialTargets(document: EditorDocumentV4): EditorialTargetClassificationResult {
    const validation = validateEditorialLinkGraph(document);
    if (!validation.valid) return { kind: 'error', error: validationIssueToError(validation.issues[0]) };
    const snapshots = listTargetSnapshots(document);
    if (snapshots.kind === 'error') return snapshots;
    const linkByTarget = new Map(document.dependentLinks.map(link => [getEditorialTargetKey(link.target), link]));
    const classifications = snapshots.snapshots.map((snapshot): EditorialTargetClassification => {
        const owner = findVideoOwner(document, snapshot.target);
        if (owner) {
            return {
                kind: 'owned',
                target: cloneTarget(snapshot.target),
                targetKey: snapshot.key,
                ownerBlockId: owner.id,
            };
        }
        const link = linkByTarget.get(snapshot.key);
        if (!link) {
            return { kind: 'unbound', target: cloneTarget(snapshot.target), targetKey: snapshot.key };
        }
        return link.association.kind === 'transcript-bound'
            ? {
                kind: 'transcript-bound',
                target: cloneTarget(snapshot.target),
                targetKey: snapshot.key,
                link: cloneLink(link),
            }
            : {
                kind: 'overlap-linked',
                target: cloneTarget(snapshot.target),
                targetKey: snapshot.key,
                link: cloneLink(link),
            };
    });
    return { kind: 'success', classifications };
}

/**
 * Finds only unique-greatest positive half-open overlaps.
 *
 * Exact-bound and already overlap-linked targets never enter the candidate set. Equal greatest
 * overlaps remain explicit ambiguity; no track order, filename, or nearest-neighbor fallback is
 * allowed to establish durable identity.
 */
export function discoverEditorialOverlapCandidates(
    document: EditorDocumentV4,
): EditorialOverlapDiscoveryResult {
    const classified = classifyEditorialTargets(document);
    if (classified.kind === 'error') return classified;
    if (!document.narrative) {
        return { kind: 'error', error: linkError('missing-narrative', 'Text editing is not active.', []) };
    }
    const anchors: AnchorSnapshot[] = [];
    for (const blockId of document.narrative.blockIds) {
        const resolved = resolveAnchor(document, document.narrative.blocks[blockId]);
        if (resolved.kind === 'error') return resolved;
        anchors.push(resolved.snapshot);
    }
    const entries: EditorialOverlapDiscoveryEntry[] = [];
    for (const classification of classified.classifications) {
        if (classification.kind !== 'unbound') continue;
        const target = resolveTarget(document, classification.target);
        if (target.kind === 'error') return target;
        const positive = anchors
            .map(anchor => ({
                anchor,
                overlap: intervalOverlapLength(anchor.interval, target.snapshot.interval),
            }))
            .filter(candidate => candidate.overlap > 0);
        if (positive.length === 0) {
            entries.push({
                target: cloneTarget(classification.target),
                targetKey: classification.targetKey,
                outcome: 'no-overlap',
            });
            continue;
        }
        const greatest = Math.max(...positive.map(candidate => candidate.overlap));
        const tied = positive.filter(candidate => candidate.overlap === greatest);
        if (tied.length !== 1) {
            entries.push({
                target: cloneTarget(classification.target),
                targetKey: classification.targetKey,
                outcome: 'ambiguous',
                overlapOutputSamples: greatest,
                tiedBlockIds: tied.map(candidate => candidate.anchor.block.id).sort(compareIds),
            });
            continue;
        }
        entries.push({
            target: cloneTarget(classification.target),
            targetKey: classification.targetKey,
            outcome: 'linked',
            anchorBlockId: tied[0].anchor.block.id,
            overlapOutputSamples: greatest,
        });
    }
    return { kind: 'success', entries };
}

/** Creates every currently unambiguous automatic overlap link as one standalone command. */
export function planDiscoverEditorialOverlapLinks(input: {
    document: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    idFactory: EditorialLinkIdFactory;
}): EditorialLinkPlanResult {
    const preflight = preflightStandalone(input.document, input.guard);
    if (preflight) return preflight;
    const discovery = discoverEditorialOverlapCandidates(input.document);
    if (discovery.kind === 'error') return discovery;
    const linkable = discovery.entries.filter((entry): entry is EditorialOverlapDiscoveryEntry & {
        outcome: 'linked';
        anchorBlockId: string;
    } => entry.outcome === 'linked' && entry.anchorBlockId !== undefined);
    if (linkable.length === 0) {
        return {
            ...noop('no-linkable-overlap'),
            discovery: discovery.entries,
        };
    }

    const allocate = createLinkIdAllocator(input.document, input.idFactory);
    const nextRevision = input.document.revision + 1;
    const links = input.document.dependentLinks.map(cloneLink);
    try {
        for (const entry of linkable) {
            const created = buildLink({
                document: input.document,
                id: allocate('link'),
                anchorBlockId: entry.anchorBlockId,
                target: entry.target,
                association: { kind: 'overlap', origin: 'auto' },
                followPolicy: 'none',
                revision: nextRevision,
            });
            if (created.kind === 'error') return created;
            links.push(created.link);
        }
    } catch {
        return commandError('invalid-id', 'Injected link ID is unsafe or already used.', []);
    }
    const result = finalizeStandalone({
        command: 'link-overlap-dependents',
        label: 'Link dependent',
        before: input.document,
        dependentLinks: links,
    });
    if (result.kind === 'success') result.discovery = discovery.entries;
    return result;
}

/**
 * Adds discovery results to an already-planned ownership command without a second revision.
 *
 * WP6 uses this after WP4 activation established every owner in its pending V4 projection. Link
 * revisions use that pending document revision, and the returned history/persistence flags remain
 * false so activation can publish ownership, links, selection, and persistence exactly once.
 */
export function planIntegrateDiscoveredEditorialOverlapLinks(input: {
    document: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    idFactory: EditorialLinkIdFactory;
}): EditorialLinkPlanResult {
    const preflight = preflightStandalone(input.document, input.guard);
    if (preflight) return preflight;
    const discovery = discoverEditorialOverlapCandidates(input.document);
    if (discovery.kind === 'error') return discovery;
    const linkable = discovery.entries.filter((entry): entry is EditorialOverlapDiscoveryEntry & {
        outcome: 'linked';
        anchorBlockId: string;
    } => entry.outcome === 'linked' && entry.anchorBlockId !== undefined);
    if (linkable.length === 0) {
        return { ...noop('no-linkable-overlap'), discovery: discovery.entries };
    }
    const after = cloneTargetGraph(input.document);
    const allocate = createLinkIdAllocator(input.document, input.idFactory);
    try {
        for (const entry of linkable) {
            const created = buildLink({
                document: after,
                id: allocate('link'),
                anchorBlockId: entry.anchorBlockId,
                target: entry.target,
                association: { kind: 'overlap', origin: 'auto' },
                followPolicy: 'none',
                revision: after.revision,
            });
            if (created.kind === 'error') return created;
            after.dependentLinks.push(created.link);
        }
    } catch {
        return commandError('invalid-id', 'Injected link ID is unsafe or already used.', []);
    }
    const proposal = preflightFinalProposal(after);
    if (proposal) return proposal;
    const result = integratedSuccess({
        command: 'integrate-overlap-discovery',
        before: input.document,
        after,
        targetMutations: [],
    });
    result.discovery = discovery.entries;
    return result;
}

/**
 * Creates an explicit overlap association.
 *
 * A manual relationship is allowed even when the current intervals do not overlap. This is the
 * intentional user-confirmed escape hatch for equal-overlap ambiguity and non-geometric editorial
 * relationships; persisted target and anchor identity, rather than proximity, remains authority.
 */
export function planCreateManualOverlapLink(input: {
    document: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    target: EditorialDependentTargetV1;
    anchorBlockId: string;
    followPolicy?: 'none' | 'follow';
    idFactory: EditorialLinkIdFactory;
}): EditorialLinkPlanResult {
    const preflight = preflightStandalone(input.document, input.guard);
    if (preflight) return preflight;
    const eligibility = preflightNewTargetLink(input.document, input.target, input.anchorBlockId);
    if (eligibility) return eligibility;
    const target = resolveTarget(input.document, input.target);
    if (target.kind === 'error') return target;
    const followPolicy = input.followPolicy ?? 'none';
    if (followPolicy === 'follow' && target.snapshot.locked) return lockedTargetError(target.snapshot);
    const allocate = createLinkIdAllocator(input.document, input.idFactory);
    let id: string;
    try {
        id = allocate('link');
    } catch {
        return commandError('invalid-id', 'Injected link ID is unsafe or already used.', []);
    }
    const created = buildLink({
        document: input.document,
        id,
        anchorBlockId: input.anchorBlockId,
        target: input.target,
        association: { kind: 'overlap', origin: 'manual' },
        followPolicy,
        revision: input.document.revision + 1,
    });
    if (created.kind === 'error') return created;
    return finalizeStandalone({
        command: 'link-dependent',
        label: 'Link dependent',
        before: input.document,
        dependentLinks: [...input.document.dependentLinks.map(cloneLink), created.link],
    });
}

/** Creates one exact transcript-fragment binding for any eligible target kind. */
export function planBindEditorialTarget(input: {
    document: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    target: EditorialDependentTargetV1;
    anchorBlockId: string;
    activeStartSample: number;
    activeEndSample: number;
    followPolicy?: 'none' | 'follow';
    idFactory: EditorialLinkIdFactory;
}): EditorialLinkPlanResult {
    const preflight = preflightStandalone(input.document, input.guard);
    if (preflight) return preflight;
    const eligibility = preflightNewTargetLink(input.document, input.target, input.anchorBlockId);
    if (eligibility) return eligibility;
    const anchor = input.document.narrative!.blocks[input.anchorBlockId];
    if (!validContainedSampleRange(input.activeStartSample, input.activeEndSample, anchor)) {
        return commandError('invalid-binding',
            'Transcript binding fragment must be non-empty and contained in the exact anchor core.',
            [input.anchorBlockId]);
    }
    const descriptor = findTranscriptDescriptor(
        input.document,
        anchor.transcriptRecordId,
        anchor.sourceId,
    );
    if (!descriptor || input.activeEndSample > descriptor.sampleCount) {
        return commandError('invalid-binding',
            'Transcript binding fragment exceeds persisted transcript sample bounds.',
            [anchor.transcriptRecordId]);
    }
    const target = resolveTarget(input.document, input.target);
    if (target.kind === 'error') return target;
    const followPolicy = input.followPolicy ?? 'none';
    if (followPolicy === 'follow' && target.snapshot.locked) return lockedTargetError(target.snapshot);
    const allocate = createLinkIdAllocator(input.document, input.idFactory);
    let linkId: string;
    let bindingId: string;
    try {
        linkId = allocate('link');
        bindingId = allocate('binding');
    } catch {
        return commandError('invalid-id', 'Injected link or binding ID is unsafe or already used.', []);
    }
    const binding: TranscriptFragmentBindingV1 = {
        version: 1,
        bindingId,
        transcriptRecordId: anchor.transcriptRecordId,
        sourceIntervalId: anchor.sourceIntervalId,
        activeStartSample: input.activeStartSample,
        activeEndSample: input.activeEndSample,
        lineageRootId: anchor.lineageRootId,
        createdFromBlockId: anchor.id,
    };
    const created = buildLink({
        document: input.document,
        id: linkId,
        anchorBlockId: anchor.id,
        target: input.target,
        association: { kind: 'transcript-bound', binding },
        followPolicy,
        revision: input.document.revision + 1,
    });
    if (created.kind === 'error') return created;
    return finalizeStandalone({
        command: 'bind-target-to-transcript',
        label: 'Bind target to transcript',
        before: input.document,
        dependentLinks: [...input.document.dependentLinks.map(cloneLink), created.link],
    });
}

/** Removes either association kind while preserving the exact target placement. */
export function planUnlinkEditorialTarget(input: {
    document: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    target: EditorialDependentTargetV1;
}): EditorialLinkPlanResult {
    const preflight = preflightStandalone(input.document, input.guard);
    if (preflight) return preflight;
    const target = resolveTarget(input.document, input.target);
    if (target.kind === 'error') return target;
    const targetKey = target.snapshot.key;
    const link = input.document.dependentLinks.find(value => getEditorialTargetKey(value.target) === targetKey);
    if (!link) return noop('unchanged');
    return finalizeStandalone({
        command: 'unlink-dependent',
        label: 'Unlink dependent',
        before: input.document,
        dependentLinks: input.document.dependentLinks
            .filter(value => value.id !== link.id)
            .map(cloneLink),
    });
}

/** Exact-binding-specific unlink with the required history label. */
export function planUnbindEditorialTarget(input: {
    document: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    target: EditorialDependentTargetV1;
}): EditorialLinkPlanResult {
    const preflight = preflightStandalone(input.document, input.guard);
    if (preflight) return preflight;
    const target = resolveTarget(input.document, input.target);
    if (target.kind === 'error') return target;
    const targetKey = target.snapshot.key;
    const link = input.document.dependentLinks.find(value => getEditorialTargetKey(value.target) === targetKey);
    if (!link) return noop('unchanged');
    if (link.association.kind !== 'transcript-bound') {
        return commandError('association-mismatch', 'Only an exact transcript binding can be unbound.', [link.id]);
    }
    return finalizeStandalone({
        command: 'unbind-target-from-transcript',
        label: 'Unbind target from transcript',
        before: input.document,
        dependentLinks: input.document.dependentLinks
            .filter(value => value.id !== link.id)
            .map(cloneLink),
    });
}

/** Re-anchors a durable relationship and recomputes offsets without moving the target. */
export function planReanchorEditorialLink(input: {
    document: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    target: EditorialDependentTargetV1;
    anchorBlockId: string;
}): EditorialLinkPlanResult {
    const preflight = preflightStandalone(input.document, input.guard);
    if (preflight) return preflight;
    const requestedTarget = resolveTarget(input.document, input.target);
    if (requestedTarget.kind === 'error') return requestedTarget;
    const targetKey = requestedTarget.snapshot.key;
    const link = input.document.dependentLinks.find(value => getEditorialTargetKey(value.target) === targetKey);
    if (!link) return commandError('link-not-found', 'Dependent target is not linked.', [targetKey]);
    const anchor = input.document.narrative!.blocks[input.anchorBlockId];
    if (!anchor || !input.document.narrative!.blockIds.includes(anchor.id)) {
        return commandError('missing-anchor', 'Replacement anchor does not exist.', [input.anchorBlockId]);
    }
    if (link.anchorBlockId === anchor.id) return noop('unchanged');
    if (link.followPolicy === 'follow' && requestedTarget.snapshot.locked) {
        return lockedTargetError(requestedTarget.snapshot);
    }

    let association: EditorialLinkAssociationV1;
    if (link.association.kind === 'transcript-bound') {
        const binding = link.association.binding;
        if (anchor.transcriptRecordId !== binding.transcriptRecordId
            || anchor.lineageRootId !== binding.lineageRootId) {
            return commandError('lineage-mismatch',
                'Exact binding re-anchor must preserve transcript record and occurrence lineage.',
                [anchor.id]);
        }
        if (!validContainedSampleRange(binding.activeStartSample, binding.activeEndSample, anchor)) {
            return commandError('invalid-binding',
                'Replacement anchor does not contain the exact active transcript fragment.',
                [anchor.id]);
        }
        association = {
            kind: 'transcript-bound',
            binding: { ...binding, sourceIntervalId: anchor.sourceIntervalId },
        };
    } else {
        // Re-anchoring is an explicit user decision, so an auto-discovered relation becomes manual.
        association = { kind: 'overlap', origin: 'manual' };
    }
    const updated = refreshLink({
        document: input.document,
        link: { ...link, anchorBlockId: anchor.id, association },
        revision: input.document.revision + 1,
    });
    if (updated.kind === 'error') return updated;
    return finalizeStandalone({
        command: link.association.kind === 'transcript-bound'
            ? 'retarget-transcript-binding'
            : 'reanchor-dependent',
        label: link.association.kind === 'transcript-bound'
            ? 'Retarget transcript binding'
            : 'Link dependent',
        before: input.document,
        dependentLinks: replaceLink(input.document.dependentLinks, updated.link),
    });
}

/** Enables/disables following. Enabling on a locked target fails before any graph mutation. */
export function planSetEditorialLinkFollowPolicy(input: {
    document: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    target: EditorialDependentTargetV1;
    followPolicy: 'none' | 'follow';
}): EditorialLinkPlanResult {
    const preflight = preflightStandalone(input.document, input.guard);
    if (preflight) return preflight;
    const target = resolveTarget(input.document, input.target);
    if (target.kind === 'error') return target;
    const targetKey = target.snapshot.key;
    const link = input.document.dependentLinks.find(value => getEditorialTargetKey(value.target) === targetKey);
    if (!link) return commandError('link-not-found', 'Dependent target is not linked.', [targetKey]);
    if (link.followPolicy === input.followPolicy) return noop('unchanged');
    if (input.followPolicy === 'follow' && target.snapshot.locked) return lockedTargetError(target.snapshot);
    const updated = { ...cloneLink(link), followPolicy: input.followPolicy, revision: input.document.revision + 1 };
    return finalizeStandalone({
        command: 'toggle-dependent-follow',
        label: 'Toggle dependent follow',
        before: input.document,
        dependentLinks: replaceLink(input.document.dependentLinks, updated),
    });
}

/**
 * Integrates WP4 anchor transforms into the same structural command.
 *
 * `afterNarrativeCommand` is the complete WP4 success document before link/target integration.
 * The returned graph keeps that revision and history ownership: WP6 must publish the combined
 * projection once, rather than finalizing a second link command.
 */
export function planEditorialLinksForAnchorTransforms(input: {
    before: EditorDocumentV4;
    afterNarrativeCommand: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    anchorTransforms: readonly NarrativeAnchorTransform[];
}): EditorialLinkPlanResult {
    const preflight = preflightIntegratedPair(
        input.before,
        input.afterNarrativeCommand,
        input.guard,
        { requireUnchangedNarrative: false, allowCompleteNarrativeRelease: true },
    );
    if (preflight) return preflight;
    const unchangedTargets = preflightUnchangedLinkedTargets(
        input.before,
        input.afterNarrativeCommand,
    );
    if (unchangedTargets) return unchangedTargets;
    const transformIndex = indexAndValidateAnchorTransforms(
        input.before,
        input.afterNarrativeCommand,
        input.anchorTransforms,
    );
    if (transformIndex.kind === 'error') return transformIndex;

    const working = cloneTargetGraph(input.afterNarrativeCommand);
    working.dependentLinks = [];
    const targetMutations: EditorialTargetMutation[] = [];
    for (const oldLink of input.before.dependentLinks) {
        const resolution = resolveAnchorTransform({
            before: input.before,
            after: working,
            link: oldLink,
            transformIndex: transformIndex.index,
        });
        if (resolution.kind === 'error') return resolution;
        if (!resolution.resolution.touched) {
            working.dependentLinks.push(cloneLink(oldLink));
            continue;
        }

        const targetBefore = resolveTarget(input.before, oldLink.target);
        if (targetBefore.kind === 'error') return targetBefore;
        if (!resolution.resolution.anchor) {
            if (oldLink.followPolicy === 'follow') {
                // A follow relationship is executable behavior, not merely metadata. Any locked
                // target rejects the complete anchor command, including a follow-delete.
                if (targetBefore.snapshot.locked) return lockedTargetError(targetBefore.snapshot);
                const pendingTarget = resolveTarget(working, oldLink.target);
                if (pendingTarget.kind === 'error') return pendingTarget;
                if (pendingTarget.snapshot.locked) return lockedTargetError(pendingTarget.snapshot);
                const deleted = deleteTarget(working, oldLink.target);
                if (deleted.kind === 'error') return deleted;
                targetMutations.push({
                    kind: 'deleted',
                    target: cloneTarget(oldLink.target),
                    before: { ...targetBefore.snapshot.interval },
                });
            }
            // `none` detaches and preserves placement; `follow` deletes target and link together.
            continue;
        }

        const oldAnchor = resolveAnchor(input.before, input.before.narrative!.blocks[oldLink.anchorBlockId]);
        const newAnchor = resolveAnchor(working, resolution.resolution.anchor);
        if (oldAnchor.kind === 'error') return oldAnchor;
        if (newAnchor.kind === 'error') return newAnchor;
        if (oldLink.followPolicy === 'follow') {
            if (targetBefore.snapshot.locked) return lockedTargetError(targetBefore.snapshot);
            const pendingTarget = resolveTarget(working, oldLink.target);
            if (pendingTarget.kind === 'error') return pendingTarget;
            if (pendingTarget.snapshot.locked) return lockedTargetError(pendingTarget.snapshot);
            const deltaFrames = resolution.resolution.anchor.timelineStartFrame
                - oldAnchor.snapshot.block.timelineStartFrame;
            const deltaOutputSamples = newAnchor.snapshot.interval.start - oldAnchor.snapshot.interval.start;
            const translated = translateTarget(working, oldLink.target, deltaFrames, deltaOutputSamples);
            if (translated.kind === 'error') return translated;
            if (translated.mutation) targetMutations.push(translated.mutation);
        }
        const refreshed = refreshLink({
            document: working,
            link: {
                ...cloneLink(oldLink),
                anchorBlockId: resolution.resolution.anchor.id,
                association: resolution.resolution.association,
            },
            revision: working.revision,
        });
        if (refreshed.kind === 'error') return refreshed;
        working.dependentLinks.push(refreshed.link);
    }

    const proposal = preflightFinalProposal(working);
    if (proposal) return proposal;
    return integratedSuccess({
        command: 'integrate-anchor-dependent-links',
        before: input.before,
        after: working,
        targetMutations,
    });
}

/**
 * Integrates direct target move/trim/split/delete results into their existing WP6 command.
 *
 * Callers provide the complete post-edit target graph and an explicit transform ledger. Linked
 * moves/trims refresh offsets, deletion removes the link, and split selects exactly one child by
 * greatest overlap with the old anchor (chronologically earlier child on an exact tie). Video
 * moves must also ledger every subtitle changed by the visible unlinked-response policy; they may
 * translate/trim cues but cannot delete cues or change subtitle-track visibility.
 */
export function planEditorialLinksForTargetTransforms(input: {
    before: EditorDocumentV4;
    afterTargetCommand: EditorDocumentV4;
    guard: EditorialLinkCommandGuard;
    targetTransforms: readonly EditorialDirectTargetTransform[];
}): EditorialLinkPlanResult {
    const preflight = preflightIntegratedPair(
        input.before,
        input.afterTargetCommand,
        input.guard,
        { requireUnchangedNarrative: true, allowCompleteNarrativeRelease: false },
    );
    if (preflight) return preflight;
    const transformed = validateDirectTargetTransforms(
        input.before,
        input.afterTargetCommand,
        input.targetTransforms,
    );
    if (transformed.kind === 'error') return transformed;

    const working = cloneTargetGraph(input.afterTargetCommand);
    const linksByTarget = new Map(input.before.dependentLinks
        .map(link => [getEditorialTargetKey(link.target), link]));
    const updatedById = new Map(input.before.dependentLinks.map(link => [link.id, cloneLink(link)]));
    const targetMutations: EditorialTargetMutation[] = [];

    for (const transform of input.targetTransforms) {
        const oldTarget = resolveTarget(input.before, transform.target);
        if (oldTarget.kind === 'error') return oldTarget;
        if (oldTarget.snapshot.locked) return lockedTargetError(oldTarget.snapshot);
        const targetKey = oldTarget.snapshot.key;
        const link = linksByTarget.get(targetKey);

        if (transform.kind === 'deleted') {
            targetMutations.push({
                kind: 'deleted',
                target: cloneTarget(transform.target),
                before: { ...oldTarget.snapshot.interval },
            });
            if (link) updatedById.delete(link.id);
            continue;
        }
        if (transform.kind === 'moved' || transform.kind === 'trimmed') {
            const afterTarget = transform.kind === 'moved'
                ? transform.afterTarget ?? transform.target
                : transform.target;
            const current = resolveTarget(working, afterTarget);
            if (current.kind === 'error') return current;
            if (current.snapshot.locked) return lockedTargetError(current.snapshot);
            targetMutations.push(transform.kind === 'moved'
                ? {
                    kind: 'moved',
                    target: cloneTarget(transform.target),
                    afterTarget: cloneTarget(afterTarget),
                    before: { ...oldTarget.snapshot.interval },
                    after: { ...current.snapshot.interval },
                }
                : {
                    kind: 'trimmed',
                    target: cloneTarget(transform.target),
                    before: { ...oldTarget.snapshot.interval },
                    after: { ...current.snapshot.interval },
                });
            if (!link) continue;
            const refreshed = refreshLink({
                document: working,
                link: { ...cloneLink(link), target: cloneTarget(afterTarget) },
                revision: working.revision,
            });
            if (refreshed.kind === 'error') return refreshed;
            updatedById.set(link.id, refreshed.link);
            continue;
        }

        const children: TargetSnapshot[] = [];
        for (const childTarget of transform.childTargets) {
            const child = resolveTarget(working, childTarget);
            if (child.kind === 'error') return child;
            if (child.snapshot.locked) return lockedTargetError(child.snapshot);
            children.push(child.snapshot);
        }
        children.sort(compareTargetSnapshotsByTime);
        targetMutations.push({
            kind: 'split',
            target: cloneTarget(transform.target),
            before: { ...oldTarget.snapshot.interval },
            children: children.map(child => ({
                target: cloneTarget(child.target),
                interval: { ...child.interval },
            })),
        });
        if (!link) continue;
        const anchor = resolveAnchor(input.before, input.before.narrative!.blocks[link.anchorBlockId]);
        if (anchor.kind === 'error') return anchor;
        const selected = selectDirectSplitChild({
            before: input.before,
            after: working,
            link,
            children,
            anchor,
        });
        const refreshed = refreshLink({
            document: working,
            link: { ...cloneLink(link), target: cloneTarget(selected.target) },
            revision: working.revision,
        });
        if (refreshed.kind === 'error') return refreshed;
        updatedById.set(link.id, refreshed.link);
    }
    working.dependentLinks = input.before.dependentLinks
        .map(link => updatedById.get(link.id))
        .filter((link): link is EditorialDependentLinkV1 => link !== undefined);

    const proposal = preflightFinalProposal(working);
    if (proposal) return proposal;
    return integratedSuccess({
        command: 'integrate-direct-target-links',
        before: input.before,
        after: working,
        targetMutations,
    });
}

function preflightStandalone(
    document: EditorDocumentV4,
    guard: EditorialLinkCommandGuard,
): EditorialLinkPlanResult | null {
    const guardError = preflightGuard(document, guard);
    if (guardError) return guardError;
    if (!document.narrative) {
        return commandError('missing-narrative', 'Text editing is not active.', []);
    }
    const validation = validateEditorialLinkGraph(document);
    return validation.valid
        ? null
        : { kind: 'error', error: validationIssueToError(validation.issues[0]) };
}

function preflightIntegratedPair(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    guard: EditorialLinkCommandGuard,
    options: {
        requireUnchangedNarrative: boolean;
        allowCompleteNarrativeRelease: boolean;
    },
): EditorialLinkPlanResult | null {
    const standalone = preflightStandalone(before, guard);
    if (standalone) return standalone;
    if (after.revision !== before.revision + 1) {
        return commandError('stale-document',
            'Integrated command must provide the next complete document revision.',
            [String(before.revision), String(after.revision)]);
    }
    if (after.globalEditingMode !== guard.expectedMode) {
        return commandError('stale-mode', 'Global editing mode changed during integrated planning.', []);
    }
    if (!after.narrative && !options.allowCompleteNarrativeRelease) {
        return commandError('missing-narrative', 'Integrated command removed narrative authority.', []);
    }
    if (!options.requireUnchangedNarrative
        && after.narrative
        && after.narrative.revision !== before.narrative!.revision + 1) {
        return commandError('stale-narrative',
            'Integrated anchor command must provide the next narrative revision.', []);
    }
    if (!sameLinks(before.dependentLinks, after.dependentLinks)) {
        return commandError('invalid-proposal',
            'The upstream command must leave dependent links for the WP5 engine to transform.', []);
    }
    if (options.requireUnchangedNarrative
        && JSON.stringify(before.narrative) !== JSON.stringify(after.narrative)) {
        return commandError('invalid-transform',
            'A direct target command cannot also mutate the controlled narrative.', []);
    }
    const targets = validateTargetGraph(after);
    return targets.kind === 'error' ? targets : null;
}

function preflightGuard(
    document: EditorDocumentV4,
    guard: EditorialLinkCommandGuard,
): EditorialLinkPlanResult | null {
    if (document.revision !== guard.expectedDocumentRevision) {
        return commandError('stale-document', 'Document revision changed before link planning.', []);
    }
    if (document.globalEditingMode !== guard.expectedMode) {
        return commandError('stale-mode', 'Global editing mode changed before link planning.', []);
    }
    if (guard.expectedNarrativeRevision !== undefined
        && document.narrative?.revision !== guard.expectedNarrativeRevision) {
        return commandError('stale-narrative', 'Narrative revision changed before link planning.', []);
    }
    return null;
}

/**
 * WP4 owns narrative/controlled-video geometry but deliberately leaves dependent targets for
 * this engine. Rejecting an already-moved linked target prevents `follow` from being applied
 * twice and prevents `none` from silently accepting an upstream target edit without a ledger.
 */
function preflightUnchangedLinkedTargets(
    before: EditorDocumentV4,
    afterNarrativeCommand: EditorDocumentV4,
): EditorialLinkPlanResult | null {
    for (const link of before.dependentLinks) {
        const oldTarget = resolveTarget(before, link.target);
        if (oldTarget.kind === 'error') return oldTarget;
        const pendingTarget = resolveTarget(afterNarrativeCommand, link.target);
        if (pendingTarget.kind === 'error'
            || pendingTarget.snapshot.trackId !== oldTarget.snapshot.trackId
            || pendingTarget.snapshot.interval.start !== oldTarget.snapshot.interval.start
            || pendingTarget.snapshot.interval.end !== oldTarget.snapshot.interval.end) {
            return commandError('invalid-transform',
                'The upstream anchor command must leave linked targets unchanged for WP5.',
                [oldTarget.snapshot.key]);
        }
    }
    return null;
}

function preflightNewTargetLink(
    document: EditorDocumentV4,
    target: EditorialDependentTargetV1,
    anchorBlockId: string,
): EditorialLinkPlanResult | null {
    const anchor = document.narrative?.blocks[anchorBlockId];
    if (!anchor || !document.narrative?.blockIds.includes(anchorBlockId)) {
        return commandError('missing-anchor', 'Dependent anchor does not exist.', [anchorBlockId]);
    }
    const resolved = resolveTarget(document, target);
    if (resolved.kind === 'error') return resolved;
    const owner = findVideoOwner(document, target);
    if (owner) {
        return commandError('owned-target',
            'A narrative-owned video occurrence cannot become a dependent target.', [owner.id]);
    }
    const targetKey = resolved.snapshot.key;
    const existing = document.dependentLinks.find(link => getEditorialTargetKey(link.target) === targetKey);
    return existing
        ? commandError('target-already-linked', 'Dependent target already has one durable link.', [existing.id])
        : null;
}

function validateAssociation(
    document: EditorDocumentV4,
    link: EditorialDependentLinkV1,
    anchor: NarrativeBlockV1 | undefined,
    bindingIds: Set<string>,
    path: string,
    issues: EditorialLinkValidationIssue[],
): void {
    if (link.association.kind === 'overlap') {
        if (link.association.origin !== 'auto' && link.association.origin !== 'manual') {
            issues.push(issue('invalid-proposal', `${path}.association.origin`,
                'Overlap origin must be auto or manual.', [link.id]));
        }
        return;
    }
    const binding = link.association.binding;
    if (binding.version !== 1
        || !isSafeEditorId(binding.bindingId)
        || !isSha256Digest(binding.transcriptRecordId)
        || !isSafeEditorId(binding.sourceIntervalId)
        || !Number.isSafeInteger(binding.activeStartSample)
        || !Number.isSafeInteger(binding.activeEndSample)
        || binding.activeStartSample < 0
        || binding.activeEndSample <= binding.activeStartSample
        || !isSafeEditorId(binding.lineageRootId)
        || !isSafeEditorId(binding.createdFromBlockId)) {
        issues.push(issue('invalid-binding', `${path}.association.binding`,
            'Transcript binding identity or sample interval is invalid.', [link.id]));
    }
    if (bindingIds.has(binding.bindingId)) {
        issues.push(issue('duplicate-link-id', `${path}.association.binding.bindingId`,
            'Transcript binding IDs must be unique.', [binding.bindingId]));
    }
    bindingIds.add(binding.bindingId);
    const descriptor = anchor
        ? findTranscriptDescriptor(document, binding.transcriptRecordId, anchor.sourceId)
        : undefined;
    if (!descriptor || binding.activeEndSample > descriptor.sampleCount) {
        issues.push(issue('invalid-binding', `${path}.association.binding`,
            'Transcript binding exceeds its persisted descriptor sample bounds.', [link.id]));
    }
    if (anchor && (binding.transcriptRecordId !== anchor.transcriptRecordId
        || binding.sourceIntervalId !== anchor.sourceIntervalId
        || binding.lineageRootId !== anchor.lineageRootId
        || !validContainedSampleRange(binding.activeStartSample, binding.activeEndSample, anchor))) {
        issues.push(issue('lineage-mismatch', `${path}.association.binding`,
            'Transcript binding must identify an exact fragment inside its current occurrence lineage.',
            [link.id, anchor.id]));
    }
}

function validateTargetGraph(
    document: EditorDocumentV4,
): { kind: 'success' } | { kind: 'error'; error: EditorialLinkError } {
    try {
        buildVideoTrackPlacementsV4(document);
    } catch {
        return commandError('collision', 'Video targets have invalid bounds or same-track collision.', []);
    }
    const snapshots = listTargetSnapshots(document);
    if (snapshots.kind === 'error') return snapshots;
    const keys = new Set<string>();
    for (const snapshot of snapshots.snapshots) {
        if (keys.has(snapshot.key)) {
            return commandError('duplicate-target', 'Target persisted identity is duplicated.', [snapshot.key]);
        }
        keys.add(snapshot.key);
    }
    const audioByTrack = new Map<string, TargetSnapshot[]>();
    snapshots.snapshots.forEach(snapshot => {
        if (snapshot.target.kind !== 'audio-clip') return;
        const values = audioByTrack.get(snapshot.trackId) ?? [];
        values.push(snapshot);
        audioByTrack.set(snapshot.trackId, values);
    });
    for (const values of Array.from(audioByTrack.values())) {
        values.sort(compareTargetSnapshotsByTime);
        for (let index = 1; index < values.length; index += 1) {
            if (intervalsOverlap(values[index - 1].interval, values[index].interval)) {
                return commandError('collision', 'Audio targets collide on one track.', [
                    values[index - 1].key,
                    values[index].key,
                ]);
            }
        }
    }
    return { kind: 'success' };
}

function listTargetSnapshots(
    document: EditorDocumentV4,
): { kind: 'success'; snapshots: TargetSnapshot[] } | { kind: 'error'; error: EditorialLinkError } {
    const targets: EditorialDependentTargetV1[] = [
        ...document.videoClips.map(clip => ({ kind: 'video-clip' as const, clipId: clip.id })),
        ...document.audioTracks.flatMap(track => track.clips.map(clip => ({
            kind: 'audio-clip' as const,
            trackId: track.id,
            clipId: clip.id,
        }))),
        ...document.subtitleTracks.flatMap(track => track.subtitles.map(subtitle => ({
            kind: 'subtitle' as const,
            trackId: track.id,
            subtitleId: subtitle.id,
        }))),
    ];
    const snapshots: TargetSnapshot[] = [];
    for (const target of targets) {
        const resolved = resolveTarget(document, target);
        if (resolved.kind === 'error') return resolved;
        snapshots.push(resolved.snapshot);
    }
    return { kind: 'success', snapshots };
}

function resolveTarget(
    document: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): { kind: 'success'; snapshot: TargetSnapshot } | { kind: 'error'; error: EditorialLinkError } {
    const key = getEditorialTargetKey(target);
    const safeIdentity = target.kind === 'video-clip'
        ? isSafeEditorId(target.clipId)
        : target.kind === 'audio-clip'
            ? isSafeEditorId(target.trackId) && isSafeEditorId(target.clipId)
            : isSafeEditorId(target.trackId) && isSafeEditorId(target.subtitleId);
    if (!safeIdentity) return commandError('invalid-id', 'Dependent target identity is unsafe.', [key]);
    if (target.kind === 'video-clip') {
        const clipIndex = document.videoClips.findIndex(clip => clip.id === target.clipId);
        if (clipIndex < 0) return commandError('missing-target', 'Dependent video target does not exist.', [key]);
        const clip = document.videoClips[clipIndex];
        const trackIndex = document.videoTracks.findIndex(track => track.id === clip.trackId);
        const source = document.videoSources.find(value => value.id === clip.sourceId);
        if (trackIndex < 0 || !source
            || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
            || !Number.isFinite(clip.sourceEnd) || clip.sourceEnd <= clip.sourceStart
            || clip.sourceEnd > source.duration + 1e-9) {
            return commandError('invalid-bounds', 'Dependent video target has invalid source ownership or bounds.', [key]);
        }
        try {
            const placement = getVideoClipPlacementV4(document, clip);
            return {
                kind: 'success',
                snapshot: {
                    target: cloneTarget(target),
                    key,
                    trackId: clip.trackId,
                    interval: {
                        start: frameToOutputSample(placement.startFrame, document.renderProfile.fps),
                        end: frameToOutputSample(placement.endFrame, document.renderProfile.fps),
                    },
                    locked: document.videoTracks[trackIndex].locked,
                    order: clipIndex,
                },
            };
        } catch {
            return commandError('invalid-bounds', 'Dependent video target interval is invalid.', [key]);
        }
    }

    if (target.kind === 'audio-clip') {
        const trackIndex = document.audioTracks.findIndex(track => track.id === target.trackId);
        if (trackIndex < 0) return commandError('missing-target', 'Dependent audio track does not exist.', [key]);
        const track = document.audioTracks[trackIndex];
        const clipIndex = track.clips.findIndex(clip => clip.id === target.clipId);
        if (clipIndex < 0) return commandError('missing-target', 'Dependent audio target does not exist.', [key]);
        const clip = track.clips[clipIndex];
        const interval = getAudioInterval(document, clip);
        if (!interval) return commandError('invalid-bounds', 'Dependent audio target interval is invalid.', [key]);
        return {
            kind: 'success',
            snapshot: {
                target: cloneTarget(target),
                key,
                trackId: track.id,
                interval,
                locked: track.locked,
                order: document.videoClips.length + trackIndex * 1_000_000 + clipIndex,
            },
        };
    }

    const trackIndex = document.subtitleTracks.findIndex(track => track.id === target.trackId);
    if (trackIndex < 0) return commandError('missing-target', 'Dependent subtitle track does not exist.', [key]);
    const track = document.subtitleTracks[trackIndex];
    const subtitleIndex = track.subtitles.findIndex(value => value.id === target.subtitleId);
    if (subtitleIndex < 0) return commandError('missing-target', 'Dependent subtitle target does not exist.', [key]);
    const subtitle = track.subtitles[subtitleIndex];
    const start = secondsBoundaryToOutputSample(subtitle.startTime);
    const end = secondsBoundaryToOutputSample(subtitle.endTime);
    if (start === null || end === null || end <= start) {
        return commandError('invalid-bounds', 'Dependent subtitle target interval is invalid.', [key]);
    }
    return {
        kind: 'success',
        snapshot: {
            target: cloneTarget(target),
            key,
            trackId: track.id,
            interval: { start, end },
            locked: track.isLocked,
            order: document.videoClips.length + document.audioTracks.length * 1_000_000
                + trackIndex * 1_000_000 + subtitleIndex,
        },
    };
}

function getAudioInterval(
    document: EditorDocumentV4,
    clip: AudioClip,
): EditorialOutputSampleInterval | null {
    if (!Number.isSafeInteger(clip.timelineStartFrame) || clip.timelineStartFrame < 0) return null;
    let start: number;
    try {
        start = frameToOutputSample(clip.timelineStartFrame, document.renderProfile.fps);
    } catch {
        return null;
    }
    let duration: number;
    if (isImportedAudioClip(clip)) {
        const source = document.audioSources.find(value => value.id === clip.source.audioSourceId);
        if (!source
            || !Number.isSafeInteger(clip.sourceStartSample) || clip.sourceStartSample < 0
            || !Number.isSafeInteger(clip.sourceEndSample)
            || clip.sourceEndSample <= clip.sourceStartSample
            || clip.sourceEndSample > source.nativeSampleCount
            || (clip.timelineDurationSamples !== undefined
                && (!Number.isSafeInteger(clip.timelineDurationSamples) || clip.timelineDurationSamples <= 0))) {
            return null;
        }
        try {
            duration = clip.timelineDurationSamples
                ?? nativeBoundaryToOutputSample(clip.sourceEndSample, source.nativeSampleRate)
                - nativeBoundaryToOutputSample(clip.sourceStartSample, source.nativeSampleRate);
        } catch {
            return null;
        }
    } else {
        const source = document.videoSources.find(value => value.id === clip.source.videoSourceId);
        if (!source
            || !Number.isFinite(clip.sourceStart) || clip.sourceStart < 0
            || !Number.isFinite(clip.sourceEnd) || clip.sourceEnd <= clip.sourceStart
            || clip.sourceEnd > source.duration + 1e-9) return null;
        try {
            const durationFrames = Math.max(1, secondsToFrames(
                clip.sourceEnd - clip.sourceStart,
                document.renderProfile.fps,
                'nearest',
            ));
            duration = frameToOutputSample(
                clip.timelineStartFrame + durationFrames,
                document.renderProfile.fps,
            ) - start;
        } catch {
            return null;
        }
    }
    const end = start + duration;
    return Number.isSafeInteger(duration) && duration > 0
        && Number.isSafeInteger(end) && end > start
        ? { start, end }
        : null;
}

function resolveAnchor(
    document: EditorDocumentV4,
    block: NarrativeBlockV1 | undefined,
): { kind: 'success'; snapshot: AnchorSnapshot } | { kind: 'error'; error: EditorialLinkError } {
    if (!block || !document.narrative?.blockIds.includes(block.id)) {
        return commandError('missing-anchor', 'Dependent anchor does not exist.', [block?.id ?? 'unknown']);
    }
    const clip = document.videoClips.find(value => value.id === block.clipId);
    if (!clip
        || clip.trackId !== block.trackId
        || clip.sourceId !== block.sourceId
        || clip.timelineStartFrame !== block.timelineStartFrame) {
        return commandError('missing-anchor', 'Dependent anchor ownership is inconsistent.', [block.id]);
    }
    try {
        const placement = getVideoClipPlacementV4(document, clip);
        return {
            kind: 'success',
            snapshot: {
                block,
                interval: {
                    start: frameToOutputSample(placement.startFrame, document.renderProfile.fps),
                    end: frameToOutputSample(placement.endFrame, document.renderProfile.fps),
                },
            },
        };
    } catch {
        return commandError('invalid-bounds', 'Dependent anchor interval is invalid.', [block.id]);
    }
}

function buildLink(input: {
    document: EditorDocumentV4;
    id: string;
    anchorBlockId: string;
    target: EditorialDependentTargetV1;
    association: EditorialLinkAssociationV1;
    followPolicy: 'none' | 'follow';
    revision: number;
}): { kind: 'success'; link: EditorialDependentLinkV1 } | { kind: 'error'; error: EditorialLinkError } {
    return refreshLink({
        document: input.document,
        link: {
            version: 1,
            id: input.id,
            anchorBlockId: input.anchorBlockId,
            target: cloneTarget(input.target),
            association: cloneAssociation(input.association),
            followPolicy: input.followPolicy,
            relativeStartOutputSample: 0,
            relativeEndOutputSample: 1,
            revision: input.revision,
        },
        revision: input.revision,
    });
}

function refreshLink(input: {
    document: EditorDocumentV4;
    link: EditorialDependentLinkV1;
    revision: number;
}): { kind: 'success'; link: EditorialDependentLinkV1 } | { kind: 'error'; error: EditorialLinkError } {
    const anchor = resolveAnchor(input.document, input.document.narrative?.blocks[input.link.anchorBlockId]);
    if (anchor.kind === 'error') return anchor;
    const target = resolveTarget(input.document, input.link.target);
    if (target.kind === 'error') return target;
    const relativeStartOutputSample = target.snapshot.interval.start - anchor.snapshot.interval.start;
    const relativeEndOutputSample = target.snapshot.interval.end - anchor.snapshot.interval.start;
    if (!Number.isSafeInteger(relativeStartOutputSample)
        || !Number.isSafeInteger(relativeEndOutputSample)
        || relativeEndOutputSample <= relativeStartOutputSample) {
        return commandError('invalid-bounds', 'Refreshed dependent offsets exceed safe bounds.', [input.link.id]);
    }
    return {
        kind: 'success',
        link: {
            ...cloneLink(input.link),
            relativeStartOutputSample,
            relativeEndOutputSample,
            revision: input.revision,
        },
    };
}

function finalizeStandalone(input: {
    command: string;
    label: string;
    before: EditorDocumentV4;
    dependentLinks: EditorialDependentLinkV1[];
}): EditorialLinkPlanResult {
    const after: EditorDocumentV4 = {
        ...input.before,
        revision: input.before.revision + 1,
        dependentLinks: input.dependentLinks.map(cloneLink),
    };
    const proposal = preflightFinalProposal(after);
    if (proposal) return proposal;
    return {
        kind: 'success',
        command: input.command,
        document: after,
        dependentLinks: after.dependentLinks,
        linkMutations: diffLinks(input.before.dependentLinks, after.dependentLinks),
        targetMutations: [],
        history: { createEntry: true, label: input.label },
        persistence: { enqueue: true },
        impact: { content: true, audioGraph: false },
    };
}

function integratedSuccess(input: {
    command: string;
    before: EditorDocumentV4;
    after: EditorDocumentV4;
    targetMutations: EditorialTargetMutation[];
}): EditorialLinkPlanSuccess {
    return {
        kind: 'success',
        command: input.command,
        document: input.after,
        dependentLinks: input.after.dependentLinks,
        linkMutations: diffLinks(input.before.dependentLinks, input.after.dependentLinks),
        targetMutations: input.targetMutations,
        history: { createEntry: false, label: null },
        persistence: { enqueue: false },
        impact: {
            content: true,
            audioGraph: input.targetMutations.some(mutation => mutation.target.kind !== 'subtitle'),
        },
    };
}

function preflightFinalProposal(document: EditorDocumentV4): EditorialLinkPlanResult | null {
    const targetGraph = validateTargetGraph(document);
    if (targetGraph.kind === 'error') return targetGraph;
    const links = validateEditorialLinkGraph(document);
    return links.valid
        ? null
        : { kind: 'error', error: validationIssueToError(links.issues[0]) };
}

function diffLinks(
    before: readonly EditorialDependentLinkV1[],
    after: readonly EditorialDependentLinkV1[],
): EditorialLinkMutation[] {
    const beforeById = new Map(before.map(link => [link.id, link]));
    const afterById = new Map(after.map(link => [link.id, link]));
    const mutations: EditorialLinkMutation[] = [];
    before.forEach(link => {
        const next = afterById.get(link.id);
        if (!next) mutations.push({ kind: 'deleted', link: cloneLink(link) });
        else if (JSON.stringify(link) !== JSON.stringify(next)) {
            mutations.push({ kind: 'updated', before: cloneLink(link), after: cloneLink(next) });
        }
    });
    after.forEach(link => {
        if (!beforeById.has(link.id)) mutations.push({ kind: 'created', link: cloneLink(link) });
    });
    return mutations;
}

function translateTarget(
    document: EditorDocumentV4,
    target: EditorialDependentTargetV1,
    deltaFrames: number,
    deltaOutputSamples: number,
): { kind: 'success'; mutation: EditorialTargetMutation | null }
    | { kind: 'error'; error: EditorialLinkError } {
    const before = resolveTarget(document, target);
    if (before.kind === 'error') return before;
    if (!Number.isSafeInteger(deltaFrames) || !Number.isSafeInteger(deltaOutputSamples)) {
        return commandError('invalid-bounds', 'Follower translation must use safe frame/sample deltas.', [before.snapshot.key]);
    }
    if (target.kind === 'video-clip') {
        const clipIndex = document.videoClips.findIndex(clip => clip.id === target.clipId);
        const clip = document.videoClips[clipIndex];
        const timelineStartFrame = clip.timelineStartFrame + deltaFrames;
        if (!Number.isSafeInteger(timelineStartFrame) || timelineStartFrame < 0) {
            return commandError('invalid-bounds', 'Followed video target would leave project bounds.', [before.snapshot.key]);
        }
        document.videoClips[clipIndex] = { ...clip, timelineStartFrame };
    } else if (target.kind === 'audio-clip') {
        const trackIndex = document.audioTracks.findIndex(track => track.id === target.trackId);
        const track = document.audioTracks[trackIndex];
        const clipIndex = track.clips.findIndex(clip => clip.id === target.clipId);
        const clip = track.clips[clipIndex];
        const timelineStartFrame = clip.timelineStartFrame + deltaFrames;
        if (!Number.isSafeInteger(timelineStartFrame) || timelineStartFrame < 0) {
            return commandError('invalid-bounds', 'Followed audio target would leave project bounds.', [before.snapshot.key]);
        }
        const clips = track.clips.map((value, index) => index === clipIndex
            ? { ...value, timelineStartFrame } as AudioClip
            : value);
        document.audioTracks[trackIndex] = { ...track, clips };
    } else {
        const trackIndex = document.subtitleTracks.findIndex(track => track.id === target.trackId);
        const track = document.subtitleTracks[trackIndex];
        const subtitleIndex = track.subtitles.findIndex(value => value.id === target.subtitleId);
        const subtitle = track.subtitles[subtitleIndex];
        const start = before.snapshot.interval.start + deltaOutputSamples;
        const end = before.snapshot.interval.end + deltaOutputSamples;
        if (!Number.isSafeInteger(start) || start < 0
            || !Number.isSafeInteger(end) || end <= start) {
            return commandError('invalid-bounds', 'Followed subtitle target would leave project bounds.', [before.snapshot.key]);
        }
        const subtitles = track.subtitles.map((value, index) => index === subtitleIndex
            ? {
                ...subtitle,
                startTime: start / EDITORIAL_PROJECT_OUTPUT_SAMPLE_RATE_HZ,
                endTime: end / EDITORIAL_PROJECT_OUTPUT_SAMPLE_RATE_HZ,
            }
            : value);
        document.subtitleTracks[trackIndex] = { ...track, subtitles };
    }
    const after = resolveTarget(document, target);
    if (after.kind === 'error') return after;
    return {
        kind: 'success',
        mutation: before.snapshot.interval.start === after.snapshot.interval.start
            && before.snapshot.interval.end === after.snapshot.interval.end
            ? null
            : {
                kind: 'translated',
                target: cloneTarget(target),
                before: { ...before.snapshot.interval },
                after: { ...after.snapshot.interval },
            },
    };
}

function deleteTarget(
    document: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): { kind: 'success' } | { kind: 'error'; error: EditorialLinkError } {
    const existing = resolveTarget(document, target);
    if (existing.kind === 'error') return existing;
    if (findVideoOwner(document, target)) {
        return commandError('owned-target', 'A controlled occurrence cannot be deleted as a dependent.', [existing.snapshot.key]);
    }
    if (target.kind === 'video-clip') {
        document.videoClips = document.videoClips.filter(clip => clip.id !== target.clipId);
    } else if (target.kind === 'audio-clip') {
        const trackIndex = document.audioTracks.findIndex(track => track.id === target.trackId);
        const track = document.audioTracks[trackIndex];
        document.audioTracks[trackIndex] = {
            ...track,
            clips: track.clips.filter(clip => clip.id !== target.clipId),
        };
    } else {
        const trackIndex = document.subtitleTracks.findIndex(track => track.id === target.trackId);
        const track = document.subtitleTracks[trackIndex];
        document.subtitleTracks[trackIndex] = {
            ...track,
            subtitles: track.subtitles.filter(subtitle => subtitle.id !== target.subtitleId),
        };
    }
    return { kind: 'success' };
}

function validateDirectTargetTransforms(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    transforms: readonly EditorialDirectTargetTransform[],
): { kind: 'success' } | { kind: 'error'; error: EditorialLinkError } {
    const keys = new Set<string>();
    for (const transform of transforms) {
        const key = getEditorialTargetKey(transform.target);
        if (keys.has(key)) {
            return commandError('invalid-transform', 'A direct target may have only one transform.', [key]);
        }
        keys.add(key);
        const oldTarget = resolveTarget(before, transform.target);
        if (oldTarget.kind === 'error') return oldTarget;
        if (findVideoOwner(before, transform.target)) {
            return commandError('owned-target',
                'Controlled video must dispatch through a narrative command.', [key]);
        }
        if (transform.kind === 'deleted') {
            const retained = resolveTarget(after, transform.target);
            if (retained.kind === 'success') {
                return commandError('invalid-transform', 'Deleted target still exists after the command.', [key]);
            }
            continue;
        }
        if (transform.kind === 'moved' || transform.kind === 'trimmed') {
            const afterTarget = transform.kind === 'moved'
                ? transform.afterTarget ?? transform.target
                : transform.target;
            if (transform.kind === 'moved' && !targetsShareMoveIdentity(transform.target, afterTarget)) {
                return commandError('invalid-transform',
                    'Move must preserve target kind and clip/subtitle occurrence identity.', [key]);
            }
            if (transform.kind === 'moved'
                && getEditorialTargetKey(afterTarget) !== key
                && resolveTarget(before, afterTarget).kind === 'success') {
                return commandError('invalid-transform',
                    'Cross-track move destination identity already existed before the command.',
                    [key, getEditorialTargetKey(afterTarget)]);
            }
            if (transform.kind === 'moved'
                && getEditorialTargetKey(afterTarget) !== key
                && resolveTarget(after, transform.target).kind === 'success') {
                return commandError('invalid-transform',
                    'Cross-track move must remove the old persisted target identity.', [key]);
            }
            const current = resolveTarget(after, afterTarget);
            if (current.kind === 'error') return current;
            if (transform.kind === 'trimmed'
                && current.snapshot.trackId !== oldTarget.snapshot.trackId) {
                return commandError('invalid-transform',
                    'Trim must preserve target track identity.', [key]);
            }
            if (transform.kind === 'moved') {
                const oldDuration = oldTarget.snapshot.interval.end - oldTarget.snapshot.interval.start;
                const newDuration = current.snapshot.interval.end - current.snapshot.interval.start;
                // Audio/subtitle cross-track moves change their persisted target key. Video keys
                // are clip-only, so their resolved track snapshot must also count as a real move
                // when a vertical drag deliberately preserves the project interval.
                if (oldDuration !== newDuration
                    || (getEditorialTargetKey(afterTarget) === key
                        && oldTarget.snapshot.trackId === current.snapshot.trackId
                        && oldTarget.snapshot.interval.start === current.snapshot.interval.start)) {
                    return commandError('invalid-transform',
                        'Move must change target placement or track without changing output duration.', [key]);
                }
            } else if (current.snapshot.interval.start < oldTarget.snapshot.interval.start
                || current.snapshot.interval.end > oldTarget.snapshot.interval.end
                || current.snapshot.interval.start === oldTarget.snapshot.interval.start
                    && current.snapshot.interval.end === oldTarget.snapshot.interval.end) {
                return commandError('invalid-transform',
                    'Trim must retain a strict non-empty subset of the old target interval.', [key]);
            }
            continue;
        }
        const childKeys = new Set(transform.childTargets.map(getEditorialTargetKey));
        if (transform.childTargets.length < 2 || childKeys.size !== transform.childTargets.length) {
            return commandError('invalid-transform', 'Split requires at least two unique child targets.', [key]);
        }
        if (!childKeys.has(key) && resolveTarget(after, transform.target).kind === 'success') {
            return commandError('invalid-transform',
                'Split must remove the old target identity unless one child explicitly retains it.', [key]);
        }
        const children: TargetSnapshot[] = [];
        for (const childTarget of transform.childTargets) {
            const childKey = getEditorialTargetKey(childTarget);
            if (childKey !== key && resolveTarget(before, childTarget).kind === 'success') {
                return commandError('invalid-transform',
                    'A new split child cannot reuse a target identity that existed before the command.',
                    [key, childKey]);
            }
            if (!targetsShareSplitDomain(transform.target, childTarget)) {
                return commandError('invalid-transform',
                    'Split children must preserve target kind and track identity.', [key]);
            }
            const child = resolveTarget(after, childTarget);
            if (child.kind === 'error') return child;
            if (child.snapshot.trackId !== oldTarget.snapshot.trackId) {
                return commandError('invalid-transform',
                    'Split children must remain on the old target track.', [key]);
            }
            children.push(child.snapshot);
        }
        children.sort(compareTargetSnapshotsByTime);
        if (children[0].interval.start !== oldTarget.snapshot.interval.start
            || children.at(-1)!.interval.end !== oldTarget.snapshot.interval.end) {
            return commandError('invalid-transform',
                'Split children must preserve the exact old target output interval.', [key]);
        }
        for (let index = 1; index < children.length; index += 1) {
            if (children[index - 1].interval.end !== children[index].interval.start) {
                return commandError('invalid-transform',
                    'Split children must concatenate without a gap or overlap.', [key]);
            }
        }
    }

    const movedVideo = transforms.some(transform => (
        transform.kind === 'moved' && transform.target.kind === 'video-clip'
    ));
    if (movedVideo) {
        // WP6 owns the visible response policy for unlinked subtitles. WP5 still requires every
        // resulting cue movement to be explicit in the shared transform ledger; otherwise a video
        // drag could silently publish an omitted deletion before link precedence is evaluated. Track
        // identity and visibility are not follower transforms at all, so a video move must preserve
        // them exactly.
        const deletedSubtitle = transforms.find(transform => (
            transform.kind === 'deleted' && transform.target.kind === 'subtitle'
        ));
        if (deletedSubtitle) {
            return commandError(
                'invalid-transform',
                'A video move cannot delete a subtitle follower.',
                [getEditorialTargetKey(deletedSubtitle.target)],
            );
        }
        for (const track of before.subtitleTracks) {
            const currentTrack = after.subtitleTracks.find(candidate => candidate.id === track.id);
            if (!currentTrack || currentTrack.isVisible !== track.isVisible) {
                return commandError(
                    'invalid-transform',
                    'A video move cannot remove or change the visibility of a subtitle track.',
                    [track.id],
                );
            }
        }
        const oldSnapshots = listTargetSnapshots(before);
        if (oldSnapshots.kind === 'error') return oldSnapshots;
        for (const oldSnapshot of oldSnapshots.snapshots) {
            if (oldSnapshot.target.kind !== 'subtitle' || keys.has(oldSnapshot.key)) continue;
            const current = resolveTarget(after, oldSnapshot.target);
            if (current.kind === 'error'
                || current.snapshot.interval.start !== oldSnapshot.interval.start
                || current.snapshot.interval.end !== oldSnapshot.interval.end) {
                return commandError(
                    'invalid-transform',
                    'Every subtitle changed by a video move requires an explicit follower transform.',
                    [oldSnapshot.key],
                );
            }
        }
    }

    // A changed linked target omitted from the ledger would otherwise be silently refreshed by
    // inference. Requiring explicit coverage keeps WP6's command/undo intent auditable.
    for (const link of before.dependentLinks) {
        const key = getEditorialTargetKey(link.target);
        const oldTarget = resolveTarget(before, link.target);
        if (oldTarget.kind === 'error') return oldTarget;
        const current = resolveTarget(after, link.target);
        const changed = current.kind === 'error'
            || current.snapshot.trackId !== oldTarget.snapshot.trackId
            || current.snapshot.interval.start !== oldTarget.snapshot.interval.start
            || current.snapshot.interval.end !== oldTarget.snapshot.interval.end;
        if (changed && !keys.has(key)) {
            return commandError('invalid-transform',
                'Every changed linked target requires an explicit direct-edit transform.', [key]);
        }
    }
    return { kind: 'success' };
}

function targetsShareSplitDomain(
    parent: EditorialDependentTargetV1,
    child: EditorialDependentTargetV1,
): boolean {
    if (parent.kind !== child.kind) return false;
    if (parent.kind === 'video-clip' && child.kind === 'video-clip') return true;
    if (parent.kind === 'audio-clip' && child.kind === 'audio-clip') return parent.trackId === child.trackId;
    return parent.kind === 'subtitle' && child.kind === 'subtitle' && parent.trackId === child.trackId;
}

function targetsShareMoveIdentity(
    before: EditorialDependentTargetV1,
    after: EditorialDependentTargetV1,
): boolean {
    if (before.kind !== after.kind) return false;
    if (before.kind === 'video-clip' && after.kind === 'video-clip') {
        return before.clipId === after.clipId;
    }
    if (before.kind === 'audio-clip' && after.kind === 'audio-clip') {
        return before.clipId === after.clipId;
    }
    return before.kind === 'subtitle' && after.kind === 'subtitle'
        && before.subtitleId === after.subtitleId;
}

function indexAndValidateAnchorTransforms(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    transforms: readonly NarrativeAnchorTransform[],
): { kind: 'success'; index: AnchorTransformIndex } | { kind: 'error'; error: EditorialLinkError } {
    const beforeNarrative = before.narrative!;
    if (!after.narrative) {
        return indexAndValidateCompleteNarrativeRelease(before, after, transforms);
    }
    const afterNarrative = after.narrative;
    const byOldBlockId = new Map<string, NarrativeAnchorTransform>();
    const register = (
        blockId: string,
        transform: NarrativeAnchorTransform,
    ): { kind: 'error'; error: EditorialLinkError } | null => {
        if (byOldBlockId.has(blockId)) {
            return commandError('invalid-transform',
                'An old anchor block may have only one structural transform.', [blockId]);
        }
        byOldBlockId.set(blockId, transform);
        return null;
    };

    for (const transform of transforms) {
        if (transform.kind === 'created') {
            if (beforeNarrative.blocks[transform.blockId]
                || !afterNarrative.blocks[transform.blockId]
                || !afterNarrative.blockIds.includes(transform.blockId)) {
                return commandError('invalid-transform',
                    'Created anchor transform does not match before/after narrative identity.', [transform.blockId]);
            }
            continue;
        }
        if (transform.kind === 'deleted') {
            const duplicate = register(transform.blockId, transform);
            if (duplicate) return duplicate;
            if (!beforeNarrative.blocks[transform.blockId]
                || afterNarrative.blocks[transform.blockId]
                || afterNarrative.blockIds.includes(transform.blockId)) {
                return commandError('invalid-transform',
                    'Deleted anchor transform does not remove the exact old block.', [transform.blockId]);
            }
            continue;
        }
        if (transform.kind === 'translated') {
            const duplicate = register(transform.blockId, transform);
            if (duplicate) return duplicate;
            const oldBlock = beforeNarrative.blocks[transform.blockId];
            const newBlock = afterNarrative.blocks[transform.blockId];
            if (!oldBlock || !newBlock
                || !Number.isSafeInteger(transform.deltaFrames)
                || transform.deltaFrames === 0
                || newBlock.timelineStartFrame - oldBlock.timelineStartFrame !== transform.deltaFrames
                || !sameAnchorSourceGeometry(oldBlock, newBlock)) {
                return commandError('invalid-transform',
                    'Translated anchor transform does not match exact source geometry and frame delta.',
                    [transform.blockId]);
            }
            continue;
        }
        if (transform.kind === 'split') {
            const duplicate = register(transform.oldBlockId, transform);
            if (duplicate) return duplicate;
            const oldBlock = beforeNarrative.blocks[transform.oldBlockId];
            const left = afterNarrative.blocks[transform.leftBlockId];
            const right = afterNarrative.blocks[transform.rightBlockId];
            if (!oldBlock || !left || !right || left.id === right.id
                || !Number.isSafeInteger(transform.splitSample)
                || left.coreStartSample !== oldBlock.coreStartSample
                || left.coreEndSample !== transform.splitSample
                || right.coreStartSample !== transform.splitSample
                || right.coreEndSample !== oldBlock.coreEndSample
                || !sameTranscriptLineage(oldBlock, left)
                || !sameTranscriptLineage(oldBlock, right)
                || left.timelineStartFrame > right.timelineStartFrame) {
                return commandError('invalid-transform',
                    'Split anchor transform does not partition the exact old occurrence.',
                    [transform.oldBlockId]);
            }
            continue;
        }
        if (transform.kind === 'merged') {
            const leftDuplicate = register(transform.leftBlockId, transform);
            if (leftDuplicate) return leftDuplicate;
            const rightDuplicate = register(transform.rightBlockId, transform);
            if (rightDuplicate) return rightDuplicate;
            const left = beforeNarrative.blocks[transform.leftBlockId];
            const right = beforeNarrative.blocks[transform.rightBlockId];
            const merged = afterNarrative.blocks[transform.mergedBlockId];
            if (!left || !right || !merged
                || left.id === right.id
                || left.coreEndSample !== right.coreStartSample
                || merged.coreStartSample !== left.coreStartSample
                || merged.coreEndSample !== right.coreEndSample
                || !sameTranscriptLineage(left, right)
                || !sameTranscriptLineage(left, merged)) {
                return commandError('invalid-transform',
                    'Merge anchor transform does not preserve exact occurrence lineage and coverage.',
                    [transform.leftBlockId, transform.rightBlockId]);
            }
            continue;
        }

        const duplicate = register(transform.oldBlockId, transform);
        if (duplicate) return duplicate;
        const oldBlock = beforeNarrative.blocks[transform.oldBlockId];
        if (!oldBlock
            || transform.newBlockIds.length !== transform.retainedRanges.length
            || transform.newBlockIds.length === 0
            || new Set(transform.newBlockIds).size !== transform.newBlockIds.length) {
            return commandError('invalid-transform',
                'Trim transform requires one ordered retained range per new occurrence.', [transform.oldBlockId]);
        }
        for (let index = 0; index < transform.newBlockIds.length; index += 1) {
            const child = afterNarrative.blocks[transform.newBlockIds[index]];
            const range = transform.retainedRanges[index];
            // WP4 deliberately reuses `trimmed` for source extension and margin rematerialization.
            // Therefore the exact after-range may extend beyond the old semantic core; identity,
            // lineage, and agreement with the published child are the authoritative checks here.
            if (!child
                || !isValidOutputInterval(range)
                || child.coreStartSample !== range.start
                || child.coreEndSample !== range.end
                || !sameTranscriptLineage(oldBlock, child)) {
                return commandError('invalid-transform',
                    'Trim transform retained range does not match its exact child occurrence.',
                    [transform.oldBlockId, transform.newBlockIds[index]]);
            }
            if (index > 0) {
                const previousRange = transform.retainedRanges[index - 1];
                const previousChild = afterNarrative.blocks[transform.newBlockIds[index - 1]];
                if (previousRange.end > range.start
                    || previousChild.timelineStartFrame > child.timelineStartFrame) {
                    return commandError('invalid-transform',
                        'Trim children must remain in ordered, non-overlapping source/project order.',
                        [transform.oldBlockId]);
                }
            }
        }
    }
    return { kind: 'success', index: { byOldBlockId } };
}

/**
 * Validates the one legal anchor-command projection whose post-state has no narrative.
 *
 * Releasing the final controlled track removes narrative authority but is not a media deletion:
 * every old anchor is represented by exactly one `deleted` transform while its formerly owned
 * clip remains structurally equivalent in the pending V4 graph. This exact coverage check keeps
 * ordinary delete/malformed null-narrative projections from being mistaken for a release.
 */
function indexAndValidateCompleteNarrativeRelease(
    before: EditorDocumentV4,
    after: EditorDocumentV4,
    transforms: readonly NarrativeAnchorTransform[],
): { kind: 'success'; index: AnchorTransformIndex } | { kind: 'error'; error: EditorialLinkError } {
    const beforeNarrative = before.narrative!;
    const beforeValidation = validateEditorDocumentV4(before);
    if (!beforeValidation.valid) {
        return commandError('invalid-proposal',
            'Final narrative release requires a structurally valid V4 source document.',
            [beforeValidation.issues[0]?.path ?? 'document']);
    }
    const expectedBlockIds = new Set(beforeNarrative.blockIds);
    const byOldBlockId = new Map<string, NarrativeAnchorTransform>();
    if (transforms.length !== expectedBlockIds.size) {
        return commandError('invalid-transform',
            'Final narrative release requires exactly one deleted transform for every old anchor.',
            beforeNarrative.blockIds);
    }

    for (const transform of transforms) {
        if (transform.kind !== 'deleted'
            || !expectedBlockIds.has(transform.blockId)
            || byOldBlockId.has(transform.blockId)) {
            const referencedId = transform.kind === 'deleted'
                ? transform.blockId
                : 'blockId' in transform
                    ? transform.blockId
                    : 'oldBlockId' in transform
                        ? transform.oldBlockId
                        : 'leftBlockId' in transform
                            ? transform.leftBlockId
                            : 'unknown';
            return commandError('invalid-transform',
                'Final narrative release may contain only unique deleted transforms for old anchors.',
                [referencedId]);
        }
        byOldBlockId.set(transform.blockId, transform);
    }
    const uncovered = beforeNarrative.blockIds.filter(blockId => !byOldBlockId.has(blockId));
    if (uncovered.length > 0) {
        return commandError('invalid-transform',
            'Final narrative release omitted one or more old anchors.', uncovered);
    }

    for (const blockId of beforeNarrative.blockIds) {
        const block = beforeNarrative.blocks[blockId];
        const beforeClip = before.videoClips.find(clip => clip.id === block.clipId);
        const afterClip = after.videoClips.find(clip => clip.id === block.clipId);
        if (!beforeClip || !afterClip || JSON.stringify(beforeClip) !== JSON.stringify(afterClip)) {
            return commandError('invalid-transform',
                'Final narrative release must preserve every formerly controlled clip in place.',
                [blockId, block.clipId]);
        }
    }
    return { kind: 'success', index: { byOldBlockId } };
}

function resolveAnchorTransform(input: {
    before: EditorDocumentV4;
    after: EditorDocumentV4;
    link: EditorialDependentLinkV1;
    transformIndex: AnchorTransformIndex;
}): { kind: 'success'; resolution: AnchorResolution } | { kind: 'error'; error: EditorialLinkError } {
    const oldBlock = input.before.narrative!.blocks[input.link.anchorBlockId];
    if (!oldBlock) return commandError('missing-anchor', 'Old dependent anchor is missing.', [input.link.anchorBlockId]);
    const transform = input.transformIndex.byOldBlockId.get(oldBlock.id);
    if (!transform) {
        const current = input.after.narrative!.blocks[oldBlock.id];
        if (!current || !sameCompleteAnchorGeometry(oldBlock, current)) {
            return commandError('invalid-transform',
                'Changed dependent anchor is missing an explicit WP4 transform.', [oldBlock.id]);
        }
        return {
            kind: 'success',
            resolution: {
                touched: false,
                anchor: current,
                association: cloneAssociation(input.link.association),
            },
        };
    }
    if (transform.kind === 'deleted') {
        return {
            kind: 'success',
            resolution: { touched: true, anchor: null, association: cloneAssociation(input.link.association) },
        };
    }
    if (transform.kind === 'translated') {
        const anchor = input.after.narrative!.blocks[transform.blockId];
        return {
            kind: 'success',
            resolution: {
                touched: true,
                anchor,
                association: retargetBindingToAnchor(input.link.association, anchor),
            },
        };
    }
    if (transform.kind === 'merged') {
        const anchor = input.after.narrative!.blocks[transform.mergedBlockId];
        if (input.link.association.kind === 'transcript-bound'
            && !validContainedSampleRange(
                input.link.association.binding.activeStartSample,
                input.link.association.binding.activeEndSample,
                anchor,
            )) {
            return commandError('invalid-binding',
                'Merged anchor no longer contains the exact active fragment.', [input.link.id]);
        }
        return {
            kind: 'success',
            resolution: {
                touched: true,
                anchor,
                association: retargetBindingToAnchor(input.link.association, anchor),
            },
        };
    }

    const candidateIds = transform.kind === 'split'
        ? [transform.leftBlockId, transform.rightBlockId]
        : transform.kind === 'trimmed'
            ? [...transform.newBlockIds]
            : [];
    const candidates = candidateIds.map(blockId => input.after.narrative!.blocks[blockId]);
    if (input.link.association.kind === 'transcript-bound') {
        const selected = selectBindingAnchor(candidates, input.link.association.binding);
        if (!selected) {
            return {
                kind: 'success',
                resolution: {
                    touched: true,
                    anchor: null,
                    association: cloneAssociation(input.link.association),
                },
            };
        }
        return {
            kind: 'success',
            resolution: {
                touched: true,
                anchor: selected.block,
                association: {
                    kind: 'transcript-bound',
                    binding: {
                        ...input.link.association.binding,
                        sourceIntervalId: selected.block.sourceIntervalId,
                        activeStartSample: selected.intersection.start,
                        activeEndSample: selected.intersection.end,
                    },
                },
            },
        };
    }
    const target = resolveTarget(input.after, input.link.target);
    if (target.kind === 'error') return target;
    const selected = selectOverlapAnchor(input.after, candidates, target.snapshot.interval);
    if (selected.kind === 'error') return selected;
    return {
        kind: 'success',
        resolution: {
            touched: true,
            anchor: selected.anchor,
            association: cloneAssociation(input.link.association),
        },
    };
}

function selectBindingAnchor(
    candidates: readonly NarrativeBlockV1[],
    binding: TranscriptFragmentBindingV1,
): { block: NarrativeBlockV1; intersection: EditorialOutputSampleInterval } | null {
    const compatible = candidates
        .filter(block => block.transcriptRecordId === binding.transcriptRecordId
            && block.lineageRootId === binding.lineageRootId)
        .map((block, order) => {
            const start = Math.max(block.coreStartSample, binding.activeStartSample);
            const end = Math.min(block.coreEndSample, binding.activeEndSample);
            return { block, order, intersection: start < end ? { start, end } : null };
        })
        .filter((candidate): candidate is {
            block: NarrativeBlockV1;
            order: number;
            intersection: EditorialOutputSampleInterval;
        } => candidate.intersection !== null);
    if (compatible.length === 0) return null;
    compatible.sort((left, right) => {
        const leftLength = left.intersection.end - left.intersection.start;
        const rightLength = right.intersection.end - right.intersection.start;
        // The exact-binding split rule chooses greater source intersection and resolves an exact
        // tie to the earlier child. Candidate order is the WP4 retained/left-to-right order.
        return rightLength - leftLength || left.order - right.order;
    });
    return { block: compatible[0].block, intersection: compatible[0].intersection };
}

function selectOverlapAnchor(
    document: EditorDocumentV4,
    candidates: readonly NarrativeBlockV1[],
    targetInterval: EditorialOutputSampleInterval,
): { kind: 'success'; anchor: NarrativeBlockV1 } | { kind: 'error'; error: EditorialLinkError } {
    const resolved: AnchorSnapshot[] = [];
    for (const block of candidates) {
        const anchor = resolveAnchor(document, block);
        if (anchor.kind === 'error') return anchor;
        resolved.push(anchor.snapshot);
    }
    if (resolved.length === 0) {
        return commandError('invalid-transform', 'Overlap anchor transform has no surviving child.', []);
    }
    const scored = resolved.map((anchor, order) => ({
        anchor,
        order,
        overlap: intervalOverlapLength(anchor.interval, targetInterval),
    }));
    const greatest = Math.max(...scored.map(candidate => candidate.overlap));
    const tied = scored.filter(candidate => candidate.overlap === greatest);
    if (tied.length === 1) return { kind: 'success', anchor: tied[0].anchor.block };

    // For partial overlap split/delete, the target midpoint resolves a greatest-overlap tie. A
    // midpoint exactly on a child boundary is intentionally assigned to the earlier child rather
    // than relying on half-open containment, which would otherwise pick the right child.
    const midpointTwice = BigInt(targetInterval.start) + BigInt(targetInterval.end);
    const containing = tied.filter(candidate => (
        BigInt(candidate.anchor.interval.start) * BigInt(2) < midpointTwice
        && midpointTwice < BigInt(candidate.anchor.interval.end) * BigInt(2)
    ));
    if (containing.length === 1) return { kind: 'success', anchor: containing[0].anchor.block };
    tied.sort((left, right) => left.anchor.interval.start - right.anchor.interval.start
        || left.anchor.interval.end - right.anchor.interval.end
        || left.order - right.order
        || compareIds(left.anchor.block.id, right.anchor.block.id));
    return { kind: 'success', anchor: tied[0].anchor.block };
}

function selectGreatestOverlapChild(
    children: readonly TargetSnapshot[],
    anchorInterval: EditorialOutputSampleInterval,
    exactTieToEarlier: boolean,
): TargetSnapshot {
    const scored = children.map(child => ({
        child,
        overlap: intervalOverlapLength(child.interval, anchorInterval),
    }));
    const greatest = Math.max(...scored.map(candidate => candidate.overlap));
    const tied = scored.filter(candidate => candidate.overlap === greatest);
    if (tied.length === 1) return tied[0].child;
    if (!exactTieToEarlier) {
        const midpointTwice = BigInt(anchorInterval.start) + BigInt(anchorInterval.end);
        const containing = tied.filter(candidate => (
            BigInt(candidate.child.interval.start) * BigInt(2) < midpointTwice
            && midpointTwice < BigInt(candidate.child.interval.end) * BigInt(2)
        ));
        if (containing.length === 1) return containing[0].child;
    }
    return [...tied].sort((left, right) => compareTargetSnapshotsByTime(left.child, right.child))[0].child;
}

function selectDirectSplitChild(input: {
    before: EditorDocumentV4;
    after: EditorDocumentV4;
    link: EditorialDependentLinkV1;
    children: readonly TargetSnapshot[];
    anchor: { kind: 'success'; snapshot: AnchorSnapshot };
}): TargetSnapshot {
    if (input.link.target.kind !== 'video-clip') {
        return selectGreatestOverlapChild(input.children, input.anchor.snapshot.interval, true);
    }
    // Video split selection is explicitly frame-domain. Equal frame coverage must stay a tie even
    // when fractional-FPS frame-to-48-kHz conversion makes one span one sample longer.
    const anchorPlacement = getVideoClipPlacementV4(
        input.before,
        input.anchor.snapshot.block.clipId,
    );
    const anchorFrames = { start: anchorPlacement.startFrame, end: anchorPlacement.endFrame };
    const scored = input.children.map(child => {
        if (child.target.kind !== 'video-clip') {
            return { child, overlap: -1 };
        }
        const placement = getVideoClipPlacementV4(input.after, child.target.clipId);
        return {
            child,
            overlap: intervalOverlapLength(
                { start: placement.startFrame, end: placement.endFrame },
                anchorFrames,
            ),
        };
    });
    const greatest = Math.max(...scored.map(candidate => candidate.overlap));
    return scored
        .filter(candidate => candidate.overlap === greatest)
        .sort((left, right) => compareTargetSnapshotsByTime(left.child, right.child))[0].child;
}

function retargetBindingToAnchor(
    association: EditorialLinkAssociationV1,
    anchor: NarrativeBlockV1,
): EditorialLinkAssociationV1 {
    return association.kind === 'overlap'
        ? { kind: 'overlap', origin: association.origin }
        : {
            kind: 'transcript-bound',
            binding: { ...association.binding, sourceIntervalId: anchor.sourceIntervalId },
        };
}

function sameAnchorSourceGeometry(left: NarrativeBlockV1, right: NarrativeBlockV1): boolean {
    return left.id === right.id
        && left.clipId === right.clipId
        && left.trackId === right.trackId
        && left.sourceId === right.sourceId
        && left.transcriptRecordId === right.transcriptRecordId
        && left.sourceIntervalId === right.sourceIntervalId
        && left.lineageRootId === right.lineageRootId
        && left.coreStartSample === right.coreStartSample
        && left.coreEndSample === right.coreEndSample
        && left.materialization.sourceStartFrame === right.materialization.sourceStartFrame
        && left.materialization.sourceEndFrame === right.materialization.sourceEndFrame;
}

function sameCompleteAnchorGeometry(left: NarrativeBlockV1, right: NarrativeBlockV1): boolean {
    return sameAnchorSourceGeometry(left, right)
        && left.timelineStartFrame === right.timelineStartFrame;
}

function sameTranscriptLineage(left: NarrativeBlockV1, right: NarrativeBlockV1): boolean {
    return left.trackId === right.trackId
        && left.sourceId === right.sourceId
        && left.transcriptRecordId === right.transcriptRecordId
        && left.lineageRootId === right.lineageRootId;
}

function findVideoOwner(
    document: EditorDocumentV4,
    target: EditorialDependentTargetV1,
): NarrativeBlockV1 | null {
    if (target.kind !== 'video-clip' || !document.narrative) return null;
    for (const blockId of document.narrative.blockIds) {
        const block = document.narrative.blocks[blockId];
        if (block?.clipId === target.clipId) return block;
    }
    return null;
}

function validContainedSampleRange(
    start: number,
    end: number,
    block: NarrativeBlockV1,
): boolean {
    return Number.isSafeInteger(start)
        && Number.isSafeInteger(end)
        && start >= block.coreStartSample
        && end <= block.coreEndSample
        && end > start;
}

function isValidOutputInterval(interval: HalfOpenInterval): boolean {
    return Number.isSafeInteger(interval.start)
        && interval.start >= 0
        && Number.isSafeInteger(interval.end)
        && interval.end > interval.start;
}

function secondsBoundaryToOutputSample(seconds: number): number | null {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    const sample = Math.round(seconds * EDITORIAL_PROJECT_OUTPUT_SAMPLE_RATE_HZ);
    return Number.isSafeInteger(sample) ? sample : null;
}

function createLinkIdAllocator(
    document: EditorDocumentV4,
    factory: EditorialLinkIdFactory,
): EditorialLinkIdFactory {
    const used = new Set<string>([
        ...document.videoSources.map(source => source.id),
        ...document.audioSources.map(source => source.id),
        ...document.videoTracks.map(track => track.id),
        ...document.videoClips.map(clip => clip.id),
        ...document.audioTracks.flatMap(track => [track.id, ...track.clips.map(clip => clip.id)]),
        ...document.subtitleTracks.flatMap(track => [track.id, ...track.subtitles.map(value => value.id)]),
        ...(document.narrative ? [
            document.narrative.id,
            ...document.narrative.blockIds,
            ...Object.values(document.narrative.blocks).flatMap(block => [
                block.instanceId,
                block.lineageRootId,
                block.sourceIntervalId,
                ...block.parentInstanceIds,
                ...(block.materialization.preBoundary.kind === 'partition-seam'
                    ? [block.materialization.preBoundary.seamId]
                    : []),
                ...(block.materialization.postBoundary.kind === 'partition-seam'
                    ? [block.materialization.postBoundary.seamId]
                    : []),
            ]),
        ] : []),
        ...document.dependentLinks.flatMap(link => [
            link.id,
            ...(link.association.kind === 'transcript-bound'
                ? [link.association.binding.bindingId]
                : []),
        ]),
    ]);
    return kind => {
        const id = factory(kind);
        if (!isSafeEditorId(id) || used.has(id)) {
            throw new Error(`Injected ${kind} ID is unsafe or already used.`);
        }
        used.add(id);
        return id;
    };
}

function cloneTargetGraph(document: EditorDocumentV4): EditorDocumentV4 {
    return {
        ...document,
        videoClips: document.videoClips.map(clip => ({
            ...clip,
            audio: clip.audio ? { ...clip.audio } : null,
        })),
        audioTracks: document.audioTracks.map(track => ({
            ...track,
            clips: track.clips.map(cloneAudioClip),
        })),
        subtitleTracks: document.subtitleTracks.map(track => ({
            ...track,
            subtitles: track.subtitles.map(subtitle => ({ ...subtitle })),
        })),
        dependentLinks: document.dependentLinks.map(cloneLink),
    };
}

function cloneAudioClip(clip: AudioClip): AudioClip {
    return clip.source.kind === 'audio-source'
        ? {
            ...clip,
            source: { ...clip.source },
        } as ImportedAudioClip
        : {
            ...clip,
            source: { ...clip.source },
        } as VideoSourceAudioClip;
}

function isImportedAudioClip(clip: AudioClip): clip is ImportedAudioClip {
    return clip.source.kind === 'audio-source';
}

function cloneTarget(target: EditorialDependentTargetV1): EditorialDependentTargetV1 {
    return { ...target };
}

function cloneAssociation(association: EditorialLinkAssociationV1): EditorialLinkAssociationV1 {
    return association.kind === 'overlap'
        ? { kind: 'overlap', origin: association.origin }
        : { kind: 'transcript-bound', binding: { ...association.binding } };
}

function cloneLink(link: EditorialDependentLinkV1): EditorialDependentLinkV1 {
    return {
        ...link,
        target: cloneTarget(link.target),
        association: cloneAssociation(link.association),
    };
}

function replaceLink(
    links: readonly EditorialDependentLinkV1[],
    replacement: EditorialDependentLinkV1,
): EditorialDependentLinkV1[] {
    return links.map(link => link.id === replacement.id ? cloneLink(replacement) : cloneLink(link));
}

function sameLinks(
    left: readonly EditorialDependentLinkV1[],
    right: readonly EditorialDependentLinkV1[],
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function compareTargetSnapshotsByTime(left: TargetSnapshot, right: TargetSnapshot): number {
    return left.interval.start - right.interval.start
        || left.interval.end - right.interval.end
        || left.order - right.order
        || compareIds(left.key, right.key);
}

function lockedTargetError(snapshot: TargetSnapshot): { kind: 'error'; error: EditorialLinkError } {
    return commandError('locked-target',
        'Dependent follow or direct edit requires mutation on an unlocked target track.', [snapshot.key]);
}

function noop(code: EditorialLinkPlanNoop['code']): EditorialLinkPlanNoop {
    return {
        kind: 'noop',
        code,
        history: { createEntry: false, label: null },
        persistence: { enqueue: false },
    };
}

function commandError(
    code: EditorialLinkErrorCode,
    message: string,
    ids: readonly string[],
): { kind: 'error'; error: EditorialLinkError } {
    return { kind: 'error', error: linkError(code, message, ids) };
}

function linkError(
    code: EditorialLinkErrorCode,
    message: string,
    ids: readonly string[],
): EditorialLinkError {
    return { code, message, ids: [...ids] };
}

function issue(
    code: EditorialLinkErrorCode,
    path: string,
    message: string,
    ids: readonly string[],
): EditorialLinkValidationIssue {
    return { ...linkError(code, message, ids), path };
}

function validationIssueToError(value: EditorialLinkValidationIssue): EditorialLinkError {
    return { code: value.code, message: value.message, ids: [...value.ids] };
}

function findTranscriptDescriptor(
    document: EditorDocumentV4,
    recordId: string,
    sourceId: string,
) {
    return document.editorialTranscriptDescriptors.find(descriptor =>
        descriptor.recordId === recordId && descriptor.sourceId === sourceId);
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
