import { useCallback, useEffect, useRef, useState } from 'react';
import {
  beginContinuousEdit,
  getContinuousEditKeyboardTerminal,
  previewContinuousEdit,
  terminateContinuousEdit,
  type ContinuousEditSession,
} from '@/lib/continuous-edit-session';
import { useEditorTransactionCoordinator } from '@/components/video-editor/EditorTransactionContext';
import { isCompleteHexColor } from './hex-color-draft';

interface TransactionalHexInputProps {
  value: string;
  ariaLabel: string;
  onPreview: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: (value: string) => void;
  className?: string;
}

/**
 * Hex field whose raw keyboard draft is independent from its valid color preview.
 *
 * A browser color input requires a complete color, while users necessarily pass through partial
 * text such as `#12`. Keeping that text local prevents incomplete drafts from reaching rendering,
 * history, revisions, or persistence. Only an exact `#RRGGBB` value can preview and commit.
 */
export function TransactionalHexInput({
  value,
  ariaLabel,
  onPreview,
  onCommit,
  onCancel,
  className = '',
}: TransactionalHexInputProps) {
  const transactionCoordinator = useEditorTransactionCoordinator();
  const [draft, setDraft] = useState(value);
  const sessionRef = useRef<ContinuousEditSession<string> | null>(null);

  useEffect(() => {
    // Durable external changes, including Undo and Redo, replace an idle or completed draft. An
    // active focus session keeps ownership so a valid preview render cannot normalize raw text.
    if (sessionRef.current?.terminal === null) return;
    sessionRef.current = null;
    setDraft(value);
  }, [value]);

  const begin = useCallback(() => {
    sessionRef.current = beginContinuousEdit(value);
  }, [value]);

  const preview = useCallback((nextDraft: string) => {
    sessionRef.current = previewContinuousEdit(
      sessionRef.current ?? beginContinuousEdit(value),
      nextDraft,
    );
    onPreview(nextDraft);
  }, [onPreview, value]);

  const finish = useCallback((terminal: 'commit' | 'cancel') => {
    const session = sessionRef.current;
    if (!session || session.terminal !== null) return;

    const canCommit = terminal === 'commit' && isCompleteHexColor(draft);
    const resolvedTerminal = canCommit ? 'commit' : 'cancel';
    const latestSession = canCommit ? previewContinuousEdit(session, draft) : session;
    const result = terminateContinuousEdit(latestSession, resolvedTerminal);
    sessionRef.current = result.session;
    setDraft(result.value);

    if (result.shouldCommit) onCommit(result.value);
    else if (resolvedTerminal === 'cancel') onCancel(result.value);
  }, [draft, onCancel, onCommit]);

  useEffect(
    () => transactionCoordinator.register(() => finish('cancel')),
    [finish, transactionCoordinator],
  );

  return (
    <input
      type="text"
      aria-label={ariaLabel}
      value={draft}
      onFocus={begin}
      onChange={(event) => {
        const rawDraft = event.target.value;
        setDraft(rawDraft);
        if (isCompleteHexColor(rawDraft)) preview(rawDraft);
      }}
      onBlur={() => finish('commit')}
      onKeyDown={(event) => {
        const terminal = getContinuousEditKeyboardTerminal(
          event.key,
          event.nativeEvent.isComposing,
        );
        if (terminal === 'commit') {
          event.preventDefault();
          finish('commit');
          event.currentTarget.blur();
        } else if (terminal === 'cancel') {
          event.preventDefault();
          finish('cancel');
          event.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}
