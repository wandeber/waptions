import { describe, expect, it, vi } from 'vitest';
import { createEditorTransactionCoordinator } from '@/lib/editor-transaction-coordinator';

describe('editor transaction coordinator', () => {
  it('isolates cancellation to one editor instance and tolerates unregister during iteration', () => {
    const first = createEditorTransactionCoordinator();
    const second = createEditorTransactionCoordinator();
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    let unregisterFirst: () => void = () => undefined;
    unregisterFirst = first.register(() => {
      firstCancel();
      unregisterFirst();
    });
    second.register(secondCancel);

    first.cancelActivePreviews();
    first.cancelActivePreviews();

    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).not.toHaveBeenCalled();
    second.cancelActivePreviews();
    expect(secondCancel).toHaveBeenCalledOnce();
  });

  it('prepares history separately and disposes every active registration exactly once', () => {
    const coordinator = createEditorTransactionCoordinator();
    const cancel = vi.fn();
    const prepare = vi.fn();
    coordinator.register(cancel, prepare);

    coordinator.prepareHistoryNavigation();
    expect(prepare).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();

    coordinator.dispose();
    coordinator.dispose();
    expect(cancel).toHaveBeenCalledOnce();

    const lateCancel = vi.fn();
    coordinator.register(lateCancel);
    expect(lateCancel).toHaveBeenCalledOnce();
  });

  it('publishes one aggregate undoable-draft signal across scoped owners', () => {
    const coordinator = createEditorTransactionCoordinator();
    const firstOwner = Symbol('first');
    const secondOwner = Symbol('second');
    const listener = vi.fn();
    const unsubscribe = coordinator.subscribePendingUndoableDraft(listener);

    coordinator.setPendingUndoableDraft(firstOwner, true);
    coordinator.setPendingUndoableDraft(secondOwner, true);
    coordinator.setPendingUndoableDraft(firstOwner, false);
    expect(coordinator.hasPendingUndoableDraft()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    coordinator.setPendingUndoableDraft(secondOwner, false);
    expect(coordinator.hasPendingUndoableDraft()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
