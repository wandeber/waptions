export type VideoTrackDropTarget =
    | { kind: 'track'; trackId: string }
    | { kind: 'insertion'; insertionIndex: number };

/** Converts the deepest pointer hit into the nearest explicit video-lane drop contract. */
export function parseVideoTrackDropTarget(element: Element | null): VideoTrackDropTarget | null {
    const insertion = element?.closest<HTMLElement>('[data-video-track-insertion-index]');
    if (insertion) {
        const insertionIndex = Number(insertion.dataset.videoTrackInsertionIndex);
        return Number.isSafeInteger(insertionIndex) && insertionIndex >= 0
            ? { kind: 'insertion', insertionIndex }
            : null;
    }
    const track = element?.closest<HTMLElement>('[data-video-track-id]');
    const trackId = track?.dataset.videoTrackId;
    return trackId ? { kind: 'track', trackId } : null;
}
