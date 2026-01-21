'use client';

import { useState, useRef, useEffect } from 'react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { SubtitleEditor } from '@/components/video-editor/subtitle-editor';
import { ExportButton } from '@/components/video-editor/ExportButton';
import type { Subtitle } from '@/components/video-editor/SubtitleTrack';

import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { extractAudio } from '@/lib/mediabunny-utils';

export default function Home() {
  const {
    isPlaying,
    currentTime,
    duration: playbackDuration,
    pause,
    toggle: togglePlayback,
    seek,
    setDuration: setPlaybackDuration
  } = usePlaybackStore();

  const {
    videoFile,
  } = useVideoStore();

  const {
    tracks,
    addTrack,
    updateTrackStyle,
    removeSubtitleFromTrack,
    setTracks
  } = useTimelineStore();

  const [selectedSubtitle, setSelectedSubtitle] = useState<Subtitle | null>(null);
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
  const [showThirdsGuide, setShowThirdsGuide] = useState(false);
  const [showDevinGuide, setShowDevinGuide] = useState(false);
  const [showMetaInfo, setShowMetaInfo] = useState(true);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Default track and style from the first track
  const activeTrack = tracks[0];
  const subtitles = activeTrack?.subtitles || [];
  const animationStyle = activeTrack?.style;

  // Initialize first track if none exists
  useEffect(() => {
    if (tracks.length === 0) {
      addTrack('Subtítulos 1');
    }
  }, [tracks.length, addTrack]);

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleVideoLoad = (videoDuration: number, fps: number | null, _file?: File) => {
    setPlaybackDuration(videoDuration);
    setDetectedFps(fps);
  };

  const handleSubtitleClick = (subtitle: Subtitle | null) => {
    if (subtitle !== null || !selectedSubtitle) {
      setSelectedSubtitle(subtitle);
    }
  };

  const handlePlayPause = () => {
    togglePlayback();
  };

  const handleThirdsGuideToggle = () => {
    setShowThirdsGuide(!showThirdsGuide);
  };

  const handleDevinGuideToggle = () => {
    setShowDevinGuide(!showDevinGuide);
  };

  const handleMetaInfoToggle = () => {
    setShowMetaInfo(!showMetaInfo);
  };

  const handleAudioExtracted = (url: string) => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
    setAudioUrl(url);
  };

  const handleWaveformReady = () => {
    // No necesitamos hacer nada aquí
  };

  const handleAnimationStyleChange = (style: any) => {
    if (activeTrack) {
      updateTrackStyle(activeTrack.id, style);
    }
  };

  const handleDelete = (subtitleId: string) => {
    if (activeTrack) {
      removeSubtitleFromTrack(activeTrack.id, subtitleId);
      if (selectedSubtitle?.id === subtitleId) {
        setSelectedSubtitle(null);
      }
    }
  };

  const handleSubtitlesChange = (newSubtitles: Subtitle[]) => {
    if (activeTrack) {
      const updatedTracks = tracks.map(t =>
        t.id === activeTrack.id ? { ...t, subtitles: newSubtitles } : t
      );
      setTracks(updatedTracks);
    }
  };

  const handleSubtitlesVisibilityToggle = () => {
    setShowSubtitles(!showSubtitles);
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-900 text-white">
      {/* Header */}
      <header className="flex-none p-4 bg-gray-800 flex justify-between items-center">
        <h1 className="text-2xl font-bold select-none">Waptions</h1>
        <ExportButton
          videoFile={videoFile}
          subtitles={subtitles}
          fps={detectedFps || 30}
          animationStyle={animationStyle as any}
        />
      </header>

      {/* Main content */}
      <main className="flex-1 p-4 min-h-0">
        <div className="h-full flex gap-4">
          <div className="flex-1 flex flex-col gap-4 min-h-0 min-w-0 overflow-hidden">
            <VideoViewport
              onVideoLoad={handleVideoLoad}
              onEnded={() => pause()}
              showThirdsGuide={showThirdsGuide}
              showDevinGuide={showDevinGuide}
              showMetaInfo={showMetaInfo}
              animationStyle={animationStyle as any}
              onAudioExtracted={handleAudioExtracted}
              showSubtitles={showSubtitles}
              subtitles={subtitles}
            />
            <Timeline
              duration={playbackDuration}
              currentTime={currentTime}
              onTimeUpdate={seek}
              onSubtitleClick={handleSubtitleClick}
              subtitles={subtitles}
              selectedSubtitleId={selectedSubtitle?.id}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              fps={detectedFps ?? 0}
              showThirdsGuide={showThirdsGuide}
              onThirdsGuideToggle={handleThirdsGuideToggle}
              showDevinGuide={showDevinGuide}
              onDevinGuideToggle={handleDevinGuideToggle}
              showMetaInfo={showMetaInfo}
              onMetaInfoToggle={handleMetaInfoToggle}
              showSubtitles={showSubtitles}
              onSubtitlesVisibilityToggle={handleSubtitlesVisibilityToggle}
            />
          </div>

          <div className="w-96 flex flex-col gap-4">
            <SubtitleEditor
              subtitles={subtitles}
              selectedSubtitleId={selectedSubtitle?.id}
              onSubtitleClick={handleSubtitleClick}
              onDelete={handleDelete}
              onSubtitlesChange={handleSubtitlesChange}
              currentTime={currentTime}
              fps={detectedFps || 30}
              onGenerateSubtitles={async () => {
                if (!videoFile || !audioUrl) {
                  alert('Por favor, carga un video primero');
                  return;
                }

                try {
                  setIsGeneratingSubtitles(true);

                  // Extraer solo el audio para optimizar el envío a Whisper (< 25MB)
                  const audioBlob = await extractAudio(videoFile);
                  const formData = new FormData();
                  formData.append('audio', audioBlob, 'audio.mp4');

                  // Llamar al endpoint
                  const response = await fetch('/api/generate-subtitles', {
                    method: 'POST',
                    body: formData,
                  });

                  const data = await response.json();

                  if (!response.ok) {
                    throw new Error(data.error || 'Error al generar subtítulos');
                  }

                  // Aplicar snap a frames en los subtítulos generados
                  const fps = detectedFps || 30;
                  const frameDuration = 1 / fps;
                  const snapTime = (t: number) => Math.round(t / frameDuration) * frameDuration;

                  const snappedSubtitles = (data.subtitles as Subtitle[]).map(s => ({
                    ...s,
                    startTime: snapTime(s.startTime),
                    endTime: snapTime(s.endTime)
                  }));

                  if (activeTrack) {
                    const updatedTracks = tracks.map(t =>
                      t.id === activeTrack.id ? { ...t, subtitles: snappedSubtitles } : t
                    );
                    setTracks(updatedTracks);
                  }
                } catch (error) {
                  console.error('Error detallado al generar subtítulos:', {
                    error,
                    message: error instanceof Error ? error.message : 'Error desconocido'
                  });
                  alert(error instanceof Error ? error.message : 'Error al generar los subtítulos. Por favor, intenta de nuevo.');
                } finally {
                  setIsGeneratingSubtitles(false);
                }
              }}
              isGeneratingSubtitles={isGeneratingSubtitles}
              animationStyle={animationStyle as any}
              onAnimationStyleChange={handleAnimationStyleChange}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
