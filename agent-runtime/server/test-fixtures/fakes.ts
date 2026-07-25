import type {
  CoordinatorResult,
  DurableReceiptScopeResolution,
  MutationToolCall,
  ReadToolCall,
  ScopedMutationToolCall,
  StateToken,
} from "../../mcp/contracts.js";
import { loadCommittedCoreSemanticSchemaBundle } from "../../mcp/core-schema-loader.js";
import type {
  CoordinatorEventSubscription,
  ManagedCoordinatorAdapter,
} from "../coordinator-adapter.js";

export const TEST_SEMANTIC_SCHEMAS =
  loadCommittedCoreSemanticSchemaBundle();

export const TEST_STATE: StateToken = {
  sessionId: "session-1",
  projectId: "project-1",
  sessionEpoch: "epoch-1",
  sessionRevision: 7,
  documentRevision: 4,
  audioGraphRevision: 3,
  narrativeRevision: 2,
  eventCursor: "event-9",
};

export const TEST_PROJECT_DATA = {
  projectId: "project-1",
  name: "Test project",
  renderProfile: {
    fps: { numerator: 30, denominator: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48_000,
    isFrameRateLocked: true,
    isCanvasSizeLocked: true,
  },
  renderBackgroundColor: "#000000",
  counts: {
    tracks: 0,
    clips: 0,
    subtitles: 0,
    sources: 0,
    links: 0,
  },
  activeJobIds: [],
  references: [],
  page: { hasMore: false },
};

export class FakeCoordinatorAdapter implements ManagedCoordinatorAdapter {
  readonly calls: string[] = [];
  readResult: CoordinatorResult = {
    ok: true,
    data: TEST_PROJECT_DATA,
    state: TEST_STATE,
    warnings: [],
  };
  mutationResult: CoordinatorResult = {
    ok: true,
    data: {
      commandId: "command-1",
      noOp: false,
      historyEntryId: "history-1",
      eventId: "event-10",
      aliases: {},
    },
    state: TEST_STATE,
    warnings: [],
    replayed: false,
  };
  receiptResolution?: DurableReceiptScopeResolution;
  eventCallback?: () => void;

  async executeRead(
    call: ReadToolCall,
  ): Promise<CoordinatorResult> {
    this.calls.push(`read:${call.toolName}`);
    return this.readResult;
  }

  async resolveReceiptScope(
    call: MutationToolCall,
  ): Promise<DurableReceiptScopeResolution> {
    this.calls.push(`scope:${call.toolName}`);
    if (this.receiptResolution) {
      return this.receiptResolution;
    }
    return {
      ok: true,
      scope: {
        projectId: TEST_STATE.projectId,
        toolName: call.toolName,
        idempotencyKey: call.identity.idempotencyKey,
      },
    };
  }

  async executeMutation(
    call: ScopedMutationToolCall,
  ): Promise<CoordinatorResult> {
    this.calls.push(
      `mutation:${call.receiptScope.projectId}:${call.toolName}:${call.receiptScope.idempotencyKey}`,
    );
    return this.mutationResult;
  }

  async executeSessionOpen(
    call: MutationToolCall,
  ): Promise<CoordinatorResult> {
    this.calls.push(`bootstrap:${call.toolName}`);
    return this.mutationResult;
  }

  async subscribeToEvents(
    _sessionId: string,
    onEventAvailable: () => void,
  ): Promise<CoordinatorEventSubscription> {
    this.eventCallback = onEventAvailable;
    return {
      close: async () => {
        this.eventCallback = undefined;
      },
    };
  }
}
