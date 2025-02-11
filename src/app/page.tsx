'use client';

import { useState, useRef } from 'react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { SubtitleEditor } from '@/components/video-editor/SubtitleEditor';
import { ExportButton } from '@/components/video-editor/ExportButton';
import type { Subtitle } from '@/components/video-editor/SubtitleTrack';

export default function Home() {
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedSubtitle, setSelectedSubtitle] = useState<Subtitle | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [detectedFps, setDetectedFps] = useState(30);
  const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
  const [showThirdsGuide, setShowThirdsGuide] = useState(false);
  const [showMetaInfo, setShowMetaInfo] = useState(true);
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
    hidePunctuation: false,
    punctuationChars: '¿?:-,;¡!',
    removeAccents: false
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleTimeUpdate = (time: number) => {
    setCurrentTime(time);
  };

  const handleVideoLoad = (videoDuration: number, detectedFps: number) => {
    setDuration(videoDuration);
    setDetectedFps(detectedFps);
  };

  const handleSubtitleClick = (subtitle: Subtitle | null) => {
    if (subtitle !== null || !selectedSubtitle) {
      setSelectedSubtitle(subtitle);
    }
  };

  const handlePlayPause = () => {
    setIsPlaying(!isPlaying);
  };

  const handleThirdsGuideToggle = () => {
    setShowThirdsGuide(!showThirdsGuide);
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

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-900 text-white">
      {/* Header */}
      <header className="flex-none p-4 bg-gray-800 flex justify-between items-center">
        <h1 className="text-2xl font-bold select-none">Waptions</h1>
        <ExportButton
          videoRef={videoRef}
          subtitles={subtitles}
          canvasRef={canvasRef}
          animationStyle={animationStyle}
        />
      </header>

      {/* Main content */}
      <main className="flex-1 p-4 min-h-0">
        <div className="h-full flex gap-4">
          <div className="flex-1 flex flex-col gap-4 min-h-0">
            <VideoViewport 
              onVideoLoad={handleVideoLoad}
              onTimeUpdate={handleTimeUpdate}
              currentTime={currentTime}
              videoRef={videoRef}
              isPlaying={isPlaying}
              subtitles={subtitles}
              canvasRef={canvasRef}
              onEnded={() => setIsPlaying(false)}
              showThirdsGuide={showThirdsGuide}
              showMetaInfo={showMetaInfo}
              animationStyle={animationStyle}
              onAudioExtracted={handleAudioExtracted}
            />
            <Timeline 
              duration={duration}
              currentTime={currentTime}
              onTimeUpdate={handleTimeUpdate}
              onSubtitleClick={handleSubtitleClick}
              subtitles={subtitles}
              onSubtitlesChange={setSubtitles}
              selectedSubtitleId={selectedSubtitle?.id}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              fps={detectedFps}
              showThirdsGuide={showThirdsGuide}
              onThirdsGuideToggle={handleThirdsGuideToggle}
              showMetaInfo={showMetaInfo}
              onMetaInfoToggle={handleMetaInfoToggle}
              audioUrl={audioUrl || undefined}
              onWaveformReady={handleWaveformReady}
            />
          </div>

          <div className="w-96 flex flex-col gap-4">
            <SubtitleEditor
              subtitles={subtitles}
              selectedSubtitleId={selectedSubtitle?.id}
              onSubtitleClick={handleSubtitleClick}
              onSubtitlesChange={setSubtitles}
              currentTime={currentTime}
              onGenerateSubtitles={async () => {
                setIsGeneratingSubtitles(true);
                // TODO: Implementar generación de subtítulos
                await new Promise(resolve => setTimeout(resolve, 2000));
                setIsGeneratingSubtitles(false);
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
