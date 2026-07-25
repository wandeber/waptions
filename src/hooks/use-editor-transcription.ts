import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeWithOpenAICompatibleEndpoint } from '@/lib/ai/openai-compatible-transcription';
import {
  createLocalBrowserTranscriptionSession,
  type LocalBrowserTranscriptionProgress,
  type LocalBrowserTranscriptionSession,
} from '@/lib/ai/local-browser-transcription';
import {
  resolveEditorTranscriptionRoute,
  resolvePerSourceTranscriptionRequest,
  runDiarizedEditorTranscription,
} from '@/hooks/editor-transcription-orchestration';
import { buildAudioTranscriptionPlan } from '@/lib/audio-transcription-plan';
import { resolveAudioMediaAsset, type AudioMediaCacheKey } from '@/lib/media-asset-ref';
import {
  decodeBoundedSourceTranscriptionWindows,
  int16PcmToFloat32,
  projectWindowWordsToSource,
  type SourceTimedWord,
} from '@/lib/ai/bounded-source-transcription';
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
import { readBoundedJsonResponse } from '@/lib/ai/transcription-http-policy';
import type { TranscriptionAcquisitionWindowV2 } from '@/types/editorial';

interface GenerateSubtitlesResponse {
  subtitles?: Subtitle[];
  raw?: Subtitle[];
  groups?: Array<{ id: string; words: Subtitle[] }>;
}

interface TimedTranscriptionResponse {
  words?: Array<{ word: string; start: number; end: number }>;
}

const projectSubtitlesFromWindow = (
  subtitles: readonly Subtitle[],
  window: TranscriptionAcquisitionWindowV2,
): Subtitle[] => projectWindowWordsToSource(
  subtitles.map((subtitle) => ({
    word: subtitle.text,
    start: subtitle.startTime,
    end: subtitle.endTime,
  })),
  window,
).map((word) => ({
  id: crypto.randomUUID(),
  startTime: word.start,
  endTime: word.end,
  text: word.word,
}));

const projectTimedWordsFromWindow = (
  words: readonly SourceTimedWord[],
  window: TranscriptionAcquisitionWindowV2,
): Subtitle[] => projectWindowWordsToSource(words, window).map((word) => ({
  id: crypto.randomUUID(),
  startTime: word.start,
  endTime: word.end,
  text: word.word,
}));

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
    let localBrowserSession: LocalBrowserTranscriptionSession | null = null;
    try {
      setIsGenerating(true);
      const sourceWords = new Map<AudioMediaCacheKey, Subtitle[]>();
      const premiumBySource = new Map<AudioMediaCacheKey, SourcePremiumTranscription>();
      if (requestRoute.kind === 'local-browser') {
        localBrowserSession = await createLocalBrowserTranscriptionSession({
          settings: requestRoute.settings,
          signal: abortController.signal,
          onProgress: progress => setStatus(formatLocalProgress(progress)),
        });
      }

      for (let sourceIndex = 0; sourceIndex < transcriptionPlan.sourceJobs.length; sourceIndex += 1) {
        const sourceJob = transcriptionPlan.sourceJobs[sourceIndex];
        const media = resolveAudioMediaAsset(
          sourceJob.source,
          document.videoSources,
          document.audioSources,
        );
        if (!media) throw new Error(`The audio source ${sourceJob.sourceKey} is no longer available.`);

        const sourceNumber = `${sourceIndex + 1}/${transcriptionPlan.sourceJobs.length}`;
        const accumulated: GenerateSubtitlesResponse = {
          subtitles: [],
          raw: [],
          groups: [],
        };
        let windowIndex = 0;
        for await (const bounded of decodeBoundedSourceTranscriptionWindows({
          job: sourceJob,
          media,
          signal: abortController.signal,
        })) {
          windowIndex += 1;
          setStatus(`Transcribing ${sourceNumber}, window ${windowIndex}…`);
          let data: GenerateSubtitlesResponse;
          if (requestRoute.kind === 'local-browser') {
            if (!localBrowserSession) {
              throw new Error('Local browser transcription session is unavailable.');
            }
            const transcription = await localBrowserSession.transcribeWindow({
                startSample: bounded.window.decoded.startSample,
                samples: int16PcmToFloat32(bounded.pcm),
            }, `${media.asset.id}-${windowIndex}`);
            data = {
              subtitles: projectTimedWordsFromWindow(
                transcription.result.words,
                bounded.window,
              ),
            };
          } else if (requestRoute.kind === 'custom-browser') {
            try {
              const transcription = await transcribeWithOpenAICompatibleEndpoint({
                settings: requestRoute.settings,
                audioFile: new File([bounded.wav], `${media.asset.id}-${windowIndex}.wav`, {
                  type: 'audio/wav',
                }),
                fallbackModel: 'faster-whisper',
                options: {
                  response_format: 'verbose_json',
                  timestamp_granularities: ['word'],
                  prompt: 'Use correct punctuation.',
                  temperature: 0,
                },
                signal: abortController.signal,
              }) as TimedTranscriptionResponse;
              data = {
                subtitles: projectTimedWordsFromWindow(
                  transcription.words ?? [],
                  bounded.window,
                ),
              };
            } catch (error) {
              if (abortController.signal.aborted) throw error;
              const message = error instanceof Error
                ? error.message
                : 'The browser could not call the transcriber.';
              throw new Error(`${message} Check that the endpoint allows CORS from ${window.location.origin}.`);
            }
          } else {
            const formData = new FormData();
            formData.append('audio', bounded.wav, `${media.asset.id}-${windowIndex}.wav`);
            formData.append('model', requestRoute.transportModelId);
            if (requestRoute.customOpenAITranscription?.enabled) {
              formData.append('customOpenAITranscription', JSON.stringify(requestRoute.customOpenAITranscription));
            }
            const response = await fetch('/api/generate-subtitles', {
              method: 'POST',
              body: formData,
              signal: abortController.signal,
            });
            const responseBody = await readBoundedJsonResponse(response, {
              signal: abortController.signal,
            });
            data = parseGenerateSubtitlesResponse(responseBody);
            if (!response.ok) {
              throw new Error(
                isRecord(responseBody) && typeof responseBody.error === 'string'
                  ? responseBody.error
                  : 'Subtitle generation failed.',
              );
            }
            data = {
              subtitles: projectSubtitlesFromWindow(data.subtitles ?? [], bounded.window),
              raw: projectSubtitlesFromWindow(data.raw ?? data.subtitles ?? [], bounded.window),
              groups: (data.groups ?? []).map((group) => ({
                id: `${bounded.window.windowId}:${group.id}`,
                words: projectSubtitlesFromWindow(group.words, bounded.window),
              })).filter((group) => group.words.length > 0),
            };
          }
          accumulated.subtitles!.push(...(data.subtitles ?? []));
          accumulated.raw!.push(...(data.raw ?? data.subtitles ?? []));
          accumulated.groups!.push(...(data.groups ?? []));
        }
        const data = accumulated;

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
      localBrowserSession?.dispose();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGenerateSubtitlesResponse(value: unknown): GenerateSubtitlesResponse {
  if (!isRecord(value)) throw new Error('Subtitle generation returned an invalid response.');
  const parseSubtitles = (candidate: unknown): Subtitle[] => {
    if (candidate === undefined) return [];
    if (!Array.isArray(candidate) || candidate.length > 100_000) {
      throw new Error('Subtitle generation returned too many or invalid words.');
    }
    return candidate.map((subtitle) => {
      if (!isRecord(subtitle)
        || typeof subtitle.id !== 'string'
        || typeof subtitle.startTime !== 'number'
        || !Number.isFinite(subtitle.startTime)
        || typeof subtitle.endTime !== 'number'
        || !Number.isFinite(subtitle.endTime)
        || subtitle.endTime <= subtitle.startTime
        || typeof subtitle.text !== 'string'
        || !subtitle.text.trim()
        || subtitle.text.length > 4_096) {
        throw new Error('Subtitle generation returned a malformed word.');
      }
      return subtitle as unknown as Subtitle;
    });
  };
  const groupsValue = value.groups;
  if (groupsValue !== undefined
    && (!Array.isArray(groupsValue) || groupsValue.length > 20_000)) {
    throw new Error('Subtitle generation returned invalid groups.');
  }
  const groups = (groupsValue ?? []).map((group) => {
    if (!isRecord(group) || typeof group.id !== 'string' || !group.id.trim()) {
      throw new Error('Subtitle generation returned a malformed group.');
    }
    return { id: group.id, words: parseSubtitles(group.words) };
  });
  return {
    subtitles: parseSubtitles(value.subtitles),
    raw: parseSubtitles(value.raw),
    groups,
  };
}
