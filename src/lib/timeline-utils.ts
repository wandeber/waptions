import { Subtitle, SubtitleTrack } from '@/types/timeline';

/**
 * Finds a subtitle at a specific time on a given track.
 */
export function findSubtitleAtTime(track: SubtitleTrack, time: number): Subtitle | undefined {
    const EPSILON = 0.005; // 5ms buffer for floating point/snapping
    return track.subtitles.find(s => time >= s.startTime - EPSILON && time < s.endTime - EPSILON);
}

/**
 * Finds a subtitle at a specific time across all tracks, prioritizing the active one.
 */
export function findSubtitleAcrossTracks(
    tracks: SubtitleTrack[],
    time: number,
    activeTrackId: string | null
): { subtitle: Subtitle; trackId: string } | null {
    const activeTrack = tracks.find(t => t.id === activeTrackId);
    if (activeTrack) {
        const sub = findSubtitleAtTime(activeTrack, time);
        if (sub) return { subtitle: sub, trackId: activeTrack.id };
    }

    for (const track of tracks) {
        if (track.id === activeTrackId) continue;
        const sub = findSubtitleAtTime(track, time);
        if (sub) return { subtitle: sub, trackId: track.id };
    }

    return null;
}

/**
 * Groups words into lines for the transcription grouper (Mode Sagrado).
 */
export function generateDefaultGrouperState(words: Subtitle[], wordsPerLine: number = 3) {
    const groups: { [key: string]: Subtitle[] } = {};
    const containerIds: string[] = [];

    const sorted = [...words].sort((a, b) => a.startTime - b.startTime);
    const timestamp = Date.now();

    let currentChunk: Subtitle[] = [];
    let currentChars = 0;
    let groupCount = 0;

    const flush = () => {
        if (currentChunk.length > 0) {
            const id = `container-${timestamp}-${groupCount++}`;
            groups[id] = currentChunk;
            containerIds.push(id);
            currentChunk = [];
            currentChars = 0;
        }
    };

    for (const word of sorted) {
        const wordLen = word.text.length;

        // Split conditions:
        // 1. Max words reached
        // 2. Significant silence gap (> 0.5s)
        // 3. Very long line (> 35 chars roughly)
        const lastWord = currentChunk[currentChunk.length - 1];
        const silenceGap = lastWord ? (word.startTime - lastWord.endTime) : 0;

        if (
            (currentChunk.length >= wordsPerLine) ||
            (silenceGap > 0.5) ||
            (currentChars + wordLen > 35)
        ) {
            flush();
        }

        currentChunk.push(word);
        currentChars += wordLen + 1;
    }

    flush();
    return { groups, containerIds };
}

/**
 * Converts words into final subtitles for the timeline.
 */
export function generateTimelineSubtitles(words: Subtitle[], wordsPerLine: number = 3): Subtitle[] {
    const { groups, containerIds } = generateDefaultGrouperState(words, wordsPerLine);

    return containerIds.map(id => {
        const groupWords = groups[id];
        return {
            id: crypto.randomUUID(),
            startTime: groupWords[0].startTime,
            endTime: groupWords[groupWords.length - 1].endTime,
            text: groupWords.map(w => w.text).join(' ')
        };
    });
}
