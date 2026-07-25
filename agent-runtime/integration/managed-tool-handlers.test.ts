import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManagedCoordinator,
  type ManagedCoordinatorOptions,
} from "../coordinator/managed-coordinator.js";
import type {
  CanonicalToolCall,
  CoordinatorResult,
} from "../mcp/contracts.js";
import {
  loadCommittedCoreSemanticSchemaBundle,
} from "../mcp/core-schema-loader.js";
import type { WaptionsToolName } from "../mcp/constants.js";
import { TOOL_NAMES } from "../mcp/constants.js";
import { ToolSchemaValidator } from "../mcp/schema-validator.js";
import type { CoordinatorCallContext } from "../server/coordinator-adapter.js";
import {
  CoreEditorPortFactory,
  type ManagedCoreCommand,
  type ManagedCoreEditorState,
  type ManagedCoreResult,
} from "./core-editor-port.js";
import {
  createManagedToolHandlers,
  type ManagedDelegatedToolPort,
  type ManagedEditorRenderAuthority,
  type ManagedToolHandlerDependencies,
} from "./managed-tool-handlers.js";

const schemas = loadCommittedCoreSemanticSchemaBundle();
const validator = new ToolSchemaValidator();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("managed canonical tool handlers", () => {
  it("composes exactly the canonical tools and forwards delegated calls unchanged", async () => {
    const runtime = await managedRuntime();
    const expected: CoordinatorResult = {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Expected delegated result.",
        retryable: false,
      },
    };
    const delegated = delegatedPort(expected);
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated,
      editorRender: editorRenderPort(expected),
    });

    expect(Object.keys(handlers)).toEqual([...TOOL_NAMES]);
    const call = canonicalCall("waptions_project_import", {
      apiVersion: "2026-07-25",
      sessionId: "session-1",
    }, "a");

    await expect(
      handlers.waptions_project_import(call, context()),
    ).resolves.toBe(expected);
    expect(delegated.waptions_project_import).toHaveBeenCalledWith(
      call,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("creates and replays a session from the exact dispatcher request hash", async () => {
    const runtime = await managedRuntime();
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const call = canonicalCall("waptions_session_open", {
      apiVersion: "2026-07-25",
      action: "create",
      projectId: "project-bootstrap",
      idempotencyKey: "open-1",
      name: "Managed project",
    }, "b");

    const first = await handlers.waptions_session_open(call, context());
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      data: {
        action: "create",
        created: true,
        recovered: false,
      },
    });
    expectCanonicalOutput("waptions_session_open", first);

    const receipt = await runtime.coordinator.store.readReceipt(
      "project-bootstrap",
      "waptions_session_open",
      "open-1",
    );
    expect(receipt?.canonicalRequestHash).toBe(call.requestHash);

    const replay = await handlers.waptions_session_open(call, context());
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expectCanonicalOutput("waptions_session_open", replay);
  });

  it("persists view updates through mutateRegistry writes and reads them back", async () => {
    const runtime = await managedRuntime();
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-view",
        idempotencyKey: "open-view",
        name: "View project",
      }, "c"),
      context(),
    );
    const state = successState(opened);
    const update = canonicalCall("waptions_view_update", {
      apiVersion: "2026-07-25",
      sessionId: state.sessionId,
      sessionEpoch: state.sessionEpoch,
      expected: expected(state),
      idempotencyKey: "view-1",
      viewId: "view-1",
      expectedViewRevision: 0,
      patch: {
        selection: { kind: "clips", ids: ["clip-1"] },
        playheadFrame: 24,
        zoom: 2,
        scrollLeft: 12,
        presentation: "fullscreen",
      },
    }, "d");

    const updated = await handlers.waptions_view_update(update, context());
    expect(updated).toMatchObject({
      ok: true,
      data: {
        view: {
          viewId: "view-1",
          viewRevision: 1,
          playheadFrame: 24,
          presentation: "fullscreen",
        },
      },
    });
    expectCanonicalOutput("waptions_view_update", updated);
    expect(successState(updated).sessionRevision).toBe(state.sessionRevision);

    const durable = await runtime.coordinator.store.readNamespace<{
      viewId: string;
      viewRevision: number;
    }>("project-view", "views");
    expect(durable).toEqual([
      expect.objectContaining({
        viewId: "view-1",
        viewRevision: 1,
      }),
    ]);

    const read = await handlers.waptions_view_get(
      canonicalCall("waptions_view_get", {
        apiVersion: "2026-07-25",
        sessionId: state.sessionId,
        viewId: "view-1",
      }, "e"),
      context(),
    );
    expect(read).toMatchObject({
      ok: true,
      data: updated.ok ? updated.data : {},
    });
    expectCanonicalOutput("waptions_view_get", read);
  });

  it("preserves the public hash in the durable Core edit receipt", async () => {
    const runtime = await managedRuntime();
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-edit",
        idempotencyKey: "open-edit",
        name: "Edit project",
      }, "f"),
      context(),
    );
    const state = successState(opened);
    const call = canonicalCall("waptions_edit_apply", {
      apiVersion: "2026-07-25",
      sessionId: state.sessionId,
      sessionEpoch: state.sessionEpoch,
      expected: expected(state),
      idempotencyKey: "edit-1",
      operations: [{
        operationId: "operation-1",
        type: "project.set-name",
        payload: { name: "Renamed project" },
      }],
    }, "1");

    const result = await handlers.waptions_edit_apply(call, context());
    expect(result).toMatchObject({
      ok: true,
      data: {
        commandId: expect.any(String),
        noOp: false,
      },
    });
    expectCanonicalOutput("waptions_edit_apply", result);

    const receipt = await runtime.coordinator.store.readReceipt(
      "project-edit",
      "waptions_edit_apply",
      "edit-1",
    );
    expect(receipt?.canonicalRequestHash).toBe(call.requestHash);
  });

  it("returns schema-valid canonical envelopes for the direct read handlers", async () => {
    const runtime = await managedRuntime();
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-reads",
        idempotencyKey: "open-reads",
        name: "Read project",
      }, "2"),
      context(),
    );
    const state = successState(opened);
    const base = {
      apiVersion: "2026-07-25",
      sessionId: state.sessionId,
    };
    const calls: Array<[WaptionsToolName, CanonicalToolCall]> = [
      [
        "waptions_session_list",
        canonicalCall("waptions_session_list", {
          apiVersion: "2026-07-25",
        }, "3"),
      ],
      [
        "waptions_project_get",
        canonicalCall("waptions_project_get", base, "4"),
      ],
      [
        "waptions_project_validate",
        canonicalCall("waptions_project_validate", base, "5"),
      ],
      [
        "waptions_timeline_query",
        canonicalCall("waptions_timeline_query", {
          ...base,
          entityKind: "tracks",
        }, "6"),
      ],
      [
        "waptions_edit_plan",
        canonicalCall("waptions_edit_plan", {
          ...base,
          sessionEpoch: state.sessionEpoch,
          expected: expected(state),
          operations: [{
            operationId: "operation-plan",
            type: "project.set-name",
            payload: { name: "Planned name" },
          }],
        }, "7"),
      ],
      [
        "waptions_history_get",
        canonicalCall("waptions_history_get", base, "8"),
      ],
      [
        "waptions_job_list",
        canonicalCall("waptions_job_list", base, "9"),
      ],
      [
        "waptions_artifact_list",
        canonicalCall("waptions_artifact_list", base, "a"),
      ],
      [
        "waptions_events_read",
        canonicalCall("waptions_events_read", base, "b"),
      ],
    ];

    for (const [toolName, call] of calls) {
      const result = await handlers[toolName](call, context());
      expect(result.ok, toolName).toBe(true);
      expectCanonicalOutput(toolName, result);
    }

    const diagnostics = await handlers.waptions_diagnostics_get(
      canonicalCall("waptions_diagnostics_get", base, "c"),
      context(),
    );
    expect(diagnostics).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        retryable: false,
      },
    });
    expectCanonicalOutput("waptions_diagnostics_get", diagnostics);
  });

  it("rejects validation scopes it cannot check synchronously", async () => {
    const runtime = await managedRuntime();
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-validation",
        idempotencyKey: "open-validation",
        name: "Validation project",
      }, "d"),
      context(),
    );
    const state = successState(opened);

    const unsupportedRequests: Array<
      [CanonicalToolCall["request"], string]
    > = [
      [{ scopes: ["hydrated"] }, "e"],
      [{ deep: true }, "f"],
    ];
    for (const [request, digest] of unsupportedRequests) {
      const result = await handlers.waptions_project_validate(
        canonicalCall("waptions_project_validate", {
          apiVersion: "2026-07-25",
          sessionId: state.sessionId,
          ...request,
        }, digest),
        context(),
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          retryable: false,
        },
      });
      expectCanonicalOutput("waptions_project_validate", result);
    }
  });

  it("does not restore tombstones or persist a fake detach", async () => {
    const runtime = await managedRuntime();
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-lifecycle",
        idempotencyKey: "open-lifecycle",
        name: "Lifecycle project",
      }, "1"),
      context(),
    );
    const openedState = successState(opened);
    const deleted = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(openedState, "delete-lifecycle"),
        action: {
          kind: "delete",
          confirmProjectId: "project-lifecycle",
        },
      }, "2"),
      context(),
    );
    const deletedState = successState(deleted);
    expect(deletedState.sessionRevision).toBe(openedState.sessionRevision);

    const restored = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(deletedState, "restore-tombstone"),
        action: { kind: "restore" },
      }, "3"),
      context(),
    );
    expect(restored).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(runtime.coordinator.getProject("project-lifecycle").envelope.deletedAt)
      .toEqual(expect.any(String));
    expectCanonicalOutput("waptions_session_manage", restored);

    const beforeDetach = runtime.coordinator.getProject("project-lifecycle");
    const detached = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(deletedState, "detach-local"),
        action: { kind: "detach" },
      }, "4"),
      context(),
    );
    expect(detached).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expectCanonicalOutput("waptions_session_manage", detached);
    expect(
      await runtime.coordinator.store.readReceipt(
        "project-lifecycle",
        "waptions_session_manage",
        "detach-local",
      ),
    ).toBeNull();
    expect(runtime.coordinator.getProject("project-lifecycle").state.eventCursor)
      .toBe(beforeDetach.state.eventCursor);
  });

  it("projects exact half-open timeline bounds and enforces output caps", async () => {
    const runtime = await managedRuntime();
    const realHandlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await realHandlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-timeline",
        idempotencyKey: "open-timeline",
        name: "Timeline project",
      }, "5"),
      context(),
    );
    const state = successState(opened);
    const project = runtime.coordinator.getProject("project-timeline");
    const manifest = project.envelope.editor.state.snapshot.manifest;
    manifest.renderProfile = {
      ...manifest.renderProfile,
      fps: { numerator: 30, denominator: 1 },
    };
    manifest.videoSourceDescriptors = [{
      id: "video-source",
      originalName: "video-source",
      mimeType: "video/mp4",
      size: 1,
      lastModified: 0,
      fingerprint: "video-fingerprint",
      duration: 1,
      fps: 30,
      width: 1,
      height: 1,
      bitrate: null,
      hasAudio: true,
    }];
    manifest.videoTracks = [{
      id: "video-track",
      name: "v".repeat(600),
      visible: true,
      locked: false,
    }];
    manifest.videoClips = [{
      id: "video-clip",
      sourceId: "video-source",
      trackId: "video-track",
      timelineStartFrame: 0,
      sourceStart: 0,
      sourceEnd: 0.1,
      audio: null,
    }];
    manifest.audioSourceDescriptors = [{
      id: "audio-source",
      originalName: "audio-source",
      mimeType: "audio/wav",
      size: 1,
      lastModified: 0,
      fingerprint: "audio-fingerprint",
      duration: 1,
      nativeSampleRate: 48_000,
      nativeSampleCount: 48_000,
      nativeChannelCount: 1,
      bitrate: null,
      codec: null,
    }];
    manifest.audioTracks = [{
      id: "audio-track",
      name: "audio-track",
      muted: false,
      solo: false,
      locked: false,
      gainDb: 0,
      clips: [{
        id: "imported-audio",
        timelineStartFrame: 10,
        muted: false,
        gainDb: 0,
        source: {
          kind: "audio-source",
          audioSourceId: "audio-source",
        },
        sourceStartSample: 0,
        sourceEndSample: 24_001,
        timelineDurationSamples: 24_001,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      }, {
        id: "detached-audio",
        timelineStartFrame: 20,
        muted: false,
        gainDb: 0,
        source: {
          kind: "video-source-audio",
          videoSourceId: "video-source",
        },
        sourceStart: 0,
        sourceEnd: 0.25,
        fadeInFrames: 0,
        fadeOutFrames: 0,
      }],
    }];
    manifest.subtitleTracks = [{
      id: "subtitle-track",
      name: "subtitle-track",
      style: {},
      subtitles: [{
        id: "subtitle",
        startTime: 0.1,
        endTime: 1.01,
        text: "s".repeat(600),
      }],
      isVisible: true,
      isLocked: false,
      unlinkedVideoEditResponse: "stay-absolute",
    } as never];
    const activeJobs = Array.from({ length: 300 }, (_, index) => ({
      jobId: `job-${index}`,
      state: "running",
      kind: "test",
      stage: "j".repeat(600),
    }));
    const fakeCoordinator = {
      resolveProjectId: () => "project-timeline",
      getProject: () => project,
      jobs: { list: () => activeJobs },
    } as unknown as ManagedToolHandlerDependencies["coordinator"];
    const handlers = createManagedToolHandlers({
      coordinator: fakeCoordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const base = {
      apiVersion: "2026-07-25",
      sessionId: state.sessionId,
    };

    const clips = await handlers.waptions_timeline_query(
      canonicalCall("waptions_timeline_query", {
        ...base,
        entityKind: "clips",
      }, "6"),
      context(),
    );
    expect(clips).toMatchObject({
      ok: true,
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "imported-audio",
            startFrame: 10,
            endFrame: 26,
          }),
          expect.objectContaining({
            id: "detached-audio",
            startFrame: 20,
            endFrame: 28,
          }),
        ]),
      },
    });
    expectCanonicalOutput("waptions_timeline_query", clips);

    const subtitles = await handlers.waptions_timeline_query(
      canonicalCall("waptions_timeline_query", {
        ...base,
        entityKind: "subtitles",
      }, "7"),
      context(),
    );
    expect(subtitles).toMatchObject({
      ok: true,
      data: {
        items: [{
          id: "subtitle",
          kind: "subtitle",
          trackId: "subtitle-track",
          startFrame: 3,
          endFrame: 31,
          label: "s".repeat(512),
        }],
      },
    });
    expectCanonicalOutput("waptions_timeline_query", subtitles);

    const bounded = await handlers.waptions_timeline_query(
      canonicalCall("waptions_timeline_query", {
        ...base,
        entityKind: "clips",
        startFrame: 26,
        endFrame: 27,
      }, "8"),
      context(),
    );
    expect(bounded).toMatchObject({
      ok: true,
      data: {
        items: [expect.objectContaining({ id: "detached-audio" })],
      },
    });
    expectCanonicalOutput("waptions_timeline_query", bounded);

    const boundary = await handlers.waptions_timeline_query(
      canonicalCall("waptions_timeline_query", {
        ...base,
        entityKind: "content-boundary",
      }, "9"),
      context(),
    );
    expect(boundary).toMatchObject({
      ok: true,
      data: {
        items: [{
          id: "content-boundary",
          kind: "content-boundary",
          startFrame: 0,
          endFrame: 31,
        }],
      },
    });
    expectCanonicalOutput("waptions_timeline_query", boundary);

    const invalidBounds = await handlers.waptions_timeline_query(
      canonicalCall("waptions_timeline_query", {
        ...base,
        entityKind: "clips",
        startFrame: 5,
        endFrame: 5,
      }, "a"),
      context(),
    );
    expect(invalidBounds).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expectCanonicalOutput("waptions_timeline_query", invalidBounds);

    const projectResult = await handlers.waptions_project_get(
      canonicalCall("waptions_project_get", {
        ...base,
        section: "tracks",
      }, "b"),
      context(),
    );
    if (!projectResult.ok) throw new Error("Expected project_get to succeed.");
    expect(projectResult.data.activeJobIds).toHaveLength(256);
    expect(
      (projectResult.data.references as Array<{ label: string }>)[0].label,
    ).toHaveLength(512);
    expectCanonicalOutput("waptions_project_get", projectResult);
  });

  it("does not publish a prepared grant in memory when the WAL commit fails", async () => {
    let injectFault = false;
    const runtime = await managedRuntime({
      persistenceFaultInjector: {
        hit: (point) => {
          if (injectFault && point === "transaction:wal-durable") {
            injectFault = false;
            throw new Error("Injected grant WAL failure.");
          }
        },
      },
    });
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-grant-fault",
        idempotencyKey: "open-grant-fault",
        name: "Grant fault project",
      }, "d"),
      context(),
    );
    const state = successState(opened);
    const root = join(runtime.path, "read-root");
    await mkdir(root);
    let preparedGrantId = "";
    const prepare = runtime.coordinator.pathGrants.prepareCreate.bind(
      runtime.coordinator.pathGrants,
    );
    vi.spyOn(runtime.coordinator.pathGrants, "prepareCreate")
      .mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        preparedGrantId = prepared.record.grantId;
        return prepared;
      });
    injectFault = true;

    const result = await handlers.waptions_path_grant(
      canonicalCall("waptions_path_grant", {
        ...mutationBase(state, "grant-fault"),
        action: {
          kind: "add",
          grantKind: "read-root",
          path: root,
          allowCreate: false,
          confirmAuthorityExpansion: true,
        },
      }, "e"),
      context(),
    );

    expect(result.ok).toBe(false);
    expect(preparedGrantId).not.toBe("");
    expect(
      runtime.coordinator.pathGrants.hasRegisteredGrant(preparedGrantId),
    ).toBe(false);
  });

  it("keeps an active grant usable when its revoke WAL commit fails", async () => {
    let injectFault = false;
    const runtime = await managedRuntime({
      persistenceFaultInjector: {
        hit: (point) => {
          if (injectFault && point === "transaction:wal-durable") {
            injectFault = false;
            throw new Error("Injected revoke WAL failure.");
          }
        },
      },
    });
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-revoke-fault",
        idempotencyKey: "open-revoke-fault",
        name: "Revoke fault project",
      }, "f"),
      context(),
    );
    const initialState = successState(opened);
    const root = join(runtime.path, "revoke-root");
    const source = join(root, "source.bin");
    await mkdir(root);
    await writeFile(source, "retained source");
    const granted = await handlers.waptions_path_grant(
      canonicalCall("waptions_path_grant", {
        ...mutationBase(initialState, "grant-before-revoke"),
        action: {
          kind: "add",
          grantKind: "read-root",
          path: root,
          allowCreate: false,
          confirmAuthorityExpansion: true,
        },
      }, "1"),
      context(),
    );
    if (!granted.ok) throw new Error("Expected the grant to succeed.");
    expect(granted.state?.sessionRevision).toBe(initialState.sessionRevision);
    const grantId = (granted.data.grants as Array<{ grantId: string }>)[0]
      .grantId;
    injectFault = true;

    const revoked = await handlers.waptions_path_grant(
      canonicalCall("waptions_path_grant", {
        ...mutationBase(granted.state!, "revoke-fault"),
        action: {
          kind: "revoke",
          grantId,
          confirmGrantId: grantId,
        },
      }, "2"),
      context(),
    );

    expect(revoked.ok).toBe(false);
    const handle = await runtime.coordinator.pathGrants.openRead(
      grantId,
      {
        sessionId: initialState.sessionId,
        sessionEpoch: initialState.sessionEpoch,
      },
      source,
    );
    await handle.close();
  });
});

async function managedRuntime(
  options: ManagedCoordinatorOptions = {},
): Promise<{
  path: string;
  coordinator: ManagedCoordinator<
    ManagedCoreEditorState,
    ManagedCoreCommand,
    ManagedCoreResult
  >;
}> {
  const path = await mkdtemp(join(tmpdir(), "waptions-handlers-"));
  const coordinator = await ManagedCoordinator.start(
    path,
    new CoreEditorPortFactory(),
    options,
  );
  cleanups.push(async () => {
    await coordinator.close();
    await rm(path, { recursive: true, force: true });
  });
  return { path, coordinator };
}

function delegatedPort(
  result: CoordinatorResult,
): ManagedDelegatedToolPort {
  const handler = () => Promise.resolve(result);
  return {
    waptions_project_import: vi.fn(handler),
    waptions_media_probe: vi.fn(handler),
    waptions_media_import: vi.fn(handler),
    waptions_media_review: vi.fn(handler),
    waptions_media_release: vi.fn(handler),
    waptions_transcription_start: vi.fn(handler),
    waptions_export_start: vi.fn(handler),
  };
}

function editorRenderPort(
  result: CoordinatorResult,
): ManagedEditorRenderAuthority {
  return {
    renderEditorReceiptFirst: vi.fn().mockResolvedValue(result),
  };
}

function canonicalCall(
  toolName: WaptionsToolName,
  request: CanonicalToolCall["request"],
  digestCharacter: string,
): CanonicalToolCall {
  return {
    toolName,
    request,
    canonicalRequest: JSON.stringify(request),
    requestHash: `sha256:${digestCharacter.repeat(64)}`,
  };
}

function context(): CoordinatorCallContext {
  return { signal: new AbortController().signal };
}

function failure(): CoordinatorResult {
  return {
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "Expected test failure.",
      retryable: false,
    },
  };
}

function successState(result: CoordinatorResult) {
  if (!result.ok || !result.state) {
    throw new Error("Expected a successful stateful result.");
  }
  return result.state;
}

function expected(state: ReturnType<typeof successState>) {
  return {
    sessionRevision: state.sessionRevision,
    documentRevision: state.documentRevision,
    audioGraphRevision: state.audioGraphRevision,
    ...(state.narrativeRevision === undefined
      ? {}
      : { narrativeRevision: state.narrativeRevision }),
  };
}

function mutationBase(
  state: ReturnType<typeof successState>,
  idempotencyKey: string,
) {
  return {
    apiVersion: "2026-07-25",
    sessionId: state.sessionId,
    sessionEpoch: state.sessionEpoch,
    expected: expected(state),
    idempotencyKey,
  };
}

function expectCanonicalOutput(
  toolName: WaptionsToolName,
  result: CoordinatorResult,
): void {
  expect(
    validator.validateOutput(
      schemas.toolSchemas[toolName].outputSchema,
      result,
    ),
  ).toBe(true);
}
