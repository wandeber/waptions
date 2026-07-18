import { afterEach, describe, expect, it, vi } from "vitest";
import {
    normalizeOpenAICompatibleDiarization,
    transcribeDiarizedAudioWithOpenAICompatibleEndpoint,
} from "./openai-compatible-diarization";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("transcribeDiarizedAudioWithOpenAICompatibleEndpoint", () => {
    it("sends exactly one non-streaming verbose diarization request with the caller signal", async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const formData = init?.body as FormData;
            const entries = Array.from(formData.entries()).map(([key, value]) => [
                key,
                typeof value === "string" ? value : `file:${value.name}`,
            ]);

            expect(input.toString()).toBe("http://localhost:43556/v1/audio/transcriptions");
            expect(init?.signal).toBe(controller.signal);
            expect(entries).toEqual([
                ["file", "file:project-audio.mp4"],
                ["model", "whisper-1"],
                ["response_format", "verbose_json"],
                ["diarize", "true"],
                ["stream", "false"],
            ]);

            return new Response(JSON.stringify({ diarization: { speaker_segments: [] } }), { status: 200 });
        }) as unknown as typeof fetch;

        const result = await transcribeDiarizedAudioWithOpenAICompatibleEndpoint({
            settings: {
                enabled: true,
                requestMode: "browser",
                endpoint: "localhost:43556/v1",
                model: "whisper-1",
            },
            audioFile: new File(["audio"], "project-audio.mp4", { type: "audio/mp4" }),
            fetchImpl,
            signal: controller.signal,
        });

        expect(result).toEqual({ diarization: { speaker_segments: [] } });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe("normalizeOpenAICompatibleDiarization", () => {
    it("orders speakers by first chronological appearance and preserves repeated segments", () => {
        mockRandomUUIDs();

        const result = normalizeOpenAICompatibleDiarization({
            speakers: ["A", "Z"],
            diarization: {
                speaker_segments: [
                    { speaker: "Z", start: 2, end: 2.5, text: "  Later Z  " },
                    { speaker: "A", start: 1, end: 1.5, text: "Speaker A" },
                    { speaker: "Z", start: 0.25, end: 0.75, text: "First Z" },
                ],
            },
        }, 3, 30);

        expect(result.map(speaker => speaker.sourceSpeakerLabel)).toEqual(["Z", "A"]);
        expect(result[0].subtitles.map(subtitle => subtitle.text)).toEqual(["First Z", "Later Z"]);
        expect(result[0].subtitles.map(subtitle => [subtitle.startTime, subtitle.endTime])).toEqual([
            [0.25, 0.75],
            [2, 2.5],
        ]);
        expect(result[0].transcription.containerIds).toHaveLength(2);
        expect(result[0].transcription.containerIds.map(containerId => (
            result[0].transcription.groups[containerId].map(subtitle => subtitle.text)
        ))).toEqual([["First Z"], ["Later Z"]]);
        expect(result[0].transcription.raw).toHaveLength(2);
        expect(result[0].transcription.raw[0].id).not.toBe(result[0].subtitles[0].id);
    });

    it("uses start, end, and source order as deterministic chronological tie-breakers", () => {
        mockRandomUUIDs();

        const result = normalizeOpenAICompatibleDiarization({
            diarization: {
                speaker_segments: [
                    { speaker: "A", start: 1, end: 2, text: "long" },
                    { speaker: "B", start: 1, end: 1.5, text: "short first" },
                    { speaker: "C", start: 1, end: 1.5, text: "same timing second" },
                ],
            },
        }, 3, 30);

        expect(result.map(speaker => speaker.sourceSpeakerLabel)).toEqual(["B", "C", "A"]);
    });

    it("returns an empty speaker list for a valid no-speech response", () => {
        expect(normalizeOpenAICompatibleDiarization({
            diarization: { speaker_segments: [] },
        }, 10, 30)).toEqual([]);
    });

    it("clamps only frame-or-AAC-sized encoder rounding at the duration boundaries", () => {
        mockRandomUUIDs();

        const result = normalizeOpenAICompatibleDiarization({
            diarization: {
                speaker_segments: [
                    { speaker: "A", start: -0.039, end: 10.039, text: "Rounded" },
                ],
            },
        }, 10, 25);

        expect(result[0].subtitles[0]).toMatchObject({ startTime: 0, endTime: 10 });
    });

    it("uses one AAC frame as the minimum rounding tolerance at high project frame rates", () => {
        mockRandomUUIDs();

        const result = normalizeOpenAICompatibleDiarization({
            diarization: {
                speaker_segments: [
                    { speaker: "A", start: -0.02, end: 1.02, text: "AAC rounded" },
                ],
            },
        }, 1, 120);

        expect(result[0].subtitles[0]).toMatchObject({ startTime: 0, endTime: 1 });
    });

    it.each([
        undefined,
        null,
        {},
        { diarization: null },
        { diarization: {} },
        { diarization: { speaker_segments: "not-an-array" } },
    ])("rejects an unsupported response shape: %j", (response) => {
        expect(() => normalizeOpenAICompatibleDiarization(response, 10, 30)).toThrow("unsupported diarization response");
    });

    it.each([
        null,
        { speaker: "", start: 0, end: 1, text: "text" },
        { speaker: "A", start: 0, end: 1, text: "   " },
        { speaker: "A", start: Number.NaN, end: 1, text: "text" },
        { speaker: "A", start: 0, end: Number.POSITIVE_INFINITY, text: "text" },
        { speaker: "A", start: 1, end: 1, text: "text" },
        { speaker: "A", start: 2, end: 1, text: "text" },
    ])("rejects a malformed segment: %j", (segment) => {
        expect(() => normalizeOpenAICompatibleDiarization({
            diarization: { speaker_segments: [segment] },
        }, 10, 30)).toThrow("segment 1 is malformed");
    });

    it.each([
        { speaker: "A", start: -0.041, end: 1, text: "too early" },
        { speaker: "A", start: 0, end: 10.041, text: "too late" },
        { speaker: "A", start: 10.02, end: 10.03, text: "collapsed after clamp" },
    ])("rejects timestamps beyond the bounded rounding tolerance: %j", (segment) => {
        expect(() => normalizeOpenAICompatibleDiarization({
            diarization: { speaker_segments: [segment] },
        }, 10, 25)).toThrow();
    });

    it.each([
        { duration: Number.NaN, fps: 30, message: "duration" },
        { duration: -1, fps: 30, message: "duration" },
        { duration: 1, fps: 0, message: "FPS" },
        { duration: 1, fps: Number.POSITIVE_INFINITY, message: "FPS" },
    ])("rejects invalid normalization bounds: $message", ({ duration, fps, message }) => {
        expect(() => normalizeOpenAICompatibleDiarization({
            diarization: { speaker_segments: [] },
        }, duration, fps)).toThrow(message);
    });
});

function mockRandomUUIDs() {
    let index = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
        index += 1;
        return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    });
}
