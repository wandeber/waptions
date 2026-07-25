'use client';

import {
  ArrowDown,
  ArrowUp,
  GitMerge,
  Link2,
  Scissors,
  Sparkles,
  Trash2,
  Unlink,
  VolumeX,
} from 'lucide-react';
import { buildEditorialTranscriptionCommand } from '@/lib/editor-ui/command-builders';
import type { EditorUiNarrativeBlock } from '@/lib/editor-ui/contracts';
import { secondsToNarrativeSample } from '@/lib/editor-ui/core-operation-mapper';
import { useEditorSurfaceHost, useEditorUiSnapshot } from './EditorSurfaceProvider';

export function ManagedTextWorkspace() {
  const snapshot = useEditorUiSnapshot();
  const { controller, services } = useEditorSurfaceHost();
  const blocks = snapshot.project.narrativeBlocks;
  const selected = new Set(snapshot.view.selectedIds);
  const selectedBlocks = blocks.filter((block) => selected.has(block.id));
  const narrativeSources = (snapshot.project.mediaSources ?? []).filter((source) => (
    source.kind === 'video' && source.narrativeRecordId
  ));
  const controlledTrackIds = Array.from(new Set(blocks.map((block) => (
    block.destinationTrackId
  )).filter((id): id is string => Boolean(id))));
  const moveBlock = (blockId: string, direction: -1 | 1) => {
    const index = blocks.findIndex((block) => block.id === blockId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= blocks.length) return;
    void controller.dispatch({
      type: 'narrative.reorder-blocks',
      blockIds: [blockId],
      targetIndex,
    });
  };
  const splitBlock = async (block: EditorUiNarrativeBlock) => {
    const raw = await services.requestText({
      title: 'Split transcript block',
      label: 'Seconds from the start of this block',
      initialValue: (block.durationSeconds / 2).toFixed(2),
    });
    if (raw === null) return;
    const seconds = Number.parseFloat(raw);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= block.durationSeconds) {
      services.notify('Enter a time strictly inside this block.', 'warning');
      return;
    }
    const splitSample16k = Math.min(
      block.sourceEndSample16k - 1,
      block.sourceStartSample16k + secondsToNarrativeSample(seconds),
    );
    void controller.dispatch({
      type: 'narrative.split-block',
      blockId: block.id,
      splitSample16k,
    });
  };
  const deleteBlock = (block: EditorUiNarrativeBlock) => controller.dispatch({
    type: 'narrative.delete-range',
    start: { blockId: block.id, sample16k: block.sourceStartSample16k },
    end: { blockId: block.id, sample16k: block.sourceEndSample16k },
  });
  const prepareTextEditor = async () => {
    const providerId = await services.requestText({
      title: 'Prepare text editor',
      label: 'Managed local transcription provider ID',
      initialValue: 'lazy-whisper-api',
    });
    const command = providerId
      ? buildEditorialTranscriptionCommand(snapshot, providerId)
      : null;
    if (command) await controller.dispatch(command);
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950"
      aria-label="Text editor"
      data-testid="managed-editor-text"
    >
      <div className="flex h-9 flex-none items-center gap-1 border-b border-slate-800 px-2">
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded bg-violet-500/15 px-2 text-[11px] font-medium text-violet-200 hover:bg-violet-500/25 disabled:opacity-40"
          onClick={() => void prepareTextEditor()}
          disabled={!snapshot.capabilities.canTranscribe}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Prepare text editor
        </button>
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded px-2 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
          disabled={narrativeSources.length === 0}
          onClick={() => void controller.dispatch({
            type: 'narrative.activate',
            selectedTrackIds: snapshot.project.tracks
              .filter((track) => track.kind === 'video')
              .map((track) => track.id),
            recordIdBySourceId: Object.fromEntries(narrativeSources.map((source) => (
              [source.id, source.narrativeRecordId!]
            ))),
            splitOnSpeakerChange: true,
          })}
        >
          <Link2 className="h-3.5 w-3.5" /> Control tracks
        </button>
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded px-2 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
          disabled={controlledTrackIds.length === 0}
          onClick={() => void controller.dispatch({
            type: 'narrative.release-tracks',
            trackIds: controlledTrackIds,
          })}
        >
          <Unlink className="h-3.5 w-3.5" /> Release
        </button>
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded px-2 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
          disabled={selectedBlocks.length !== 2}
          onClick={() => {
            const ordered = [...selectedBlocks].sort((left, right) => (
              left.startSeconds - right.startSeconds
            ));
            if (ordered.length === 2) {
              void controller.dispatch({
                type: 'narrative.merge-blocks',
                leftBlockId: ordered[0].id,
                rightBlockId: ordered[1].id,
              });
            }
          }}
        >
          <GitMerge className="h-3.5 w-3.5" /> Merge
        </button>
        <button
          type="button"
          className="ml-auto flex h-7 items-center gap-1.5 rounded px-2 text-[11px] text-slate-400 hover:bg-rose-500/15 hover:text-rose-200 disabled:opacity-40"
          onClick={() => void controller.dispatch({ type: 'narrative.delete-all-silences' })}
          disabled={!blocks.some((block) => block.kind === 'silence')}
        >
          <VolumeX className="h-3.5 w-3.5" />
          Remove all silences
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {blocks.length === 0 ? (
          <div className="mx-auto mt-8 max-w-md rounded border border-dashed border-slate-700 p-6 text-center">
            <h2 className="text-sm font-semibold text-slate-200">No editorial transcript yet</h2>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Prepare the text editor for one or more video tracks. Transcript editing remains
              independent from subtitle generation.
            </p>
          </div>
        ) : (
          <ol className="mx-auto flex max-w-4xl flex-col gap-2">
            {blocks.map((block, index) => (
              <li
                key={block.id}
                className={`group flex items-start gap-2 rounded border p-2 ${block.kind === 'silence'
                  ? 'border-amber-500/20 bg-amber-500/5'
                  : selected.has(block.id)
                    ? 'border-violet-400 bg-violet-500/15'
                    : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'}`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
                  onClick={(event) => {
                    const selectedIds = event.shiftKey
                      ? Array.from(new Set([...snapshot.view.selectedIds, block.id]))
                      : [block.id];
                    controller.updateView({ selectedIds });
                    void controller.dispatch({ type: 'view.select', ids: selectedIds });
                  }}
                >
                  <span className="block font-mono text-[9px] text-slate-600">
                    {block.startSeconds.toFixed(2)}s · {block.durationSeconds.toFixed(2)}s
                    {block.speaker ? ` · ${block.speaker}` : ''}
                  </span>
                  <span className={`mt-1 block text-sm leading-6 ${block.kind === 'silence'
                    ? 'italic text-amber-300/80'
                    : 'text-slate-200'}`}
                  >
                    {block.text}
                  </span>
                  {block.linkedTargetIds.length > 0 && (
                    <span className="mt-1 flex items-center gap-1 text-[10px] text-sky-400">
                      <Link2 className="h-3 w-3" />
                      {block.linkedTargetIds.length} linked target
                      {block.linkedTargetIds.length === 1 ? '' : 's'}
                    </span>
                  )}
                </button>
                {block.kind === 'speech' && block.words && block.words.length > 0 && (
                  <div className="flex max-w-[48%] flex-wrap gap-1" aria-label="Editable transcript words">
                    {block.words.map((word) => (
                      <input
                        key={`${word.id}:${word.text ?? ''}:${word.speakerId ?? ''}`}
                        defaultValue={word.text ?? ''}
                        aria-label={`Edit word ${word.text ?? word.id}`}
                        title="Edit word; double-click to change speaker"
                        onBlur={(event) => {
                          const text = event.currentTarget.value.trim() || null;
                          if (text !== word.text) {
                            void controller.dispatch({
                              type: 'narrative.set-word-text',
                              blockId: block.id,
                              wordId: word.id,
                              text,
                            });
                          }
                        }}
                        onDoubleClick={async () => {
                          const speakerId = await services.requestText({
                            title: 'Change word speaker',
                            label: 'Speaker ID (empty clears it)',
                            initialValue: word.speakerId ?? '',
                          });
                          if (speakerId !== null) {
                            void controller.dispatch({
                              type: 'narrative.set-word-speaker',
                              blockId: block.id,
                              wordId: word.id,
                              speakerId: speakerId.trim() || null,
                            });
                          }
                        }}
                        className="w-auto min-w-10 max-w-28 select-text rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-xs text-slate-200 outline-none focus:border-violet-400"
                      />
                    ))}
                    <button
                      type="button"
                      className="rounded px-1.5 text-[9px] text-rose-300 hover:bg-rose-500/15"
                      onClick={() => {
                        const first = block.words?.[0];
                        const last = block.words?.[block.words.length - 1];
                        if (first && last) {
                          void controller.dispatch({
                            type: 'narrative.delete-words',
                            firstBlockId: block.id,
                            firstWordId: first.id,
                            lastBlockId: block.id,
                            lastWordId: last.id,
                            currentPlayheadFrame: Math.round(
                              snapshot.view.playheadSeconds * snapshot.project.fps,
                            ),
                          });
                        }
                      }}
                    >
                      Delete words
                    </button>
                  </div>
                )}
                <div className="flex flex-none items-center gap-0.5 opacity-70 group-hover:opacity-100">
                  <BlockAction
                    label="Move block earlier"
                    icon={ArrowUp}
                    disabled={index === 0}
                    onClick={() => moveBlock(block.id, -1)}
                  />
                  <BlockAction
                    label="Move block later"
                    icon={ArrowDown}
                    disabled={index === blocks.length - 1}
                    onClick={() => moveBlock(block.id, 1)}
                  />
                  {block.kind === 'speech' && (
                    <BlockAction
                      label="Split transcript block"
                      icon={Scissors}
                      onClick={() => void splitBlock(block)}
                    />
                  )}
                  <BlockAction
                    label="Delete transcript block"
                    icon={Trash2}
                    onClick={() => void deleteBlock(block)}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function BlockAction({
  label,
  icon: Icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: typeof ArrowUp;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white disabled:opacity-25"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
