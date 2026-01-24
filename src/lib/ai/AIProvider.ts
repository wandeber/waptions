export interface AIMessage {
    role: "system" | "user" | "assistant"
    content: string
}

/**
 * Represents an attachment (file) sent with the request.
 */
export interface AIAttachment {
    filename: string;
    /**
     * Binary data for the attachment.
     */
    data: string | ArrayBuffer | Uint8Array | Buffer;
    /**
     * MIME type of the attachment (e.g. image/png, image/jpeg)
     */
    mimeType?: string;
}

/**
 * Structured options for generation.
 * @typeParam T - Expected response type shaped by schema.
 */
export interface AIGenerateOptions {
    /** Free-form instructions for the model (system-level guidance). */
    instructions?: string

    /** Conversation messages (user/assistant interaction). */
    messages: AIMessage[]

    /** Optional attachments (files, images, etc.), sent as base64. */
    attachments?: AIAttachment[]

    /**
     * JSON Schema describing desired response structure.
     */
    responseSchema?: object

    /**
     * Additional provider-specific settings (max_tokens, temperature...).
     */
    extra?: Record<string, unknown>
}

/**
 * Standard usage metrics for AI generation.
 */
export interface AIUsageMetrics {
    inputTokens: number;
    outputTokens: number;
    inputTokenPrice: number; // Price per token (e.g. 0.000001)
    outputTokenPrice: number; // Price per token
    totalPrice: number;
}

/**
 * Abstract base for AI service providers.
 */
export abstract class AIProvider {
    readonly name: string;
    readonly models: string[];
    readonly settings: Record<string, unknown>;

    constructor(name: string, models: string[], settings: Record<string, unknown>) {
        this.name = name;
        this.models = models;
        this.settings = settings;
    }

    /**
     * Sends a request to the specified model and returns typed response with usage info.
     * @typeParam T - Response type validated by schema.
     */
    abstract generate<T>(
        model: string,
        options: AIGenerateOptions
    ): Promise<{ data: T; usage: AIUsageMetrics }>;

    /**
     * Transcribes audio using the specified model.
     */
    abstract transcribe(
        model: string,
        audioFile: File | Blob,
        options?: {
            response_format?: string;
            timestamp_granularities?: string[];
            prompt?: string;
            temperature?: number;
            language?: string;
            chunking_strategy?: string;
        }
    ): Promise<unknown>;
}
