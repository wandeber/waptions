import { shouldShowPaidTranscriptionModels } from "@/lib/config/feature-flags";

export type TranscriptionModelId = 'whisper-1' | 'deepgram-nova-2' | 'premium-whisper-gpt4o' | 'local-browser';
export type OpenAICompatibleTranscriptionRequestMode = 'browser' | 'server';
export type LocalBrowserTranscriptionDevice = 'webgpu' | 'wasm';
export type LocalBrowserTranscriptionEngine = 'whisper-webgpu' | 'qwen3-asr-aligner';
export type LocalBrowserTranscriptionLanguage = 'auto' | 'en' | 'es';

export interface OpenAICompatibleTranscriptionSettings {
    enabled: boolean;
    requestMode?: OpenAICompatibleTranscriptionRequestMode;
    endpoint: string;
    apiKey?: string;
    model?: string;
}

export interface LocalBrowserTranscriptionSettings {
    enabled: boolean;
    engine: LocalBrowserTranscriptionEngine;
    manifestId: string;
    device?: LocalBrowserTranscriptionDevice;
    language?: LocalBrowserTranscriptionLanguage;
    allowWasmFallback?: boolean;
}

export interface TranscriptionModel {
    id: TranscriptionModelId;
    name: string;
    description: string;
    badge?: string;
    badgeColor?: 'blue' | 'purple' | 'green' | 'red';
    provider: 'OpenAI' | 'Deepgram';
    isPremium?: boolean;
}

export const SUPPORTED_MODELS: TranscriptionModel[] = [
    {
        id: 'whisper-1',
        name: 'Whisper (OpenAI)',
        description: 'Standard high-quality model. Best for general use.',
        provider: 'OpenAI',
        badge: 'Recommended',
        badgeColor: 'blue'
    },
    {
        id: 'premium-whisper-gpt4o',
        name: 'Whisper + GPT-4o + o4-mini',
        description: 'Ultimate pipeline for precisely timed, short-form subtitles with speaker isolation.',
        provider: 'OpenAI',
        badge: 'Premium',
        badgeColor: 'purple',
        isPremium: true
    },
    {
        id: 'deepgram-nova-2',
        name: 'Nova 2 (Deepgram)',
        description: 'Next-gen speech-to-text. Superior speed and accuracy.',
        provider: 'Deepgram',
        badgeColor: 'green'
    }
];

export function getVisibleTranscriptionModels(): TranscriptionModel[] {
    return shouldShowPaidTranscriptionModels() ? SUPPORTED_MODELS : [];
}
