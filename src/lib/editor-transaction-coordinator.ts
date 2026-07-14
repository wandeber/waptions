export type EditorTransactionCanceller = () => void;

export interface EditorTransactionCoordinator {
  register: (
    canceller: EditorTransactionCanceller,
    prepareForHistory?: EditorTransactionCanceller,
  ) => () => void;
  cancelActivePreviews: () => void;
  prepareHistoryNavigation: () => void;
  setPendingUndoableDraft: (owner: symbol, pending: boolean) => void;
  hasPendingUndoableDraft: () => boolean;
  subscribePendingUndoableDraft: (listener: () => void) => () => void;
  dispose: () => void;
}

/** Creates one cancellation registry whose lifetime belongs to exactly one editor instance. */
export function createEditorTransactionCoordinator(): EditorTransactionCoordinator {
  const registrations = new Set<{
    cancel: EditorTransactionCanceller;
    prepareForHistory: EditorTransactionCanceller;
  }>();
  const pendingUndoableDraftOwners = new Set<symbol>();
  const pendingDraftListeners = new Set<() => void>();
  let disposed = false;
  const notifyPendingDraftChange = (previousPending: boolean) => {
    if (previousPending === (pendingUndoableDraftOwners.size > 0)) return;
    Array.from(pendingDraftListeners).forEach((listener) => listener());
  };
  return {
    register: (canceller, prepareForHistory = canceller) => {
      if (disposed) {
        canceller();
        return () => undefined;
      }
      const registration = { cancel: canceller, prepareForHistory };
      registrations.add(registration);
      return () => registrations.delete(registration);
    },
    cancelActivePreviews: () => {
      // A cancellation may synchronously unmount and unregister its control. Iterating a snapshot
      // keeps every session that was active at the transaction boundary deterministic.
      Array.from(registrations).forEach(({ cancel }) => cancel());
    },
    prepareHistoryNavigation: () => {
      Array.from(registrations).forEach(({ prepareForHistory }) => prepareForHistory());
    },
    setPendingUndoableDraft: (owner, pending) => {
      if (disposed) return;
      const previousPending = pendingUndoableDraftOwners.size > 0;
      if (pending) pendingUndoableDraftOwners.add(owner);
      else pendingUndoableDraftOwners.delete(owner);
      notifyPendingDraftChange(previousPending);
    },
    hasPendingUndoableDraft: () => pendingUndoableDraftOwners.size > 0,
    subscribePendingUndoableDraft: (listener) => {
      if (disposed) return () => undefined;
      pendingDraftListeners.add(listener);
      return () => pendingDraftListeners.delete(listener);
    },
    dispose: () => {
      if (disposed) return;
      const hadPendingDraft = pendingUndoableDraftOwners.size > 0;
      disposed = true;
      Array.from(registrations).forEach(({ cancel }) => cancel());
      registrations.clear();
      pendingUndoableDraftOwners.clear();
      notifyPendingDraftChange(hadPendingDraft);
      pendingDraftListeners.clear();
    },
  };
}
