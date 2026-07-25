import { describe, expect, it } from 'vitest';
import type { VerifiedMediaCandidate } from '../media/contracts';
import {
  compareCanonicalNaturalNames,
  selectNaturalVideoCandidates,
} from './natural-sort';

async function* entries(
  values: readonly VerifiedMediaCandidate[],
): AsyncIterable<VerifiedMediaCandidate> {
  yield* values;
}

describe('canonical natural media candidate sorting', () => {
  it('orders numeric chunks deterministically and rejects unsafe or non-video names', async () => {
    const values: VerifiedMediaCandidate[] = [
      { displayName: 'IMG_3621.mov', sourceCapabilityId: '5', fileType: 'regular-file' },
      { displayName: 'clip02.mp4', sourceCapabilityId: '7', fileType: 'regular-file' },
      { displayName: '244754_medium.mp4', sourceCapabilityId: '2', fileType: 'regular-file' },
      { displayName: 'IMG_3619.mov', sourceCapabilityId: '3', fileType: 'regular-file' },
      { displayName: '3840.mp4', sourceCapabilityId: '1', fileType: 'regular-file' },
      { displayName: 'IMG_3620.mov', sourceCapabilityId: '4', fileType: 'regular-file' },
      { displayName: 'clip2.mp4', sourceCapabilityId: '6', fileType: 'regular-file' },
      { displayName: '../escape.mp4', sourceCapabilityId: '8', fileType: 'regular-file' },
      { displayName: 'line\nbreak.mp4', sourceCapabilityId: '9', fileType: 'regular-file' },
      { displayName: 'audio.mp3', sourceCapabilityId: '10', fileType: 'regular-file' },
      { displayName: 'folder.mp4', sourceCapabilityId: '11', fileType: 'other' },
    ];

    const selected = await selectNaturalVideoCandidates(entries(values), { maxEntries: 20 });

    expect(selected.candidates.map((candidate) => candidate.displayName)).toEqual([
      '3840.mp4',
      '244754_medium.mp4',
      'clip2.mp4',
      'clip02.mp4',
      'IMG_3619.mov',
      'IMG_3620.mov',
      'IMG_3621.mov',
    ]);
    expect(selected.rejectedCount).toBe(4);
  });

  it('uses canonical case and code-point tie breakers', () => {
    expect(compareCanonicalNaturalNames('a2.MP4', 'A10.mp4')).toBeLessThan(0);
    expect(compareCanonicalNaturalNames('A2.mp4', 'a2.mp4')).toBeLessThan(0);
  });

  it('enforces a hard directory entry limit', async () => {
    await expect(selectNaturalVideoCandidates(entries([
      { displayName: 'a.mp4', sourceCapabilityId: '1', fileType: 'regular-file' },
      { displayName: 'b.mp4', sourceCapabilityId: '2', fileType: 'regular-file' },
    ]), { maxEntries: 1 })).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
    });
  });
});
