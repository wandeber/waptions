import type { Subtitle } from '../SubtitleTrack';

export interface SubtitleEditorProps {
  subtitles: Subtitle[];
  selectedSubtitleId?: string | null;
  onSubtitleClick?: (subtitle: Subtitle) => void;
  onDelete?: (subtitleId: string) => void;
  onSubtitlesChange?: (subtitles: Subtitle[]) => void;
  currentTime: number;
  onGenerateSubtitles?: () => void;
  isGeneratingSubtitles?: boolean;
  onAnimationStyleChange?: (style: SubtitleAnimationStyle) => void;
  animationStyle?: SubtitleAnimationStyle;
}

export interface SubtitleAnimationStyle {
  // Propiedades de animación
  fadeInDuration: number;
  fadeOutDuration: number;
  initialScale: number;
  bounceStrength: number;
  useElasticEffect: boolean;
  // Propiedades de estilo visual
  fontSize: number;
  fontFamily: string;
  textColor: string;
  strokeWidth: number;
  strokeColor: string;
  fontWeight: number;
  textCase: 'normal' | 'uppercase' | 'lowercase';
  textAlign: 'left' | 'center' | 'right';
  hidePunctuation: boolean;
  punctuationChars: string;
  removeAccents: boolean;
  numberOfLines: number;
  // Propiedades de posición
  position: {
    x: number;
    y: number;
  };
  // Propiedades del fondo
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

export const defaultAnimationStyle: SubtitleAnimationStyle = {
  fadeInDuration: 0,
  fadeOutDuration: 0,
  initialScale: 1.5,
  bounceStrength: 1.70158,
  useElasticEffect: true,
  fontSize: 48,
  fontFamily: 'Inter',
  textColor: '#FFD000',
  strokeWidth: 6,
  strokeColor: '#000000',
  fontWeight: 800,
  textCase: 'normal',
  textAlign: 'center',
  hidePunctuation: false,
  punctuationChars: '¿?:-,.;¡!',
  removeAccents: false,
  numberOfLines: 1,
  position: {
    x: 50,
    y: 80
  },
  backgroundColor: '#000000',
  backgroundOpacity: 0.5,
  backgroundBorderColor: '#000000',
  backgroundBorderWidth: 0,
  backgroundMarginVertical: 8,
  backgroundMarginHorizontal: 16,
  backgroundBorderRadius: 4,
  backgroundOffsetX: 0,
  backgroundOffsetY: 0
};

export interface StylePreset {
  id: string;
  name: string;
  style: SubtitleAnimationStyle;
  isDefault?: boolean;
}

export const eduSiverioPreset: StylePreset = {
  id: 'edu-siverio',
  name: 'Edu Siverio',
  isDefault: true,
  style: {
    ...defaultAnimationStyle,
    fontSize: 48,
    fontFamily: 'Verdana',
    textColor: '#FFD000',
    strokeWidth: 0,
    fontWeight: 800,
    textCase: 'uppercase',
    textAlign: 'center',
    position: {
      x: 50,
      y: 65
    },
    backgroundColor: '#000000',
    backgroundOpacity: 100,
    backgroundBorderWidth: 0,
    backgroundMarginVertical: 8,
    backgroundMarginHorizontal: 16,
    backgroundBorderRadius: 2,
    numberOfLines: 2,
    hidePunctuation: true,
  }
}; 