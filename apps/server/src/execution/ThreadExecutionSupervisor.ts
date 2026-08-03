import type {
  OrchestrationEvent,
  OrchestrationStopExecutionInput,
  OrchestrationStopExecutionResult,
  ProviderInstanceId,
  ThreadTurnAdmissionConflictError,
  ThreadExecutionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/unstable/sql/SqlError";
// T3-CUSTOM(expbkt3): durable stop fencing can fail before provider shutdown.
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProviderServiceError } from "../provider/Errors.ts";

export interface ThreadTurnAdmissionInput {
  readonly threadId: ThreadId;
  readonly executionId: string;
  readonly expectedExecutionRevision: number;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly startedAt: string;
}

export interface ThreadExecutionSupervisorShape {
  readonly authorityEpoch: string;
  readonly getSnapshot: (threadId: ThreadId) => Effect.Effect<ThreadExecutionSnapshot>;
  readonly getSnapshots: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyMap<ThreadId, ThreadExecutionSnapshot>>;
  /** T3-CUSTOM(expbkt3): publish the latest durable desired state after coordinator changes. */
  readonly refreshIntent: (threadId: ThreadId) => Effect.Effect<ThreadExecutionSnapshot>;
  readonly prepareExecution: (
    event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>,
  ) => Effect.Effect<ThreadExecutionSnapshot, SqlError>;
  /** T3-CUSTOM(expbkt3): re-admit the same durable execution after authority loss. */
  readonly recoverExecution: (
    event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>,
  ) => Effect.Effect<ThreadExecutionSnapshot, SqlError>;
  readonly admitIdleTurn: (
    input: ThreadTurnAdmissionInput,
  ) => Effect.Effect<ThreadExecutionSnapshot, ThreadTurnAdmissionConflictError | SqlError>;
  readonly releaseTurnAdmission: (
    threadId: ThreadId,
    executionId: string,
  ) => Effect.Effect<ThreadExecutionSnapshot, SqlError>;
  readonly canContinueExecution: (
    threadId: ThreadId,
    executionId: string,
  ) => Effect.Effect<boolean>;
  readonly failExecution: (
    threadId: ThreadId,
    executionId: string,
    error: string,
  ) => Effect.Effect<ThreadExecutionSnapshot, SqlError>;
  readonly stopExecution: (
    input: OrchestrationStopExecutionInput,
  ) => Effect.Effect<
    OrchestrationStopExecutionResult,
    ProviderServiceError | ProjectionRepositoryError | SqlError
  >;
  readonly streamSnapshots: Stream.Stream<ThreadExecutionSnapshot>;
}

const unavailableSnapshot = (threadId: ThreadId): ThreadExecutionSnapshot => ({
  threadId,
  authorityEpoch: "unavailable",
  revision: 0,
  observedAt: "1970-01-01T00:00:00.000Z",
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

export class ThreadExecutionSupervisor extends Context.Reference<ThreadExecutionSupervisorShape>(
  "t3/execution/ThreadExecutionSupervisor",
  {
    defaultValue: () => ({
      authorityEpoch: "unavailable",
      getSnapshot: (threadId) => Effect.succeed(unavailableSnapshot(threadId)),
      getSnapshots: (threadIds) =>
        Effect.succeed(
          new Map(threadIds.map((threadId) => [threadId, unavailableSnapshot(threadId)])),
        ),
      // T3-CUSTOM(expbkt3): unavailable fallback has no durable repository.
      refreshIntent: (threadId) => Effect.succeed(unavailableSnapshot(threadId)),
      prepareExecution: (event) => {
        const snapshot = unavailableSnapshot(event.payload.threadId);
        return Effect.succeed({
          ...snapshot,
          activity: "active",
          canStop: true,
          providerSession: {
            ...snapshot.providerSession,
            state: "starting",
            generation: 0,
          },
          turn: {
            executionId: String(event.commandId ?? event.eventId),
            providerTurnId: null,
            state: "starting",
            startedAt: event.payload.createdAt,
            stopRequestedAt: null,
            completedAt: null,
            lastError: null,
          },
        });
      },
      // T3-CUSTOM(expbkt3): unavailable supervisor still models a recovery admission.
      recoverExecution: (event) => {
        const snapshot = unavailableSnapshot(event.payload.threadId);
        return Effect.succeed({
          ...snapshot,
          activity: "active",
          canStop: true,
          providerSession: { ...snapshot.providerSession, state: "starting" },
          turn: {
            executionId: String(event.commandId ?? event.eventId),
            providerTurnId: null,
            state: "starting",
            startedAt: event.payload.createdAt,
            stopRequestedAt: null,
            completedAt: null,
            lastError: null,
          },
        });
      },
      admitIdleTurn: (input) =>
        Effect.succeed({
          ...unavailableSnapshot(input.threadId),
          activity: "active",
          canStop: true,
          turn: {
            executionId: input.executionId,
            providerTurnId: null,
            state: "starting",
            startedAt: input.startedAt,
            stopRequestedAt: null,
            completedAt: null,
            lastError: null,
          },
        }),
      releaseTurnAdmission: (threadId) => Effect.succeed(unavailableSnapshot(threadId)),
      canContinueExecution: () => Effect.succeed(true),
      failExecution: (threadId, executionId, error) => {
        const snapshot = unavailableSnapshot(threadId);
        return Effect.succeed({
          ...snapshot,
          activity: "failed",
          providerSession: { ...snapshot.providerSession, state: "failed", lastError: error },
          turn: {
            executionId,
            providerTurnId: null,
            state: "failed",
            startedAt: snapshot.observedAt,
            stopRequestedAt: null,
            completedAt: snapshot.observedAt,
            lastError: error,
          },
        });
      },
      stopExecution: (input) =>
        Effect.succeed({
          operationId: "unavailable",
          disposition: "already-stopped",
          snapshot: unavailableSnapshot(input.threadId),
        }),
      streamSnapshots: Stream.empty,
    }),
  },
) {}
