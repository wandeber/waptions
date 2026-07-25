import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerateDiarizedSubtitlesAction } from "./generate-diarized-subtitles.action";
import type { OpenAICompatibleTranscriptionSettings } from "@/types/transcription";

const ALLOWLIST_ENV = "OPENAI_COMPATIBLE_TRANSCRIPTION_SERVER_ALLOWED_HOSTS";
const actionContext = { user: null };

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("GenerateDiarizedSubtitlesAction", () => {
    it("rejects missing mixed audio without making a request", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(GenerateDiarizedSubtitlesAction.run({
            audioFile: null,
            customOpenAITranscription: serverSettings("http://localhost:43556/v1"),
            signal: new AbortController().signal,
        }, actionContext)).rejects.toThrow("No mixed audio file provided");

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects built-in-only input and browser-mode custom settings", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const audioFile = new File(["audio"], "mix.mp4", { type: "audio/mp4" });
        const signal = new AbortController().signal;

        const builtInOnlyInput = {
            audioFile,
            customOpenAITranscription: null,
            signal,
            model: "whisper-1",
        };
        await expect(GenerateDiarizedSubtitlesAction.run(
            builtInOnlyInput,
            actionContext,
        )).rejects.toThrow("Configure a custom OpenAI-compatible transcriber");

        await expect(GenerateDiarizedSubtitlesAction.run({
            audioFile,
            customOpenAITranscription: {
                ...serverSettings("http://localhost:43556/v1"),
                requestMode: "browser",
            },
            signal,
        }, actionContext)).rejects.toThrow("must be sent directly from the browser");

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a production endpoint before fetch when its host is not allowlisted", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv(ALLOWLIST_ENV, "");
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(GenerateDiarizedSubtitlesAction.run({
            audioFile: new File(["audio"], "mix.mp4", { type: "audio/mp4" }),
            customOpenAITranscription: serverSettings("https://transcriber.example.com/v1"),
            signal: new AbortController().signal,
        }, actionContext)).rejects.toThrow("not allowed");

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("allows an allowlisted production endpoint and attaches the bounded request signal", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv(ALLOWLIST_ENV, "8.8.8.8");
        const controller = new AbortController();
        const rawResponse = { diarization: { speaker_segments: [] } };
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            expect(init?.signal?.aborted).toBe(false);
            return new Response(JSON.stringify(rawResponse), { status: 200 });
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await GenerateDiarizedSubtitlesAction.run({
            audioFile: new File(["audio"], "mix.mp4", { type: "audio/mp4" }),
            customOpenAITranscription: serverSettings("https://8.8.8.8/v1"),
            signal: controller.signal,
        }, actionContext);

        expect(result).toEqual(rawResponse);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows localhost in development without weakening the production rule", async () => {
        vi.stubEnv("NODE_ENV", "development");
        vi.stubEnv(ALLOWLIST_ENV, "");
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            diarization: { speaker_segments: [] },
        }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        await GenerateDiarizedSubtitlesAction.run({
            audioFile: new File(["audio"], "mix.mp4", { type: "audio/mp4" }),
            customOpenAITranscription: serverSettings("http://localhost:43556/v1"),
            signal: new AbortController().signal,
        }, actionContext);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

function serverSettings(endpoint: string): OpenAICompatibleTranscriptionSettings {
    return {
        enabled: true,
        requestMode: "server",
        endpoint,
        model: "whisper-1",
    };
}
