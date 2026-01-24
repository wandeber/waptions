import { AIProvider } from "./AIProvider";
import { OpenAIProvider } from "./OpenAIProvider";

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
