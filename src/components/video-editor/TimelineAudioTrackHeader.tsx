'use client';

import { useEffect, useRef, useState } from 'react';
import { Headphones, Lock, Trash2, Unlock, Volume2, VolumeX } from 'lucide-react';
import type { AudioTrack } from '@/types/video';
import { useTimelineStore } from '@/stores/timeline-store';
import { useShallow } from 'zustand/react/shallow';

interface TimelineAudioTrackHeaderProps {
    track: AudioTrack;
}

/** Track controls align one-to-one with the audio rows in the scrolling timeline body. */
export function TimelineAudioTrackHeader({ track }: TimelineAudioTrackHeaderProps) {
    const {
        renameAudioTrack,
        removeAudioTrack,
        setAudioTrackLocked,
        updateAudioTrackMix,
    } = useTimelineStore(useShallow((state) => ({
        renameAudioTrack: state.renameAudioTrack,
        removeAudioTrack: state.removeAudioTrack,
        setAudioTrackLocked: state.setAudioTrackLocked,
        updateAudioTrackMix: state.updateAudioTrackMix,
    })));
    const [nameDraft, setNameDraft] = useState(track.name);
    const escapedNameRef = useRef(false);
    const lastCommittedNameRef = useRef(track.name);

    useEffect(() => {
        setNameDraft(track.name);
        lastCommittedNameRef.current = track.name;
    }, [track.name]);

    const commitName = () => {
        if (escapedNameRef.current) {
            escapedNameRef.current = false;
            setNameDraft(track.name);
            return;
        }
        const nextName = nameDraft.trim();
        if (nextName && nextName !== lastCommittedNameRef.current) {
            lastCommittedNameRef.current = nextName;
            renameAudioTrack(track.id, nextName);
        }
        else setNameDraft(track.name);
    };

    return (
        <div className="flex h-full flex-col justify-center gap-1 border-b border-slate-800 bg-slate-950 px-2">
            <input
                value={nameDraft}
                disabled={track.locked}
                aria-label={`Rename ${track.name}`}
                title="Rename audio track"
                className="h-5 w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-[11px] font-medium text-slate-200 outline-none hover:border-slate-700 focus:border-teal-400 disabled:text-slate-500"
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        commitName();
                        event.currentTarget.blur();
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        escapedNameRef.current = true;
                        setNameDraft(track.name);
                        event.currentTarget.blur();
                    }
                }}
            />
            <div className="flex w-full items-center gap-0.5">
              <button
                type="button"
                className={`rounded p-1 ${track.locked ? 'bg-amber-500/20 text-amber-300' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}
                aria-label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
                title={track.locked ? 'Unlock track' : 'Lock track'}
                onClick={() => setAudioTrackLocked(track.id, !track.locked)}
            >
                {track.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                disabled={track.locked}
                className={`rounded p-1 disabled:opacity-40 ${track.muted ? 'bg-red-500/20 text-red-300' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}
                aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
                title={track.muted ? 'Unmute track' : 'Mute track'}
                onClick={() => updateAudioTrackMix(track.id, { muted: !track.muted })}
            >
                {track.muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                disabled={track.locked}
                className={`rounded p-1 disabled:opacity-40 ${track.solo ? 'bg-teal-500/20 text-teal-200' : 'text-slate-500 hover:bg-slate-800 hover:text-white'}`}
                aria-label={track.solo ? `Disable solo for ${track.name}` : `Solo ${track.name}`}
                title={track.solo ? 'Disable solo' : 'Solo track'}
                onClick={() => updateAudioTrackMix(track.id, { solo: !track.solo })}
            >
                <Headphones className="h-3.5 w-3.5" />
              </button>
              <span
                className="ml-auto font-mono text-[9px] tabular-nums text-slate-500"
                title="Track gain · edit from the inspector"
                aria-label={`${track.name} gain ${track.gainDb} decibels`}
              >
                {track.gainDb > 0 ? '+' : ''}{track.gainDb} dB
              </span>
              <button
                type="button"
                disabled={track.locked}
                className="rounded p-1 text-slate-600 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
                aria-label={`Remove ${track.name}`}
                title="Remove audio track"
                onClick={() => removeAudioTrack(track.id)}
            >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
        </div>
    );
}
