import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
// T3-CUSTOM(expbkt3): deterministic late subscriber delivery barrier.
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { ThreadExecutionSupervisor } from "./ThreadExecutionSupervisor.ts";
import { ThreadExecutionSupervisorLive } from "./ThreadExecutionSupervisorLive.ts";
// T3-CUSTOM(expbkt3): verifies Stop fences the durable coordinator claim.
import { DurableExecutionIntentRepositoryLive } from "./DurableExecutionIntentRepository.ts";
// T3-CUSTOM(expbkt3): the supervisor journals session-recovery intent.
import { layer as SessionRecoveryStateLayer } from "../persistence/SessionRecoveryState.ts";

const threadId = ThreadId.make("thread-execution-supervisor");
const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const createdAt = "2026-07-20T00:00:00.000Z";

const startEvent = (
  suffix: string,
): Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }> =>
  ({
    type: "thread.turn-start-requested",
    eventId: EventId.make(`event-${suffix}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: createdAt,
    commandId: CommandId.make(`command-${suffix}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`command-${suffix}`),
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(`message-${suffix}`),
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    },
  }) as Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

const layer = it.layer(SqlitePersistenceMemory);

layer("ThreadExecutionSupervisor", (it) => {
  // T3-CUSTOM(expbkt3): durable desired state is streamed with provider observation.
  it.effect("joins and refreshes the durable intent in execution snapshots", () =>
    Effect.gen(function* () {
      const stoppedSetupTerminals: Array<{
        readonly threadId: string;
        readonly terminalId: string;
      }> = [];
      const providerService = {
        inspectSession: () => Effect.succeed(null),
        streamEvents: Stream.empty,
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        Layer.provide(DurableExecutionIntentRepositoryLive),
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(
          Layer.succeed(TerminalManager, {
            stopCommand: (input: { readonly threadId: string; readonly terminalId: string }) =>
              Effect.sync(() => void stoppedSetupTerminals.push(input)),
          } as unknown as TerminalManager["Service"]),
        ),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const supervisor = yield* ThreadExecutionSupervisor;
        const intentThreadId = ThreadId.make("thread-execution-intent-snapshot");
        yield* sql`
          INSERT INTO projection_thread_execution_intents (
            work_item_id, thread_id, message_id, command_id,
            desired_state, phase, delivery_certainty, runnable, bootstrap_json,
            accepted_at, updated_at
          ) VALUES (
            'command-intent', ${intentThreadId}, 'message-intent', 'command-intent',
            'running', 'recovering', 'uncertain', 1,
            '{"resolvedRequest":{"workspace":{"mode":"new-worktree","projectCwd":"/project","baseRef":{"kind":"branch","source":"local","branch":"main"},"intendedPath":"/worktree","newBranch":"t3code/setup"}}}',
            ${createdAt}, ${createdAt}
          )
        `;
        yield* sql`
          INSERT INTO thread_execution_bootstrap_operations (
            work_item_id, thread_id, worktree_phase, worktree_path,
            setup_phase, setup_terminal_id, updated_at
          ) VALUES (
            'command-intent', ${intentThreadId}, 'acknowledged', '/worktree',
            'running', 'setup-command-intent', ${createdAt}
          )
        `;
        // A queued follow-up is newer in the snapshot order but does not own
        // the running setup that this Stop must terminate.
        yield* sql`
          INSERT INTO projection_thread_execution_intents (
            work_item_id, thread_id, message_id, command_id, request_event_sequence,
            desired_state, phase, delivery_certainty, runnable, accepted_at, updated_at
          ) VALUES (
            'command-followup', ${intentThreadId}, 'message-followup', 'command-followup', 9001,
            'running', 'queued', 'never-delivered', 0, ${createdAt}, ${createdAt}
          )
        `;

        const refreshed = yield* supervisor.refreshIntent(intentThreadId);
        const snapshot = yield* supervisor.getSnapshot(intentThreadId);

        assert.strictEqual(refreshed.revision, 1);
        assert.strictEqual(snapshot.intent?.workItemId, "command-followup");
        assert.strictEqual(snapshot.intent?.phase, "queued");
        assert.strictEqual(snapshot.intent?.recovery.maximumAttempts, 10);

        const stopped = yield* supervisor.stopExecution({ threadId: intentThreadId });
        const rows = yield* sql<{
          readonly desiredState: string;
          readonly runnable: number;
          readonly claimGeneration: number;
        }>`
          SELECT desired_state AS "desiredState", runnable,
                 claim_generation AS "claimGeneration"
          FROM projection_thread_execution_intents
          WHERE work_item_id = 'command-intent'
        `;

        assert.strictEqual(stopped.disposition, "already-stopped");
        assert.strictEqual(stopped.snapshot.intent, undefined);
        assert.strictEqual(rows[0]?.desiredState, "stopped");
        assert.strictEqual(rows[0]?.runnable, 0);
        assert.strictEqual(rows[0]?.claimGeneration, 1);
        assert.deepStrictEqual(stoppedSetupTerminals, [
          { threadId: intentThreadId, terminalId: "setup-command-intent" },
        ]);
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  // T3-CUSTOM(expbkt3): persisted request ownership wins over a newer queued
  // follow-up and survives a supervisor restart with no in-memory request map.
  it.effect("reconciles simultaneous persisted native blockers before a queued follow-up", () =>
    Effect.gen(function* () {
      const providerService = {
        inspectSession: () => Effect.succeed(null),
        streamEvents: Stream.empty,
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        Layer.provide(DurableExecutionIntentRepositoryLive),
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const supervisor = yield* ThreadExecutionSupervisor;
        const persistedThreadId = ThreadId.make("thread-persisted-native-blockers");
        yield* supervisor.admitIdleTurn({
          threadId: persistedThreadId,
          executionId: "persisted-execution",
          expectedExecutionRevision: 0,
          providerInstanceId,
          startedAt: createdAt,
        });
        yield* sql`
          INSERT INTO projection_thread_execution_intents (
            work_item_id, thread_id, message_id, command_id, desired_state, phase,
            delivery_certainty, runnable, request_event_sequence, accepted_at, updated_at
          ) VALUES
            ('blocked-intent', ${persistedThreadId}, 'blocked-message', 'blocked-command', 'running', 'waiting-for-input', 'provider-acknowledged', 0, 1, ${createdAt}, ${createdAt}),
            ('queued-followup', ${persistedThreadId}, 'queued-message', 'queued-command', 'running', 'queued', 'provider-acknowledged', 1, 2, ${createdAt}, ${createdAt})
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES
            ('native-a-request', ${persistedThreadId}, NULL, 'info', 'user-input.requested', 'Question A', '{"requestId":"native-a"}', 10, ${createdAt}),
            ('native-b-request', ${persistedThreadId}, NULL, 'info', 'user-input.requested', 'Question B', '{"requestId":"native-b"}', 11, ${createdAt}),
            ('async-question', ${persistedThreadId}, NULL, 'info', 'user-input.requested', 'Async question', '{"requestId":"async-only","responseMode":"message"}', 12, ${createdAt})
        `;

        let snapshot = yield* supervisor.refreshIntent(persistedThreadId);
        assert.strictEqual(snapshot.activity, "blocked");
        assert.strictEqual(snapshot.turn?.state, "waiting-for-input");
        assert.strictEqual(snapshot.intent?.workItemId, "queued-followup");

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES ('native-a-resolved', ${persistedThreadId}, NULL, 'info', 'user-input.resolved', 'Answered', '{"requestId":"native-a"}', 13, ${createdAt})
        `;
        snapshot = yield* supervisor.refreshIntent(persistedThreadId);
        assert.strictEqual(snapshot.activity, "blocked");
        assert.strictEqual(snapshot.turn?.state, "waiting-for-input");

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES ('native-b-resolved', ${persistedThreadId}, NULL, 'info', 'user-input.resolved', 'Answered', '{"requestId":"native-b"}', 14, ${createdAt})
        `;
        snapshot = yield* supervisor.refreshIntent(persistedThreadId);
        assert.strictEqual(snapshot.activity, "active");
        assert.strictEqual(snapshot.turn?.state, "running");
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  it.effect("atomically admits only one idle turn and makes same-command retries idempotent", () =>
    Effect.gen(function* () {
      const providerService = {
        inspectSession: () => Effect.succeed(null),
        streamEvents: Stream.empty,
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        // T3-CUSTOM(expbkt3): session recovery desired-state journal.
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const supervisor = yield* ThreadExecutionSupervisor;
        const results = yield* Effect.all(
          ["automatic-a", "automatic-b"].map((executionId) =>
            supervisor
              .admitIdleTurn({
                threadId,
                executionId,
                expectedExecutionRevision: 0,
                providerInstanceId,
                startedAt: createdAt,
              })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        const admitted = results.find(Result.isSuccess);
        const rejected = results.find(Result.isFailure);
        assert.isDefined(admitted);
        assert.isDefined(rejected);
        if (Result.isFailure(rejected!)) {
          assert.strictEqual(rejected.failure._tag, "ThreadTurnAdmissionConflictError");
          if (rejected.failure._tag === "ThreadTurnAdmissionConflictError") {
            assert.strictEqual(rejected.failure.actualExecutionRevision, 1);
          }
        }
        if (Result.isSuccess(admitted!)) {
          const duplicate = yield* supervisor.admitIdleTurn({
            threadId,
            executionId: admitted.success.turn!.executionId,
            expectedExecutionRevision: 0,
            providerInstanceId,
            startedAt: createdAt,
          });
          assert.strictEqual(duplicate.revision, admitted.success.revision);
          assert.strictEqual(duplicate.turn?.executionId, admitted.success.turn?.executionId);

          const released = yield* supervisor.releaseTurnAdmission(
            threadId,
            admitted.success.turn!.executionId,
          );
          assert.strictEqual(released.activity, "idle");
          assert.strictEqual(released.turn, null);
        }
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  // T3-CUSTOM(expbkt3): native completion may precede the independent domain subscriber.
  it.effect(
    "ignores delayed native command delivery while allowing explicit older queued dispatch",
    () =>
      Effect.gen(function* () {
        const deliver = yield* Deferred.make<void>();
        const subscriptionDrained = yield* Deferred.make<void>();
        const nativeEvent = { ...startEvent("native-delayed"), sequence: 10 };
        const providerService = {
          inspectSession: () => Effect.succeed(null),
          streamEvents: Stream.empty,
        } as unknown as ProviderServiceShape;
        const orchestration = {
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          dispatch: () => Effect.succeed({ sequence: 0 }),
          streamDomainEvents: Stream.concat(
            Stream.fromEffect(Deferred.await(deliver).pipe(Effect.as(nativeEvent))),
            // The next stream is pulled only after runForEach has handled the event.
            Stream.fromEffect(Deferred.succeed(subscriptionDrained, undefined)).pipe(Stream.drain),
          ),
          latestSequence: Effect.succeed(10),
        } satisfies OrchestrationEngineService["Service"];
        const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
          Layer.provide(SessionRecoveryStateLayer),
          Layer.provide(Layer.succeed(ProviderService, providerService)),
          Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const supervisor = yield* ThreadExecutionSupervisor;
          yield* supervisor.prepareExecution(nativeEvent);
          const released = yield* supervisor.releaseTurnAdmission(
            threadId,
            "command-native-delayed",
            10,
          );
          assert.strictEqual(released.turn, null);
          yield* Deferred.succeed(deliver, undefined);
          yield* Deferred.await(subscriptionDrained);
          const afterDelivery = yield* supervisor.getSnapshot(threadId);
          assert.strictEqual(afterDelivery.revision, released.revision);
          assert.strictEqual(afterDelivery.activity, "idle");
          assert.strictEqual(afterDelivery.canStop, false);
          assert.strictEqual(afterDelivery.turn, null);
          const queued = yield* supervisor.prepareExecution({
            ...startEvent("older-queued"),
            sequence: 9,
          });
          assert.strictEqual(queued.turn?.executionId, "command-older-queued");
          assert.strictEqual(queued.activity, "active");
        }).pipe(Effect.provide(supervisorLayer));
      }),
  );

  // T3-CUSTOM(expbkt3): a classified compact command must not let the real
  // subscriber overwrite an already-ready compatibility session as running.
  it.effect("does not admit a classified compact event through the real subscriber", () =>
    Effect.gen(function* () {
      const delivered = yield* Deferred.make<void>();
      const compactEvent = {
        ...startEvent("classified-compact"),
        sequence: 11,
        payload: { ...startEvent("classified-compact").payload, isCompaction: true },
      };
      const providerService = {
        inspectSession: () => Effect.succeed(null),
        streamEvents: Stream.empty,
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.concat(
          Stream.make(compactEvent),
          Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
        ),
        latestSequence: Effect.succeed(11),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const supervisor = yield* ThreadExecutionSupervisor;
        yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at) VALUES (${threadId}, 'ready', ${createdAt})`;
        yield* Deferred.await(delivered);
        assert.strictEqual((yield* supervisor.getSnapshot(threadId)).activity, "idle");
        const rows = yield* sql<{
          readonly status: string;
        }>`SELECT status FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
        assert.strictEqual(rows[0]?.status, "ready");
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  it.effect("installs ownership before spawn, fences stale stops, and deduplicates stops", () =>
    Effect.gen(function* () {
      const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>({ replay: 1 });
      const interruptCount = yield* Ref.make(0);
      const providerService = {
        inspectSession: () =>
          Effect.succeed({
            threadId,
            generation: 1,
            state: "running" as const,
            activeProviderTurnId: TurnId.make("provider-turn"),
            runtimeAlive: true,
          }),
        requestTurnInterrupt: () =>
          Ref.update(interruptCount, (count) => count + 1).pipe(
            Effect.andThen(
              PubSub.publish(runtimeEvents, {
                type: "turn.aborted",
                eventId: EventId.make("provider-aborted"),
                provider,
                providerInstanceId,
                threadId,
                sessionGeneration: 1,
                turnId: TurnId.make("provider-turn"),
                createdAt,
                payload: { reason: "Interrupted by test." },
              }),
            ),
            Effect.as({ acknowledged: true, acknowledgedAt: createdAt }),
          ),
        terminateSession: () =>
          Effect.succeed({ verified: true, graceful: true, processTreeExited: true }),
        streamEvents: Stream.fromPubSub(runtimeEvents),
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        // T3-CUSTOM(expbkt3): session recovery desired-state journal.
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const supervisor = yield* ThreadExecutionSupervisor;
        yield* Effect.yieldNow;
        const firstEvent = startEvent("one");
        const first = yield* supervisor.prepareExecution(firstEvent);
        assert.strictEqual(first.activity, "active");
        assert.strictEqual(first.providerSession.state, "starting");
        assert.strictEqual(first.providerSession.generation, 0);
        assert.strictEqual(first.turn?.executionId, "command-one");

        yield* PubSub.publish(runtimeEvents, {
          type: "turn.started",
          eventId: EventId.make("provider-turn-started"),
          provider,
          providerInstanceId,
          threadId,
          sessionGeneration: 1,
          turnId: TurnId.make("provider-turn"),
          createdAt,
          payload: {},
        });
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        assert.strictEqual((yield* supervisor.getSnapshot(threadId)).turn?.state, "running");

        const stopped = yield* supervisor.stopExecution({
          threadId,
          expectedExecutionId: "command-one",
        });
        assert.strictEqual(stopped.snapshot.activity, "idle");
        assert.strictEqual(stopped.snapshot.turn?.state, "interrupted");

        const duplicate = yield* supervisor.stopExecution({
          threadId,
          expectedExecutionId: "command-one",
        });
        assert.strictEqual(duplicate.operationId, stopped.operationId);
        assert.strictEqual(yield* Ref.get(interruptCount), 1);

        const second = yield* supervisor.prepareExecution(startEvent("two"));
        assert.strictEqual(second.turn?.executionId, "command-two");
        const staleStop = yield* supervisor.stopExecution({
          threadId,
          expectedExecutionId: "command-one",
        });
        assert.strictEqual(staleStop.disposition, "already-stopped");
        assert.strictEqual(staleStop.snapshot.turn?.executionId, "command-two");
        assert.strictEqual(staleStop.snapshot.activity, "active");
        assert.strictEqual(yield* Ref.get(interruptCount), 1);
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  it.effect("treats a missing provider session as already stopped", () =>
    Effect.gen(function* () {
      const providerService = {
        inspectSession: () => Effect.succeed(null),
        streamEvents: Stream.empty,
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        // T3-CUSTOM(expbkt3): session recovery desired-state journal.
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const supervisor = yield* ThreadExecutionSupervisor;
        yield* supervisor.prepareExecution(startEvent("missing"));
        const stopping = yield* supervisor
          .stopExecution({ threadId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(stopping);
        assert.strictEqual(result.disposition, "already-stopped");
        assert.strictEqual(result.snapshot.activity, "idle");
        assert.strictEqual(result.snapshot.canStop, false);
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  // T3-CUSTOM(expbkt3): Durable bootstrap admits work before a provider runtime exists.
  it.effect("does not reap an admitted execution before its provider runtime exists", () =>
    Effect.gen(function* () {
      const inspectionCount = yield* Ref.make(0);
      const providerService = {
        inspectSession: () =>
          Ref.update(inspectionCount, (count) => count + 1).pipe(Effect.as(null)),
        streamEvents: Stream.empty,
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        // T3-CUSTOM(expbkt3): session recovery desired-state journal.
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const supervisor = yield* ThreadExecutionSupervisor;
        const prepared = yield* supervisor.prepareExecution(startEvent("slow-start"));
        assert.strictEqual(prepared.providerSession.state, "starting");

        yield* TestClock.adjust("16 seconds");
        yield* Effect.yieldNow;

        const audited = yield* supervisor.getSnapshot(threadId);
        assert.strictEqual(audited.activity, "active");
        assert.strictEqual(audited.turn?.state, "starting");
        assert.strictEqual(audited.providerSession.state, "starting");
        assert.isAtLeast(yield* Ref.get(inspectionCount), 1);
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  it.effect("publishes provider startup failures as authoritative execution errors", () =>
    Effect.gen(function* () {
      const providerService = {
        inspectSession: () => Effect.succeed(null),
        streamEvents: Stream.empty,
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        // T3-CUSTOM(expbkt3): session recovery desired-state journal.
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const supervisor = yield* ThreadExecutionSupervisor;
        const prepared = yield* supervisor.prepareExecution(startEvent("failed-start"));
        const failed = yield* supervisor.failExecution(
          threadId,
          prepared.turn?.executionId ?? "missing",
          "Codex failed to start.",
        );

        assert.strictEqual(failed?.activity, "failed");
        assert.strictEqual(failed?.canStop, false);
        assert.strictEqual(failed?.providerSession.state, "failed");
        assert.strictEqual(failed?.providerSession.lastError, "Codex failed to start.");
        assert.strictEqual(failed?.turn?.state, "failed");
        assert.strictEqual(failed?.turn?.lastError, "Codex failed to start.");
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  it.effect("keeps unverifiable termination stoppable and permits a verified retry", () =>
    Effect.gen(function* () {
      const terminationAttempts = yield* Ref.make(0);
      const providerService = {
        inspectSession: () =>
          Effect.succeed({
            threadId,
            generation: 1,
            state: "running" as const,
            activeProviderTurnId: TurnId.make("provider-turn"),
            runtimeAlive: true,
          }),
        requestTurnInterrupt: () =>
          Effect.succeed({ acknowledged: true, acknowledgedAt: createdAt }),
        terminateSession: () =>
          Ref.updateAndGet(terminationAttempts, (count) => count + 1).pipe(
            Effect.map((attempt) => ({
              verified: attempt > 1,
              graceful: attempt > 1,
              processTreeExited: attempt > 1,
            })),
          ),
        streamEvents: Stream.empty,
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        // T3-CUSTOM(expbkt3): session recovery desired-state journal.
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const supervisor = yield* ThreadExecutionSupervisor;
        yield* supervisor.prepareExecution(startEvent("retry"));

        const firstStop = yield* supervisor
          .stopExecution({ threadId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        const failed = yield* Fiber.join(firstStop);
        assert.strictEqual(failed.snapshot.activity, "failed");
        assert.strictEqual(failed.snapshot.canStop, true);
        assert.strictEqual(failed.snapshot.turn?.state, "failed");

        const retry = yield* supervisor
          .stopExecution({ threadId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        const settled = yield* Fiber.join(retry);
        assert.strictEqual(settled.operationId, failed.operationId);
        assert.strictEqual(settled.snapshot.activity, "idle");
        assert.strictEqual(settled.snapshot.canStop, false);
        assert.strictEqual(settled.snapshot.turn?.state, "interrupted");
        assert.strictEqual(yield* Ref.get(terminationAttempts), 2);
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );

  it.effect("rejects stale generations and settles immediately on observed process exit", () =>
    Effect.gen(function* () {
      const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>({ replay: 1 });
      const providerService = {
        inspectSession: () => Effect.succeed(null),
        streamEvents: Stream.fromPubSub(runtimeEvents),
      } as unknown as ProviderServiceShape;
      const orchestration = {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngineService["Service"];
      const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
        // T3-CUSTOM(expbkt3): session recovery desired-state journal.
        Layer.provide(SessionRecoveryStateLayer),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const supervisor = yield* ThreadExecutionSupervisor;
        yield* Effect.yieldNow;
        const prepared = yield* supervisor.prepareExecution(startEvent("exit"));

        yield* PubSub.publish(runtimeEvents, {
          type: "turn.started",
          eventId: EventId.make("current-turn-started"),
          provider,
          providerInstanceId,
          threadId,
          sessionGeneration: 7,
          turnId: TurnId.make("provider-turn"),
          createdAt,
          payload: {},
        });
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        const adopted = yield* supervisor.getSnapshot(threadId);
        assert.strictEqual(adopted.providerSession.generation, 7);
        assert.strictEqual(adopted.turn?.providerTurnId, TurnId.make("provider-turn"));

        yield* PubSub.publish(runtimeEvents, {
          type: "user-input.requested",
          eventId: EventId.make("async-question"),
          provider,
          providerInstanceId,
          threadId,
          sessionGeneration: 7,
          turnId: TurnId.make("provider-turn"),
          createdAt,
          payload: { questions: [], responseMode: "message" },
        });
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        const afterAsyncQuestion = yield* supervisor.getSnapshot(threadId);
        assert.strictEqual(afterAsyncQuestion.activity, "active");
        assert.strictEqual(afterAsyncQuestion.turn?.state, "running");

        // T3-CUSTOM(expbkt3): resolving one native request must not clear a
        // second outstanding blocker from the same provider turn.
        for (const requestId of ["approval-a", "approval-b"] as const) {
          yield* PubSub.publish(runtimeEvents, {
            type: "request.opened",
            eventId: EventId.make(`opened-${requestId}`),
            provider,
            providerInstanceId,
            threadId,
            sessionGeneration: 7,
            turnId: TurnId.make("provider-turn"),
            requestId: requestId as never,
            createdAt,
            payload: { requestType: "command_execution_approval" },
          });
        }
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        yield* PubSub.publish(runtimeEvents, {
          type: "request.resolved",
          eventId: EventId.make("resolved-approval-a"),
          provider,
          providerInstanceId,
          threadId,
          sessionGeneration: 7,
          turnId: TurnId.make("provider-turn"),
          requestId: "approval-a" as never,
          createdAt,
          payload: { requestType: "command_execution_approval" },
        });
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        const afterFirstNativeResolution = yield* supervisor.getSnapshot(threadId);
        assert.strictEqual(afterFirstNativeResolution.activity, "blocked");
        assert.strictEqual(afterFirstNativeResolution.turn?.state, "waiting-for-approval");

        // T3-CUSTOM(expbkt3): A stale provider response is terminal once its
        // projection lands, even if this process saw the opening event first.
        yield* PubSub.publish(runtimeEvents, {
          type: "user-input.requested",
          eventId: EventId.make("opened-stale-input"),
          provider,
          providerInstanceId,
          threadId,
          sessionGeneration: 7,
          turnId: TurnId.make("provider-turn"),
          requestId: "stale-input" as never,
          createdAt,
          payload: { questions: [] },
        });
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES ('stale-input-failure', ${threadId}, 'provider-turn', 'error',
            'provider.user-input.respond.failed', 'Stale',
            '{"requestId":"stale-input","detail":"Unknown pending codex user input request"}', 99, ${createdAt})
        `;
        yield* supervisor.refreshIntent(threadId);

        yield* PubSub.publish(runtimeEvents, {
          type: "request.resolved",
          eventId: EventId.make("resolved-approval-b"),
          provider,
          providerInstanceId,
          threadId,
          sessionGeneration: 7,
          turnId: TurnId.make("provider-turn"),
          requestId: "approval-b" as never,
          createdAt,
          payload: { requestType: "command_execution_approval" },
        });
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        const afterStaleClosure = yield* supervisor.getSnapshot(threadId);
        assert.strictEqual(afterStaleClosure.activity, "active");
        assert.strictEqual(afterStaleClosure.turn?.state, "running");

        yield* PubSub.publish(runtimeEvents, {
          type: "turn.started",
          eventId: EventId.make("stale-turn-started"),
          provider,
          providerInstanceId,
          threadId,
          sessionGeneration: 6,
          turnId: TurnId.make("stale-provider-turn"),
          createdAt,
          payload: {},
        });
        yield* Effect.yieldNow;
        assert.strictEqual(
          (yield* supervisor.getSnapshot(threadId)).turn?.providerTurnId,
          TurnId.make("provider-turn"),
        );

        yield* PubSub.publish(runtimeEvents, {
          type: "session.exited",
          eventId: EventId.make("runtime-exited"),
          provider,
          providerInstanceId,
          threadId,
          sessionGeneration: 7,
          createdAt,
          payload: { exitKind: "error", reason: "process crashed" },
        });
        for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
        const exited = yield* supervisor.getSnapshot(threadId);
        assert.strictEqual(exited.activity, "failed");
        assert.strictEqual(exited.providerSession.state, "failed");
        assert.strictEqual(exited.turn?.state, "failed");
        assert.strictEqual(exited.canStop, false);
      }).pipe(Effect.provide(supervisorLayer));
    }),
  );
});
