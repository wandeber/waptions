import type { MediaCandidate } from './contracts';

const naturalCollator = new Intl.Collator('en', {
    numeric: true,
    sensitivity: 'base',
    usage: 'sort',
});

export function compareMediaCandidatesNaturally(
    left: Pick<MediaCandidate, 'displayName' | 'candidateId'>,
    right: Pick<MediaCandidate, 'displayName' | 'candidateId'>,
): number {
    const natural = naturalCollator.compare(
        left.displayName.normalize('NFC'),
        right.displayName.normalize('NFC'),
    );
    if (natural !== 0) return natural;
    const exact = left.displayName.localeCompare(right.displayName, 'en', {
        sensitivity: 'variant',
    });
    return exact !== 0 ? exact : left.candidateId.localeCompare(right.candidateId);
}

export function sortMediaCandidatesNaturally(
    candidates: readonly MediaCandidate[],
): readonly MediaCandidate[] {
    return [...candidates].sort(compareMediaCandidatesNaturally);
}
