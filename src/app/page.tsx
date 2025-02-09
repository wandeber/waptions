'use client';

import { useState, useRef } from 'react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { SubtitleEditor } from '@/components/video-editor/SubtitleEditor';
import type { Subtitle } from '@/components/video-editor/SubtitleTrack';

export default function Home() {
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedSubtitle, setSelectedSubtitle] = useState<Subtitle | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(30);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleTimeUpdate = (time: number) => {
    setCurrentTime(time);
  };

  const handleVideoLoad = (videoDuration: number, detectedFps: number) => {
    setDuration(videoDuration);
    setFps(detectedFps);
  };

  const handleSubtitleClick = (subtitle: Subtitle | null) => {
    if (subtitle !== null || !selectedSubtitle) {
      setSelectedSubtitle(subtitle);
    }
  };

  const handleSubtitleSave = (subtitle: Subtitle) => {
    setSubtitles(prev => {
      const index = prev.findIndex(s => s.id === subtitle.id);
      if (index === -1) {
        return [...prev, subtitle];
      }
      const newSubtitles = [...prev];
      newSubtitles[index] = subtitle;
      return newSubtitles;
    });
  };

  const handleSubtitleDelete = (subtitleId: string) => {
    setSubtitles(prev => prev.filter(s => s.id !== subtitleId));
    setSelectedSubtitle(null);
  };

  const handlePlayPause = () => {
    if (!videoRef.current) return;

    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleFpsChange = (newFps: number) => {
    setFps(newFps);
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-900 text-white">
      {/* Header */}
      <header className="flex-none p-4 bg-gray-800">
        <h1 className="text-2xl font-bold">Editor de Subtítulos</h1>
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
              onPlayPause={handlePlayPause}
              fps={fps}
              onFpsChange={handleFpsChange}
              subtitles={subtitles}
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
              fps={fps}
            />
          </div>
          <div className="w-80 flex-none">
            <SubtitleEditor
              subtitles={subtitles}
              selectedSubtitleId={selectedSubtitle?.id}
              onSave={handleSubtitleSave}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
