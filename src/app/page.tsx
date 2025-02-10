'use client';

import { useState, useRef } from 'react';
import { VideoViewport } from '@/components/video-editor/VideoViewport';
import { Timeline } from '@/components/video-editor/Timeline';
import { SubtitleEditor } from '@/components/video-editor/SubtitleEditor';
import { ExportButton } from '@/components/video-editor/ExportButton';
import type { Subtitle } from '@/components/video-editor/SubtitleTrack';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

export default function Home() {
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedSubtitle, setSelectedSubtitle] = useState<Subtitle | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(30);
  const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
  const [showThirdsGuide, setShowThirdsGuide] = useState(false);
  const [showMetaInfo, setShowMetaInfo] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

  const handleThirdsGuideToggle = () => {
    setShowThirdsGuide(prev => !prev);
  };

  const handleMetaInfoToggle = () => {
    setShowMetaInfo(prev => !prev);
  };

  const handleGenerateSubtitles = async () => {
    if (!videoRef.current?.src) {
      alert('Por favor, carga un video primero');
      return;
    }

    try {
      setIsGeneratingSubtitles(true);

      // Inicializar FFmpeg en el cliente
      const ffmpeg = new FFmpeg();
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      // Obtener el blob del video
      const response = await fetch(videoRef.current.src);
      const videoBlob = await response.blob();
      const videoData = await videoBlob.arrayBuffer();
      
      // Escribir el video en FFmpeg
      ffmpeg.writeFile('input.mp4', new Uint8Array(videoData));

      // Extraer el audio como MP3
      await ffmpeg.exec([
        '-i', 'input.mp4',
        '-vn',
        '-acodec', 'libmp3lame',
        '-ar', '16000',
        '-ac', '1',
        'audio.mp3'
      ]);

      // Leer el archivo de audio
      const audioData = await ffmpeg.readFile('audio.mp3');
      const audioBlob = new Blob([audioData], { type: 'audio/mpeg' });

      // Crear FormData y añadir el audio
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.mp3');

      // Enviar al endpoint
      const result = await fetch('/api/generate-subtitles', {
        method: 'POST',
        body: formData,
      });

      if (!result.ok) {
        throw new Error('Error al generar los subtítulos');
      }

      const data = await result.json();
      
      // Actualizar los subtítulos
      setSubtitles(data.subtitles);
    } catch (error) {
      console.error('Error:', error);
      alert('Error al generar los subtítulos');
    } finally {
      setIsGeneratingSubtitles(false);
    }
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
              fps={fps}
              onFpsChange={handleFpsChange}
              subtitles={subtitles}
              canvasRef={canvasRef}
              onEnded={() => setIsPlaying(false)}
              showThirdsGuide={showThirdsGuide}
              showMetaInfo={showMetaInfo}
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
              showThirdsGuide={showThirdsGuide}
              onThirdsGuideToggle={handleThirdsGuideToggle}
              showMetaInfo={showMetaInfo}
              onMetaInfoToggle={handleMetaInfoToggle}
            />
          </div>
          <div className="w-80 flex-none">
            <SubtitleEditor
              subtitles={subtitles}
              selectedSubtitleId={selectedSubtitle?.id}
              onSave={handleSubtitleSave}
              onSubtitleClick={handleSubtitleClick}
              onDelete={handleSubtitleDelete}
              onSubtitlesChange={setSubtitles}
              currentTime={currentTime}
              onGenerateSubtitles={handleGenerateSubtitles}
              isGeneratingSubtitles={isGeneratingSubtitles}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
