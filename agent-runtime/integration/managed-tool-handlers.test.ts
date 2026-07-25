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
import { canonicalDigest } from "../persistence/canonical-json.js";
import type { CoordinatorCallContext } from "../server/coordinator-adapter.js";
import {
  CoreEditorPortFactory,
  type ManagedCoreCommand,
  type ManagedCoreEditorState,
  type ManagedCoreResult,
} from "./core-editor-port.js";
import {
  createManagedToolHandlers,
  type ManagedArtifactAccessAuthority,
  type ManagedDelegatedToolPort,
  type ManagedDiagnosticsAuthority,
  type ManagedEditorRenderAuthority,
  type ManagedProjectValidationAuthority,
  type ManagedStagedOutputAuthority,
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

  it("accepts bounded path-free media probe inventory from the delegated seam", async () => {
    const runtime = await managedRuntime();
    const handle = {
      schemaVersion: 1,
      handleId: "media-handle",
      capabilityId: "media-capability",
      identity: {
        schemaVersion: 1,
        contentDigest: `sha256:${"a".repeat(64)}`,
        descriptorFingerprint: "descriptor-fingerprint",
        byteLength: 1_024,
        immutableVersion: "immutable-version",
        streamMetadataRefs: [{
          kind: "probe",
          ref: "probe-metadata",
        }],
      },
      verifiedAt: "2026-07-25T12:00:00.000Z",
    };
    const expected: CoordinatorResult = {
      ok: true,
      data: {
        handles: [handle],
        media: [{
          handle,
          displayName: "clip.mp4",
          mediaClass: "video",
          mimeType: "video/mp4",
          metadata: {
            containerFormats: ["mov", "mp4"],
            containerLongName: "QuickTime / MOV",
            durationUs: 1_000_000,
            bitRate: 5_128_000,
            videoStreams: [{
              index: 0,
              codec: "h264",
              profile: "High",
              pixelFormat: "yuv420p",
              width: 1_920,
              height: 1_080,
              frameRate: { numerator: 30_000, denominator: 1_001 },
              durationUs: 1_000_000,
              bitRate: 5_000_000,
            }],
            audioStreams: [{
              index: 1,
              codec: "aac",
              sampleRate: 48_000,
              channels: 2,
              channelLayout: "stereo",
              durationUs: 1_000_000,
              bitRate: 128_000,
            }],
            primaryVideoStreamIndex: 0,
            primaryAudioStreamIndex: 1,
          },
        }],
        jobIds: [],
      },
      state: {
        sessionId: "session-1",
        projectId: "project-1",
        sessionEpoch: runtime.coordinator.epoch,
        sessionRevision: 0,
        documentRevision: 0,
        audioGraphRevision: 0,
        eventCursor: "event-0",
      },
      warnings: [],
      replayed: false,
    };
    const delegated = delegatedPort(expected);
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated,
      editorRender: editorRenderPort(failure()),
    });
    const call = canonicalCall("waptions_media_probe", {
      apiVersion: "2026-07-25",
      sessionId: "session-1",
      grantId: "grant-1",
      paths: ["/private/input.mp4"],
    }, "f");

    const result = await handlers.waptions_media_probe(call, context());

    expect(result).toBe(expected);
    if (!result.ok) throw new Error("Expected media probe success.");
    expect(JSON.stringify(result.data)).not.toContain("/private");
    expectCanonicalOutput("waptions_media_probe", result);
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

  it("passes the bound participant into the editor-render attachment seam", async () => {
    const runtime = await managedRuntime();
    let renderResult: CoordinatorResult = failure();
    const editorRender: ManagedEditorRenderAuthority = {
      renderEditorReceiptFirst: vi.fn().mockImplementation(
        () => Promise.resolve(renderResult),
      ),
    };
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender,
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-render",
        idempotencyKey: "open-render",
        name: "Render project",
      }, "7"),
      context(),
    );
    const state = successState(opened);
    const participantId = runtime.coordinator.participantForConnection(
      "connection-test",
    );
    if (participantId === null) throw new Error("Expected a bound participant.");
    renderResult = {
      ok: true,
      data: {
        resourceUri:
          `ui://waptions/editor/v1/${"a".repeat(64)}/index.html`,
        mimeType: "text/html;profile=mcp-app",
        viewId: "view-render",
        presentation: "inline",
        capabilityId: "capability-render",
        capabilityExpiresAt: "2026-07-25T12:00:00.000Z",
      },
      state,
      warnings: [],
      replayed: false,
    };
    const rendered = await handlers.waptions_editor_render(
      canonicalCall("waptions_editor_render", {
        ...mutationBase(state, "render-view"),
        viewId: "view-render",
        presentation: "inline",
      }, "8"),
      context(),
    );

    expect(rendered).toBe(renderResult);
    expect(editorRender.renderEditorReceiptFirst).toHaveBeenCalledWith(
      "project-render",
      expect.any(Object),
      expect.objectContaining({
        viewId: "view-render",
        participantId,
        presentation: "inline",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const arbitraryUpdate = await handlers.waptions_view_update(
      canonicalCall("waptions_view_update", {
        ...mutationBase(state, "render-seam-missing-view"),
        viewId: "view-render",
        expectedViewRevision: 0,
        patch: { zoom: 2 },
      }, "9"),
      context(),
    );
    expect(arbitraryUpdate).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expectCanonicalOutput("waptions_editor_render", rendered);
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
    const participantId = runtime.coordinator.participantForConnection(
      "connection-test",
    );
    if (participantId === null) throw new Error("Expected a bound participant.");
    await attachDurableView(runtime, "project-view", "view-1");
    runtime.coordinator.presence.attach(
      "project-view",
      "view-2",
      participantId,
    );
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
          participantIds: [participantId],
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

    const arbitrary = await handlers.waptions_view_update(
      canonicalCall("waptions_view_update", {
        apiVersion: "2026-07-25",
        sessionId: state.sessionId,
        sessionEpoch: state.sessionEpoch,
        expected: expected(state),
        idempotencyKey: "view-arbitrary",
        viewId: "view-arbitrary",
        expectedViewRevision: 0,
        patch: { zoom: 2 },
      }, "9"),
      context(),
    );
    expect(arbitrary).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(runtime.coordinator.presence.list("project-view")).not.toContainEqual(
      expect.objectContaining({ viewId: "view-arbitrary" }),
    );
  });

  it("inspects grants without persisting a receipt or consuming an event", async () => {
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
        projectId: "project-grant-inspect",
        idempotencyKey: "open-grant-inspect",
        name: "Grant inspect project",
      }, "8"),
      context(),
    );
    const state = successState(opened);

    const inspected = await handlers.waptions_path_grant(
      canonicalCall("waptions_path_grant", {
        ...mutationBase(state, "inspect-grants"),
        action: { kind: "inspect" },
      }, "9"),
      context(),
    );

    expect(inspected).toMatchObject({
      ok: true,
      data: { action: "inspect", grants: [] },
      state: { eventCursor: state.eventCursor },
    });
    expect(
      await runtime.coordinator.store.readReceipt(
        "project-grant-inspect",
        "waptions_path_grant",
        "inspect-grants",
      ),
    ).toBeNull();
    expectCanonicalOutput("waptions_path_grant", inspected);
  });

  it("returns fresh export-registered capabilities for write destinations", async () => {
    const runtime = await managedRuntime();
    let capabilitySequence = 0;
    const stagedOutput: ManagedStagedOutputAuthority = {
      stageWriteDestination: vi.fn().mockImplementation(
        (_projectId, input: { grantId: string; outputName: string }) => {
          capabilitySequence += 1;
          return Promise.resolve({
            schemaVersion: 1 as const,
            destinationId: `destination-${capabilitySequence}`,
            grantId: input.grantId,
            stagingHandleId: `staging-${capabilitySequence}`,
            mode: "create-only" as const,
            outputName: input.outputName,
            verifiedParentIdentity: `parent-${capabilitySequence}`,
            expiresAt: "2099-07-25T12:00:00.000Z",
          });
        },
      ),
    };
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
      stagedOutput,
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-write-destination",
        idempotencyKey: "open-write-destination",
        name: "Write destination project",
      }, "a"),
      context(),
    );
    const state = successState(opened);
    const outputRoot = join(runtime.path, "outputs");
    await mkdir(outputRoot);
    const firstCall = canonicalCall("waptions_path_grant", {
      ...mutationBase(state, "grant-output-one"),
      action: {
        kind: "add",
        grantKind: "write-destination",
        path: join(outputRoot, "one.mp4"),
        outputName: "one.mp4",
        allowCreate: true,
        confirmAuthorityExpansion: true,
      },
    }, "b");

    const first = await handlers.waptions_path_grant(firstCall, context());
    const replay = await handlers.waptions_path_grant(firstCall, context());
    const second = await handlers.waptions_path_grant(
      canonicalCall("waptions_path_grant", {
        ...mutationBase(successState(first), "grant-output-two"),
        action: {
          kind: "add",
          grantKind: "write-destination",
          path: join(outputRoot, "two.webm"),
          outputName: "two.webm",
          allowCreate: true,
          confirmAuthorityExpansion: true,
        },
      }, "c"),
      context(),
    );

    expect(first).toMatchObject({
      ok: true,
      data: {
        destination: {
          destinationId: "destination-1",
          outputName: "one.mp4",
        },
      },
    });
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      data: {
        destination: {
          destinationId: "destination-2",
          outputName: "one.mp4",
        },
      },
    });
    expect(second).toMatchObject({
      ok: true,
      data: {
        destination: {
          destinationId: "destination-3",
          outputName: "two.webm",
        },
      },
    });
    expect(stagedOutput.stageWriteDestination).toHaveBeenNthCalledWith(
      1,
      "project-write-destination",
      expect.objectContaining({ outputName: "one.mp4" }),
      expect.any(Object),
    );
    expectCanonicalOutput("waptions_path_grant", first);
    expectCanonicalOutput("waptions_path_grant", replay);
    expectCanonicalOutput("waptions_path_grant", second);
  });

  it("detaches the caller's bound participant without consuming an event", async () => {
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
        projectId: "project-detach",
        idempotencyKey: "open-detach",
        name: "Detach project",
      }, "a"),
      context(),
    );
    const state = successState(opened);
    await attachDurableView(runtime, "project-detach", "view-detach");
    const call = canonicalCall("waptions_session_manage", {
      ...mutationBase(state, "detach-participant"),
      action: { kind: "detach" },
    }, "b");

    const detached = await handlers.waptions_session_manage(call, context());
    expect(detached).toMatchObject({
      ok: true,
      data: { action: "detach", status: "detached" },
      state: { eventCursor: state.eventCursor },
    });
    expect(runtime.coordinator.presence.list("project-detach")).toEqual([]);
    expect(runtime.coordinator.participantForConnection("connection-test"))
      .toBeNull();
    const replay = await handlers.waptions_session_manage(call, context());
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      state: { eventCursor: state.eventCursor },
    });
    expectCanonicalOutput("waptions_session_manage", detached);
    expectCanonicalOutput("waptions_session_manage", replay);
  });

  it("bounds event reads to the state captured before concurrent commits", async () => {
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
        projectId: "project-event-bound",
        idempotencyKey: "open-event-bound",
        name: "Event bound project",
      }, "a"),
      context(),
    );
    const state = successState(opened);
    await attachDurableView(runtime, "project-event-bound", "view-bound");
    const first = await handlers.waptions_view_update(
      canonicalCall("waptions_view_update", {
        ...mutationBase(state, "view-bound-1"),
        viewId: "view-bound",
        expectedViewRevision: 0,
        patch: { zoom: 2 },
      }, "b"),
      context(),
    );
    const capturedState = successState(first);
    const read = runtime.coordinator.events.read.bind(
      runtime.coordinator.events,
    );
    vi.spyOn(runtime.coordinator.events, "read").mockImplementationOnce(
      async (...args) => {
        const concurrent = await handlers.waptions_view_update(
          canonicalCall("waptions_view_update", {
            ...mutationBase(capturedState, "view-bound-2"),
            viewId: "view-bound",
            expectedViewRevision: 1,
            patch: { zoom: 3 },
          }, "c"),
          context(),
        );
        expect(concurrent.ok).toBe(true);
        return read(...args);
      },
    );

    const events = await handlers.waptions_events_read(
      canonicalCall("waptions_events_read", {
        apiVersion: "2026-07-25",
        sessionId: state.sessionId,
      }, "d"),
      context(),
    );

    expect(events).toMatchObject({
      ok: true,
      state: { eventCursor: capturedState.eventCursor },
      data: {
        events: [expect.objectContaining({ sequence: 1 })],
        nextCursor: capturedState.eventCursor,
        hasMore: false,
      },
    });
    if (!events.ok) throw new Error("Expected bounded events to succeed.");
    expect(events.data.events).toHaveLength(1);
    expect(
      runtime.coordinator.getProject("project-event-bound").state.eventCursor,
    ).not.toBe(capturedState.eventCursor);
    expectCanonicalOutput("waptions_events_read", events);
  });

  it("enforces presenter ownership and keeps playback no-ops event-free", async () => {
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
        projectId: "project-playback",
        idempotencyKey: "open-playback",
        name: "Playback project",
      }, "d"),
      context(),
    );
    const initialState = successState(opened);
    await attachDurableView(runtime, "project-playback", "view-a");
    await attachDurableView(runtime, "project-playback", "view-b");

    const claim = await handlers.waptions_playback_control(
      canonicalCall("waptions_playback_control", {
        ...mutationBase(initialState, "claim-a"),
        viewId: "view-a",
        expectedPlaybackRevision: 0,
        action: { kind: "claim-presenter" },
      }, "e"),
      context(),
    );
    expect(claim).toMatchObject({
      ok: true,
      data: {
        playbackRevision: 1,
        presenterViewId: "view-a",
      },
      state: { sessionRevision: initialState.sessionRevision },
    });
    const claimedState = successState(claim);

    const repeatedClaim = await handlers.waptions_playback_control(
      canonicalCall("waptions_playback_control", {
        ...mutationBase(claimedState, "claim-a-noop"),
        viewId: "view-a",
        expectedPlaybackRevision: 1,
        action: { kind: "claim-presenter" },
      }, "f"),
      context(),
    );
    expect(repeatedClaim).toMatchObject({
      ok: true,
      data: { playbackRevision: 1 },
      state: { eventCursor: claimedState.eventCursor },
    });

    const stolen = await handlers.waptions_playback_control(
      canonicalCall("waptions_playback_control", {
        ...mutationBase(claimedState, "claim-b-blocked"),
        viewId: "view-b",
        expectedPlaybackRevision: 1,
        action: { kind: "claim-presenter" },
      }, "1"),
      context(),
    );
    expect(stolen).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
      state: { eventCursor: claimedState.eventCursor },
    });

    const played = await handlers.waptions_playback_control(
      canonicalCall("waptions_playback_control", {
        ...mutationBase(claimedState, "play-a"),
        viewId: "view-a",
        expectedPlaybackRevision: 1,
        action: { kind: "play" },
      }, "2"),
      context(),
    );
    expect(played).toMatchObject({
      ok: true,
      data: { playbackRevision: 2, playing: true },
    });
    const playedState = successState(played);

    const repeatedPlay = await handlers.waptions_playback_control(
      canonicalCall("waptions_playback_control", {
        ...mutationBase(playedState, "play-a-noop"),
        viewId: "view-a",
        expectedPlaybackRevision: 2,
        action: { kind: "play" },
      }, "3"),
      context(),
    );
    expect(repeatedPlay).toMatchObject({
      ok: true,
      data: { playbackRevision: 2, playing: true },
      state: { eventCursor: playedState.eventCursor },
    });

    runtime.coordinator.presence.detach("view-a");
    const reclaimed = await handlers.waptions_playback_control(
      canonicalCall("waptions_playback_control", {
        ...mutationBase(playedState, "claim-b-after-detach"),
        viewId: "view-b",
        expectedPlaybackRevision: 2,
        action: { kind: "claim-presenter" },
      }, "4"),
      context(),
    );
    expect(reclaimed).toMatchObject({
      ok: true,
      data: {
        playbackRevision: 3,
        presenterViewId: "view-b",
      },
    });
    const reclaimedState = successState(reclaimed);
    const followed = await handlers.waptions_playback_control(
      canonicalCall("waptions_playback_control", {
        ...mutationBase(reclaimedState, "follow-b"),
        viewId: "view-b",
        expectedPlaybackRevision: 3,
        action: { kind: "follow" },
      }, "5"),
      context(),
    );
    expect(followed).toMatchObject({
      ok: true,
      data: {
        playbackRevision: 3,
        followingPresenter: true,
      },
      state: { eventCursor: reclaimedState.eventCursor },
    });

    const events = await handlers.waptions_events_read(
      canonicalCall("waptions_events_read", {
        apiVersion: "2026-07-25",
        sessionId: initialState.sessionId,
      }, "6"),
      context(),
    );
    if (!events.ok) throw new Error("Expected playback events to succeed.");
    expect(
      (events.data.events as Array<{ type: string }>).map((event) =>
        event.type
      ),
    ).toEqual(["project.snapshot", "project.snapshot", "project.snapshot"]);
    expectCanonicalOutput("waptions_playback_control", claim);
    expectCanonicalOutput("waptions_playback_control", repeatedClaim);
    expectCanonicalOutput("waptions_playback_control", played);
    expectCanonicalOutput("waptions_playback_control", repeatedPlay);
    expectCanonicalOutput("waptions_playback_control", reclaimed);
    expectCanonicalOutput("waptions_playback_control", followed);
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

  it("keeps Core edit plans valid across independent view mutations", async () => {
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
        projectId: "project-plan-view",
        idempotencyKey: "open-plan-view",
        name: "Plan and view project",
      }, "0"),
      context(),
    );
    const initialState = successState(opened);
    await attachDurableView(runtime, "project-plan-view", "view-plan");
    const planned = await handlers.waptions_edit_plan(
      canonicalCall("waptions_edit_plan", {
        apiVersion: "2026-07-25",
        sessionId: initialState.sessionId,
        sessionEpoch: initialState.sessionEpoch,
        expected: expected(initialState),
        operations: [{
          operationId: "rename-after-view",
          type: "project.set-name",
          payload: { name: "Plan survived" },
        }],
      }, "1"),
      context(),
    );
    if (!planned.ok) throw new Error("Expected edit planning to succeed.");
    const planId = planned.data.planId;
    if (typeof planId !== "string") throw new Error("Expected a plan ID.");

    const view = await handlers.waptions_view_update(
      canonicalCall("waptions_view_update", {
        apiVersion: "2026-07-25",
        sessionId: initialState.sessionId,
        sessionEpoch: initialState.sessionEpoch,
        expected: expected(initialState),
        idempotencyKey: "view-between-plan-and-apply",
        viewId: "view-plan",
        expectedViewRevision: 0,
        patch: { zoom: 2 },
      }, "2"),
      context(),
    );
    expect(view).toMatchObject({
      ok: true,
      state: {
        sessionRevision: initialState.sessionRevision,
        documentRevision: initialState.documentRevision,
      },
    });

    const applied = await handlers.waptions_edit_apply(
      canonicalCall("waptions_edit_apply", {
        apiVersion: "2026-07-25",
        sessionId: initialState.sessionId,
        sessionEpoch: initialState.sessionEpoch,
        expected: expected(initialState),
        idempotencyKey: "apply-after-view",
        planId,
      }, "3"),
      context(),
    );
    expect(applied).toMatchObject({
      ok: true,
      data: {
        planId,
        noOp: false,
      },
    });
    expectCanonicalOutput("waptions_edit_apply", applied);
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
        code: "COORDINATOR_UNAVAILABLE",
        retryable: true,
      },
    });
    expectCanonicalOutput("waptions_diagnostics_get", diagnostics);
  });

  it("projects authoritative bounded diagnostics through the injected seam", async () => {
    const runtime = await managedRuntime();
    const diagnostics: ManagedDiagnosticsAuthority = {
      readDiagnostics: vi.fn().mockResolvedValue({
        diagnosticsRevision: 7,
        currentBytes: 1_024,
        peakBytes: 2_048,
        reservedDecoderPixelBytes: 512,
        leasedDecoderPixelBytes: 256,
        decoderSessions: 2,
        queueLengths: {
          render: 1,
          transcription: 0,
        },
        evictions: 3,
        cancellations: 4,
        lateResultDisposals: 5,
        leakedResourceAssertions: [],
      }),
    };
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
      diagnostics,
    });
    const opened = await handlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-diagnostics",
        idempotencyKey: "open-diagnostics",
        name: "Diagnostics project",
      }, "c"),
      context(),
    );
    const state = successState(opened);

    const result = await handlers.waptions_diagnostics_get(
      canonicalCall("waptions_diagnostics_get", {
        apiVersion: "2026-07-25",
        sessionId: state.sessionId,
        sections: ["memory", "decoders", "queues"],
      }, "d"),
      context(),
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnosticsRevision: 7,
        currentBytes: 1_024,
        queueLengths: {
          render: 1,
          transcription: 0,
        },
      },
    });
    expect(diagnostics.readDiagnostics).toHaveBeenCalledWith(
      "project-diagnostics",
      ["memory", "decoders", "queues"],
      expect.any(Object),
    );
    expectCanonicalOutput("waptions_diagnostics_get", result);
  });

  it("delegates deep validation to the authoritative structured seam", async () => {
    const runtime = await managedRuntime();
    const projectValidation: ManagedProjectValidationAuthority = {
      validateProject: vi.fn().mockResolvedValue({
        valid: false,
        issues: [{
          code: "SOURCE_IDENTITY_CHANGED",
          path: "videoSourceDescriptors[0]",
          message: "The hydrated source identity changed.",
        }],
        jobId: "validation-job",
      }),
    };
    const handlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
      projectValidation,
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

    const result = await handlers.waptions_project_validate(
      canonicalCall("waptions_project_validate", {
        apiVersion: "2026-07-25",
        sessionId: state.sessionId,
        scopes: ["hydrated", "sources", "history-wal", "renderability"],
        deep: true,
      }, "e"),
      context(),
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        valid: false,
        issues: [{
          code: "SOURCE_IDENTITY_CHANGED",
          path: "videoSourceDescriptors[0]",
          message: "The hydrated source identity changed.",
        }],
        jobId: "validation-job",
      },
    });
    expect(projectValidation.validateProject).toHaveBeenCalledWith(
      "project-validation",
      expect.objectContaining({
        scopes: ["hydrated", "sources", "history-wal", "renderability"],
        deep: true,
        state: expect.objectContaining({
          projectId: "project-validation",
        }),
      }),
      expect.any(Object),
    );
    expectCanonicalOutput("waptions_project_validate", result);

    const handlersWithoutAuthority = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const unavailable = await handlersWithoutAuthority.waptions_project_validate(
      canonicalCall("waptions_project_validate", {
        apiVersion: "2026-07-25",
        sessionId: state.sessionId,
        scopes: ["all"],
        deep: true,
      }, "f"),
      context(),
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: {
        code: "COORDINATOR_UNAVAILABLE",
        retryable: true,
      },
    });
    expectCanonicalOutput("waptions_project_validate", unavailable);
  });

  it("reads artifact bytes through a public 1 MiB bounded authority seam", async () => {
    const runtime = await managedRuntime();
    const openedHandlers = createManagedToolHandlers({
      coordinator: runtime.coordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
    });
    const opened = await openedHandlers.waptions_session_open(
      canonicalCall("waptions_session_open", {
        apiVersion: "2026-07-25",
        action: "create",
        projectId: "project-artifact-range",
        idempotencyKey: "open-artifact-range",
        name: "Artifact range project",
      }, "1"),
      context(),
    );
    const state = successState(opened);
    const project = runtime.coordinator.getProject("project-artifact-range");
    const jsonBytes = Buffer.from('{"ok":true}', "utf8");
    const imageBytes = Buffer.from([0, 255, 1, 254]);
    const artifacts = new Map([
      ["artifact-json", {
        schemaVersion: 1 as const,
        artifactId: "artifact-json",
        projectId: "project-artifact-range",
        kind: "transcript",
        mediaType: "application/json",
        byteLength: jsonBytes.byteLength,
        digest: `sha256:${"a".repeat(64)}`,
        relativeBlobPath: "blobs/json.blob",
        createdAt: "2026-07-25T12:00:00.000Z",
        sourceIds: [] as string[],
      }],
      ["artifact-image", {
        schemaVersion: 1 as const,
        artifactId: "artifact-image",
        projectId: "project-artifact-range",
        kind: "thumbnail-strip",
        mediaType: "image/png",
        byteLength: imageBytes.byteLength,
        digest: `sha256:${"b".repeat(64)}`,
        relativeBlobPath: "blobs/image.blob",
        createdAt: "2026-07-25T12:00:00.000Z",
        sourceIds: [] as string[],
      }],
    ]);
    const bytesByArtifact = new Map([
      ["artifact-json", jsonBytes],
      ["artifact-image", imageBytes],
    ]);
    const fakeCoordinator = {
      resolveProjectId: () => "project-artifact-range",
      getProject: () => project,
      artifacts: {
        get: (_projectId: string, artifactId: string) =>
          Promise.resolve(artifacts.get(artifactId)!),
      },
    } as unknown as ManagedToolHandlerDependencies["coordinator"];
    const artifactAccess: ManagedArtifactAccessAuthority = {
      readRange: vi.fn().mockImplementation(
        (_projectId, artifact, offset, endExclusive) => {
          const bytes = bytesByArtifact.get(artifact.artifactId)!;
          return Promise.resolve({
            bytes: bytes.subarray(offset, endExclusive),
            start: offset,
            endExclusive,
            totalBytes: artifact.byteLength,
            digest: artifact.digest,
          });
        },
      ),
      signedRangeUrl: vi.fn().mockResolvedValue({
        signedRangeUrl:
          "http://localhost:59941/artifacts/artifact-image?capability=signed",
        expiresAt: "2099-07-25T12:00:00.000Z",
      }),
    };
    const handlers = createManagedToolHandlers({
      coordinator: fakeCoordinator,
      delegated: delegatedPort(failure()),
      editorRender: editorRenderPort(failure()),
      artifactAccess,
    });
    const base = {
      apiVersion: "2026-07-25",
      sessionId: state.sessionId,
    };

    const jsonRange = await handlers.waptions_artifact_get(
      canonicalCall("waptions_artifact_get", {
        ...base,
        artifactId: "artifact-json",
        presentation: "inline-range",
        offset: 2,
        maxBytes: 4,
      }, "2"),
      context(),
    );
    expect(jsonRange).toMatchObject({
      ok: true,
      data: {
        presentation: "inline-range",
        mediaType: "application/json",
        encoding: "utf8",
        data: 'ok":',
        nextOffset: 6,
        done: false,
        digest: `sha256:${"a".repeat(64)}`,
      },
    });
    expect(artifactAccess.readRange).toHaveBeenCalledWith(
      "project-artifact-range",
      expect.objectContaining({ artifactId: "artifact-json" }),
      2,
      6,
      expect.any(Object),
    );
    expectCanonicalOutput("waptions_artifact_get", jsonRange);

    const binaryRange = await handlers.waptions_artifact_get(
      canonicalCall("waptions_artifact_get", {
        ...base,
        artifactId: "artifact-image",
        presentation: "inline-range",
        offset: 0,
        maxBytes: 4,
      }, "3"),
      context(),
    );
    expect(binaryRange).toMatchObject({
      ok: true,
      data: {
        mediaType: "image/png",
        encoding: "base64",
        data: imageBytes.toString("base64"),
        nextOffset: 4,
        done: true,
        digest: `sha256:${"b".repeat(64)}`,
      },
    });
    expectCanonicalOutput("waptions_artifact_get", binaryRange);

    const signed = await handlers.waptions_artifact_get(
      canonicalCall("waptions_artifact_get", {
        ...base,
        artifactId: "artifact-image",
        presentation: "signed-range-url",
      }, "4"),
      context(),
    );
    expect(signed).toMatchObject({
      ok: true,
      data: {
        presentation: "signed-range-url",
        signedRangeUrl:
          "http://localhost:59941/artifacts/artifact-image?capability=signed",
      },
    });
    expectCanonicalOutput("waptions_artifact_get", signed);

    const overCap = await handlers.waptions_artifact_get(
      canonicalCall("waptions_artifact_get", {
        ...base,
        artifactId: "artifact-json",
        presentation: "inline-range",
        offset: 0,
        maxBytes: 1024 * 1024 + 1,
      }, "5"),
      context(),
    );
    expect(overCap).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expectCanonicalOutput("waptions_artifact_get", overCap);
  });

  it("keeps Core-authoritative renames and enforces lifecycle transitions", async () => {
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
    const renamed = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(openedState, "rename-lifecycle"),
        action: {
          kind: "rename",
          name: "Renamed lifecycle project",
        },
      }, "2"),
      context(),
    );
    expect(renamed).toMatchObject({
      ok: true,
      data: { action: "rename", status: "renamed" },
    });
    const renamedState = successState(renamed);
    expect(renamedState.sessionRevision).toBe(
      openedState.sessionRevision + 1,
    );
    const renameReceipt = await runtime.coordinator.store.readReceipt(
      "project-lifecycle",
      "waptions_session_manage",
      "rename-lifecycle",
    );
    expect(renameReceipt?.canonicalRequestHash).toBe(
      `sha256:${"2".repeat(64)}`,
    );

    const edited = await handlers.waptions_edit_apply(
      canonicalCall("waptions_edit_apply", {
        ...mutationBase(renamedState, "edit-after-rename"),
        operations: [{
          operationId: "background-after-rename",
          type: "render.set-background",
          payload: { color: "#112233" },
        }],
      }, "3"),
      context(),
    );
    expect(edited.ok).toBe(true);
    const editedState = successState(edited);
    expect(runtime.coordinator.getProject("project-lifecycle").envelope.name)
      .toBe("Renamed lifecycle project");

    const archived = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(editedState, "archive-lifecycle"),
        action: { kind: "archive" },
      }, "4"),
      context(),
    );
    expect(archived).toMatchObject({
      ok: true,
      data: { action: "archive", status: "archived" },
    });
    const archivedState = successState(archived);
    expect(archivedState.sessionRevision).toBe(editedState.sessionRevision);
    const beforeRepeatedArchive = runtime.coordinator.getProject(
      "project-lifecycle",
    ).state.eventCursor;
    const repeatedArchive = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(archivedState, "archive-lifecycle-again"),
        action: { kind: "archive" },
      }, "5"),
      context(),
    );
    expect(repeatedArchive).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(runtime.coordinator.getProject("project-lifecycle").state.eventCursor)
      .toBe(beforeRepeatedArchive);

    const restoredArchive = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(archivedState, "restore-archive"),
        action: { kind: "restore" },
      }, "6"),
      context(),
    );
    expect(restoredArchive).toMatchObject({
      ok: true,
      data: { action: "restore", status: "restored" },
    });
    const restoredState = successState(restoredArchive);
    await attachDurableView(
      runtime,
      "project-lifecycle",
      "view-lifecycle",
    );
    const beforeDetach = runtime.coordinator.getProject("project-lifecycle");
    const detachedCall = canonicalCall("waptions_session_manage", {
      ...mutationBase(restoredState, "detach-lifecycle"),
      action: { kind: "detach" },
    }, "7");
    const detached = await handlers.waptions_session_manage(
      detachedCall,
      context(),
    );
    expect(detached).toMatchObject({
      ok: true,
      data: { action: "detach", status: "detached" },
      state: { eventCursor: beforeDetach.state.eventCursor },
    });
    expect(runtime.coordinator.presence.list("project-lifecycle")).toEqual([]);
    expect(
      runtime.coordinator.participantForConnection("connection-test"),
    ).toBeNull();
    const replayedDetach = await handlers.waptions_session_manage(
      detachedCall,
      context(),
    );
    expect(replayedDetach).toMatchObject({
      ok: true,
      replayed: true,
      state: { eventCursor: beforeDetach.state.eventCursor },
    });
    const detachedState = successState(detached);
    const deleted = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(detachedState, "delete-lifecycle"),
        action: {
          kind: "delete",
          confirmProjectId: "project-lifecycle",
        },
      }, "8"),
      context(),
    );
    const deletedState = successState(deleted);
    expect(deletedState.sessionRevision).toBe(detachedState.sessionRevision);

    const restored = await handlers.waptions_session_manage(
      canonicalCall("waptions_session_manage", {
        ...mutationBase(deletedState, "restore-tombstone"),
        action: { kind: "restore" },
      }, "9"),
      context(),
    );
    expect(restored).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(runtime.coordinator.getProject("project-lifecycle").envelope.deletedAt)
      .toEqual(expect.any(String));
    expectCanonicalOutput("waptions_session_manage", restored);
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
    const transcriptRecordId = `sha256:${"1".repeat(64)}` as const;
    manifest.narrative = {
      version: 1,
      id: "narrative",
      revision: 3,
      controlledTrackIds: ["video-track"],
      blockIds: ["narrative-block"],
      blocks: {
        "narrative-block": {
          id: "narrative-block",
          kind: "speech",
          instanceId: "narrative-instance",
          lineageRootId: "narrative-lineage",
          parentInstanceIds: [],
          clipId: "video-clip",
          trackId: "video-track",
          sourceId: "video-source",
          transcriptRecordId,
          sourceIntervalId: "source-interval",
          coreStartSample: 100,
          coreEndSample: 900,
          materialization: {
            sourceStartFrame: 2,
            sourceEndFrame: 8,
            preBoundary: {
              kind: "margin",
              mode: "explicit",
              requestedSamples: 0,
            },
            postBoundary: {
              kind: "margin",
              mode: "explicit",
              requestedSamples: 0,
            },
          },
          timelineStartFrame: 0,
          startBoundaryRefinement: null,
          endBoundaryRefinement: null,
          revision: 4,
          sourceWordIds: ["word-one", "word-two"],
          wordTextOverrides: {},
          speakerOverrides: {},
        },
      },
      sourceRecordIds: [transcriptRecordId],
      settings: {
        globalPreMarginSamples: 0,
        globalPostMarginSamples: 0,
        boundaryRefinementEnabled: false,
        showSpeakers: false,
      },
      createdAt: "2026-07-25T12:00:00.000Z",
      updatedAt: "2026-07-25T12:00:00.000Z",
    };
    manifest.dependentLinks = [{
      version: 1,
      id: "dependent-link",
      anchorBlockId: "narrative-block",
      target: {
        kind: "subtitle",
        trackId: "subtitle-track",
        subtitleId: "subtitle",
      },
      association: {
        kind: "overlap",
        origin: "manual",
      },
      followPolicy: "follow",
      relativeStartOutputSample: 4_800,
      relativeEndOutputSample: 9_600,
      revision: 2,
    }];
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
            sourceId: "audio-source",
            sourceKind: "audio-source",
            sourceStartSample: 0,
            sourceEndSample: 24_001,
            timelineDurationSamples: 24_001,
            muted: false,
            gainDb: 0,
          }),
          expect.objectContaining({
            id: "detached-audio",
            startFrame: 20,
            endFrame: 28,
            sourceId: "video-source",
            sourceKind: "video-source-audio",
            sourceStartSeconds: 0,
            sourceEndSeconds: 0.25,
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
          text: "s".repeat(600),
        }],
      },
    });
    expectCanonicalOutput("waptions_timeline_query", subtitles);

    const narrative = await handlers.waptions_timeline_query(
      canonicalCall("waptions_timeline_query", {
        ...base,
        entityKind: "narrative-blocks",
      }, "7"),
      context(),
    );
    expect(narrative).toMatchObject({
      ok: true,
      data: {
        items: [{
          id: "narrative-block",
          blockId: "narrative-block",
          clipId: "video-clip",
          sourceId: "video-source",
          coreStartSample: 100,
          coreEndSample: 900,
          sourceStartFrame: 2,
          sourceEndFrame: 8,
          sourceWordIds: ["word-one", "word-two"],
          sourceWordCount: 2,
          transcriptRecordId,
          revision: 4,
        }],
      },
    });
    expectCanonicalOutput("waptions_timeline_query", narrative);

    const links = await handlers.waptions_timeline_query(
      canonicalCall("waptions_timeline_query", {
        ...base,
        entityKind: "links",
      }, "7"),
      context(),
    );
    expect(links).toMatchObject({
      ok: true,
      data: {
        items: [{
          id: "dependent-link",
          anchorBlockId: "narrative-block",
          targetKind: "subtitle",
          targetTrackId: "subtitle-track",
          targetId: "subtitle",
          associationKind: "overlap",
          followPolicy: "follow",
          relativeStartOutputSample: 4_800,
          relativeEndOutputSample: 9_600,
          revision: 2,
        }],
      },
    });
    expectCanonicalOutput("waptions_timeline_query", links);

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

function context(connectionId = "connection-test"): CoordinatorCallContext {
  return {
    signal: new AbortController().signal,
    connectionId,
  } as CoordinatorCallContext;
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

async function attachDurableView(
  runtime: Awaited<ReturnType<typeof managedRuntime>>,
  projectId: string,
  viewId: string,
): Promise<void> {
  const project = runtime.coordinator.getProject(projectId);
  const now = new Date().toISOString();
  await runtime.coordinator.store.transact({
    envelope: project.envelope,
    baseSessionRevision: project.envelope.sessionRevision,
    writes: [{
      relativePath: `views/${canonicalDigest({ viewId }).slice(7)}.json`,
      value: {
        schemaVersion: 1,
        projectId,
        viewId,
        viewRevision: 0,
        connectedAt: now,
        heartbeatAt: now,
        followPresenter: false,
        selectedIds: [],
        playheadSample: 0,
        zoom: 1,
        scrollLeft: 0,
        presentation: "inline",
      },
    }],
  });
  const participantId = runtime.coordinator.participantForConnection(
    "connection-test",
  );
  if (participantId === null) {
    throw new Error("Expected a participant binding before attaching a view.");
  }
  runtime.coordinator.presence.attach(projectId, viewId, participantId);
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
