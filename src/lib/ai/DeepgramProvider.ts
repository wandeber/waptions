import { createClient } from "@deepgram/sdk";
import type { AIGenerateOptions, AIUsageMetrics } from "./AIProvider";
import { AIProvider } from "./AIProvider";

export interface DeepgramSettings {
    apiKey: string;
}

/**
 * DeepgramProvider handles speech-to-text using Deepgram's API.
 */
export class DeepgramProvider extends AIProvider {
    private client: ReturnType<typeof createClient> | undefined;

    constructor(name: string, models: string[], settings: DeepgramSettings) {
        super(name, models, settings as unknown as Record<string, unknown>);
    }

    private getClient() {
        if (!this.client) {
            this.client = createClient(this.settings.apiKey as string);
        }
        return this.client;
    }

    async generate<T>(
        model: string,
        options: AIGenerateOptions
    ): Promise<{ data: T; usage: AIUsageMetrics }> {
        console.warn(`Generate not implemented for DeepgramProvider: ${model}`, options);
        throw new Error("Generate not implemented for DeepgramProvider");
    }

    async transcribe(
        model: string,
        audioFile: File | Blob,
        options?: {
            response_format?: string;
            language?: string;
            [key: string]: unknown;
        }
    ): Promise<unknown> {
        if (!this.models.includes(model)) {
            throw new Error(`Model not supported: ${model}`);
        }

        const buffer = Buffer.from(await audioFile.arrayBuffer());

        const response = await this.getClient().listen.prerecorded.transcribeFile(
            buffer,
            {
                model: model === "deepgram-nova-2" ? "nova-2" : model,
                smart_format: true,
                utterances: true,
                punctuated: true,
                paragraphs: true,
                diarize: true,
                language: options?.language || "es",
                ...options
            }
        );

        if (response.error) {
            throw new Error(`Deepgram transcription error: ${response.error.message}`);
        }

        return response.result;
    }
}
