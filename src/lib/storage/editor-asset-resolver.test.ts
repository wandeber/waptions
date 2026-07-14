import { describe, expect, it } from 'vitest';
import type { AudioSourceDescriptor, VideoSourceDescriptorV3 } from '@/types/video';
import { createVideoSourceFingerprint } from '@/lib/video-timeline';
import {
    resolveEditorAudioAsset,
    resolveEditorVideoAsset,
    type EditorAssetReader,
} from './editor-asset-resolver';

const file = (name: string, type: string, lastModified = 4): File => {
    const size = 12;
    return { name, type, size, lastModified } as File;
};

const descriptor = (id: string, sourceFile: File): VideoSourceDescriptorV3 => ({
    id,
    originalName: sourceFile.name,
    mimeType: sourceFile.type,
    size: sourceFile.size,
    lastModified: sourceFile.lastModified,
    fingerprint: createVideoSourceFingerprint(sourceFile),
    duration: 2,
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate: null,
    hasAudio: true,
});

const reader = (values: Record<string, unknown>): EditorAssetReader => ({
    get: async (key) => values[key] ?? null,
});

describe('editor asset resolver', () => {
    it('prefers the typed video key and falls back without copying legacy blobs', async () => {
        const sourceFile = file('video.mp4', 'video/mp4');
        const sourceDescriptor = descriptor('shared', sourceFile);
        const typed = await resolveEditorVideoAsset(reader({
            'video-source:shared': sourceFile,
            'source:shared': { ...sourceFile },
        }), sourceDescriptor, 1);
        expect(typed).toMatchObject({ storageKey: 'video-source:shared', usesTypedKey: true });

        const legacy = await resolveEditorVideoAsset(reader({ 'source:shared': sourceFile }), sourceDescriptor, 1);
        expect(legacy).toMatchObject({ storageKey: 'source:shared', usesTypedKey: false });
        expect(legacy.asset.file).toBe(sourceFile);
    });

    it('uses scalar video only for a manifest with exactly one video source', async () => {
        const sourceFile = file('video.mp4', 'video/mp4');
        const sourceDescriptor = descriptor('video', sourceFile);
        await expect(resolveEditorVideoAsset(reader({ 'video-file': sourceFile }), sourceDescriptor, 2))
            .rejects.toThrow('Missing video source');
        await expect(resolveEditorVideoAsset(reader({ 'video-file': sourceFile }), sourceDescriptor, 1))
            .resolves.toMatchObject({ storageKey: 'video-file', usesTypedKey: false });
    });

    it('isolates equal IDs by media kind and never gives audio a legacy fallback', async () => {
        const videoFile = file('video.mp4', 'video/mp4');
        const audioFile = file('audio.wav', 'audio/wav');
        const audioDescriptor: AudioSourceDescriptor = {
            ...descriptor('shared', audioFile),
            duration: 1,
            nativeSampleRate: 48_000,
            nativeSampleCount: 48_000,
            nativeChannelCount: 2,
            codec: 'pcm',
        };
        const values = reader({
            'video-source:shared': videoFile,
            'audio-source:shared': audioFile,
        });
        await expect(resolveEditorVideoAsset(values, descriptor('shared', videoFile), 1))
            .resolves.toMatchObject({ asset: { file: videoFile } });
        await expect(resolveEditorAudioAsset(values, audioDescriptor))
            .resolves.toMatchObject({ asset: { file: audioFile } });
        await expect(resolveEditorAudioAsset(reader({ 'source:shared': audioFile }), audioDescriptor))
            .rejects.toThrow('Missing audio source');
    });

    it('rejects a File whose metadata or fingerprint differs from the descriptor', async () => {
        const sourceFile = file('video.mp4', 'video/mp4');
        const mismatched = file('renamed.mp4', 'video/mp4');
        await expect(resolveEditorVideoAsset(
            reader({ 'video-source:video': mismatched }),
            descriptor('video', sourceFile),
            1,
        )).rejects.toThrow('does not match');
    });
});
