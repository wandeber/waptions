import OpenAI from "openai";
import type { AIGenerateOptions, AIUsageMetrics } from "./AIProvider";
import { AIProvider } from "./AIProvider";

export interface OpenAISettings {
    projectName?: string;
    projectId?: string;
    projectSecret?: string;
}

/**
 * OpenAIProvider wraps the OpenAI responses API for vision and text,
 * and standard audio endpoints for transcription.
 */
export class OpenAIProvider extends AIProvider {
    private client: OpenAI | undefined;

    constructor(name: string, models: string[], settings: OpenAISettings) {
        super(name, models, settings as unknown as Record<string, unknown>);
    }

    private getClient(): OpenAI {
        if (!this.client) {
            this.client = new OpenAI({
                apiKey: (this.settings as any).projectSecret as string,
            });
        }
        return this.client;
    }

    async generate<T>(
        model: string,
        options: AIGenerateOptions
    ): Promise<{ data: T; usage: AIUsageMetrics }> {
        if (!this.models.includes(model)) {
            throw new Error(`Model not supported: ${model}`);
        }

        const { instructions, messages, attachments, responseSchema, extra } = options;
        let schemaName: string | undefined;
        let schemaDescription: string | undefined;
        const finalExtra = { ...extra };

        if (finalExtra) {
            schemaName = finalExtra.schemaName as string | undefined;
            schemaDescription = finalExtra.schemaDescription as string | undefined;
            delete finalExtra.schemaName;
            delete finalExtra.schemaDescription;
        }

        // Build content parts
        const contentParts: Array<any> = [];
        for (const m of messages) {
            contentParts.push({ type: "input_text", text: m.content });
        }

        if (attachments) {
            for (const att of attachments) {
                if ("url" in att) {
                    contentParts.push({
                        type: "input_image",
                        image_url: att.url as string,
                    });
                }
                else {
                    const buffer = att.data instanceof ArrayBuffer
                        ? Buffer.from(new Uint8Array(att.data))
                        : Buffer.from(att.data as any);
                    const base64 = buffer.toString("base64");
                    const mime = att.mimeType || "image/png";
                    contentParts.push({
                        type: "input_image",
                        image_url: `data:${mime};base64,${base64}`,
                    });
                }
            }
        }

        const payload: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
            model: model as OpenAI.ResponsesModel,
            input: [
                {
                    role: "user",
                    content: contentParts,
                },
            ],
            include: [
                "reasoning.encrypted_content",
                "web_search_call.action.sources"
            ],
            ...finalExtra,
        };

        if (instructions) {
            payload.instructions = instructions;
        }

        if (responseSchema) {
            payload.text = {
                format: {
                    type: "json_schema",
                    name: schemaName || "response_schema",
                    description: schemaDescription || "JSON response structure",
                    schema: responseSchema as Record<string, unknown>,
                    strict: true,
                },
            };
        }

        const res = await this.getClient().responses.create(payload);
        const usage = this.getUsageMetrics(payload, res);
        const text = res.output_text;

        let data: T;
        if (responseSchema) {
            data = JSON.parse(text) as T;
        }
        else {
            data = text as unknown as T;
        }

        return { data, usage };
    }

    async transcribe(
        model: string,
        audioFile: File | Blob,
        options: any = {}
    ): Promise<unknown> {
        const params = {
            ...options,
            file: audioFile,
            model: model
        };

        // Standard transcription API call
        return await this.getClient().audio.transcriptions.create(params);
    }

    /**
     * Calculates usage metrics from OpenAI response.
     */
    private getUsageMetrics(
        req: OpenAI.Responses.ResponseCreateParamsNonStreaming,
        res: OpenAI.Responses.Response
    ): AIUsageMetrics {
        const model = req.model || "gpt-4o-mini";
        const usage = res.usage || { input_tokens: 0, output_tokens: 0 };
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;

        // Type-safe extraction of cached tokens
        const prompt_tokens_details = (usage as any).prompt_tokens_details;
        const cachedTokens = prompt_tokens_details?.cached_tokens || 0;

        const pricingTable: Record<string, { input: number; cached: number; output: number }> = {
            "gpt-4o": { input: 2.50, cached: 1.25, output: 10.00 },
            "o4-mini": { input: 1.10, cached: 0.275, output: 4.40 },
        };

        const rates = pricingTable[model as string] || pricingTable["o4-mini"];
        const inputRate = rates.input / 1_000_000;
        const cachedRate = rates.cached / 1_000_000;
        const outputRate = rates.output / 1_000_000;

        const totalPrice = ((inputTokens - cachedTokens) * inputRate) +
            (cachedTokens * cachedRate) +
            (outputTokens * outputRate);

        return {
            inputTokens,
            outputTokens,
            inputTokenPrice: inputRate,
            outputTokenPrice: outputRate,
            totalPrice,
        };
    }
}
