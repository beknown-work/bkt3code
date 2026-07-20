import type {
  OrchestrationEvent,
  OrchestrationStopExecutionInput,
  OrchestrationStopExecutionResult,
  ThreadExecutionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderServiceError } from "../provider/Errors.ts";

export interface ThreadExecutionSupervisorShape {
  readonly authorityEpoch: string;
  readonly getSnapshot: (threadId: ThreadId) => Effect.Effect<ThreadExecutionSnapshot>;
  readonly getSnapshots: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyMap<ThreadId, ThreadExecutionSnapshot>>;
  readonly prepareExecution: (
    event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>,
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
  ) => Effect.Effect<OrchestrationStopExecutionResult, ProviderServiceError | SqlError>;
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
      prepareExecution: (event) => {
        const snapshot = unavailableSnapshot(event.payload.threadId);
        return Effect.succeed({
          ...snapshot,
          activity: "active",
          canStop: true,
          providerSession: {
            ...snapshot.providerSession,
            state: "starting",
            generation: 1,
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
