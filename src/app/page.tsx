'use client';

import { useState, useRef } from 'react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { SubtitleEditor } from '@/components/video-editor/subtitle-editor';
import { ExportButton } from '@/components/video-editor/ExportButton';
import type { Subtitle } from '@/components/video-editor/SubtitleTrack';

import { usePlaybackStore } from '@/stores/playback-store';
import { useVideoStore } from '@/stores/video-store';
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

  const [selectedSubtitle, setSelectedSubtitle] = useState<Subtitle | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
  const [showThirdsGuide, setShowThirdsGuide] = useState(false);
  const [showDevinGuide, setShowDevinGuide] = useState(false);
  const [showMetaInfo, setShowMetaInfo] = useState(true);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [animationStyle, setAnimationStyle] = useState({
    fadeInDuration: 0,
    fadeOutDuration: 0,
    initialScale: 1.5,
    bounceStrength: 1.70158,
    useElasticEffect: true,
    fontSize: 48,
    textColor: '#FFD000',
    strokeWidth: 6,
    strokeColor: '#000000',
    fontWeight: 800,
    textCase: 'normal' as 'normal' | 'uppercase' | 'lowercase',
    textAlign: 'center' as 'left' | 'center' | 'right',
    hidePunctuation: false,
    punctuationChars: '¿?:-,.;¡!',
    removeAccents: false,
    fontFamily: 'Arial',
    numberOfLines: 1,
    position: {
      x: 50,
      y: 80
    },
    backgroundColor: '#000000',
    backgroundOpacity: 0.5,
    backgroundBorderColor: '#FFD000',
    backgroundBorderWidth: 2,
    backgroundMarginVertical: 8,
    backgroundMarginHorizontal: 16,
    backgroundBorderRadius: 8,
    backgroundOffsetX: 0,
    backgroundOffsetY: 0
  });
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // No need for local handleTimeUpdate as we use seek directly or setPlaybackCurrentTime
  /*
  const handleTimeUpdate = (time: number) => {
    setPlaybackCurrentTime(time);
  };
  */

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

  const handleAnimationStyleChange = (style: typeof animationStyle) => {
    setAnimationStyle(style);
  };

  const handleDelete = (subtitleId: string) => {
    setSubtitles(prev => prev.filter(s => s.id !== subtitleId));
    if (selectedSubtitle?.id === subtitleId) {
      setSelectedSubtitle(null);
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
          animationStyle={animationStyle}
        />
      </header>

      {/* Main content */}
      <main className="flex-1 p-4 min-h-0">
        <div className="h-full flex gap-4">
          <div className="flex-1 flex flex-col gap-4 min-h-0">
            <VideoViewport
              onVideoLoad={handleVideoLoad}
              onEnded={() => pause()}
              showThirdsGuide={showThirdsGuide}
              showDevinGuide={showDevinGuide}
              showMetaInfo={showMetaInfo}
              animationStyle={animationStyle}
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
              onSubtitlesChange={setSubtitles}
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
              audioUrl={audioUrl || undefined}
              onWaveformReady={handleWaveformReady}
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
              onSubtitlesChange={setSubtitles}
              currentTime={currentTime}
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

                  setSubtitles(data.subtitles);
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
              animationStyle={animationStyle}
              onAnimationStyleChange={handleAnimationStyleChange}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
