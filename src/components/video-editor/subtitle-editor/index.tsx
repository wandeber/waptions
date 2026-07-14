'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Subtitle } from '@/types/timeline';
import {
  beginContinuousEdit,
  previewContinuousEdit,
  terminateContinuousEdit,
  type ContinuousEditSession,
} from '@/lib/continuous-edit-session';
import { useEditorTransactionCoordinator } from '@/components/video-editor/EditorTransactionContext';
import { useTimelineStore } from '@/stores/timeline-store';
import { Tabs } from '../../design-system/Tabs';
import { Accordion } from '../../design-system/Accordion';
import { TextStyleSection } from './TextStyleSection';
import { BackgroundSection } from './BackgroundSection';
import { AnimationSection } from './AnimationSection';
import { PositionSection } from './PositionSection';
import { SubtitleList } from './SubtitleList';
import { StylePresetSelector } from './StylePresetSelector';
import { getSubtitleHistoryShortcut } from './subtitle-edit-session';
import type { SubtitleEditorProps, SubtitleAnimationStyle, SubtitleStyleEditHandlers } from './types';
import { defaultAnimationStyle } from './types';

type StyleValue = SubtitleAnimationStyle[keyof SubtitleAnimationStyle];

interface SubtitleTextSession {
  subtitleId: string;
  session: ContinuousEditSession<string>;
}

const styleValueEquals = (left: StyleValue, right: StyleValue): boolean => {
  if (typeof left === 'object' && typeof right === 'object') {
    return left.x === right.x && left.y === right.y;
  }
  return Object.is(left, right);
};

const textMapsEqual = (left: Record<string, string>, right: Record<string, string>): boolean => {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return leftIds.length === rightIds.length && leftIds.every((id) => left[id] === right[id]);
};

export function SubtitleEditor({
  subtitles,
  onSubtitleClick,
  onDelete,
  onSubtitlesChange,
  onSubtitleUpdate,
  onAddSubtitle,
  currentTime,
  onGenerateSubtitles,
  isGeneratingSubtitles,
  onAnimationStyleChange,
  animationStyle = defaultAnimationStyle,
  onUndo,
  onRedo,
  fps = 30,
}: SubtitleEditorProps & { fps?: number }) {
  const transactionCoordinator = useEditorTransactionCoordinator();
  const selectedSubtitleIds = useTimelineStore((state) => state.selectedSubtitleIds);
  const frameDuration = fps > 0 ? 1 / fps : 0.01;
  const snapTime = (time: number) => Math.round(time / frameDuration) * frameDuration;
  const canonicalStyle = { ...defaultAnimationStyle, ...animationStyle };

  const [editingText, setEditingText] = useState<Record<string, string>>({});
  const editingTextRef = useRef<Record<string, string>>({});
  const textSessionRef = useRef<SubtitleTextSession | null>(null);
  const textDraftOwnerRef = useRef(Symbol('subtitle-text-draft'));
  const composingSubtitleIdRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<'subtitles' | 'style'>('subtitles');
  const [expandedStyleSection, setExpandedStyleSection] = useState<string | null>(null);
  const [localAnimationStyle, setLocalAnimationStyle] = useState<SubtitleAnimationStyle>(canonicalStyle);
  const localStyleRef = useRef(localAnimationStyle);
  const canonicalStyleRef = useRef(canonicalStyle);
  const styleSessionsRef = useRef(new Map<keyof SubtitleAnimationStyle, ContinuousEditSession<StyleValue>>());
  const publishTextDraftState = useCallback((session: ContinuousEditSession<string> | null) => {
    transactionCoordinator.setPendingUndoableDraft(
      textDraftOwnerRef.current,
      session?.terminal === null && session.latest !== session.baseline,
    );
  }, [transactionCoordinator]);

  useEffect(() => {
    const nextCanonical = { ...defaultAnimationStyle, ...animationStyle };
    canonicalStyleRef.current = nextCanonical;
    const nextLocal = { ...nextCanonical };
    styleSessionsRef.current.forEach((session, key) => {
      if (session.terminal === null) {
        Object.assign(nextLocal, { [key]: session.latest });
      } else {
        styleSessionsRef.current.delete(key);
      }
    });
    localStyleRef.current = nextLocal;
    setLocalAnimationStyle((current) => (
      JSON.stringify(current) === JSON.stringify(nextLocal) ? current : nextLocal
    ));
  }, [animationStyle]);

  useEffect(() => {
    const expectedText = Object.fromEntries(subtitles.map((subtitle) => [subtitle.id, subtitle.text]));
    const currentSession = textSessionRef.current;
    if (currentSession?.session.terminal === null
      && Object.prototype.hasOwnProperty.call(expectedText, currentSession.subtitleId)) {
      // A focused textarea owns its draft. Store updates for every other subtitle still flow into
      // the controlled map, so selection changes and unrelated undo operations do not stale it.
      expectedText[currentSession.subtitleId] = currentSession.session.latest;
    }
    editingTextRef.current = expectedText;
    setEditingText((current) => textMapsEqual(current, expectedText) ? current : expectedText);

    if (currentSession && (
      currentSession.session.terminal !== null
      || !Object.prototype.hasOwnProperty.call(expectedText, currentSession.subtitleId)
    )) {
      // Do not turn an intermediate committed render into a fresh active session or retain a draft
      // for a removed subtitle. Focused history can commit and undo in one task; keeping that
      // intermediate value active would preserve the wrong draft on the restored store render.
      textSessionRef.current = null;
      publishTextDraftState(null);
    }
  }, [publishTextDraftState, subtitles]);

  useEffect(() => () => {
    transactionCoordinator.setPendingUndoableDraft(textDraftOwnerRef.current, false);
  }, [transactionCoordinator]);

  const setTextDraft = (subtitle: Subtitle, nextText: string) => {
    const current = textSessionRef.current;
    const session = current?.subtitleId === subtitle.id && current.session.terminal === null
      ? current.session
      : beginContinuousEdit(subtitle.text);
    const nextSession = previewContinuousEdit(session, nextText);
    textSessionRef.current = { subtitleId: subtitle.id, session: nextSession };
    publishTextDraftState(nextSession);
    const nextEditingText = { ...editingTextRef.current, [subtitle.id]: nextText };
    editingTextRef.current = nextEditingText;
    setEditingText(nextEditingText);
  };

  const finishTextSession = (
    subtitle: Subtitle,
    terminal: 'commit' | 'cancel',
    persist = true,
  ) => {
    const current = textSessionRef.current;
    const session = current?.subtitleId === subtitle.id
      ? current.session
      : beginContinuousEdit(subtitle.text);
    const result = terminateContinuousEdit(session, terminal);
    textSessionRef.current = { subtitleId: subtitle.id, session: result.session };
    publishTextDraftState(result.session);
    const nextEditingText = { ...editingTextRef.current, [subtitle.id]: result.value };
    editingTextRef.current = nextEditingText;
    setEditingText(nextEditingText);

    if (persist && result.shouldCommit) {
      if (onSubtitleUpdate) onSubtitleUpdate(subtitle.id, { text: result.value });
      else onSubtitlesChange?.(subtitles.map((entry) => (
        entry.id === subtitle.id ? { ...entry, text: result.value } : entry
      )));
    }
    return result;
  };

  const consumeTextDraft = (subtitle: Subtitle): string => {
    const latest = editingTextRef.current[subtitle.id] ?? subtitle.text;
    const current = textSessionRef.current;
    const session = current?.subtitleId === subtitle.id && current.session.terminal === null
      ? current.session
      : previewContinuousEdit(beginContinuousEdit(subtitle.text), latest);
    const terminatedSession = terminateContinuousEdit(session, 'commit').session;
    textSessionRef.current = {
      subtitleId: subtitle.id,
      session: terminatedSession,
    };
    publishTextDraftState(terminatedSession);
    return latest;
  };

  const handleSubtitleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>, subtitle: Subtitle) => {
    const isComposing = event.nativeEvent.isComposing || composingSubtitleIdRef.current === subtitle.id;
    const historyShortcut = getSubtitleHistoryShortcut({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      isComposing,
    });
    if (historyShortcut) {
      event.preventDefault();
      event.stopPropagation();
      const textarea = event.currentTarget;
      // The draft becomes one normal durable command immediately before app history runs. Undo
      // therefore restores its baseline atomically instead of entering the browser's native text
      // history, and redo restores the same full editor snapshot.
      finishTextSession(subtitle, 'commit');
      const action = historyShortcut === 'undo' ? onUndo : onRedo;
      void Promise.resolve().then(() => action?.()).finally(() => {
        requestAnimationFrame(() => {
          if (textarea.isConnected) textarea.focus();
        });
      });
      return;
    }
    if (isComposing) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      finishTextSession(subtitle, 'cancel');
      event.currentTarget.blur();
      return;
    }

    if (event.key === 'Enter') {
      if (event.ctrlKey) {
        event.preventDefault();
        const textarea = event.currentTarget;
        const cursorPosition = textarea.selectionStart;
        const currentText = editingTextRef.current[subtitle.id] ?? '';
        const nextText = `${currentText.slice(0, cursorPosition)}\n${currentText.slice(cursorPosition)}`;
        setTextDraft(subtitle, nextText);
        requestAnimationFrame(() => textarea.setSelectionRange(cursorPosition + 1, cursorPosition + 1));
        return;
      }

      event.preventDefault();
      const textarea = event.currentTarget;
      const cursorPosition = textarea.selectionStart;
      const currentText = editingTextRef.current[subtitle.id] ?? '';
      if (!currentText.trim()) return;

      // Consume the local draft before replacing the graph. The following blur observes a terminal
      // session and cannot create a second text-only history entry.
      consumeTextDraft(subtitle);
      const firstPart = currentText.slice(0, cursorPosition).replace(/\s+$/, '');
      const secondPart = currentText.slice(cursorPosition).replace(/^\s+/, '');
      const isAtEnd = cursorPosition >= currentText.length;
      const splitRatio = cursorPosition / currentText.length;
      const splitTime = isAtEnd
        ? snapTime(subtitle.endTime)
        : snapTime(subtitle.startTime + (subtitle.endTime - subtitle.startTime) * splitRatio);
      const newSubtitle: Subtitle = {
        id: Date.now().toString(),
        startTime: splitTime,
        endTime: isAtEnd ? snapTime(splitTime + 1) : snapTime(subtitle.endTime),
        text: secondPart,
      };
      const nextSubtitles = [
        ...subtitles.map((entry) => entry.id === subtitle.id
          ? { ...entry, text: firstPart, endTime: splitTime }
          : entry),
        newSubtitle,
      ];
      const nextEditingText = {
        ...editingTextRef.current,
        [subtitle.id]: firstPart,
        [newSubtitle.id]: secondPart,
      };
      editingTextRef.current = nextEditingText;
      setEditingText(nextEditingText);
      onSubtitlesChange?.(nextSubtitles);
      onSubtitleClick?.(newSubtitle);
      requestAnimationFrame(() => {
        const nextTextarea = document.getElementById(`subtitle-${newSubtitle.id}`) as HTMLTextAreaElement | null;
        nextTextarea?.focus();
        nextTextarea?.setSelectionRange(0, 0);
      });
      return;
    }

    if (event.key !== 'Backspace') return;
    const textarea = event.currentTarget;
    const currentText = editingTextRef.current[subtitle.id] ?? '';
    if (currentText.length > 0 && textarea.selectionStart !== 0) return;

    const sortedSubtitles = [...subtitles].sort((left, right) => left.startTime - right.startTime);
    const currentIndex = sortedSubtitles.findIndex((entry) => entry.id === subtitle.id);
    if (currentIndex <= 0) return;
    event.preventDefault();
    consumeTextDraft(subtitle);

    const previousSubtitle = sortedSubtitles[currentIndex - 1];
    const previousText = editingTextRef.current[previousSubtitle.id] ?? previousSubtitle.text;
    const combinedText = currentText
      ? `${previousText.trim()} ${currentText.trim()}`.trim()
      : previousText;
    const updatedPrevious: Subtitle = {
      ...previousSubtitle,
      text: combinedText,
      endTime: snapTime(subtitle.endTime),
    };
    const nextSubtitles = subtitles
      .filter((entry) => entry.id !== subtitle.id)
      .map((entry) => entry.id === previousSubtitle.id ? updatedPrevious : entry);
    const nextEditingText = { ...editingTextRef.current, [previousSubtitle.id]: combinedText };
    delete nextEditingText[subtitle.id];
    editingTextRef.current = nextEditingText;
    setEditingText(nextEditingText);
    onSubtitlesChange?.(nextSubtitles);
    onSubtitleClick?.(updatedPrevious);
    const joinPosition = previousText.length;
    requestAnimationFrame(() => {
      const previousTextarea = document.getElementById(`subtitle-${previousSubtitle.id}`) as HTMLTextAreaElement | null;
      previousTextarea?.focus();
      previousTextarea?.setSelectionRange(joinPosition, joinPosition);
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (selectedSubtitleIds.length === 0 || event.key !== 'Delete' || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
      selectedSubtitleIds.forEach((id) => onDelete?.(id));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSubtitleIds, onDelete]);

  const setLocalStyleValue = <Key extends keyof SubtitleAnimationStyle>(
    key: Key,
    value: SubtitleAnimationStyle[Key],
  ): SubtitleAnimationStyle => {
    const next = { ...localStyleRef.current, [key]: value };
    localStyleRef.current = next;
    setLocalAnimationStyle(next);
    return next;
  };

  const getStyleSession = <Key extends keyof SubtitleAnimationStyle>(key: Key, restartTerminal: boolean) => {
    const current = styleSessionsRef.current.get(key) as ContinuousEditSession<SubtitleAnimationStyle[Key]> | undefined;
    if (current && (current.terminal === null || !restartTerminal)) return current;
    return beginContinuousEdit(canonicalStyleRef.current[key]);
  };

  const handleStylePreview: SubtitleStyleEditHandlers['onStylePreview'] = (key, value) => {
    const session = previewContinuousEdit(getStyleSession(key, true), value);
    styleSessionsRef.current.set(key, session as ContinuousEditSession<StyleValue>);
    setLocalStyleValue(key, value);
  };

  const handleStyleCommit: SubtitleStyleEditHandlers['onStyleCommit'] = (key, value) => {
    const session = previewContinuousEdit(getStyleSession(key, false), value);
    const result = terminateContinuousEdit(session, 'commit', styleValueEquals);
    styleSessionsRef.current.set(key, result.session as ContinuousEditSession<StyleValue>);
    const nextStyle = setLocalStyleValue(key, result.value);
    if (result.shouldCommit) onAnimationStyleChange?.(nextStyle);
  };

  const handleStyleCancel: SubtitleStyleEditHandlers['onStyleCancel'] = (key) => {
    const session = getStyleSession(key, false);
    const result = terminateContinuousEdit(session, 'cancel', styleValueEquals);
    styleSessionsRef.current.set(key, result.session as ContinuousEditSession<StyleValue>);
    setLocalStyleValue(key, result.value);
  };

  const handleStyleChange: SubtitleStyleEditHandlers['onStyleChange'] = (key, value) => {
    styleSessionsRef.current.delete(key);
    const nextStyle = setLocalStyleValue(key, value);
    onAnimationStyleChange?.(nextStyle);
  };

  const cancelStyleSessionsForHistory = useCallback(() => {
    let nextStyle = localStyleRef.current;
    let changed = false;
    styleSessionsRef.current.forEach((session, key) => {
      if (session.terminal !== null) return;
      const result = terminateContinuousEdit(session, 'cancel', styleValueEquals);
      styleSessionsRef.current.set(key, result.session as ContinuousEditSession<StyleValue>);
      nextStyle = { ...nextStyle, [key]: result.value };
      changed = true;
    });
    if (!changed) return;
    localStyleRef.current = nextStyle;
    setLocalAnimationStyle(nextStyle);
  }, []);

  const cancelContinuousEditsForHistory = useCallback(() => {
    cancelStyleSessionsForHistory();
    const current = textSessionRef.current;
    if (!current || current.session.terminal !== null) return;
    const result = terminateContinuousEdit(current.session, 'cancel');
    textSessionRef.current = { subtitleId: current.subtitleId, session: result.session };
    publishTextDraftState(result.session);
    const nextEditingText = {
      ...editingTextRef.current,
      [current.subtitleId]: result.value,
    };
    editingTextRef.current = nextEditingText;
    setEditingText(nextEditingText);
  }, [cancelStyleSessionsForHistory, publishTextDraftState]);

  const prepareContinuousEditsForHistory = useCallback(() => {
    cancelStyleSessionsForHistory();
    const current = textSessionRef.current;
    if (!current || current.session.terminal !== null) return;
    const result = terminateContinuousEdit(current.session, 'commit');
    textSessionRef.current = { subtitleId: current.subtitleId, session: result.session };
    publishTextDraftState(result.session);
    const nextEditingText = {
      ...editingTextRef.current,
      [current.subtitleId]: result.value,
    };
    editingTextRef.current = nextEditingText;
    setEditingText(nextEditingText);
    if (!result.shouldCommit) return;

    // History initiated outside the focused textarea must match Ctrl/Cmd+Z semantics: the draft
    // first becomes one durable command, then Undo targets precisely that command.
    if (onSubtitleUpdate) onSubtitleUpdate(current.subtitleId, { text: result.value });
    else onSubtitlesChange?.(subtitles.map((entry) => entry.id === current.subtitleId
      ? { ...entry, text: result.value }
      : entry));
  }, [cancelStyleSessionsForHistory, onSubtitleUpdate, onSubtitlesChange, publishTextDraftState, subtitles]);

  useEffect(
    () => transactionCoordinator.register(
      cancelContinuousEditsForHistory,
      prepareContinuousEditsForHistory,
    ),
    [cancelContinuousEditsForHistory, prepareContinuousEditsForHistory, transactionCoordinator],
  );

  const handlePresetStyleChange = useCallback((newStyle: SubtitleAnimationStyle) => {
    styleSessionsRef.current.clear();
    localStyleRef.current = newStyle;
    setLocalAnimationStyle(newStyle);
    onAnimationStyleChange?.(newStyle);
  }, [onAnimationStyleChange]);

  const styleHandlers: SubtitleStyleEditHandlers = {
    onStylePreview: handleStylePreview,
    onStyleCommit: handleStyleCommit,
    onStyleCancel: handleStyleCancel,
    onStyleChange: handleStyleChange,
  };

  const styleContent = (
    <div className="flex flex-col gap-6">
      <div className="px-4 pt-4">
        <StylePresetSelector currentStyle={localAnimationStyle} onStyleChange={handlePresetStyleChange} />
      </div>
      <Accordion
        sections={[
          {
            id: 'textStyle',
            title: 'Estilo del texto',
            content: <TextStyleSection style={localAnimationStyle} {...styleHandlers} />,
          },
          {
            id: 'position',
            title: 'Posición',
            content: <PositionSection style={localAnimationStyle} {...styleHandlers} />,
          },
          {
            id: 'background',
            title: 'Fondo',
            content: <BackgroundSection style={localAnimationStyle} {...styleHandlers} />,
          },
          {
            id: 'entryAnimation',
            title: 'Animación de entrada',
            content: <AnimationSection style={localAnimationStyle} {...styleHandlers} type="entry" />,
          },
          {
            id: 'exitAnimation',
            title: 'Animación de salida',
            content: <AnimationSection style={localAnimationStyle} {...styleHandlers} type="exit" />,
          },
        ]}
        expandedSection={expandedStyleSection}
        onSectionChange={setExpandedStyleSection}
      />
    </div>
  );

  const tabs = [
    {
      id: 'subtitles',
      label: 'Subtítulos',
      content: (
        <SubtitleList
          subtitles={subtitles}
          editingText={editingText}
          currentTime={currentTime}
          onSubtitleClick={onSubtitleClick}
          onDelete={onDelete}
          onSubtitlesChange={onSubtitlesChange}
          onAddSubtitle={onAddSubtitle}
          onGenerateSubtitles={onGenerateSubtitles}
          isGeneratingSubtitles={isGeneratingSubtitles}
          onTextChange={setTextDraft}
          onTextFocus={(subtitle) => {
            textSessionRef.current = { subtitleId: subtitle.id, session: beginContinuousEdit(subtitle.text) };
          }}
          onTextBlur={(subtitle) => finishTextSession(subtitle, 'commit')}
          onCompositionStart={(subtitle) => { composingSubtitleIdRef.current = subtitle.id; }}
          onCompositionEnd={(subtitle) => {
            if (composingSubtitleIdRef.current === subtitle.id) composingSubtitleIdRef.current = null;
          }}
          onKeyDown={handleSubtitleKeyDown}
        />
      ),
    },
    { id: 'style', label: 'Estilo', content: styleContent },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden select-none" data-testid="subtitle-editor">
      <Tabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(tabId) => setActiveTab(tabId as 'subtitles' | 'style')}
      />
    </div>
  );
}
