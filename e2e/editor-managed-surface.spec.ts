import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_EDITOR_UI_SUBTITLE_STYLE,
  createEmptyEditorUiSnapshot,
  type EditorUiSnapshot,
} from '../src/lib/editor-ui/contracts';

const createManagedFixture = (): EditorUiSnapshot => {
  const snapshot = createEmptyEditorUiSnapshot({
    sessionId: 'managed-session',
    projectId: 'managed-project',
    sessionEpoch: 'managed-epoch',
    eventCursor: 'cursor-1',
  });
  snapshot.connection = 'connected';
  snapshot.capabilities = {
    canEdit: true,
    canImportMedia: true,
    canTranscribe: true,
    canExport: true,
    canPresentFullscreen: true,
    canPresentPictureInPicture: true,
    canSubscribeToEvents: true,
  };
  snapshot.project = {
    id: 'managed-project',
    name: 'Managed fixture',
    durationSeconds: 16,
    fps: 30,
    renderProfile: {
      fps: { numerator: 30, denominator: 1 },
      width: 1920,
      height: 1080,
      audioSampleRate: 48_000,
      isFrameRateLocked: false,
      isCanvasSizeLocked: false,
    },
    backgroundColor: '#000000',
    mediaSources: [{
      id: 'source-1',
      kind: 'video',
      label: 'Opening.mov',
      durationSeconds: 30,
    }, {
      id: 'source-music',
      kind: 'audio',
      label: 'Score.wav',
      durationSeconds: 16,
      nativeSampleRateHz: 48_000,
    }],
    artifacts: [],
    links: [],
    tracks: [{
      id: 'video-1',
      kind: 'video',
      name: 'Video 1',
      locked: false,
      visible: true,
      subtitleStyle: DEFAULT_EDITOR_UI_SUBTITLE_STYLE,
      unlinkedVideoPolicy: 'preserve-absolute',
      height: 96,
      clips: [{
        id: 'clip-1',
        trackId: 'video-1',
        sourceId: 'source-1',
        kind: 'video',
        label: 'Opening shot',
        startSeconds: 0,
        durationSeconds: 8,
        sourceOffsetSeconds: 0,
        sourceDurationSeconds: 30,
        hasLinkedAudio: true,
        linkedTargetIds: ['block-1'],
      }],
    }, {
      id: 'audio-1',
      kind: 'audio',
      name: 'Music',
      locked: false,
      muted: false,
      solo: false,
      height: 84,
      clips: [{
        id: 'music-1',
        trackId: 'audio-1',
        sourceId: 'source-music',
        kind: 'audio',
        label: 'Score',
        startSeconds: 0,
        durationSeconds: 16,
        sourceOffsetSeconds: 0,
        linkedTargetIds: ['block-1'],
        gainDb: -3,
      }],
    }, {
      id: 'subtitles-1',
      kind: 'subtitle',
      name: 'Speaker',
      locked: false,
      visible: true,
      height: 72,
      clips: [{
        id: 'subtitle-1',
        trackId: 'subtitles-1',
        kind: 'subtitle',
        label: 'Welcome',
        text: 'Welcome',
        startSeconds: 1,
        durationSeconds: 2,
        sourceOffsetSeconds: 0,
        linkedTargetIds: ['block-1'],
      }],
    }],
    narrativeBlocks: [{
      id: 'block-1',
      clipId: 'clip-1',
      kind: 'speech',
      text: 'Welcome to the managed editor.',
      sourceStartSample16k: 0,
      sourceEndSample16k: 128_000,
      startSeconds: 0,
      durationSeconds: 8,
      linkedTargetIds: ['subtitle-1', 'music-1'],
      words: [{
        id: 'word-1',
        text: 'Welcome',
        speakerId: 'speaker-1',
        startSample16k: 0,
        endSample16k: 8_000,
      }],
    }, {
      id: 'silence-1',
      clipId: 'clip-1',
      kind: 'silence',
      text: 'Silence',
      sourceStartSample16k: 128_000,
      sourceEndSample16k: 144_000,
      startSeconds: 8,
      durationSeconds: 1,
      linkedTargetIds: [],
    }],
    history: [{
      id: 'history-1',
      label: 'Import media',
      timestamp: Date.now(),
      isCurrent: true,
      isRedo: false,
    }],
    canUndo: true,
    canRedo: false,
    editingMode: 'ripple',
    narrativeSettings: {
      globalPreMarginSamples16k: 3_200,
      globalPostMarginSamples16k: 3_200,
      showSpeakers: true,
    },
  };
  snapshot.view.playheadSeconds = 4;
  snapshot.playback.presenterViewId = 'managed-view';
  snapshot.presence = [{
    viewId: 'managed-view',
    label: 'Codex',
    color: '#38bdf8',
    selectedIds: [],
    playheadSeconds: 4,
    isPresenter: true,
    isFollowing: false,
  }];
  return snapshot;
};

const installManagedBridge = async (
  page: Page,
  fixture: EditorUiSnapshot,
): Promise<void> => {
  await page.addInitScript(({ initial }) => {
    const snapshot = initial;
    let cursor = 1;
    let activeViewId = '';
    const commands: Array<{ type: string; [key: string]: unknown }> = [];
    const listeners = new Map<string, Set<(params: unknown) => void>>();
    const clone = <Value,>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
    const advance = (action: string) => {
      cursor += 1;
      snapshot.stateToken.sessionRevision += 1;
      snapshot.stateToken.documentRevision += 1;
      snapshot.stateToken.eventCursor = `cursor-${cursor}`;
      snapshot.recentSemanticAction = action;
    };
    const applyCommand = (command: {
      type: string;
      [key: string]: unknown;
    }) => {
      commands.push(clone(command));
      if (command.type === 'edit.batch' && Array.isArray(command.commands)) {
        for (const child of command.commands) {
          applyCommand(child as { type: string; [key: string]: unknown });
        }
        return;
      }
      if (command.type === 'track.add') {
        const kind = String(command.kind);
        const index = snapshot.project.tracks.filter((track) => track.kind === kind).length + 1;
        snapshot.project.tracks.push({
          id: `${kind}-${index}`,
          kind: kind as 'video' | 'audio' | 'subtitle',
          name: `${kind[0]?.toUpperCase()}${kind.slice(1)} ${index}`,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          height: kind === 'video' ? 96 : kind === 'audio' ? 84 : 72,
          clips: [],
        });
      }
      if (command.type === 'video-clip.split') {
        for (const track of snapshot.project.tracks) {
          const clip = track.clips.find((candidate) => candidate.id === command.clipId);
          if (!clip) continue;
          const splitSeconds = Number(command.timelineFrame) / snapshot.project.fps;
          const firstDuration = splitSeconds - clip.startSeconds;
          track.clips.push({
            ...clip,
            id: `${clip.id}-right`,
            startSeconds: splitSeconds,
            sourceOffsetSeconds: clip.sourceOffsetSeconds + firstDuration,
            durationSeconds: clip.durationSeconds - firstDuration,
          });
          clip.durationSeconds = firstDuration;
        }
      }
      if (command.type === 'narrative.delete-all-silences') {
        snapshot.project.narrativeBlocks = snapshot.project.narrativeBlocks
          .filter((block) => block.kind !== 'silence');
      }
      if (command.type === 'export.start') {
        snapshot.jobs.push({
          id: 'export-job',
          kind: 'export',
          label: 'Export video',
          state: 'running',
          progress: 0.25,
        });
      }
      if (command.type === 'history.undo') {
        snapshot.project.canUndo = false;
        snapshot.project.canRedo = true;
      }
      advance(command.type);
    };
    window.__WAPTIONS_MANAGED_EDITOR_BRIDGE__ = {
      async request<Result>(method: string, params?: unknown): Promise<Result> {
        const input = params as {
          mode?: 'inline' | 'fullscreen' | 'picture-in-picture';
          viewId?: string;
          request?: { commandId: string; command: { type: string; [key: string]: unknown } };
        };
        if (method === 'waptions/editor/pair') {
          return { viewToken: 'scoped-view-token' } as Result;
        }
        if (method === 'waptions/editor/snapshot') return clone(snapshot) as Result;
        if (method === 'waptions/editor/subscribe') {
          activeViewId = input.viewId ?? '';
          return { subscribed: true } as Result;
        }
        if (method === 'waptions/editor/presentation') return input.mode as Result;
        if (method === 'waptions/editor/context') return { accepted: true } as Result;
        if (method === 'waptions/editor/command' && input.request) {
          applyCommand(input.request.command);
          return {
            ok: true,
            commandId: input.request.commandId,
            stateToken: clone(snapshot.stateToken),
            snapshot: clone(snapshot),
          } as Result;
        }
        throw new Error(`Unexpected managed editor method: ${method}`);
      },
      notify() {},
      subscribe(method, listener) {
        const current = listeners.get(method) ?? new Set();
        current.add(listener);
        listeners.set(method, current);
        return () => current.delete(listener);
      },
      handleRequest() {
        return () => {};
      },
      close() {},
    };
    (window as typeof window & { emitExternalEdit(name: string): void }).emitExternalEdit = (name: string) => {
      const previousCursor = snapshot.stateToken.eventCursor;
      snapshot.project.name = name;
      advance('external.rename');
      const params = {
        viewId: activeViewId,
        event: {
          eventId: `external-${cursor}`,
          previousCursor,
          cursor: snapshot.stateToken.eventCursor,
          stateToken: clone(snapshot.stateToken),
          kind: 'project' as const,
          snapshot: clone(snapshot),
        },
      };
      listeners.get('waptions/editor/event')?.forEach((listener) => listener(params));
    };
    (window as typeof window & { getManagedCommands(): typeof commands }).getManagedCommands = () => (
      clone(commands)
    );
  }, { initial: fixture });
};

test.describe('managed editor surface', () => {
  test('keeps complete inline editing live across host mutations and presentation changes', async ({ page }) => {
    test.setTimeout(60_000);
    const editorOrigin = `http://localhost:${process.env.WAPTIONS_E2E_PORT}`;
    await installManagedBridge(page, createManagedFixture());
    await page.goto(`${editorOrigin}/managed/managed-session?capability=one-time-capability`);
    await expect(page).toHaveURL(`${editorOrigin}/managed/managed-session`);
    const editor = page;
    const surface = editor.locator('[data-editor-surface]').first();
    await expect(surface).toHaveAttribute('data-editor-connection', 'connected');
    await expect(editor.getByTestId('managed-editor-timeline')).toBeVisible();
    await expect(editor.getByLabel('video clip Opening shot')).toBeVisible();
    await expect(editor.getByLabel('audio clip Score')).toBeVisible();
    await expect(editor.getByLabel('subtitle clip Welcome')).toBeVisible();

    await editor.getByRole('button', { name: 'Add video track' }).click();
    await expect(editor.getByLabel('Lock Video 2')).toBeVisible();

    await editor.getByLabel('video clip Opening shot').click();
    await editor.getByRole('button', { name: 'Split selected clips at playhead' }).click();
    await expect(editor.getByLabel('video clip Opening shot')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { getManagedCommands(): Array<{ type: string }> })
        .getManagedCommands()
        .some((command) => command.type === 'edit.batch')
    ))).toBe(true);

    await editor.locator('button[title="Hide inspector"]').click();
    await editor.getByRole('tab', { name: 'Text' }).click();
    await expect(editor.getByText('Welcome to the managed editor.')).toBeVisible();
    await editor.getByRole('button', { name: 'Remove all silences' }).click();
    await expect(editor.getByText('Silence', { exact: true })).toHaveCount(0);

    const exportPromptValues = ['destination-grant', '/tmp/managed-export.mp4'];
    editor.on('dialog', async (dialog) => {
      await dialog.accept(exportPromptValues.shift() ?? '');
    });
    await editor.getByRole('button', { name: 'Export project' }).click();
    await editor.getByRole('button', { name: 'History' }).click();
    const inspector = editor.getByTestId('managed-editor-inspector');
    await inspector.getByRole('button', { name: 'Undo' }).click();
    await expect(inspector.getByRole('button', { name: 'Redo' })).toBeEnabled();
    await inspector.getByRole('button', { name: 'Hide inspector' }).click();

    await editor.getByRole('tab', { name: 'Timeline' }).click();
    await editor.getByLabel('Timeline zoom').fill('2');
    const surfaceHandle = await surface.elementHandle();
    await page.evaluate(() => {
      (window as typeof window & { emitExternalEdit(name: string): void })
        .emitExternalEdit('Edited by Codex tool');
    });
    await expect(editor.getByLabel('Project name')).toHaveValue('Edited by Codex tool');
    await expect(editor.getByLabel('Timeline zoom')).toHaveValue('2');
    expect(await surfaceHandle?.evaluate((node) => node.isConnected)).toBe(true);

    await editor.getByRole('button', { name: 'Open fullscreen editor' }).click();
    await expect(surface).toHaveAttribute('data-editor-presentation', 'fullscreen');
    expect(await surfaceHandle?.evaluate((node) => node.isConnected)).toBe(true);
    await expect(editor.getByTestId('managed-editor-timeline')).toBeVisible();
    await expect(editor.getByTestId('managed-editor-text')).toBeVisible();
  });
});
