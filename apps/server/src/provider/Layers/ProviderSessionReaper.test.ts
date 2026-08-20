import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import {
  makeProviderSessionReaperLive,
  providerSessionInactivityThresholdConfig,
} from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
    readonly backgroundLiveness?: "working" | "monitoring" | null;
  }>,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        ownerUserId: null,
        memberUserIds: [],
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      sourceControlProfileId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      latestTurn: null,
      messages: [],
      session: thread.session,
      backgroundLiveness: thread.backgroundLiveness ?? null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      rollingSummary: null,
      turnSummaries: [],
      deletedAt: null,
      ownerUserId: null,
      memberUserIds: [],
    })),
  };
}

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    ProviderSessionReaper | ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("uses the deployment-configured inactivity threshold", async () => {
    const threshold = await Effect.runPromise(
      providerSessionInactivityThresholdConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { T3CODE_PROVIDER_SESSION_INACTIVITY_MS: "600000" },
            }),
          ),
        ),
      ),
    );

    expect(threshold).toBe(600_000);
  });

  it("keeps the product inactivity default at thirty minutes", async () => {
    const threshold = await Effect.runPromise(
      providerSessionInactivityThresholdConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
    );

    expect(threshold).toBe(1_800_000);
  });

  it("rejects invalid and non-positive deployment inactivity thresholds", async () => {
    for (const value of ["0", "-1", "not-a-number"]) {
      const exit = await Effect.runPromiseExit(
        providerSessionInactivityThresholdConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { T3CODE_PROVIDER_SESSION_INACTIVITY_MS: value },
              }),
            ),
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
    }
  });

  // Shared start sequence so each test adds no manual Effect runners
  // (no-manual-effect-runtime-in-tests tracks this file's legacy count).
  async function startReaper() {
    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    // T3-CUSTOM(expbkt3): run inside the managed runtime so the reaper start
    // sees the harness-provided config and services.
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));
  }

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly terminateSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["terminateSession"]>;
    readonly configEnv?: Record<string, string>;
    readonly inactivityThresholdMs?: number;
    readonly sweepIntervalMs?: number;
    // T3-CUSTOM(expbkt3): orphaned-turn pass doubles.
    readonly turnAbsoluteCapMs?: number;
    readonly listSessions?: ProviderServiceShape["listSessions"];
    readonly inspectSession?: ProviderServiceShape["inspectSession"];
    readonly dispatch?: OrchestrationEngineService["Service"]["dispatch"];
  }) {
    const terminatedThreadIds = new Set<ThreadId>();
    const terminateSession = vi.fn<ProviderServiceShape["terminateSession"]>(
      (request) =>
        (input.terminateSessionImplementation
          ? input.terminateSessionImplementation(request)
          : Effect.sync(() => {
              terminatedThreadIds.add(request.threadId);
              return { verified: true, graceful: true, processTreeExited: true };
            })) as ReturnType<ProviderServiceShape["terminateSession"]>,
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      inspectSession: input.inspectSession ?? (() => Effect.succeed(null)),
      requestTurnInterrupt: () => unsupported(),
      terminateSession,
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: input.listSessions ?? (() => Effect.succeed([])),
      // T3-CUSTOM(expbkt3): explicit durable execution behavior.
      getCapabilities: () =>
        Effect.succeed({
          sessionModelSwitch: "in-session",
          activeTurnInput: "steer",
          durableResume: "supported",
        }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: input.inactivityThresholdMs ?? 1_000,
      sweepIntervalMs: input.sweepIntervalMs ?? 60_000,
      ...(input.turnAbsoluteCapMs !== undefined
        ? { turnAbsoluteCapMs: input.turnAbsoluteCapMs }
        : {}),
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          // T3-CUSTOM(expbkt3): required bounded projection-query test doubles.
          getSessionListDetails: () => Effect.succeed([]),
          listLatestProposedPlansForActiveThreads: () => Effect.succeed([]),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: input.readModel.snapshotSequence }),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadAccessById: () => Effect.succeed(Option.none()),
          getThreadShellById: (threadId) =>
            Effect.succeed(
              input.readModel.threads.find((thread) => thread.id === threadId)
                ? Option.some(input.readModel.threads.find((thread) => thread.id === threadId)!)
                : Option.none(),
            ),
          listThreadShellsByProjectId: () => Effect.succeed([]),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
      ),
      // The reaper's orphaned-turn pass reads the projections directly and
      // settles via the orchestration engine. No rows exist in this harness, so
      // the engine is never actually dispatched to.
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: input.dispatch ?? (() => Effect.die("unused")),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(
      input.configEnv === undefined
        ? layer
        : layer.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.configEnv }))),
          ),
    );
    return { terminateSession, terminatedThreadIds };
  }

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      configEnv: { T3CODE_PROVIDER_SESSION_INACTIVITY_MS: "0" },
      inactivityThresholdMs: 600_000,
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stale",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();

    await waitFor(() => harness.terminateSession.mock.calls.length === 1);

    expect(harness.terminateSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expect(harness.terminatedThreadIds.has(threadId)).toBe(true);
  });

  it("skips stale sessions when the thread still has an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      inactivityThresholdMs: 600_000,
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-active-turn",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.terminateSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips stale sessions while background work is still live", async () => {
    const threadId = ThreadId.make("thread-reaper-background-work");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          backgroundLiveness: "working",
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-background-work",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.terminateSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: now,
        resumeCursor: {
          opaque: "resume-fresh",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.terminateSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("skips persisted sessions that are already marked stopped", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-stopped",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.terminateSession).not.toHaveBeenCalled();
    const remaining = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(remaining)).toBe(true);
  });

  it("continues reaping other sessions when one termination attempt fails", async () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      terminateSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated termination failure",
              }),
            )
          : Effect.succeed({ verified: true, graceful: true, processTreeExited: true }),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: failedThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-failure",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-success",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();

    await waitFor(() => harness.terminateSession.mock.calls.length === 2);

    expect(harness.terminateSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      failedThreadId,
      reapedThreadId,
    ]);
    const failedBinding = await runtime!.runPromise(
      repository.getByThreadId({ threadId: failedThreadId }),
    );
    expect(Option.isSome(failedBinding)).toBe(true);
    if (Option.isSome(failedBinding)) {
      expect(failedBinding.value.status).toBe("running");
    }
  });

  it("continues reaping other sessions when one termination attempt defects", async () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      terminateSessionImplementation: (request) =>
        request.threadId === defectThreadId
          ? Effect.die(new Error("simulated termination defect"))
          : Effect.succeed({ verified: true, graceful: true, processTreeExited: true }),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId: defectThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: {
          opaque: "resume-defect",
        },
        runtimePayload: null,
      }),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId: reapedThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:01:00.000Z",
        resumeCursor: {
          opaque: "resume-after-defect",
        },
        runtimePayload: null,
      }),
    );

    await startReaper();

    await waitFor(() => harness.terminateSession.mock.calls.length === 2);

    expect(harness.terminateSession.mock.calls.map(([request]) => request.threadId)).toEqual([
      defectThreadId,
      reapedThreadId,
    ]);
  });

  it("retries an unverified termination on the next sweep", async () => {
    const threadId = ThreadId.make("thread-reaper-termination-retry");
    let attempts = 0;
    const harness = await createHarness({
      sweepIntervalMs: 10,
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ]),
      terminateSessionImplementation: () => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated unverified termination",
              }),
            )
          : Effect.succeed({ verified: true, graceful: true, processTreeExited: true });
      },
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: { opaque: "resume-retry" },
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await waitFor(() => harness.terminateSession.mock.calls.length >= 2);
    await runtime!.runPromise(Scope.close(scope, Exit.void));
    scope = null;

    expect(harness.terminateSession.mock.calls.slice(0, 2)).toEqual([
      [{ threadId }],
      [{ threadId }],
    ]);
  });
  // T3-CUSTOM(expbkt3): BEGIN - orphaned-turn pass: silence, real interrupts,
  // and no termination of a turn the adapter still reports as running.
  const sqlQuote = (value: string | number | null) =>
    value === null
      ? "NULL"
      : typeof value === "number"
        ? String(value)
        : `'${value.replace(/'/g, "''")}'`;

  async function seedRow(table: string, values: Record<string, string | number | null>) {
    // The harness layer merges SqlitePersistenceMemory in, but the runtime's
    // declared context is narrowed to the reaper services.
    const sqlRuntime = runtime as unknown as ManagedRuntime.ManagedRuntime<
      SqlClient.SqlClient,
      never
    >;
    await sqlRuntime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const columns = yield* sql.unsafe<{
          readonly name: string;
          readonly notnull: number;
          readonly dflt_value: string | null;
          readonly pk: number;
        }>(`PRAGMA table_info(${table})`);
        const row: Record<string, string | number | null> = { ...values };
        for (const column of columns) {
          if (column.notnull === 1 && column.dflt_value === null && !(column.name in row)) {
            row[column.name] = column.name.endsWith("_json")
              ? "{}"
              : column.name.endsWith("_at")
                ? "2026-01-01T00:00:00.000Z"
                : "";
          }
        }
        const names = Object.keys(row).join(", ");
        const placeholders = Object.values(row).map(sqlQuote).join(", ");
        yield* sql.unsafe(`INSERT INTO ${table} (${names}) VALUES (${placeholders})`);
      }),
    );
  }

  async function seedRunningTurn(input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly startedAt: string;
    readonly lastEventAt: string | null;
  }) {
    await seedRow("projection_threads", {
      thread_id: input.threadId,
      project_id: "project-provider-session-reaper",
      title: "silent turn",
      created_at: input.startedAt,
      updated_at: input.startedAt,
    });
    await seedRow("projection_thread_sessions", {
      thread_id: input.threadId,
      status: "running",
      provider_name: "codex",
      provider_instance_id: "codex",
      active_turn_id: input.turnId,
      updated_at: input.startedAt,
    });
    await seedRow("projection_turns", {
      thread_id: input.threadId,
      turn_id: input.turnId,
      state: "running",
      requested_at: input.startedAt,
      started_at: input.startedAt,
      checkpoint_files_json: "[]",
    });
    if (input.lastEventAt !== null) {
      await seedRow("orchestration_events", {
        event_id: `event-${input.threadId}`,
        aggregate_kind: "thread",
        stream_id: input.threadId,
        stream_version: 1,
        event_type: "thread.activity-appended",
        occurred_at: input.lastEventAt,
        actor_kind: "provider",
        payload_json: "{}",
        metadata_json: "{}",
      });
    }
  }

  function liveCodexSession(threadId: ThreadId, at: string) {
    return () =>
      Effect.succeed([
        {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running" as const,
          runtimeMode: "full-access" as const,
          threadId,
          createdAt: at,
          updatedAt: at,
        },
      ]);
  }

  it("interrupts for real, then settles, a live turn that has been silent past the cap", async () => {
    const threadId = ThreadId.make("thread-reaper-silent");
    const turnId = TurnId.make("turn-reaper-silent");
    const nowMs = await Effect.runPromise(Clock.currentTimeMillis);
    const threeHoursAgo = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 3 * 60 * 60 * 1000));
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const dispatched: Array<{ readonly type: string }> = [];
    const harness = await createHarness({
      inactivityThresholdMs: 24 * 60 * 60 * 1000,
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: threeHoursAgo,
          },
        },
      ]),
      listSessions: liveCodexSession(threadId, threeHoursAgo),
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    });
    await seedRunningTurn({
      threadId,
      turnId,
      startedAt: threeHoursAgo,
      lastEventAt: threeHoursAgo,
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: nowIso,
        resumeCursor: null,
        runtimePayload: null,
      }),
    );

    await startReaper();
    await waitFor(() => dispatched.length >= 3);

    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.turn.interrupt",
      "thread.activity.append",
      "thread.session.set",
    ]);
    const interrupt = dispatched[0] as { readonly turnId?: string };
    expect(interrupt.turnId).toBe(turnId);
    const settle = dispatched[2] as unknown as { readonly session: { readonly status: string } };
    expect(settle.session.status).toBe("interrupted");
    expect(harness.terminateSession).not.toHaveBeenCalled();
  });

  it("leaves a live turn alone while it is still emitting events, however old it is", async () => {
    const threadId = ThreadId.make("thread-reaper-busy");
    const turnId = TurnId.make("turn-reaper-busy");
    const nowMs = await Effect.runPromise(Clock.currentTimeMillis);
    const threeHoursAgo = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 3 * 60 * 60 * 1000));
    const oneMinuteAgo = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 60 * 1000));
    const dispatched: Array<{ readonly type: string }> = [];
    const harness = await createHarness({
      inactivityThresholdMs: 24 * 60 * 60 * 1000,
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: threeHoursAgo,
          },
        },
      ]),
      listSessions: liveCodexSession(threadId, threeHoursAgo),
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    });
    await seedRunningTurn({
      threadId,
      turnId,
      startedAt: threeHoursAgo,
      lastEventAt: oneMinuteAgo,
    });

    await startReaper();
    await Effect.runPromise(Effect.sleep("200 millis"));

    expect(dispatched).toEqual([]);
    expect(harness.terminateSession).not.toHaveBeenCalled();
  });

  it("does not terminate an idle-looking session while the adapter reports an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-adapter-turn");
    const now = "2026-01-01T00:00:00.000Z";
    const harness = await createHarness({
      configEnv: { T3CODE_PROVIDER_SESSION_INACTIVITY_MS: "0" },
      inactivityThresholdMs: 600_000,
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      inspectSession: () =>
        Effect.succeed({
          threadId,
          generation: 1,
          state: "running" as const,
          activeProviderTurnId: TurnId.make("turn-still-running"),
          runtimeAlive: true,
        }),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: null,
        runtimePayload: null,
      }),
    );

    await startReaper();
    await Effect.runPromise(Effect.sleep("200 millis"));

    expect(harness.terminateSession).not.toHaveBeenCalled();
  });
  // T3-CUSTOM(expbkt3): END
});
