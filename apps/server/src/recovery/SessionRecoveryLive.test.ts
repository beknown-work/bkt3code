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
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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

function makeHarness(input: {
  readonly snapshots?: ReadonlyMap<string, ThreadExecutionSnapshot>;
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
  } as unknown as typeof OrchestrationEngineService.Service;

  const supervisor = {
    getSnapshot: (threadId: ThreadId) =>
      Effect.succeed(input.snapshots?.get(String(threadId)) ?? makeSnapshot(threadId)),
  } as unknown as typeof ThreadExecutionSupervisor.Service;

  const snapshotQuery = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        Option.some(
          input.shells?.get(String(threadId)) ?? makeThreadShell(threadId),
        ) as Option.Option<never>,
      ),
  } as unknown as typeof ProjectionSnapshotQuery.Service;

  const layer = makeSessionRecoveryLive({
    // Long interval: each test drives the immediate first sweep and asserts on
    // it, rather than racing a timer.
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

  return { dispatched, layer };
}

/** The sweep runs on a forked fiber doing async SQL, so assertions poll. */
const waitUntil = (predicate: () => Effect.Effect<boolean>, remaining = 300): Effect.Effect<void> =>
  Effect.flatMap(predicate(), (satisfied) =>
    satisfied
      ? Effect.void
      : remaining <= 0
        ? Effect.die(new Error("Timed out waiting for the recovery sweep."))
        : Effect.flatMap(Effect.sleep("10 millis"), () => waitUntil(predicate, remaining - 1)),
  );

/** Let the first sweep finish when asserting that nothing should happen. */
const settle = Effect.sleep("300 millis");

const startRecovery = Effect.flatMap(SessionRecovery, (recovery) => recovery.start());

const readRow = (threadId: ThreadId) =>
  Effect.flatMap(SessionRecoveryStateRepository, (repo) => repo.getByThreadId({ threadId })).pipe(
    Effect.map(Option.getOrNull),
    Effect.orDie,
  );

const markRunning = (threadId: ThreadId, executionId: string) =>
  Effect.flatMap(SessionRecoveryStateRepository, (repo) =>
    repo.markRunning({ threadId, executionId, reason: "turn-admitted", at: now }),
  ).pipe(Effect.orDie);

const restartsIn = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.filter((command) => command.type === "thread.session.restart");

describe("SessionRecovery", () => {
  it.live("reconnects a session that went down while it was meant to be running", () => {
    const threadId = ThreadId.make("thread-down");
    const harness = makeHarness({
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
    });

    return Effect.gen(function* () {
      yield* markRunning(threadId, "exec-1");
      yield* startRecovery;
      yield* waitUntil(() => Effect.sync(() => restartsIn(harness.dispatched).length > 0));

      const restarts = restartsIn(harness.dispatched);
      expect(restarts).toHaveLength(1);
      expect(restarts[0]?.threadId).toBe(threadId);
      expect((yield* readRow(threadId))?.attempts).toBe(1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("leaves an intentionally stopped session alone", () => {
    const threadId = ThreadId.make("thread-user-stopped");
    const harness = makeHarness({
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "stopped" })]]),
    });

    return Effect.gen(function* () {
      const repo = yield* SessionRecoveryStateRepository;
      yield* markRunning(threadId, "exec-1");
      // The user pressed stop.
      yield* repo.markStopped({ threadId, reason: "user-stop", at: now }).pipe(Effect.orDie);

      yield* startRecovery;
      yield* settle;

      expect(restartsIn(harness.dispatched)).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("never disturbs a thread whose execution is still live", () => {
    const threadId = ThreadId.make("thread-live");
    const harness = makeHarness({
      snapshots: new Map([
        [
          String(threadId),
          makeSnapshot(threadId, { sessionState: "ready", activity: "active", canStop: true }),
        ],
      ]),
    });

    return Effect.gen(function* () {
      yield* markRunning(threadId, "exec-1");
      yield* startRecovery;
      yield* settle;

      expect(restartsIn(harness.dispatched)).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("gives up once the attempt budget is spent", () => {
    const threadId = ThreadId.make("thread-hopeless");
    const harness = makeHarness({
      maxAttempts: 2,
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
    });

    return Effect.gen(function* () {
      const repo = yield* SessionRecoveryStateRepository;
      yield* markRunning(threadId, "exec-1");
      // Already burned one attempt; the next one is the last.
      yield* repo.recordAttempt({ threadId, at: now, nextAttemptAt: now }).pipe(Effect.orDie);

      yield* startRecovery;
      yield* waitUntil(() => Effect.map(readRow(threadId), (row) => row?.gaveUpAt != null));

      expect((yield* readRow(threadId))?.gaveUpAt).not.toBe(null);
      expect(
        harness.dispatched.some(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "session.auto-reconnect-gave-up",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("stops retrying a thread it has given up on", () => {
    const threadId = ThreadId.make("thread-gave-up");
    const harness = makeHarness({
      maxAttempts: 2,
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
    });

    return Effect.gen(function* () {
      const repo = yield* SessionRecoveryStateRepository;
      yield* markRunning(threadId, "exec-1");
      yield* repo.recordGaveUp({ threadId, at: now }).pipe(Effect.orDie);

      yield* startRecovery;
      yield* settle;

      expect(restartsIn(harness.dispatched)).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("clears the attempt budget once a reconnected session proves healthy", () => {
    const threadId = ThreadId.make("thread-healthy");
    const harness = makeHarness({
      healthyUptimeMs: 0,
      snapshots: new Map([
        [String(threadId), makeSnapshot(threadId, { sessionState: "ready", startedAt: now })],
      ]),
    });

    return Effect.gen(function* () {
      const repo = yield* SessionRecoveryStateRepository;
      yield* markRunning(threadId, "exec-1");
      yield* repo.recordAttempt({ threadId, at: now, nextAttemptAt: now }).pipe(Effect.orDie);

      yield* startRecovery;
      yield* waitUntil(() => Effect.map(readRow(threadId), (row) => row?.recoveredAt != null));

      const row = yield* readRow(threadId);
      expect(row?.attempts).toBe(0);
      expect(row?.recoveredAt).not.toBe(null);
      expect(restartsIn(harness.dispatched)).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.live("stops tracking an archived thread", () => {
    const threadId = ThreadId.make("thread-archived");
    const harness = makeHarness({
      snapshots: new Map([[String(threadId), makeSnapshot(threadId, { sessionState: "failed" })]]),
      shells: new Map([[String(threadId), makeThreadShell(threadId, now)]]),
    });

    return Effect.gen(function* () {
      yield* markRunning(threadId, "exec-1");
      yield* startRecovery;
      yield* waitUntil(() =>
        Effect.map(readRow(threadId), (row) => row?.desiredState === "stopped"),
      );

      expect((yield* readRow(threadId))?.desiredState).toBe("stopped");
      expect(restartsIn(harness.dispatched)).toHaveLength(0);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("refunds the attempt budget when a new turn is admitted", () => {
    const threadId = ThreadId.make("thread-new-turn");
    const harness = makeHarness({});

    return Effect.gen(function* () {
      const repo = yield* SessionRecoveryStateRepository;
      yield* markRunning(threadId, "exec-1");
      yield* repo.recordAttempt({ threadId, at: now, nextAttemptAt: now }).pipe(Effect.orDie);
      yield* repo.recordGaveUp({ threadId, at: now }).pipe(Effect.orDie);
      // A fresh user turn is explicit intent and restores the budget.
      yield* markRunning(threadId, "exec-2");

      const row = yield* readRow(threadId);
      expect(row?.attempts).toBe(0);
      expect(row?.gaveUpAt).toBe(null);
      expect(row?.desiredState).toBe("running");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });

  it.effect("does not refund the budget when the same execution re-publishes", () => {
    const threadId = ThreadId.make("thread-same-exec");
    const harness = makeHarness({});

    return Effect.gen(function* () {
      const repo = yield* SessionRecoveryStateRepository;
      yield* markRunning(threadId, "exec-1");
      yield* repo.recordAttempt({ threadId, at: now, nextAttemptAt: now }).pipe(Effect.orDie);
      yield* markRunning(threadId, "exec-1");

      expect((yield* readRow(threadId))?.attempts).toBe(1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  });
});
