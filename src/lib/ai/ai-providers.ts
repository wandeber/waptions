import { AIProvider } from "./AIProvider";
import { OpenAIProvider } from "./OpenAIProvider";
import { DeepgramProvider } from "./DeepgramProvider";

const aiProvidersMap: Record<string, AIProvider> = {};

export const getAiProvider = (name: string): AIProvider => {
    return aiProvidersMap[name];
};

export const addAiProvider = (name: string, aiProvider: AIProvider) => {
    aiProvidersMap[name] = aiProvider;
};

export const getFirstAiProviderForModel = (model: string): AIProvider | undefined => {
    return Object.values(aiProvidersMap).find(aiProvider => aiProvider.models.includes(model));
};

// Initialize default providers
addAiProvider(
    "openai",
    new OpenAIProvider(
        "openai",
        ["gpt-4o", "o4-mini", "o3-mini", "gpt-5.2", "whisper-1", "gpt-4o-transcribe-diarize"],
        {
            projectSecret: process.env.OPENAI_API_KEY!,
        }
    )
);

addAiProvider(
    "deepgram",
    new DeepgramProvider(
        "deepgram",
        ["deepgram-nova-3", "nova-3", "deepgram-nova-2", "nova-2"],
        {
            apiKey: process.env.DEEPGRAM_API_KEY!,
        }
    )
);
