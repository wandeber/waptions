'use client';

import { useState, useEffect } from 'react';
import { extractAudio } from '@/lib/mediabunny-utils';

export function useWaveform(videoFile: File | null) {
    const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!videoFile) {
            setAudioBuffer(null);
            setError(null);
            return;
        }

        let isMounted = true;
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

        async function processAudio() {
            try {
                if (!videoFile) return;
                setIsLoading(true);
                setError(null);

                // 1. Extract audio blob from video
                const audioBlob = await extractAudio(videoFile);
                if (!isMounted) return;

                // 2. Decode audio data
                const arrayBuffer = await audioBlob.arrayBuffer();
                if (!isMounted) return;

                const decodedData = await audioContext.decodeAudioData(arrayBuffer);
                if (!isMounted) return;

                setAudioBuffer(decodedData);
            } catch (err) {
                console.error('Error processing waveform:', err);
                if (isMounted) {
                    setError(err instanceof Error ? err.message : 'Unknown error');
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
                audioContext.close();
            }
        }

        processAudio();

        return () => {
            isMounted = false;
        };
    }, [videoFile]);

    return { audioBuffer, isLoading, error };
}
