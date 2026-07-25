import {
  DEFAULT_EDITOR_UI_VIEW_STATE,
  type EditorUiCommand,
  type EditorUiCommandRequest,
  type EditorUiCommandResult,
  type EditorUiController,
  type EditorUiEvent,
  type EditorUiPresentationMode,
  type EditorUiSnapshot,
  type EditorUiTransport,
  type EditorUiViewState,
  type EditorUiViewStateStorage,
} from './contracts';
import { buildEditorUiModelContext } from './model-context';

const EVENT_POLL_LIMIT = 128;
const MODEL_CONTEXT_DEBOUNCE_MS = 100;

export interface CreateEditorUiControllerOptions {
  viewId: string;
  initialSnapshot: EditorUiSnapshot;
  transport: EditorUiTransport;
  viewStateStorage?: EditorUiViewStateStorage;
  createCommandId?: () => string;
}

const createDefaultCommandId = (): string => (
  globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`
);

const mergePreservedView = (
  incoming: EditorUiSnapshot,
  currentView: EditorUiViewState,
): EditorUiSnapshot => ({
  ...incoming,
  view: {
    ...incoming.view,
    ...currentView,
    // View layout is local, but its CAS revision is coordinator-owned and must advance.
    revision: incoming.view.revision,
  },
});

/**
 * Host-neutral external store with revision-aware reconnect and view-local optimistic edits.
 *
 * Durable snapshots may change at any time, including while a pointer gesture is active. They
 * replace project data without replacing the view state, so React never needs to remount the
 * editor and decoder-owning descendants can retain their warm resources.
 */
export class ExternalEditorUiController implements EditorUiController {
  readonly viewId: string;

  private snapshot: EditorUiSnapshot;
  private readonly transport: EditorUiTransport;
  private readonly storage?: EditorUiViewStateStorage;
  private readonly createCommandId: () => string;
  private readonly listeners = new Set<() => void>();
  private connectionAbort: AbortController | null = null;
  private isClosed = false;
  private connectGeneration = 0;
  private modelContextTimer: ReturnType<typeof setTimeout> | null = null;
  private modelContextDigest = '';
  private readonly hasStoredViewState: boolean;
  private hasConnectedSnapshot = false;
  private commandTail: Promise<void> = Promise.resolve();
  private activeCommandAbort: AbortController | null = null;

  constructor(options: CreateEditorUiControllerOptions) {
    this.viewId = options.viewId;
    this.transport = options.transport;
    this.storage = options.viewStateStorage;
    this.createCommandId = options.createCommandId ?? createDefaultCommandId;
    const storedView = options.viewStateStorage?.load(options.viewId) ?? null;
    this.hasStoredViewState = storedView !== null;
    this.snapshot = {
      ...options.initialSnapshot,
      view: {
        ...DEFAULT_EDITOR_UI_VIEW_STATE,
        ...options.initialSnapshot.view,
        ...storedView,
      },
    };
  }

  getSnapshot = (): EditorUiSnapshot => this.snapshot;

  getServerSnapshot = (): EditorUiSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async connect(): Promise<void> {
    if (this.isClosed) return;
    const generation = ++this.connectGeneration;
    this.connectionAbort?.abort();
    const connectionAbort = new AbortController();
    this.connectionAbort = connectionAbort;
    this.replaceSnapshot({ ...this.snapshot, connection: 'connecting', errorMessage: null });
    try {
      const incoming = await this.transport.readSnapshot(connectionAbort.signal);
      if (!this.isCurrentConnection(generation, connectionAbort)) return;
      const connected = { ...incoming, connection: 'connected' as const };
      if (!this.hasConnectedSnapshot && !this.hasStoredViewState) {
        this.replaceSnapshot(connected);
      } else {
        this.applyAuthoritativeSnapshot(connected);
      }
      this.hasConnectedSnapshot = true;
      this.startEventStream(generation, connectionAbort);
    } catch (error) {
      if (!this.isCurrentConnection(generation, connectionAbort)) return;
      this.replaceSnapshot({
        ...this.snapshot,
        connection: 'failed',
        errorMessage: error instanceof Error ? error.message : 'The editor host could not connect.',
      });
    }
  }

  async reconnect(): Promise<void> {
    if (this.isClosed) return;
    this.replaceSnapshot({ ...this.snapshot, connection: 'reconnecting', errorMessage: null });
    await this.connect();
  }

  async dispatch(
    command: EditorUiCommand,
    options?: { optimistic?: (snapshot: EditorUiSnapshot) => EditorUiSnapshot },
  ): Promise<EditorUiCommandResult> {
    const task = this.commandTail.then(() => this.dispatchNow(command, options));
    this.commandTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async dispatchNow(
    command: EditorUiCommand,
    options?: { optimistic?: (snapshot: EditorUiSnapshot) => EditorUiSnapshot },
  ): Promise<EditorUiCommandResult> {
    const before = this.snapshot;
    const commandId = this.createCommandId();
    if (this.isClosed) {
      return {
        ok: false,
        commandId,
        code: 'unavailable',
        message: 'The editor controller is closed.',
      };
    }
    const commandAbort = new AbortController();
    this.activeCommandAbort = commandAbort;
    const request: EditorUiCommandRequest = {
      commandId,
      command,
      expected: {
        sessionEpoch: before.stateToken.sessionEpoch,
        sessionRevision: before.stateToken.sessionRevision,
        documentRevision: before.stateToken.documentRevision,
        audioGraphRevision: before.stateToken.audioGraphRevision,
        narrativeRevision: before.stateToken.narrativeRevision,
      },
    };
    const optimistic = options?.optimistic?.(before) ?? before;
    this.replaceSnapshot({
      ...optimistic,
      pendingCommandIds: [...optimistic.pendingCommandIds, commandId],
      conflict: null,
      errorMessage: null,
    });

    try {
      const result = await this.transport.execute(request, commandAbort.signal);
      if (result.ok) {
        if (result.snapshot && !this.isAuthoritativeSnapshotOlder(result.snapshot)) {
          this.applyAuthoritativeSnapshot(result.snapshot, false, commandId);
        }
        else {
          const nextStateToken = this.isStateTokenOlder(result.stateToken)
            ? this.snapshot.stateToken
            : result.stateToken;
          this.replaceSnapshot({
            ...this.snapshot,
            stateToken: nextStateToken,
            pendingCommandIds: this.snapshot.pendingCommandIds.filter((id) => id !== commandId),
            recentSemanticAction: command.type,
          });
        }
        return result;
      }

      if (result.code === 'conflict') {
        const conflictSnapshot = result.snapshot ?? await this.transport.readSnapshot();
        const conflict = {
          commandId,
          message: result.message,
          expectedRevision: request.expected.sessionRevision,
          actualRevision: result.actualStateToken?.sessionRevision ?? null,
        };
        if (this.isAuthoritativeSnapshotOlder(conflictSnapshot)) {
          this.replaceSnapshot({
            ...this.snapshot,
            pendingCommandIds: this.snapshot.pendingCommandIds.filter((id) => id !== commandId),
            conflict,
          });
        } else {
          this.applyAuthoritativeSnapshot({
            ...conflictSnapshot,
            conflict,
          }, false, commandId);
        }
        return result;
      }

      await this.rollbackFailedCommand(commandId, result.message);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The editor command failed.';
      await this.rollbackFailedCommand(commandId, message);
      this.replaceSnapshot({
        ...this.snapshot,
        connection: 'reconnecting',
        pendingCommandIds: this.snapshot.pendingCommandIds.filter((id) => id !== commandId),
        errorMessage: message,
      });
      void this.reconnect();
      return {
        ok: false,
        commandId,
        code: 'unavailable',
        message: this.snapshot.errorMessage ?? 'The editor command failed.',
      };
    } finally {
      if (this.activeCommandAbort === commandAbort) this.activeCommandAbort = null;
    }
  }

  updateView(patch: Partial<EditorUiViewState>): void {
    const view = { ...this.snapshot.view, ...patch };
    this.storage?.save(this.viewId, view);
    this.replaceSnapshot({ ...this.snapshot, view });
  }

  async requestPresentation(
    mode: EditorUiPresentationMode,
  ): Promise<EditorUiPresentationMode> {
    const accepted = this.transport.requestPresentation
      ? await this.transport.requestPresentation(mode)
      : mode;
    this.updateView({ presentation: accepted });
    await this.dispatch({ type: 'view.update', patch: { presentation: accepted } });
    return accepted;
  }

  clearConflict(): void {
    if (!this.snapshot.conflict) return;
    this.replaceSnapshot({ ...this.snapshot, conflict: null });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.connectGeneration += 1;
    this.connectionAbort?.abort();
    this.connectionAbort = null;
    this.activeCommandAbort?.abort();
    this.activeCommandAbort = null;
    if (this.modelContextTimer) clearTimeout(this.modelContextTimer);
    this.modelContextTimer = null;
    this.transport.close?.();
    this.listeners.clear();
  }

  /** Exposed for deterministic host-adapter tests and direct subscription transports. */
  acceptEvent(event: EditorUiEvent): void {
    const current = this.snapshot.stateToken;
    const hasGap = event.previousCursor !== current.eventCursor;
    const changedEpoch = event.stateToken.sessionEpoch !== current.sessionEpoch;
    const inconsistentCursor = event.cursor !== event.stateToken.eventCursor;
    const wentBackwards = event.stateToken.sessionRevision < current.sessionRevision
      || event.stateToken.documentRevision < current.documentRevision
      || event.stateToken.audioGraphRevision < current.audioGraphRevision
      || (
        event.stateToken.narrativeRevision !== undefined
        && current.narrativeRevision !== undefined
        && event.stateToken.narrativeRevision < current.narrativeRevision
      );
    if (hasGap || changedEpoch || inconsistentCursor || wentBackwards || !event.snapshot) {
      void this.reconnect();
      return;
    }
    this.applyAuthoritativeSnapshot({
      ...event.snapshot,
      stateToken: event.stateToken,
    }, event.kind === 'playback' || (
      event.kind === 'view' && this.snapshot.playback.followingPresenter
    ));
  }

  private isCurrentConnection(generation: number, controller: AbortController): boolean {
    return !this.isClosed
      && this.connectGeneration === generation
      && this.connectionAbort === controller
      && !controller.signal.aborted;
  }

  private startEventStream(generation: number, controller: AbortController): void {
    if (this.transport.subscribe) {
      Promise.resolve(this.transport.subscribe(
        { cursor: this.snapshot.stateToken.eventCursor, signal: controller.signal },
        (event) => {
          if (this.isCurrentConnection(generation, controller)) this.acceptEvent(event);
        },
      )).catch((error) => {
        if (!this.isCurrentConnection(generation, controller)) return;
        this.replaceSnapshot({
          ...this.snapshot,
          connection: 'reconnecting',
          errorMessage: error instanceof Error ? error.message : 'The editor event stream closed.',
        });
        void this.reconnect();
      });
      return;
    }
    if (this.transport.readEvents) void this.pollEvents(generation, controller);
  }

  private async pollEvents(generation: number, controller: AbortController): Promise<void> {
    while (this.isCurrentConnection(generation, controller)) {
      try {
        const page = await this.transport.readEvents!({
          cursor: this.snapshot.stateToken.eventCursor,
          limit: EVENT_POLL_LIMIT,
          signal: controller.signal,
        });
        if (!this.isCurrentConnection(generation, controller)) return;
        if (page.cursorExpired) {
          await this.reconnect();
          return;
        }
        for (const event of page.events) {
          if (!this.isCurrentConnection(generation, controller)) return;
          this.acceptEvent(event);
        }
        if (page.events.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 250);
            controller.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        }
      } catch (error) {
        if (!this.isCurrentConnection(generation, controller)) return;
        this.replaceSnapshot({
          ...this.snapshot,
          connection: 'reconnecting',
          errorMessage: error instanceof Error ? error.message : 'The editor event poll failed.',
        });
        await this.reconnect();
        return;
      }
    }
  }

  private applyAuthoritativeSnapshot(
    incoming: EditorUiSnapshot,
    acceptIncomingPlayhead = false,
    resolvedCommandId?: string,
  ): void {
    const preservedView = {
      ...this.snapshot.view,
      ...(acceptIncomingPlayhead ? { playheadSeconds: incoming.view.playheadSeconds } : {}),
    };
    this.replaceSnapshot({
      ...mergePreservedView(incoming, preservedView),
      pendingCommandIds: this.snapshot.pendingCommandIds.filter(
        (id) => id !== resolvedCommandId,
      ),
    });
  }

  private isStateTokenOlder(incoming: EditorUiSnapshot['stateToken']): boolean {
    const current = this.snapshot.stateToken;
    return incoming.sessionEpoch !== current.sessionEpoch
      || incoming.sessionRevision < current.sessionRevision
      || incoming.documentRevision < current.documentRevision
      || incoming.audioGraphRevision < current.audioGraphRevision
      || (
        incoming.narrativeRevision !== undefined
        && current.narrativeRevision !== undefined
        && incoming.narrativeRevision < current.narrativeRevision
      );
  }

  private isAuthoritativeSnapshotOlder(incoming: EditorUiSnapshot): boolean {
    return this.isStateTokenOlder(incoming.stateToken);
  }

  private async rollbackFailedCommand(commandId: string, message: string): Promise<void> {
    try {
      const authoritative = await this.transport.readSnapshot();
      if (!this.isAuthoritativeSnapshotOlder(authoritative)) {
        this.applyAuthoritativeSnapshot({
          ...authoritative,
          errorMessage: message,
        }, false, commandId);
        return;
      }
    } catch {
      // A reconnect below will retry the authoritative refresh without restoring an older snapshot.
    }
    this.replaceSnapshot({
      ...this.snapshot,
      pendingCommandIds: this.snapshot.pendingCommandIds.filter((id) => id !== commandId),
      errorMessage: message,
    });
  }

  private replaceSnapshot(snapshot: EditorUiSnapshot): void {
    if (this.isClosed) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
    this.scheduleModelContext();
  }

  private scheduleModelContext(): void {
    if (!this.transport.updateModelContext || this.modelContextTimer) return;
    this.modelContextTimer = setTimeout(() => {
      this.modelContextTimer = null;
      const context = buildEditorUiModelContext(this.snapshot);
      const digest = JSON.stringify(context);
      if (digest === this.modelContextDigest) return;
      this.modelContextDigest = digest;
      void this.transport.updateModelContext?.(context).catch(() => {
        // Model context is a bounded enhancement and must never interrupt editing.
      });
    }, MODEL_CONTEXT_DEBOUNCE_MS);
  }
}
