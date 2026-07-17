import { useCallback, useEffect, useRef, useState } from 'react';
import {
  beginContinuousEdit,
  getContinuousEditKeyboardTerminal,
  previewContinuousEdit,
  terminateContinuousEdit,
  type ContinuousEditSession,
} from '@/lib/continuous-edit-session';
import { useEditorTransactionCoordinator } from '@/components/video-editor/EditorTransactionContext';
import {
  formatNumericValue,
  normalizeNumericValue,
  parseNumericDraft,
} from './numeric-input-draft';
import { ResetIcon } from '../icons/ResetIcon';

interface DraggableNumberInputProps {
  value: number;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
  onCancel: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
  className?: string;
  defaultValue?: number;
  layout?: 'stacked' | 'horizontal';
  labelWidth?: number;
  disabled?: boolean;
  decimalPlaces?: number;
  normalizeValue?: (value: number) => number;
}

/**
 * Blender-style numeric field with one atomic command per pointer or focus session.
 *
 * Dragging, local typing, and arrow keys only preview values. Pointer release, Enter, or blur
 * commits once; pointer cancellation, Escape, and invalid text restore the durable baseline.
 */
export function DraggableNumberInput({
  value,
  onPreview,
  onCommit,
  onCancel,
  min = -Infinity,
  max = Infinity,
  step = 1,
  label,
  unit = '',
  className = '',
  defaultValue = 0,
  layout = 'stacked',
  labelWidth,
  disabled = false,
  decimalPlaces,
  normalizeValue: normalizeDomainValue,
}: DraggableNumberInputProps) {
  const transactionCoordinator = useEditorTransactionCoordinator();
  const normalize = useCallback((next: number) => normalizeNumericValue(next, {
    min,
    max,
    decimalPlaces,
    normalizeValue: normalizeDomainValue,
  }), [decimalPlaces, max, min, normalizeDomainValue]);
  const format = useCallback(
    (next: number) => formatNumericValue(normalize(next), decimalPlaces),
    [decimalPlaces, normalize],
  );
  const [inputValue, setInputValue] = useState(() => format(value));
  const [isFocused, setIsFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<ContinuousEditSession<number> | null>(null);
  const pointerRef = useRef<{
    id: number;
    startX: number;
    startValue: number;
    moved: boolean;
    target: HTMLElement;
  } | null>(null);

  useEffect(() => {
    // Undo/redo and other durable store changes update an idle field immediately. An active edit
    // owns its draft until commit/cancel so parent renders cannot overwrite a gesture mid-flight.
    if (sessionRef.current?.terminal === null) return;
    sessionRef.current = null;
    setInputValue(format(value));
  }, [format, value]);

  const begin = useCallback(() => {
    sessionRef.current = beginContinuousEdit(normalize(value));
  }, [normalize, value]);

  const preview = useCallback((next: number, syncDraft = true) => {
    const currentSession = sessionRef.current ?? beginContinuousEdit(normalize(value));
    // Enter followed by blur, or pointerup followed by lostpointercapture, can deliver work after
    // the session already ended. Do not let that late preview reopen the parent style transaction.
    if (currentSession.terminal !== null) return currentSession.latest;

    const normalized = normalize(next);
    sessionRef.current = previewContinuousEdit(
      currentSession,
      normalized,
    );
    // Pointer and keyboard increments own the displayed value. Typed edits keep their exact raw
    // draft so intermediate text such as `6.` is not normalized to `6` before `5` is entered.
    if (syncDraft) setInputValue(format(normalized));
    onPreview(normalized);
    return normalized;
  }, [format, normalize, onPreview, value]);

  const finish = useCallback((terminal: 'commit' | 'cancel') => {
    const session = sessionRef.current;
    if (!session || session.terminal !== null) return;
    const result = terminateContinuousEdit(session, terminal);
    sessionRef.current = result.session;
    setInputValue(format(result.value));
    if (result.shouldCommit) onCommit(result.value);
    else if (terminal === 'cancel') onCancel(result.value);
  }, [format, onCancel, onCommit]);

  const finishPointer = useCallback((pointerId: number, terminal: 'commit' | 'cancel') => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== pointerId) return;
    pointerRef.current = null;
    setIsDragging(false);
    document.body.style.cursor = '';
    finish(terminal);
    if (terminal === 'commit' && !pointer.moved) inputRef.current?.focus();
  }, [finish]);

  const cancelForHistory = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.terminal !== null) return;
    const pointer = pointerRef.current;
    pointerRef.current = null;
    setIsDragging(false);
    document.body.style.cursor = '';
    finish('cancel');
    if (pointer?.target.hasPointerCapture(pointer.id)) {
      pointer.target.releasePointerCapture(pointer.id);
    }
  }, [finish]);

  useEffect(
    () => transactionCoordinator.register(cancelForHistory),
    [cancelForHistory, transactionCoordinator],
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !pointerRef.current) return;
      event.preventDefault();
      const pointer = pointerRef.current;
      finishPointer(pointer.id, 'cancel');
      if (pointer.target.hasPointerCapture(pointer.id)) {
        pointer.target.releasePointerCapture(pointer.id);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [finishPointer, isDragging]);

  useEffect(() => () => {
    document.body.style.cursor = '';
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0 || isFocused) return;
    begin();
    pointerRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startValue: normalize(value),
      moved: false,
      target: event.currentTarget,
    };
    setIsDragging(true);
    document.body.style.cursor = 'ew-resize';
    window.getSelection()?.removeAllRanges();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const delta = event.clientX - pointer.startX;
    if (Math.abs(delta) > 2) pointer.moved = true;
    const sensitivity = event.shiftKey ? 0.1 : 1;
    preview(pointer.startValue + delta * step * sensitivity);
    event.preventDefault();
  };

  const pointerHandlers = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      finishPointer(event.pointerId, 'commit');
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => finishPointer(event.pointerId, 'cancel'),
    onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => finishPointer(event.pointerId, 'commit'),
  };

  const commitReset = () => {
    if (disabled) return;
    // A reset inside an active focus session must keep that session's original durable baseline.
    // Starting again from the latest preview would make Undo restore the draft instead of the
    // value that existed before the user focused the field.
    if (!sessionRef.current || sessionRef.current.terminal !== null) begin();
    preview(defaultValue);
    finish('commit');
    // Reset is an explicit terminal action. Pointer-down deliberately prevented the button from
    // blurring first, so close focus now that the reset is durable; the next typed edit can then
    // begin a fresh session from the reset value instead of reusing this terminal session.
    inputRef.current?.blur();
  };

  const finishTypedValue = (terminal: 'commit' | 'cancel') => {
    if (terminal === 'cancel') {
      finish('cancel');
      return;
    }
    const parsed = parseNumericDraft(inputValue);
    if (parsed === null) {
      finish('cancel');
      return;
    }
    preview(parsed);
    finish('commit');
  };

  const parsedProgressDraft = parseNumericDraft(inputValue);
  const progressValue = normalize(parsedProgressDraft === null ? value : parsedProgressDraft);

  return (
    <div className={`${layout === 'stacked' ? 'flex flex-col gap-2' : 'flex items-center gap-3'} ${disabled ? 'opacity-40' : ''} ${className}`}>
      {label && (
        <label
          className={`select-none text-sm text-gray-300 ${disabled ? 'cursor-not-allowed' : 'cursor-ew-resize'} ${layout === 'horizontal' ? 'truncate' : ''}`}
          style={layout === 'horizontal' && labelWidth ? { width: labelWidth } : undefined}
          {...pointerHandlers}
          onDoubleClick={(event) => {
            event.preventDefault();
            commitReset();
          }}
          title={layout === 'horizontal' ? label : 'Drag to change the value. Double-click to reset.'}
        >
          {label}
        </label>
      )}
      <div className={`relative flex items-center ${layout === 'horizontal' ? 'min-w-[120px] flex-1' : ''}`}>
        <div className="relative flex-1">
          <div className="absolute inset-0 bg-gray-700 rounded-l" />
          {min !== -Infinity && max !== Infinity && (
            <div
              className="absolute inset-0 bg-gray-800 rounded-l pointer-events-none"
              style={{
                width: `${((progressValue - min) / (max - min)) * 100}%`,
                opacity: 0.5,
              }}
            />
          )}
          <input
            ref={inputRef}
            type="text"
            disabled={disabled}
            aria-label={label}
            value={inputValue}
            onChange={(event) => {
              const rawDraft = event.target.value;
              setInputValue(rawDraft);
              const parsed = parseNumericDraft(rawDraft);
              if (parsed !== null) preview(parsed, false);
            }}
            onFocus={() => {
              setIsFocused(true);
              begin();
            }}
            onBlur={() => {
              setIsFocused(false);
              finishTypedValue('commit');
            }}
            onKeyDown={(event) => {
              const terminal = getContinuousEditKeyboardTerminal(
                event.key,
                event.nativeEvent.isComposing,
              );
              if (terminal === 'cancel') {
                event.preventDefault();
                finishTypedValue('cancel');
                event.currentTarget.blur();
                return;
              }
              if (terminal === 'commit') {
                event.preventDefault();
                finishTypedValue('commit');
                event.currentTarget.blur();
                return;
              }
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                const current = parseNumericDraft(inputValue);
                const baseline = current ?? sessionRef.current?.latest ?? value;
                const direction = event.key === 'ArrowUp' ? 1 : -1;
                preview(baseline + direction * step * (event.shiftKey ? 0.1 : 1));
              }
            }}
            className={`relative w-full h-8 bg-transparent text-white rounded-l px-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 ${isFocused ? 'cursor-text' : 'cursor-ew-resize'}`}
          />
          {!disabled && !isFocused && <div className="absolute inset-0 cursor-ew-resize" {...pointerHandlers} />}
          {unit && (
            <span className="absolute right-2 text-sm text-gray-400 top-1/2 -translate-y-1/2">{unit}</span>
          )}
        </div>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Reset ${label ?? 'value'} to default`}
          onPointerDown={(event) => {
            // Keep an active typed draft from blurring into its own command immediately before
            // reset replaces it. The reset terminal below owns the whole focus session instead.
            event.preventDefault();
          }}
          onClick={commitReset}
          className="h-8 w-8 flex items-center justify-center bg-gray-700 text-gray-400 hover:text-white rounded-r border-l border-gray-600 disabled:cursor-not-allowed"
          title="Reset to default"
        >
          <ResetIcon />
        </button>
      </div>
    </div>
  );
}
