import type { Subtitle } from '@/components/video-editor/SubtitleTrack';

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

export interface TimelineState {
    zoomLevel: number;
    scrollLeft: number;
    tracks: SubtitleTrack[];
}
