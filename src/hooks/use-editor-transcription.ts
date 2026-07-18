import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeWithOpenAICompatibleEndpoint } from '@/lib/ai/openai-compatible-transcription';
import {
  type LocalBrowserTranscriptionProgress,
  transcribeWithLocalBrowserModel,
} from '@/lib/ai/local-browser-transcription';
import {
  resolveEditorTranscriptionRoute,
  resolvePerSourceTranscriptionRequest,
  runDiarizedEditorTranscription,
} from '@/hooks/editor-transcription-orchestration';
import { buildAudioTranscriptionPlan } from '@/lib/audio-transcription-plan';
import { resolveAudioMediaAsset, type AudioMediaCacheKey } from '@/lib/media-asset-ref';
import { extractAudio } from '@/lib/mediabunny-utils';
import {
  mapAudioTranscriptionPlanToProject,
  mapPremiumAudioTranscriptionPlanToProject,
  type SourcePremiumTranscription,
} from '@/lib/timeline-transcription';
import { useTimelineStore } from '@/stores/timeline-store';
import type { Subtitle } from '@/types/timeline';
import type {
  TranscriptionSubmission,
} from '@/types/transcription';

interface GenerateSubtitlesResponse {
  subtitles?: Subtitle[];
  raw?: Subtitle[];
  groups?: Array<{ id: string; words: Subtitle[] }>;
}

interface TimedTranscriptionResponse {
  words?: Array<{ word: string; start: number; end: number }>;
}

const buildSubtitlesFromTimedWords = (transcription: TimedTranscriptionResponse): Subtitle[] => (
  transcription.words?.map((word) => ({
    id: crypto.randomUUID(),
    startTime: word.start,
    endTime: word.end,
    text: word.word.trim(),
  })) ?? []
);

const formatLocalProgress = (progress: LocalBrowserTranscriptionProgress): string => (
  typeof progress.progress === 'number'
    ? `${progress.message} (${Math.round(progress.progress * 100)}%)`
    : progress.message
);

const isAbortLikeError = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
);

/** Owns the long-running transcription lifecycle independently from editor layout rendering. */
export function useEditorTranscription(targetTrackId: string | undefined) {
  const replaceTrackWithTranscription = useTimelineStore((state) => state.replaceTrackWithTranscription);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const open = useCallback(() => {
    const plan = buildAudioTranscriptionPlan(useTimelineStore.getState().buildEditorDocument());
    if (plan.sourceJobs.length === 0) {
      alert('The timeline has no audible audio to transcribe.');
      return;
    }
    setIsModalOpen(true);
  }, []);

  const close = useCallback(() => {
    setStatus(null);
    setIsModalOpen(false);
  }, []);

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setStatus('Cancelling transcription…');
  }, []);

  const confirm = useCallback(async (submission: TranscriptionSubmission) => {
    if (!targetTrackId) return;

    const timeline = useTimelineStore.getState();
    const document = timeline.buildEditorDocument();
    const route = resolveEditorTranscriptionRoute(submission);

    if (route.kind === 'diarized-custom') {
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      try {
        setIsGenerating(true);
        const result = await runDiarizedEditorTranscription({
          document,
          targetTrackId,
          settings: route.settings,
          signal: abortController.signal,
          browserOrigin: window.location.origin,
          onStatus: setStatus,
          apply: (trackId, speakers, metadata, guard) => (
            useTimelineStore.getState().replaceTrackSetWithDiarizedTranscription(
              trackId,
              speakers,
              metadata,
              guard,
            )
          ),
        });
        if (result === 'stale') {
          throw new Error('The timeline changed while diarization was running. Run transcription again on the current edit.');
        }
        setIsModalOpen(false);
      } catch (error) {
        if (abortController.signal.aborted || isAbortLikeError(error)) return;
        console.error('Failed to generate diarized subtitles:', error);
        alert(error instanceof Error ? error.message : 'Speaker diarization failed. Please try again.');
      } finally {
        if (abortControllerRef.current === abortController) abortControllerRef.current = null;
        setIsGenerating(false);
        setStatus(null);
      }
      return;
    }

    const requestRoute = resolvePerSourceTranscriptionRequest(route);
    const isPremiumBuiltIn = route.kind === 'per-source-built-in'
      && route.modelId === 'premium-whisper-gpt4o';
    const transcriptionPlan = buildAudioTranscriptionPlan(document);
    const targetGuard = timeline.createTranscriptionGuard(targetTrackId);
    if (!targetGuard || transcriptionPlan.sourceJobs.length === 0) return;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    try {
      setIsGenerating(true);
      const sourceWords = new Map<AudioMediaCacheKey, Subtitle[]>();
      const premiumBySource = new Map<AudioMediaCacheKey, SourcePremiumTranscription>();

      for (let sourceIndex = 0; sourceIndex < transcriptionPlan.sourceJobs.length; sourceIndex += 1) {
        const sourceJob = transcriptionPlan.sourceJobs[sourceIndex];
        const media = resolveAudioMediaAsset(
          sourceJob.source,
          document.videoSources,
          document.audioSources,
        );
        if (!media) throw new Error(`The audio source ${sourceJob.sourceKey} is no longer available.`);

        const sourceNumber = `${sourceIndex + 1}/${transcriptionPlan.sourceJobs.length}`;
        setStatus(`Extracting audio ${sourceNumber}: ${media.asset.originalName}`);
        const audioBlob = await extractAudio(media.asset.file);
        let data: GenerateSubtitlesResponse;
        if (abortController.signal.aborted) {
          throw new DOMException('Transcription cancelled.', 'AbortError');
        }

        if (requestRoute.kind === 'local-browser') {
          const transcription = await transcribeWithLocalBrowserModel({
            audioBlob,
            settings: requestRoute.settings,
            signal: abortController.signal,
            onProgress: (progress) => setStatus(`${sourceNumber} · ${formatLocalProgress(progress)}`),
          });
          data = { subtitles: buildSubtitlesFromTimedWords(transcription) };
        } else if (requestRoute.kind === 'custom-browser') {
          try {
            setStatus(`Transcribing ${sourceNumber} in this browser…`);
            const transcription = await transcribeWithOpenAICompatibleEndpoint({
              settings: requestRoute.settings,
              audioFile: audioBlob,
              fallbackModel: 'faster-whisper',
              options: {
                response_format: 'verbose_json',
                timestamp_granularities: ['word'],
                prompt: 'Use correct punctuation.',
                temperature: 0,
              },
              signal: abortController.signal,
            }) as TimedTranscriptionResponse;
            data = { subtitles: buildSubtitlesFromTimedWords(transcription) };
          } catch (error) {
            if (abortController.signal.aborted) throw error;
            const message = error instanceof Error
              ? error.message
              : 'The browser could not call the transcriber.';
            throw new Error(`${message} Check that the endpoint allows CORS from ${window.location.origin}.`);
          }
        } else {
          setStatus(`Transcribing ${sourceNumber} on the server…`);
          const formData = new FormData();
          formData.append('audio', audioBlob, `${media.asset.id}.mp4`);
          formData.append('model', requestRoute.transportModelId);
          if (requestRoute.customOpenAITranscription?.enabled) {
            formData.append('customOpenAITranscription', JSON.stringify(requestRoute.customOpenAITranscription));
          }
          const response = await fetch('/api/generate-subtitles', {
            method: 'POST',
            body: formData,
            signal: abortController.signal,
          });
          data = await response.json();
          if (!response.ok) {
            throw new Error((data as { error?: string }).error || 'Subtitle generation failed.');
          }
        }

        if (isPremiumBuiltIn) {
          premiumBySource.set(sourceJob.sourceKey, {
            raw: data.raw ?? data.subtitles ?? [],
            groups: data.groups ?? [],
          });
        } else {
          sourceWords.set(sourceJob.sourceKey, data.raw ?? data.subtitles ?? []);
        }
      }

      setStatus('Mapping source words onto the edited timeline…');
      if (isPremiumBuiltIn) {
        const mapped = mapPremiumAudioTranscriptionPlanToProject(transcriptionPlan, premiumBySource);
        if (mapped.raw.length === 0) {
          setIsModalOpen(false);
          return;
        }
        const applied = replaceTrackWithTranscription(targetTrackId, mapped.timelineSubtitles, {
          raw: mapped.raw,
          groups: mapped.groups,
          containerIds: mapped.containerIds,
        }, targetGuard);
        if (!applied) {
          throw new Error('The timeline changed while transcription was running. Run transcription again on the current edit.');
        }
        setIsModalOpen(false);
        return;
      }

      const mappedWords = mapAudioTranscriptionPlanToProject(transcriptionPlan, sourceWords);
      // Silent or fully clipped-out sources leave the existing subtitle track untouched.
      if (mappedWords.length === 0) {
        setIsModalOpen(false);
        return;
      }
      const latestTimeline = useTimelineStore.getState();
      const { groups, containerIds } = latestTimeline.generateDefaultGrouperState(mappedWords);
      const timelineSubtitles = latestTimeline.generateTimelineSubtitles(mappedWords);
      const applied = replaceTrackWithTranscription(targetTrackId, timelineSubtitles, {
        raw: mappedWords,
        groups,
        containerIds,
      }, targetGuard);
      if (!applied) {
        throw new Error('The timeline changed while transcription was running. Run transcription again on the current edit.');
      }
      setIsModalOpen(false);
    } catch (error) {
      if (abortController.signal.aborted || isAbortLikeError(error)) return;
      console.error('Failed to generate subtitles:', error);
      alert(error instanceof Error ? error.message : 'Subtitle generation failed. Please try again.');
    } finally {
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
      setIsGenerating(false);
      setStatus(null);
    }
  }, [replaceTrackWithTranscription, targetTrackId]);

  return {
    isGenerating,
    isModalOpen,
    status,
    open,
    close,
    confirm,
    cancel,
  };
}
