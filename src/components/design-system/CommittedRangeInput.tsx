'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  beginContinuousEdit,
  previewContinuousEdit,
  terminateContinuousEdit,
  type ContinuousEditSession,
} from '@/lib/continuous-edit-session';
import { useEditorTransactionCoordinator } from '@/components/video-editor/EditorTransactionContext';

interface CommittedRangeInputProps {
  value: number;
  minimum: number;
  maximum: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  onPreview?: (value: number) => void;
  onCommit: (value: number) => void;
  onCancel?: (value: number) => void;
}

/**
 * Range control that keeps pointer noise local and emits one durable terminal command.
 *
 * Keyboard changes are individually terminal. Pointer capture guarantees an outside release is
 * observed, while the pure session terminal makes pointerup/lost-capture and Enter/blur sequences
 * safe when browsers report both.
 */
export function CommittedRangeInput({
  value,
  minimum,
  maximum,
  step = 1,
  disabled,
  ariaLabel,
  className,
  onPreview,
  onCommit,
  onCancel,
}: CommittedRangeInputProps) {
  const transactionCoordinator = useEditorTransactionCoordinator();
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<ContinuousEditSession<number> | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const cancelledPointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    // External store updates (including undo/redo) refresh an idle control. An active pointer owns
    // its draft until its terminal event so an unrelated render cannot move the thumb underneath it.
    if (sessionRef.current?.terminal === null) return;
    sessionRef.current = null;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const clearCancelledPointer = (event: PointerEvent) => {
      if (cancelledPointerIdRef.current === event.pointerId) {
        cancelledPointerIdRef.current = null;
      }
    };
    // Escape releases pointer capture immediately, so observe the physical terminal on window.
    // Until that terminal arrives, range input events from the cancelled pointer stay suppressed.
    window.addEventListener('pointerup', clearCancelledPointer);
    window.addEventListener('pointercancel', clearCancelledPointer);
    return () => {
      window.removeEventListener('pointerup', clearCancelledPointer);
      window.removeEventListener('pointercancel', clearCancelledPointer);
    };
  }, []);

  const ensureSession = () => {
    sessionRef.current ??= beginContinuousEdit(value);
    return sessionRef.current;
  };
  const preview = (next: number) => {
    sessionRef.current = previewContinuousEdit(ensureSession(), next);
    setDraft(next);
    onPreview?.(next);
  };
  const finish = useCallback((terminal: 'commit' | 'cancel') => {
    const session = sessionRef.current;
    if (!session || session.terminal !== null) return;
    const result = terminateContinuousEdit(session, terminal);
    sessionRef.current = result.session;
    setDraft(result.value);
    if (result.shouldCommit) onCommit(result.value);
    else if (terminal === 'cancel') onCancel?.(result.value);
  }, [onCancel, onCommit]);

  const cancelActivePointer = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.terminal !== null) return;
    const pointerId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    if (pointerId !== null) cancelledPointerIdRef.current = pointerId;
    finish('cancel');

    const input = inputRef.current;
    if (pointerId !== null && input?.hasPointerCapture(pointerId)) {
      // Releasing capture prevents more physical drag movement from targeting this slider. The
      // cancelled pointer id remains suppressed until its real pointerup/pointercancel on window.
      input.releasePointerCapture(pointerId);
    }
  }, [finish]);

  useEffect(
    () => transactionCoordinator.register(cancelActivePointer),
    [cancelActivePointer, transactionCoordinator],
  );

  const finishPointer = (pointerId: number) => {
    if (cancelledPointerIdRef.current === pointerId) return;
    if (activePointerIdRef.current !== pointerId) return;
    activePointerIdRef.current = null;
    finish('commit');
  };

  return (
    <input
      ref={inputRef}
      type="range"
      min={minimum}
      max={Math.max(minimum, maximum)}
      step={step}
      value={draft}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
      onPointerDown={(event) => {
        sessionRef.current = beginContinuousEdit(value);
        activePointerIdRef.current = event.pointerId;
        cancelledPointerIdRef.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        if (cancelledPointerIdRef.current === event.pointerId) {
          cancelledPointerIdRef.current = null;
        } else {
          finishPointer(event.pointerId);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        if (activePointerIdRef.current !== event.pointerId) return;
        activePointerIdRef.current = null;
        cancelledPointerIdRef.current = event.pointerId;
        finish('cancel');
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onLostPointerCapture={(event) => {
        if (cancelledPointerIdRef.current !== event.pointerId) finishPointer(event.pointerId);
      }}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (cancelledPointerIdRef.current !== null) {
          // React's range change event has no pointer id. While the cancelled physical pointer is
          // still down, suppress every such event rather than misclassifying it as a keyboard step.
          const baseline = sessionRef.current?.baseline ?? value;
          // The DOM property already contains the browser's late movement. Restore it directly as
          // well as React state because setting the state to its existing baseline may not render.
          event.currentTarget.value = baseline.toString();
          setDraft(baseline);
          return;
        }
        if (activePointerIdRef.current !== null) {
          preview(next);
          return;
        }
        // A keyboard step is a complete editor command, but still uses the same session state so
        // the following blur cannot dispatch it a second time.
        sessionRef.current = beginContinuousEdit(value);
        preview(next);
        finish('commit');
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        cancelActivePointer();
      }}
      onBlur={() => {
        if (activePointerIdRef.current === null && cancelledPointerIdRef.current === null) {
          finish('commit');
        }
      }}
    />
  );
}
