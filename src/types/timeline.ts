export interface Subtitle {
    id: string;
    startTime: number;
    endTime: number;
    text: string;
}

export interface AnimationStyle {
    fadeInDuration: number;
    fadeOutDuration: number;
    initialScale: number;
    bounceStrength: number;
    useElasticEffect: boolean;
    fontSize: number;
    textColor: string;
    strokeWidth: number;
    strokeColor: string;
    fontWeight: number;
    textCase: 'normal' | 'uppercase' | 'lowercase';
    textAlign: 'left' | 'center' | 'right';
    hidePunctuation: boolean;
    punctuationChars: string;
    removeAccents: boolean;
    fontFamily: string;
    numberOfLines: number;
    position: {
        x: number;
        y: number;
    };
    backgroundColor: string;
    backgroundOpacity: number;
    backgroundBorderColor: string;
    backgroundBorderWidth: number;
    backgroundMarginVertical: number;
    backgroundMarginHorizontal: number;
    backgroundBorderRadius: number;
    backgroundOffsetX: number;
    backgroundOffsetY: number;
}

export interface SubtitleTrack {
    id: string;
    name: string;
    style: AnimationStyle;
    subtitles: Subtitle[];
    isVisible: boolean;
    isLocked: boolean;
}

export const UNLINKED_VIDEO_EDIT_RESPONSES = [
    'follow-project-ripple',
    'stay-absolute',
    'remove-with-deleted-video-range',
] as const;

/**
 * Visible V4 policy for an unlinked subtitle cue reacting to an uncontrolled video ripple.
 *
 * This is deliberately not a second editing mode. Direct subtitle commands always consume the
 * project-wide global mode, and a durable editorial dependent link takes precedence over this
 * fallback response. Keeping the policy on the subtitle track makes the migrated V3 behavior
 * inspectable instead of hiding it in a view-specific timing domain.
 */
export type UnlinkedVideoEditResponse = (typeof UNLINKED_VIDEO_EDIT_RESPONSES)[number];

/** V4 subtitle tracks replace the legacy `timingDomain` with the visible response policy. */
export interface SubtitleTrackV4 extends SubtitleTrack {
    unlinkedVideoEditResponse: UnlinkedVideoEditResponse;
}

export interface TimelineState {
    zoomLevel: number;
    scrollLeft: number;
    tracks: SubtitleTrack[];
}
