import { describe, expect, it } from 'vitest';
import type { MediaInspectionInput, MediaInspectionInputFactory } from './mediabunny-utils';
import {
    classifyMediaImportCandidate,
    inspectMediaBatch,
    inspectMediaFile,
} from './media-import';

type TrackKind = 'video' | 'audio' | 'mixed' | 'none' | 'failed';

const file = (name: string, type: string, kind: TrackKind): File => ({
    name,
    type,
    size: 3_000,
    lastModified: 123,
    kind,
} as unknown as File);

const inputFactory: MediaInspectionInputFactory = (mediaFile) => {
    const kind = (mediaFile as unknown as { kind: TrackKind }).kind;
    const videoTrack = {
        displayWidth: 1280,
        displayHeight: 720,
        codec: 'avc',
        computePacketStats: async () => ({
            packetCount: 60,
            averagePacketRate: 30,
            averageBitrate: 2_000_000,
        }),
    };
    const audioTrack = {
        sampleRate: 48_000,
        numberOfChannels: 2,
        codec: 'aac',
        computePacketStats: async () => ({
            packetCount: 100,
            averagePacketRate: 50,
            averageBitrate: 128_000,
        }),
    };
    return {
        computeDuration: async () => 2,
        getPrimaryVideoTrack: async () => {
            if (kind === 'failed') throw new Error('container parse failed');
            return kind === 'video' || kind === 'mixed' ? videoTrack : null;
        },
        getPrimaryAudioTrack: async () => kind === 'audio' || kind === 'mixed' ? audioTrack : null,
        dispose() { },
    } as unknown as MediaInspectionInput;
};

describe('media import candidate classification', () => {
    it('uses lowercase extension allowlists only for absent or generic MIME metadata', () => {
        expect(classifyMediaImportCandidate(file('VOICE.MP3', '', 'audio'))).toBe('audio');
        expect(classifyMediaImportCandidate(file('camera.MOV', 'application/octet-stream', 'video')))
            .toBe('video');
        expect(classifyMediaImportCandidate(file('camera.mp4', 'text/plain', 'video'))).toBe('unknown');
        expect(classifyMediaImportCandidate(file('unknown.bin', '', 'none'))).toBe('unknown');
    });
});

describe('authoritative media inspection', () => {
    it('classifies a mixed container as video even when MIME claims audio', async () => {
        const result = await inspectMediaFile(
            file('mislabelled.mp3', 'audio/mpeg', 'mixed'),
            { inputFactory, sourceId: 'video_source' },
        );

        expect(result.kind).toBe('video');
        expect(result.diagnostics).toEqual([
            expect.objectContaining({
                code: 'candidate-mismatch',
                candidateKind: 'audio',
                inspectedKind: 'video',
            }),
        ]);
        if (result.kind === 'video') expect(result.source.hasAudio).toBe(true);
    });

    it('classifies primary audio without video as audio despite a video MIME', async () => {
        const result = await inspectMediaFile(
            file('voice.mp4', 'video/mp4', 'audio'),
            { inputFactory, sourceId: 'audio_source' },
        );

        expect(result.kind).toBe('audio');
        if (result.kind === 'audio') {
            expect(result.source.nativeSampleRate).toBe(48_000);
            expect(result.source.nativeSampleCount).toBe(96_000);
        }
        expect(result.diagnostics[0]).toMatchObject({
            code: 'candidate-mismatch',
            inspectedKind: 'audio',
        });
    });

    it('marks containers without primary video or audio as unsupported', async () => {
        const result = await inspectMediaFile(
            file('empty.mp4', 'video/mp4', 'none'),
            { inputFactory },
        );

        expect(result.kind).toBe('unsupported');
        expect(result.diagnostics.map((diagnostic) => diagnostic.code))
            .toEqual(['candidate-mismatch', 'no-primary-media-track']);
    });

    it('inspects the full batch and finds the first valid video regardless of order', async () => {
        const files = [
            file('broken.mp4', 'video/mp4', 'failed'),
            file('music.wav', 'audio/wav', 'audio'),
            file('empty.bin', '', 'none'),
            file('camera.mov', '', 'video'),
            file('second.mp4', 'video/mp4', 'video'),
        ];
        const allocatedKinds: string[] = [];
        const batch = await inspectMediaBatch(files, {
            inputFactory,
            sourceIdFactory: (kind, _file, index) => {
                allocatedKinds.push(kind);
                return `${kind}_${index}`;
            },
        });

        expect(batch.items.map((item) => item.kind))
            .toEqual(['failed', 'audio', 'unsupported', 'video', 'video']);
        expect(batch.failures).toHaveLength(1);
        expect(batch.audioSources.map((source) => source.id)).toEqual(['audio_1']);
        expect(batch.videoSources.map((source) => source.id)).toEqual(['video_3', 'video_4']);
        expect(batch.firstValidVideo?.originalName).toBe('camera.mov');
        expect(allocatedKinds).toEqual(['audio', 'video', 'video']);
    });
});
