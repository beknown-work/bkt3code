// T3-CUSTOM(expbkt3): coverage for automatic session recovery.
//
// The invariants under test are the ones that keep this feature from becoming
// a restart loop: only "running" rows recover, intentional stops are immune,
// the attempt budget is finite, and a live execution is never disturbed.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ThreadExecutionSupervisor } from "../execution/ThreadExecutionSupervisor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  SessionRecoveryStateRepository,
  layer as SessionRecoveryStateLayer,
} from "../persistence/SessionRecoveryState.ts";
import { SessionRecovery } from "./SessionRecovery.ts";
import { makeSessionRecoveryLive } from "./SessionRecoveryLive.ts";

const projectId = ProjectId.make("project-recovery");
const now = "2026-01-01T00:00:00.000Z";
const instanceId = ProviderInstanceId.make("codex");

function makeSnapshot(
  threadId: ThreadId,
  overrides: {
    readonly sessionState?: ThreadExecutionSnapshot["providerSession"]["state"];
    readonly activity?: ThreadExecutionSnapshot["activity"];
    readonly canStop?: boolean;
    readonly startedAt?: string | null;
  } = {},
): ThreadExecutionSnapshot {
  return {
    threadId,
    authorityEpoch: "epoch-1",
    revision: 1,
    observedAt: now,
    activity: overrides.activity ?? "idle",
    canStop: overrides.canStop ?? false,
    providerSession: {
      state: overrides.sessionState ?? "stopped",
      generation: 1,
      providerInstanceId: instanceId,
      startedAt: overrides.startedAt === undefined ? null : overrides.startedAt,
      lastObservedAt: now,
      lastError: null,
    },
    turn: null,
  };
}

function makeThreadShell(threadId: ThreadId, archivedAt: string | null = null) {
  return {
    id: threadId,
    projectId,
    title: "Recovery thread",
    modelSelection: { instanceId, model: "gpt-5-codex" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    ownerUserId: null,
    memberUserIds: [],
    createdAt: now,
    updatedAt: now,
    archivedAt,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("SessionRecovery", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    SessionRecovery | SessionRecoveryStateRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
    if (runtime) await runtime.dispose();
    runtime = null;
  });

  function createHarness(input: {
    readonly snapshots: ReadonlyMap<string, ThreadExecutionSnapshot>;
    readonly shells?: ReadonlyMap<string, ReturnType<typeof makeThreadShell>>;
    readonly maxAttempts?: number;
    readonly healthyUptimeMs?: number;
  }) {
    const dispatched: Array<OrchestrationCommand> = [];

    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as unknown as OrchestrationEngineService["Service"];

    const supervisor = {
      getSnapshot: (threadId: ThreadId) =>
        Effect.succeed(input.snapshots.get(String(threadId)) ?? makeSnapshot(threadId)),
    } as unknown as ThreadExecutionSupervisor["Service"];

    const snapshotQuery = {
      getThreadShellById: (threadId: ThreadId) => {
        const shell = input.shells?.get(String(threadId)) ?? makeThreadShell(threadId);
        return Effect.succeed(Option.some(shell) as Option.Option<never>);
      },
    } as unknown as ProjectionSnapshotQuery["Service"];

    const layer = makeSessionRecoveryLive({
      // Long interval: these tests drive the sweep through start() once and
      // assert on the first pass rather than racing a timer.
      sweepIntervalMs: 60_000,
      maxAttempts: input.maxAttempts ?? 10,
      healthyUptimeMs: input.healthyUptimeMs ?? 5 * 60 * 1000,
    }).pipe(
      Layer.provide(Layer.succeed(ThreadExecutionSupervisor, supervisor)),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provideMerge(SessionRecoveryStateLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { dispatched };
  }

  /** Start the service; its first sweep runs immediately on a forked fiber. */
  async function startRecovery() {
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(
      Effect.gen(function* () {
        const recovery = yield* SessionRecovery;
        yield* recovery.start().pipe(Scope.provide(scope!));
      }),
    );
  }

  /** The sweep does async SQL, so assertions poll rather than yield-count. */
  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the recovery sweep.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Give the sweep room to run, for assertions that nothing should happen. */
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const readRow = (threadId: ThreadId) =>
    runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        return yield* repo.getByThreadId({ threadId });
      }),
    );

  it("reconnects a session that went down while it was meant to be running", async () => {
    const threadId = ThreadId.make("thread-down");
    const { dispatched } = createHarness({
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
    });

    await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
      }),
    );

    await startRecovery();
    await waitFor(() => dispatched.some((command) => command.type === "thread.session.restart"));

    const restarts = dispatched.filter((command) => command.type === "thread.session.restart");
    expect(restarts).toHaveLength(1);
    expect(restarts[0]?.threadId).toBe(threadId);
    expect(Option.getOrNull(await readRow(threadId))?.attempts).toBe(1);
  });

  it("leaves an intentionally stopped session alone", async () => {
    const threadId = ThreadId.make("thread-user-stopped");
    const { dispatched } = createHarness({
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "stopped" })]]),
    });

    await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
        // The user pressed stop.
        yield* repo.markStopped({ threadId, reason: "user-stop", at: now });
      }),
    );

    await startRecovery();
    await settle();

    expect(dispatched.filter((command) => command.type === "thread.session.restart")).toHaveLength(
      0,
    );
  });

  it("never disturbs a thread whose execution is still live", async () => {
    const threadId = ThreadId.make("thread-live");
    const { dispatched } = createHarness({
      snapshots: new Map([
        [
          String(threadId),
          makeSnapshot(threadId, {
            sessionState: "ready",
            activity: "active",
            canStop: true,
          }),
        ],
      ]),
    });

    await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
      }),
    );

    await startRecovery();
    await settle();

    expect(dispatched.filter((command) => command.type === "thread.session.restart")).toHaveLength(
      0,
    );
  });

  it("gives up once the attempt budget is spent", async () => {
    const threadId = ThreadId.make("thread-hopeless");
    const { dispatched } = createHarness({
      maxAttempts: 2,
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
    });

    await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
        // Already burned one attempt; the next one is the last.
        yield* repo.recordAttempt({ threadId, at: now, nextAttemptAt: now });
      }),
    );

    await startRecovery();
    await waitFor(async () => Option.getOrNull(await readRow(threadId))?.gaveUpAt != null);

    expect(Option.getOrNull(await readRow(threadId))?.gaveUpAt).not.toBe(null);
    expect(
      dispatched.some(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "session.auto-reconnect-gave-up",
      ),
    ).toBe(true);
  });

  it("stops retrying a thread it has given up on", async () => {
    const threadId = ThreadId.make("thread-gave-up");
    const { dispatched } = createHarness({
      maxAttempts: 2,
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
    });

    await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
        yield* repo.recordGaveUp({ threadId, at: now });
      }),
    );

    await startRecovery();
    await settle();

    expect(dispatched.filter((command) => command.type === "thread.session.restart")).toHaveLength(
      0,
    );
  });

  it("clears the attempt budget once a reconnected session proves healthy", async () => {
    const threadId = ThreadId.make("thread-healthy");
    const { dispatched } = createHarness({
      healthyUptimeMs: 0,
      snapshots: new Map([
        [String(threadId), makeSnapshot(threadId, { sessionState: "ready", startedAt: now })],
      ]),
    });

    await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
        yield* repo.recordAttempt({ threadId, at: now, nextAttemptAt: now });
      }),
    );

    await startRecovery();
    await waitFor(async () => Option.getOrNull(await readRow(threadId))?.recoveredAt != null);

    const row = await readRow(threadId);
    expect(Option.getOrNull(row)?.attempts).toBe(0);
    expect(Option.getOrNull(row)?.recoveredAt).not.toBe(null);
    expect(dispatched.filter((command) => command.type === "thread.session.restart")).toHaveLength(
      0,
    );
  });

  it("stops tracking an archived thread", async () => {
    const threadId = ThreadId.make("thread-archived");
    const { dispatched } = createHarness({
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
      shells: new Map([[String(threadId), makeThreadShell(threadId, now)]]),
    });

    await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
      }),
    );

    await startRecovery();
    await waitFor(
      async () => Option.getOrNull(await readRow(threadId))?.desiredState === "stopped",
    );

    expect(Option.getOrNull(await readRow(threadId))?.desiredState).toBe("stopped");
    expect(dispatched.filter((command) => command.type === "thread.session.restart")).toHaveLength(
      0,
    );
  });

  it("refunds the attempt budget when a new turn is admitted", async () => {
    const threadId = ThreadId.make("thread-new-turn");
    createHarness({
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
    });

    const row = await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
        yield* repo.recordAttempt({ threadId, at: now, nextAttemptAt: now });
        yield* repo.recordGaveUp({ threadId, at: now });
        // A fresh user turn is explicit intent and restores the budget.
        yield* repo.markRunning({
          threadId,
          executionId: "exec-2",
          reason: "turn-admitted",
          at: now,
        });
        return yield* repo.getByThreadId({ threadId });
      }),
    );

    expect(Option.getOrNull(row)?.attempts).toBe(0);
    expect(Option.getOrNull(row)?.gaveUpAt).toBe(null);
    expect(Option.getOrNull(row)?.desiredState).toBe("running");
  });

  it("does not refund the budget when the same execution re-publishes", async () => {
    const threadId = ThreadId.make("thread-same-exec");
    createHarness({
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
    });

    const row = await runtime!.runPromise(
      Effect.gen(function* () {
        const repo = yield* SessionRecoveryStateRepository;
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
        yield* repo.recordAttempt({ threadId, at: now, nextAttemptAt: now });
        yield* repo.markRunning({
          threadId,
          executionId: "exec-1",
          reason: "turn-admitted",
          at: now,
        });
        return yield* repo.getByThreadId({ threadId });
      }),
    );

    expect(Option.getOrNull(row)?.attempts).toBe(1);
  });
});
