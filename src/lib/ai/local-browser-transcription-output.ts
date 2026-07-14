import type {
    LocalBrowserTranscriptionResult,
    LocalBrowserTranscriptionWord,
} from "@/lib/ai/local-browser-transcription";

export function normalizeLocalBrowserPipelineOutput(
    value: unknown,
    fallbackDurationSeconds: number,
): Pick<LocalBrowserTranscriptionResult, "text" | "words"> {
    if (!isRecord(value)) {
        throw new Error("Local transcription returned an unsupported response.");
    }

    const text = typeof value.text === "string" ? value.text.trim() : "";
    const rawWords = Array.isArray(value.words)
        ? value.words
        : Array.isArray(value.chunks)
            ? value.chunks
            : [];

    const words = rawWords
        .flatMap((item, index) => normalizeLocalTimedItem(item, index, fallbackDurationSeconds))
        .filter((word): word is LocalBrowserTranscriptionWord => Boolean(word));

    if (words.length === 0) {
        throw new Error("The local model returned text without word timestamps. Try the stable Whisper local model or a custom endpoint.");
    }

    return {
        text: text || words.map(word => word.word).join(" "),
        words,
    };
}

function normalizeLocalTimedItem(value: unknown, index: number, fallbackDurationSeconds: number): LocalBrowserTranscriptionWord[] {
    if (!isRecord(value)) {
        return [];
    }

    const timestamp = Array.isArray(value.timestamp) ? value.timestamp : null;
    const hasSegmentTimestamp = getFiniteNumber(timestamp?.[0]) !== undefined && getFiniteNumber(timestamp?.[1]) !== undefined;
    const text = getWordText(value);

    if (hasSegmentTimestamp && text.split(/\s+/).filter(Boolean).length > 1) {
        return splitSegmentIntoTimedWords(value, fallbackDurationSeconds);
    }

    const word = normalizeLocalWord(value, index, fallbackDurationSeconds);
    return word ? [word] : [];
}

function normalizeLocalWord(value: unknown, index: number, fallbackDurationSeconds: number): LocalBrowserTranscriptionWord | null {
    if (!isRecord(value)) {
        return null;
    }

    const word = getWordText(value);
    const timestamp = Array.isArray(value.timestamp) ? value.timestamp : null;
    const start = getFiniteNumber(value.start) ?? getFiniteNumber(timestamp?.[0]);
    const end = getFiniteNumber(value.end) ?? getFiniteNumber(timestamp?.[1]);

    if (!word || start === undefined) {
        return null;
    }

    // Some browser ASR pipelines occasionally omit a word end timestamp. The
    // timeline still needs a bounded cue, so infer a tiny readable duration
    // instead of dropping the word and desynchronizing the generated subtitle set.
    const safeEnd = end !== undefined && end > start
        ? end
        : Math.min(fallbackDurationSeconds, start + 0.2 + (index % 3) * 0.03);

    return {
        word,
        start: Math.max(0, start),
        end: Math.max(start + 0.001, safeEnd),
    };
}

function splitSegmentIntoTimedWords(value: Record<string, unknown>, fallbackDurationSeconds: number): LocalBrowserTranscriptionWord[] {
    const text = getWordText(value);
    const timestamp = Array.isArray(value.timestamp) ? value.timestamp : null;
    const start = Math.max(0, getFiniteNumber(timestamp?.[0]) ?? 0);
    const end = Math.max(start + 0.001, getFiniteNumber(timestamp?.[1]) ?? fallbackDurationSeconds);
    const duration = Math.max(0.001, end - start);
    const words = text.match(/\S+/g) ?? [];

    if (words.length === 0) {
        return [];
    }

    // Segment-level Whisper timestamps do not include the cross-attention data
    // needed for real word alignment. This deterministic allocation keeps the
    // timeline editable by approximating word spans from the segment duration,
    // weighted by visible word length so long words receive slightly more time.
    const weights = words.map(word => Math.max(1, word.replace(/[^\w]/g, "").length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = start;

    return words.map((word, index) => {
        const isLast = index === words.length - 1;
        const wordDuration = isLast ? end - cursor : duration * (weights[index] / totalWeight);
        const wordEnd = isLast ? end : Math.min(end, cursor + wordDuration);
        const result = {
            word,
            start: cursor,
            end: Math.max(cursor + 0.001, wordEnd),
        };

        cursor = result.end;
        return result;
    });
}

function getWordText(value: Record<string, unknown>): string {
    const candidate = typeof value.word === "string"
        ? value.word
        : typeof value.text === "string"
            ? value.text
            : "";

    return candidate.trim();
}

function getFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
