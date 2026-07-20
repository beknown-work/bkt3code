import {
  ThreadId,
  TurnId,
  type OrchestrationStopExecutionResult,
  type ProviderRuntimeEvent,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  increment,
  setMetric,
  threadExecutionsActive,
  threadExecutionGenerationRejectionsTotal,
  threadExecutionInvariantRepairsTotal,
  threadExecutionStopDuration,
  threadExecutionStopAcknowledgementDuration,
  threadExecutionStopEscalationsTotal,
  threadExecutionTerminationOutcomesTotal,
  threadExecutionTransitionsTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  ThreadExecutionSupervisor,
  type ThreadExecutionSupervisorShape,
} from "./ThreadExecutionSupervisor.ts";

interface ExecutionRow {
  readonly threadId: string;
  readonly authorityEpoch: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly activity: ThreadExecutionSnapshot["activity"];
  readonly canStop: number;
  readonly providerSessionState: ThreadExecutionSnapshot["providerSession"]["state"];
  readonly providerGeneration: number;
  readonly providerInstanceId: string | null;
  readonly providerStartedAt: string | null;
  readonly providerLastObservedAt: string | null;
  readonly providerLastError: string | null;
  readonly executionId: string | null;
  readonly providerTurnId: string | null;
  readonly turnState: NonNullable<ThreadExecutionSnapshot["turn"]>["state"] | null;
  readonly turnStartedAt: string | null;
  readonly stopRequestedAt: string | null;
  readonly turnCompletedAt: string | null;
  readonly turnLastError: string | null;
}

const isActiveActivity = (activity: ThreadExecutionSnapshot["activity"]) =>
  activity === "active" || activity === "blocked" || activity === "stopping";

const isTerminalTurn = (snapshot: ThreadExecutionSnapshot) =>
  snapshot.turn === null ||
  snapshot.turn.state === "completed" ||
  snapshot.turn.state === "interrupted" ||
  snapshot.turn.state === "failed";

const rowToSnapshot = (row: ExecutionRow): ThreadExecutionSnapshot => ({
  threadId: ThreadId.make(row.threadId),
  authorityEpoch: row.authorityEpoch,
  revision: row.revision,
  observedAt: row.observedAt,
  activity: row.activity,
  canStop: row.canStop !== 0,
  providerSession: {
    state: row.providerSessionState,
    generation: row.providerGeneration,
    providerInstanceId: row.providerInstanceId === null ? null : (row.providerInstanceId as never),
    startedAt: row.providerStartedAt,
    lastObservedAt: row.providerLastObservedAt,
    lastError: row.providerLastError,
  },
  turn:
    row.executionId === null || row.turnState === null || row.turnStartedAt === null
      ? null
      : {
          executionId: row.executionId,
          providerTurnId: row.providerTurnId === null ? null : TurnId.make(row.providerTurnId),
          state: row.turnState,
          startedAt: row.turnStartedAt,
          stopRequestedAt: row.stopRequestedAt,
          completedAt: row.turnCompletedAt,
          lastError: row.turnLastError,
        },
});

const make = Effect.fn("ThreadExecutionSupervisor.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const provider = yield* ProviderService;
  const orchestration = yield* OrchestrationEngineService;
  const authorityEpoch = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const state = new Map<ThreadId, ThreadExecutionSnapshot>();
  const stopOperations = new Map<string, string>();
  const completedStopOperations = new Map<string, OrchestrationStopExecutionResult>();
  const stopLocks = new Map<ThreadId, Semaphore.Semaphore>();
  const transitions = yield* Semaphore.make(1);
  const snapshots = yield* PubSub.unbounded<ThreadExecutionSnapshot>();
  const observedGaugeKeys = new Set<string>();
  const terminalWaiters = new Map<string, Set<Deferred.Deferred<ThreadExecutionSnapshot>>>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const emptySnapshot = (threadId: ThreadId, observedAt: string): ThreadExecutionSnapshot => ({
    threadId,
    authorityEpoch,
    revision: 0,
    observedAt,
    activity: "idle",
    canStop: false,
    providerSession: {
      state: "absent",
      generation: 0,
      providerInstanceId: null,
      startedAt: null,
      lastObservedAt: null,
      lastError: null,
    },
    turn: null,
  });

  const legacyStatusFor = (snapshot: ThreadExecutionSnapshot) =>
    snapshot.activity === "failed"
      ? "error"
      : isActiveActivity(snapshot.activity)
        ? "running"
        : snapshot.providerSession.state === "ready"
          ? "ready"
          : "stopped";

  const persist = Effect.fn("ThreadExecutionSupervisor.persist")(function* (
    snapshot: ThreadExecutionSnapshot,
  ) {
    yield* sql`
      INSERT INTO projection_thread_executions (
        thread_id, authority_epoch, revision, observed_at, activity, can_stop,
        provider_session_state, provider_generation, provider_instance_id,
        provider_started_at, provider_last_observed_at, provider_last_error,
        execution_id, provider_turn_id, turn_state, turn_started_at,
        stop_requested_at, turn_completed_at, turn_last_error
      ) VALUES (
        ${snapshot.threadId}, ${snapshot.authorityEpoch}, ${snapshot.revision},
        ${snapshot.observedAt}, ${snapshot.activity}, ${snapshot.canStop ? 1 : 0},
        ${snapshot.providerSession.state}, ${snapshot.providerSession.generation},
        ${snapshot.providerSession.providerInstanceId}, ${snapshot.providerSession.startedAt},
        ${snapshot.providerSession.lastObservedAt}, ${snapshot.providerSession.lastError},
        ${snapshot.turn?.executionId ?? null}, ${snapshot.turn?.providerTurnId ?? null},
        ${snapshot.turn?.state ?? null}, ${snapshot.turn?.startedAt ?? null},
        ${snapshot.turn?.stopRequestedAt ?? null}, ${snapshot.turn?.completedAt ?? null},
        ${snapshot.turn?.lastError ?? null}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        authority_epoch = excluded.authority_epoch,
        revision = excluded.revision,
        observed_at = excluded.observed_at,
        activity = excluded.activity,
        can_stop = excluded.can_stop,
        provider_session_state = excluded.provider_session_state,
        provider_generation = excluded.provider_generation,
        provider_instance_id = excluded.provider_instance_id,
        provider_started_at = excluded.provider_started_at,
        provider_last_observed_at = excluded.provider_last_observed_at,
        provider_last_error = excluded.provider_last_error,
        execution_id = excluded.execution_id,
        provider_turn_id = excluded.provider_turn_id,
        turn_state = excluded.turn_state,
        turn_started_at = excluded.turn_started_at,
        stop_requested_at = excluded.stop_requested_at,
        turn_completed_at = excluded.turn_completed_at,
        turn_last_error = excluded.turn_last_error
    `;
    const legacyStatus = legacyStatusFor(snapshot);
    // Compatibility dual-write during the cutover. This row is no longer an
    // input to execution authority, but older clients must converge instead
    // of preserving a contradictory running status.
    yield* sql`
      UPDATE projection_thread_sessions
      SET status = ${legacyStatus},
          active_turn_id = ${isActiveActivity(snapshot.activity) ? (snapshot.turn?.providerTurnId ?? null) : null},
          last_error = ${snapshot.turn?.lastError ?? snapshot.providerSession.lastError},
          updated_at = ${snapshot.observedAt}
      WHERE thread_id = ${snapshot.threadId}
    `;
  });

  const appendExecutionEvent = Effect.fn("ThreadExecutionSupervisor.appendExecutionEvent")(
    function* (
      eventType:
        | "thread.execution-stop-requested"
        | "thread.execution-state-changed"
        | "thread.execution-stop-failed",
      snapshot: ThreadExecutionSnapshot,
    ) {
      yield* sql`
        INSERT INTO thread_execution_events (
          thread_id, authority_epoch, revision, event_type, execution_id,
          activity, turn_state, error, occurred_at
        ) VALUES (
          ${snapshot.threadId}, ${snapshot.authorityEpoch}, ${snapshot.revision}, ${eventType},
          ${snapshot.turn?.executionId ?? null}, ${snapshot.activity},
          ${snapshot.turn?.state ?? null},
          ${snapshot.turn?.lastError ?? snapshot.providerSession.lastError},
          ${snapshot.observedAt}
        )
      `;
    },
  );

  const publish = Effect.fn("ThreadExecutionSupervisor.publish")(function* (
    snapshot: ThreadExecutionSnapshot,
  ) {
    state.set(snapshot.threadId, snapshot);
    const gaugeCounts = new Map<string, number>();
    for (const entry of state.values()) {
      const key = `${entry.providerSession.providerInstanceId ?? "unknown"}\u0000${entry.activity}`;
      gaugeCounts.set(key, (gaugeCounts.get(key) ?? 0) + 1);
    }
    for (const key of new Set([...observedGaugeKeys, ...gaugeCounts.keys()])) {
      const [providerInstanceId, activity] = key.split("\u0000");
      yield* setMetric(
        threadExecutionsActive,
        { providerInstanceId: providerInstanceId ?? "unknown", activity: activity ?? "unknown" },
        gaugeCounts.get(key) ?? 0,
      );
      observedGaugeKeys.add(key);
    }
    yield* persist(snapshot);
    yield* appendExecutionEvent("thread.execution-state-changed", snapshot);
    yield* PubSub.publish(snapshots, snapshot);
    if (snapshot.turn && isTerminalTurn(snapshot)) {
      const waiters = terminalWaiters.get(snapshot.turn.executionId);
      if (waiters) {
        yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, snapshot), {
          discard: true,
        });
      }
    }
  });

  const transition = (
    threadId: ThreadId,
    update: (
      current: ThreadExecutionSnapshot,
      observedAt: string,
    ) => ThreadExecutionSnapshot | null,
  ) =>
    transitions.withPermit(
      Effect.gen(function* () {
        const observedAt = yield* nowIso;
        const current = state.get(threadId) ?? emptySnapshot(threadId, observedAt);
        const next = update(current, observedAt);
        if (next === null) return current;
        const revised = {
          ...next,
          authorityEpoch,
          revision: current.revision + 1,
          observedAt,
        };
        yield* publish(revised);
        yield* increment(threadExecutionTransitionsTotal, {
          activity: revised.activity,
          providerInstanceId: revised.providerSession.providerInstanceId ?? "unknown",
          providerSessionState: revised.providerSession.state,
          turnState: revised.turn?.state ?? "none",
        });
        yield* Effect.logDebug("thread execution state changed", {
          threadId,
          authorityEpoch,
          revision: revised.revision,
          activity: revised.activity,
          providerGeneration: revised.providerSession.generation,
          executionId: revised.turn?.executionId,
          turnState: revised.turn?.state,
        });
        return revised;
      }),
    );

  const loaded = yield* sql<ExecutionRow>`
    SELECT
      thread_id AS "threadId", authority_epoch AS "authorityEpoch", revision,
      observed_at AS "observedAt", activity, can_stop AS "canStop",
      provider_session_state AS "providerSessionState",
      provider_generation AS "providerGeneration",
      provider_instance_id AS "providerInstanceId",
      provider_started_at AS "providerStartedAt",
      provider_last_observed_at AS "providerLastObservedAt",
      provider_last_error AS "providerLastError", execution_id AS "executionId",
      provider_turn_id AS "providerTurnId", turn_state AS "turnState",
      turn_started_at AS "turnStartedAt", stop_requested_at AS "stopRequestedAt",
      turn_completed_at AS "turnCompletedAt", turn_last_error AS "turnLastError"
    FROM projection_thread_executions
  `;
  for (const row of loaded) {
    const previous = rowToSnapshot(row);
    const observedAt = yield* nowIso;
    const settled: ThreadExecutionSnapshot = {
      ...previous,
      authorityEpoch,
      revision: previous.revision + 1,
      observedAt,
      activity: isActiveActivity(previous.activity) ? "idle" : previous.activity,
      canStop: previous.activity === "failed" ? previous.canStop : false,
      providerSession: {
        ...previous.providerSession,
        state: "stopped",
        lastObservedAt: observedAt,
      },
      turn:
        previous.turn && !isTerminalTurn(previous)
          ? {
              ...previous.turn,
              state: "interrupted",
              completedAt: observedAt,
              lastError: "Server authority restarted before a terminal provider observation.",
            }
          : previous.turn,
    };
    state.set(settled.threadId, settled);
    yield* persist(settled);
    yield* appendExecutionEvent("thread.execution-state-changed", settled);
    yield* increment(threadExecutionInvariantRepairsTotal, {
      mismatch: "startup-old-authority-epoch",
    });
    yield* Effect.logInfo("settled execution from an older server authority epoch", {
      threadId: settled.threadId,
      previousAuthorityEpoch: previous.authorityEpoch,
      authorityEpoch,
      revision: settled.revision,
      previousActivity: previous.activity,
    });
  }

  const prepareExecution: ThreadExecutionSupervisorShape["prepareExecution"] = (event) =>
    transition(event.payload.threadId, (current, observedAt) => {
      const executionId = String(event.commandId ?? event.eventId);
      if (
        current.turn?.executionId === executionId ||
        current.canStop ||
        (current.turn && !isTerminalTurn(current))
      ) {
        return null;
      }
      const replaceProvider =
        current.providerSession.state === "absent" ||
        current.providerSession.state === "stopped" ||
        current.providerSession.state === "failed";
      return {
        ...current,
        activity: "active",
        canStop: true,
        providerSession: {
          ...current.providerSession,
          providerInstanceId:
            event.payload.modelSelection?.instanceId ?? current.providerSession.providerInstanceId,
          state: replaceProvider ? "starting" : current.providerSession.state,
          generation: replaceProvider
            ? current.providerSession.generation + 1
            : current.providerSession.generation,
          startedAt: replaceProvider ? observedAt : current.providerSession.startedAt,
          lastObservedAt: observedAt,
          lastError: null,
        },
        turn: {
          executionId,
          providerTurnId: null,
          state: "starting",
          startedAt: event.payload.createdAt,
          stopRequestedAt: null,
          completedAt: null,
          lastError: null,
        },
      };
    });

  const observeProviderEvent = (event: ProviderRuntimeEvent) => {
    const currentSnapshot = state.get(event.threadId);
    if (
      currentSnapshot &&
      event.sessionGeneration !== undefined &&
      event.sessionGeneration !== currentSnapshot.providerSession.generation
    ) {
      return increment(threadExecutionGenerationRejectionsTotal, {
        provider: event.provider,
        eventType: event.type,
      }).pipe(
        Effect.andThen(
          Effect.logWarning("stale provider event rejected by generation fence", {
            threadId: event.threadId,
            eventType: event.type,
            eventGeneration: event.sessionGeneration,
            supervisorGeneration: currentSnapshot.providerSession.generation,
          }),
        ),
      );
    }
    return transition(event.threadId, (current, observedAt) => {
      const providerInstanceId =
        event.providerInstanceId ?? current.providerSession.providerInstanceId;
      const providerSession = {
        ...current.providerSession,
        providerInstanceId: providerInstanceId ?? null,
        lastObservedAt: observedAt,
      };
      switch (event.type) {
        case "session.started":
          return {
            ...current,
            providerSession: {
              ...providerSession,
              state: "ready",
              startedAt: current.providerSession.startedAt ?? observedAt,
              lastError: null,
            },
          };
        case "session.state.changed": {
          const stateValue = event.payload.state;
          const nextState =
            stateValue === "starting"
              ? "starting"
              : stateValue === "ready"
                ? "ready"
                : stateValue === "running" || stateValue === "waiting"
                  ? "ready"
                  : stateValue === "error"
                    ? "failed"
                    : "stopped";
          return {
            ...current,
            providerSession: {
              ...providerSession,
              state: nextState,
              lastError: event.payload.reason ?? null,
            },
          };
        }
        case "turn.started":
          if (!current.turn || current.turn.state === "stopping") return current;
          return {
            ...current,
            activity: "active",
            canStop: true,
            providerSession: { ...providerSession, state: "ready" },
            turn: {
              ...current.turn,
              providerTurnId: event.turnId ?? current.turn.providerTurnId,
              state: "running",
            },
          };
        case "request.opened":
        case "user-input.requested":
          if (!current.turn || isTerminalTurn(current)) return current;
          return {
            ...current,
            activity: "blocked",
            canStop: true,
            providerSession: { ...providerSession, state: "ready" },
            turn: {
              ...current.turn,
              state:
                event.type === "user-input.requested"
                  ? "waiting-for-input"
                  : "waiting-for-approval",
            },
          };
        case "request.resolved":
        case "user-input.resolved":
          if (!current.turn || isTerminalTurn(current)) return current;
          return {
            ...current,
            activity: current.activity === "stopping" ? "stopping" : "active",
            providerSession: { ...providerSession, state: "ready" },
            turn: {
              ...current.turn,
              state: current.turn.state === "stopping" ? "stopping" : "running",
            },
          };
        case "turn.completed":
        case "turn.aborted": {
          if (!current.turn) return current;
          if (
            event.turnId !== undefined &&
            current.turn.providerTurnId !== null &&
            event.turnId !== current.turn.providerTurnId
          )
            return null;
          const interrupted = event.type === "turn.aborted";
          return {
            ...current,
            activity: "idle",
            canStop: false,
            providerSession: {
              ...providerSession,
              state: "ready",
              lastError: null,
            },
            turn: {
              ...current.turn,
              providerTurnId: event.turnId ?? current.turn.providerTurnId,
              state: interrupted ? "interrupted" : "completed",
              completedAt: observedAt,
              lastError: null,
            },
          };
        }
        case "session.exited": {
          const failed = event.payload.exitKind === "error";
          return {
            ...current,
            activity:
              current.turn && !isTerminalTurn(current)
                ? failed
                  ? "failed"
                  : "idle"
                : current.activity,
            // The independent runtime watcher observed a real exit. A failed
            // turn remains visible, but there is no process left to stop.
            canStop: false,
            providerSession: {
              ...providerSession,
              state: failed ? "failed" : "stopped",
              lastError: failed ? (event.payload.reason ?? "Provider session exited.") : null,
            },
            turn:
              current.turn && !isTerminalTurn(current)
                ? {
                    ...current.turn,
                    state: failed ? "failed" : "interrupted",
                    completedAt: observedAt,
                    lastError: event.payload.reason ?? null,
                  }
                : current.turn,
          };
        }
        default:
          return null;
      }
    });
  };

  const getSnapshot: ThreadExecutionSupervisorShape["getSnapshot"] = (threadId) =>
    Effect.gen(function* () {
      const current = state.get(threadId);
      return current ?? emptySnapshot(threadId, yield* nowIso);
    });

  const getSnapshots: ThreadExecutionSupervisorShape["getSnapshots"] = (threadIds) =>
    Effect.forEach(threadIds, (threadId) => getSnapshot(threadId)).pipe(
      Effect.map((entries) => new Map(entries.map((entry) => [entry.threadId, entry]))),
    );

  const canContinueExecution: ThreadExecutionSupervisorShape["canContinueExecution"] = (
    threadId,
    executionId,
  ) =>
    getSnapshot(threadId).pipe(
      Effect.map(
        (snapshot) =>
          snapshot.turn?.executionId === executionId &&
          (snapshot.activity === "active" || snapshot.activity === "blocked"),
      ),
    );

  const awaitTerminal = (threadId: ThreadId, executionId: string, timeoutMs: number) =>
    Effect.gen(function* () {
      const current = yield* getSnapshot(threadId);
      if (current.turn?.executionId !== executionId || isTerminalTurn(current)) return current;
      const waiter = yield* Deferred.make<ThreadExecutionSnapshot>();
      const waiters = terminalWaiters.get(executionId) ?? new Set();
      waiters.add(waiter);
      terminalWaiters.set(executionId, waiters);

      // Re-read after registering. A terminal transition between the first
      // read and waiter registration is therefore observed here rather than
      // becoming a lost wake-up.
      const afterRegistration = yield* getSnapshot(threadId);
      if (
        afterRegistration.turn?.executionId !== executionId ||
        isTerminalTurn(afterRegistration)
      ) {
        yield* Deferred.succeed(waiter, afterRegistration);
      }

      return yield* Deferred.await(waiter).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.map(Option.getOrNull),
        Effect.ensuring(
          Effect.sync(() => {
            waiters.delete(waiter);
            if (waiters.size === 0) terminalWaiters.delete(executionId);
          }),
        ),
      );
    });

  const stopExecutionUnlocked: ThreadExecutionSupervisorShape["stopExecution"] = Effect.fn(
    "ThreadExecutionSupervisor.stopExecution",
  )(function* (input) {
    const initial = yield* getSnapshot(input.threadId);
    const executionId = initial.turn?.executionId;
    if (executionId !== undefined) {
      const completed = completedStopOperations.get(executionId);
      if (completed) return completed;
    }
    const operationId =
      executionId === undefined
        ? yield* crypto.randomUUIDv4.pipe(Effect.orDie)
        : (stopOperations.get(executionId) ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie)));
    if (executionId !== undefined) stopOperations.set(executionId, operationId);
    if (
      executionId === undefined ||
      !initial.canStop ||
      (input.expectedExecutionId !== undefined && input.expectedExecutionId !== executionId)
    ) {
      const result = {
        operationId,
        disposition: "already-stopped",
        snapshot: initial,
      } satisfies OrchestrationStopExecutionResult;
      if (
        executionId !== undefined &&
        (input.expectedExecutionId === undefined || input.expectedExecutionId === executionId)
      ) {
        completedStopOperations.set(executionId, result);
      }
      return result;
    }

    const stopping = yield* transition(input.threadId, (current, observedAt) => {
      if (current.turn?.executionId !== executionId || !current.canStop) return null;
      return {
        ...current,
        activity: "stopping",
        canStop: true,
        providerSession: { ...current.providerSession, state: "stopping" },
        turn: { ...current.turn, state: "stopping", stopRequestedAt: observedAt },
      };
    });
    yield* appendExecutionEvent("thread.execution-stop-requested", stopping);

    let inspection = yield* provider.inspectSession(input.threadId).pipe(Effect.result);
    if (inspection._tag === "Failure") {
      yield* Effect.logWarning("provider session inspection failed during stop escalation", {
        threadId: input.threadId,
        executionId,
        cause: String(inspection.failure),
      });
    }
    if (
      inspection._tag === "Success" &&
      inspection.success === null &&
      initial.providerSession.state === "starting"
    ) {
      const startupTerminal = yield* awaitTerminal(input.threadId, executionId, 5_000);
      if (startupTerminal !== null) {
        const result = {
          operationId,
          disposition: "stopping",
          snapshot: startupTerminal,
        } as const;
        completedStopOperations.set(executionId, result);
        return result;
      }
      inspection = yield* provider.inspectSession(input.threadId).pipe(Effect.result);
    }
    if (inspection._tag === "Success" && inspection.success === null) {
      const settled = yield* transition(input.threadId, (current, observedAt) => ({
        ...current,
        activity: "idle",
        canStop: false,
        providerSession: {
          ...current.providerSession,
          state: "stopped",
          lastObservedAt: observedAt,
        },
        turn: current.turn
          ? { ...current.turn, state: "interrupted", completedAt: observedAt, lastError: null }
          : null,
      }));
      const result = { operationId, disposition: "already-stopped", snapshot: settled } as const;
      completedStopOperations.set(executionId, result);
      return result;
    }

    // A stop requested before provider startup completed already spent up to
    // five seconds waiting for spawn cancellation. If a runtime appeared in
    // that window, terminate it directly so the whole operation still fits
    // the 15-second acceptance bound.
    if (initial.providerSession.state !== "starting") {
      const interrupt = yield* provider
        .requestTurnInterrupt({
          threadId: input.threadId,
          ...(initial.turn?.providerTurnId !== null && initial.turn?.providerTurnId !== undefined
            ? { turnId: initial.turn.providerTurnId }
            : {}),
        })
        .pipe(
          Effect.timeoutOption("3 seconds"),
          withMetrics({
            timer: threadExecutionStopAcknowledgementDuration,
            attributes: {
              providerInstanceId: initial.providerSession.providerInstanceId ?? "unknown",
            },
          }),
          Effect.result,
        );
      if (interrupt._tag === "Failure" || Option.isNone(interrupt.success)) {
        yield* Effect.logWarning("provider turn interrupt was not acknowledged", {
          threadId: input.threadId,
          executionId,
          ...(interrupt._tag === "Failure" ? { cause: String(interrupt.failure) } : {}),
        });
      }
      const terminal = yield* awaitTerminal(input.threadId, executionId, 5_000);
      if (terminal !== null) {
        const result = { operationId, disposition: "stopping", snapshot: terminal } as const;
        completedStopOperations.set(executionId, result);
        return result;
      }
    }

    yield* increment(threadExecutionStopEscalationsTotal, {
      providerInstanceId: initial.providerSession.providerInstanceId ?? "unknown",
    });
    const termination = yield* provider
      .terminateSession({ threadId: input.threadId })
      .pipe(Effect.timeoutOption("7 seconds"), Effect.result);
    yield* increment(threadExecutionTerminationOutcomesTotal, {
      providerInstanceId: initial.providerSession.providerInstanceId ?? "unknown",
      outcome:
        termination._tag === "Success" && Option.isSome(termination.success)
          ? termination.success.value.verified && termination.success.value.processTreeExited
            ? termination.success.value.graceful
              ? "graceful"
              : "forced"
            : "unverified"
          : "failed",
    });
    if (
      termination._tag === "Success" &&
      Option.isSome(termination.success) &&
      termination.success.value.verified &&
      termination.success.value.processTreeExited
    ) {
      const settled = yield* transition(input.threadId, (current, observedAt) => ({
        ...current,
        activity: "idle",
        canStop: false,
        providerSession: {
          ...current.providerSession,
          state: "stopped",
          lastObservedAt: observedAt,
        },
        turn: current.turn
          ? { ...current.turn, state: "interrupted", completedAt: observedAt, lastError: null }
          : null,
      }));
      const result = { operationId, disposition: "stopping", snapshot: settled } as const;
      completedStopOperations.set(executionId, result);
      return result;
    }

    const failed = yield* transition(input.threadId, (current) => ({
      ...current,
      activity: "failed",
      canStop: true,
      providerSession: {
        ...current.providerSession,
        state: "failed",
        lastError: "Provider process-tree termination could not be verified.",
      },
      turn: current.turn
        ? {
            ...current.turn,
            state: "failed",
            lastError: "Provider process-tree termination could not be verified.",
          }
        : null,
    }));
    yield* appendExecutionEvent("thread.execution-stop-failed", failed);
    yield* Effect.logError("provider process-tree termination could not be verified", {
      threadId: input.threadId,
      executionId,
      operationId,
      providerInstanceId: initial.providerSession.providerInstanceId,
    });
    const result = { operationId, disposition: "stopping", snapshot: failed } as const;
    return result;
  });

  const stopExecution: ThreadExecutionSupervisorShape["stopExecution"] = (input) =>
    Effect.gen(function* () {
      let lock = stopLocks.get(input.threadId);
      if (!lock) {
        lock = yield* Semaphore.make(1);
        stopLocks.set(input.threadId, lock);
      }
      return yield* lock.withPermit(stopExecutionUnlocked(input));
    }).pipe(
      withMetrics({
        timer: threadExecutionStopDuration,
        attributes: { threadId: input.threadId },
      }),
    );

  yield* Stream.runForEach(orchestration.streamDomainEvents, (event) =>
    event.type === "thread.turn-start-requested" ? prepareExecution(event) : Effect.void,
  ).pipe(Effect.forkScoped);
  yield* Stream.runForEach(provider.streamEvents, observeProviderEvent).pipe(Effect.forkScoped);

  const audit = Effect.suspend(() =>
    Effect.forEach(
      Array.from(state.values()).filter(
        (snapshot) =>
          isActiveActivity(snapshot.activity) ||
          (snapshot.activity === "failed" && snapshot.canStop),
      ),
      (snapshot) =>
        Effect.gen(function* () {
          const inspection = yield* provider.inspectSession(snapshot.threadId);
          if (inspection === null || !inspection.runtimeAlive) {
            yield* increment(threadExecutionInvariantRepairsTotal, {
              mismatch: inspection === null ? "missing-session" : "dead-runtime",
            });
            yield* transition(snapshot.threadId, (current, observedAt) => ({
              ...current,
              activity: "idle",
              canStop: false,
              providerSession: {
                ...current.providerSession,
                state: "stopped",
                lastObservedAt: observedAt,
              },
              turn:
                current.turn && !isTerminalTurn(current)
                  ? { ...current.turn, state: "interrupted", completedAt: observedAt }
                  : current.turn,
            }));
            return;
          }
          if (snapshot.activity === "failed" && snapshot.canStop) {
            const termination = yield* provider
              .terminateSession({ threadId: snapshot.threadId })
              .pipe(Effect.timeoutOption("7 seconds"));
            if (
              Option.isSome(termination) &&
              termination.value.verified &&
              termination.value.processTreeExited
            ) {
              yield* increment(threadExecutionInvariantRepairsTotal, {
                mismatch: "termination-retry-succeeded",
              });
              yield* transition(snapshot.threadId, (current, observedAt) => ({
                ...current,
                activity: "idle",
                canStop: false,
                providerSession: {
                  ...current.providerSession,
                  state: "stopped",
                  lastObservedAt: observedAt,
                  lastError: null,
                },
                turn: current.turn
                  ? {
                      ...current.turn,
                      state: "interrupted",
                      completedAt: observedAt,
                      lastError: null,
                    }
                  : null,
              }));
              return;
            }
          }
          if (
            inspection.generation > 0 &&
            inspection.generation !== snapshot.providerSession.generation
          ) {
            yield* Effect.logWarning("provider generation mismatch detected", {
              threadId: snapshot.threadId,
              supervisorGeneration: snapshot.providerSession.generation,
              adapterGeneration: inspection.generation,
            });
          }
          const legacyRows = yield* sql<{ readonly status: string }>`
            SELECT status FROM projection_thread_sessions WHERE thread_id = ${snapshot.threadId}
          `;
          if (legacyRows[0] && legacyRows[0].status !== legacyStatusFor(snapshot)) {
            yield* increment(threadExecutionInvariantRepairsTotal, {
              mismatch: "legacy-projection",
            });
            yield* Effect.logWarning("thread execution projection mismatch repaired", {
              threadId: snapshot.threadId,
              executionStatus: snapshot.activity,
              legacyStatus: legacyRows[0].status,
            });
            yield* persist(snapshot);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread execution invariant audit failed", {
              threadId: snapshot.threadId,
              cause,
            }),
          ),
        ),
      { discard: true },
    ),
  );
  yield* Effect.forever(Effect.sleep("15 seconds").pipe(Effect.andThen(audit))).pipe(
    Effect.forkScoped,
  );

  return {
    authorityEpoch,
    getSnapshot,
    getSnapshots,
    prepareExecution,
    canContinueExecution,
    stopExecution,
    get streamSnapshots() {
      return Stream.fromPubSub(snapshots);
    },
  } satisfies ThreadExecutionSupervisorShape;
});

export const ThreadExecutionSupervisorLive = Layer.effect(ThreadExecutionSupervisor, make());
