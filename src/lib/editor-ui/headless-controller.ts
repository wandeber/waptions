import {
  DEFAULT_EDITOR_UI_CAPABILITIES,
  type EditorUiCommand,
  type EditorUiCommandResult,
  type EditorUiController,
  type EditorUiPresentationMode,
  type EditorUiSnapshot,
  type EditorUiViewState,
} from './contracts';

/**
 * Read-only adapter for deterministic render/progress consumers.
 *
 * It intentionally refuses structural commands: headless mutations belong to semantic tools,
 * while this host supplies a stable render snapshot and job progress without browser state.
 */
export class HeadlessEditorUiController implements EditorUiController {
  readonly viewId: string;
  private snapshot: EditorUiSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(viewId: string, snapshot: EditorUiSnapshot) {
    this.viewId = viewId;
    this.snapshot = {
      ...snapshot,
      connection: 'connected',
      capabilities: {
        ...DEFAULT_EDITOR_UI_CAPABILITIES,
        canExport: false,
      },
      view: { ...snapshot.view, presentation: 'picture-in-picture' },
    };
  }

  getSnapshot = (): EditorUiSnapshot => this.snapshot;
  getServerSnapshot = (): EditorUiSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async connect(): Promise<void> {}
  async reconnect(): Promise<void> {}
  async dispatch(command: EditorUiCommand): Promise<EditorUiCommandResult> {
    return {
      ok: false,
      commandId: `headless-${command.type}`,
      code: 'forbidden',
      message: 'The headless render host is read-only.',
    };
  }
  updateView(patch: Partial<EditorUiViewState>): void {
    this.snapshot = { ...this.snapshot, view: { ...this.snapshot.view, ...patch } };
    this.listeners.forEach((listener) => listener());
  }
  async requestPresentation(
    mode: EditorUiPresentationMode,
  ): Promise<EditorUiPresentationMode> {
    const accepted = mode === 'picture-in-picture' ? mode : 'picture-in-picture';
    this.updateView({ presentation: accepted });
    return accepted;
  }
  clearConflict(): void {}
  publish(snapshot: EditorUiSnapshot): void {
    this.snapshot = {
      ...snapshot,
      connection: 'connected',
      capabilities: {
        ...DEFAULT_EDITOR_UI_CAPABILITIES,
        canExport: false,
      },
      view: { ...snapshot.view, presentation: 'picture-in-picture' },
    };
    this.listeners.forEach((listener) => listener());
  }
  close(): void {
    this.listeners.clear();
  }
}
