export type TranscriptionModelId = 'whisper-1' | 'deepgram-nova-2';

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
        id: 'deepgram-nova-2',
        name: 'Nova 2 (Deepgram)',
        description: 'Next-gen speech-to-text. Superior speed and accuracy.',
        provider: 'Deepgram',
        badge: 'Premium',
        badgeColor: 'purple',
        isPremium: true
    }
];
