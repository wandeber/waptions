import { afterEach, describe, expect, it, vi } from "vitest";
import {
    getLocalBrowserModelManifest,
    getVisibleLocalBrowserModelManifests,
    normalizeLocalBrowserPipelineOutput,
} from "@/lib/ai/local-browser-transcription";

describe("normalizeLocalBrowserPipelineOutput", () => {
    it("normalizes Transformers.js word timestamp chunks", () => {
        const result = normalizeLocalBrowserPipelineOutput({
            text: "Hola mundo",
            chunks: [
                { text: " Hola", timestamp: [0.1, 0.4] },
                { text: "mundo", timestamp: [0.45, 0.9] },
            ],
        }, 1);

        expect(result.text).toBe("Hola mundo");
        expect(result.words).toEqual([
            { word: "Hola", start: 0.1, end: 0.4 },
            { word: "mundo", start: 0.45, end: 0.9 },
        ]);
    });

    it("splits segment-level timestamp chunks into editable word spans", () => {
        const result = normalizeLocalBrowserPipelineOutput({
            text: "Hola mundo cruel",
            chunks: [
                { text: " Hola mundo cruel", timestamp: [1, 4] },
            ],
        }, 4);

        expect(result.text).toBe("Hola mundo cruel");
        expect(result.words.map(word => word.word)).toEqual(["Hola", "mundo", "cruel"]);
        expect(result.words[0].start).toBe(1);
        expect(result.words.at(-1)?.end).toBe(4);
        expect(result.words.every(word => word.end > word.start)).toBe(true);
    });

    it("normalizes OpenAI-style words", () => {
        const result = normalizeLocalBrowserPipelineOutput({
            words: [
                { word: "test", start: 1, end: 1.25 },
            ],
        }, 2);

        expect(result.text).toBe("test");
        expect(result.words[0]).toEqual({ word: "test", start: 1, end: 1.25 });
    });

    it("rejects responses without word timestamps", () => {
        expect(() => normalizeLocalBrowserPipelineOutput({ text: "Only text" }, 2)).toThrow("word timestamps");
    });
});

describe("local browser model manifests", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("falls back to the stable manifest", () => {
        expect(getLocalBrowserModelManifest(undefined).id).toBe("whisper-base-webgpu");
        expect(getLocalBrowserModelManifest("missing").id).toBe("whisper-base-webgpu");
    });

    it("hides experimental Qwen manifests unless explicitly enabled", () => {
        vi.stubEnv("NEXT_PUBLIC_ENABLE_EXPERIMENTAL_QWEN_BROWSER_ASR", "false");
        expect(getVisibleLocalBrowserModelManifests().map(manifest => manifest.id)).toEqual(["whisper-base-webgpu"]);

        vi.stubEnv("NEXT_PUBLIC_ENABLE_EXPERIMENTAL_QWEN_BROWSER_ASR", "true");
        expect(getVisibleLocalBrowserModelManifests().some(manifest => manifest.id === "qwen-mega-asr-browser")).toBe(true);
    });
});
