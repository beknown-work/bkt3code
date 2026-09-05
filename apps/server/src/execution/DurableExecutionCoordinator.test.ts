import { CommandId, CorrelationId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  DurableExecutionDispatchError,
  durableExecutionRetryDelayMs,
  makeDurableExecutionCoordinator,
  shouldPublishRecoveryActivity,
} from "./DurableExecutionCoordinator.ts";
import {
  DurableExecutionIntentRepository,
  DurableExecutionIntentRepositoryLive,
} from "./DurableExecutionIntentRepository.ts";

const layer = it.layer(
  DurableExecutionIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

function makeAcceptedEvent(threadSuffix = "coordinator") {
  const acceptedAt = "2026-01-01T00:00:00.000Z";
  const threadId = ThreadId.make(`thread-${threadSuffix}`);
  return {
    type: "thread.turn-start-requested" as const,
    sequence: 10,
    eventId: EventId.make("event-coordinator"),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    occurredAt: acceptedAt,
    commandId: CommandId.make("command-coordinator"),
    causationEventId: null,
    correlationId: CorrelationId.make("command-coordinator"),
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make("message-coordinator"),
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: acceptedAt,
    },
  };
}

function makeSequentialAcceptedEvent(suffix: string, sequence: number, threadSuffix = suffix) {
  const base = makeAcceptedEvent(threadSuffix);
  return {
    ...base,
    sequence,
    eventId: EventId.make(`event-${suffix}`),
    commandId: CommandId.make(`command-${suffix}`),
    correlationId: CorrelationId.make(`command-${suffix}`),
    payload: {
      ...base.payload,
      messageId: MessageId.make(`message-${suffix}`),
    },
  };
}

const acceptEvent = Effect.fnUntraced(function* (
  repository: DurableExecutionIntentRepository["Service"],
  event: ReturnType<typeof makeSequentialAcceptedEvent>,
) {
  yield* repository.acceptFromEvent({
    event,
    message: {
      messageId: event.payload.messageId,
      threadId: event.payload.threadId,
      turnId: null,
      role: "user",
      text: `message ${event.sequence}`,
      attachments: [],
      isStreaming: false,
      sentByUserId: null,
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
    },
  });
});

layer("DurableExecutionCoordinator", (it) => {
  it.effect("completes handled native commands without provider acknowledgement or retry", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeSequentialAcceptedEvent("native-command", 50);
      yield* acceptEvent(repository, event);
      const calls = yield* Ref.make(0);
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "native-command-owner",
        now: () => Effect.succeed(event.occurredAt),
        loadEvent: () => Effect.succeed(event),
        dispatchOriginal: () =>
          Ref.update(calls, (n) => n + 1).pipe(
            Effect.as({
              providerTurnId: null,
              providerInstanceId: "codex",
              completed: true,
              handledCommand: true,
            }),
          ),
        recover: () => Effect.die("A handled command must not recover"),
      });
      yield* coordinator.run(event.commandId);
      yield* coordinator.run(event.commandId);
      const current = yield* repository.getByWorkItemId({ workItemId: event.commandId });
      assert.isTrue(Option.isSome(current));
      if (Option.isNone(current)) return;
      assert.strictEqual(current.value.desiredState, "stopped");
      assert.strictEqual(current.value.deliveryCertainty, "completed");
      assert.strictEqual(current.value.providerTurnId, null);
      assert.strictEqual(current.value.recoveryAttempts, 0);
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("does not charge the original delivery and guards the first recovery", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeAcceptedEvent();
      yield* repository.acceptFromEvent({
        event,
        message: {
          messageId: event.payload.messageId,
          threadId: event.payload.threadId,
          turnId: null,
          role: "user",
          text: "perform once",
          attachments: [],
          isStreaming: false,
          sentByUserId: null,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        },
      });
      const clock = yield* Ref.make(event.occurredAt);
      const recoveryModes = yield* Ref.make<Array<string>>([]);
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-a",
        now: () => Ref.get(clock),
        loadEvent: () => Effect.succeed(event),
        dispatchOriginal: () =>
          Effect.fail(
            new DurableExecutionDispatchError({
              failureType: "transport-lost",
              detail: "lost before acknowledgement",
              retryable: true,
            }),
          ),
        recover: ({ mode }) =>
          Ref.update(recoveryModes, (modes) => [...modes, mode]).pipe(
            Effect.as({ providerTurnId: "provider-turn-1", providerInstanceId: "codex" }),
          ),
      });

      yield* coordinator.run(event.commandId ?? "");
      const afterOriginal = yield* repository.getByWorkItemId({
        workItemId: event.commandId ?? "",
      });
      assert.isTrue(afterOriginal._tag === "Some");
      if (afterOriginal._tag === "None") return;
      assert.strictEqual(afterOriginal.value.recoveryAttempts, 0);
      assert.strictEqual(afterOriginal.value.phase, "recovering");
      assert.strictEqual(afterOriginal.value.deliveryCertainty, "uncertain");

      yield* coordinator.run(event.commandId ?? "");
      const recovered = yield* repository.getByWorkItemId({
        workItemId: event.commandId ?? "",
      });
      assert.isTrue(recovered._tag === "Some");
      if (recovered._tag === "None") return;
      assert.strictEqual(recovered.value.recoveryAttempts, 1);
      assert.strictEqual(recovered.value.phase, "running");
      assert.strictEqual(recovered.value.providerTurnId, "provider-turn-1");
      assert.deepStrictEqual(yield* Ref.get(recoveryModes), ["inspect-or-continue"]);
    }),
  );

  it.effect("moves permanent failures directly to stopped attention", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const baseEvent = makeAcceptedEvent("permanent");
      const event = {
        ...baseEvent,
        sequence: 11,
        eventId: EventId.make("event-permanent"),
        commandId: CommandId.make("command-permanent"),
        payload: {
          ...baseEvent.payload,
          messageId: MessageId.make("message-permanent"),
        },
      };
      yield* repository.acceptFromEvent({
        event,
        message: {
          messageId: event.payload.messageId,
          threadId: event.payload.threadId,
          turnId: null,
          role: "user",
          text: "cannot recover",
          attachments: [],
          isStreaming: false,
          sentByUserId: null,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        },
      });
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-b",
        now: () => Effect.succeed(event.occurredAt),
        loadEvent: () => Effect.succeed(event),
        dispatchOriginal: () =>
          Effect.fail(
            new DurableExecutionDispatchError({
              failureType: "provider-removed",
              detail: "configured provider instance no longer exists",
              retryable: false,
            }),
          ),
        recover: () => Effect.die("recovery must not run"),
      });

      yield* coordinator.run(event.commandId ?? "");
      const failed = yield* repository.getByWorkItemId({
        workItemId: event.commandId ?? "",
      });
      assert.isTrue(failed._tag === "Some");
      if (failed._tag === "None") return;
      assert.strictEqual(failed.value.desiredState, "stopped");
      assert.strictEqual(failed.value.phase, "recovery-exhausted");
      assert.strictEqual(failed.value.recoveryAttempts, 0);
    }),
  );

  it.effect("reconciles a provider-history completion without dispatching another turn", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const baseEvent = makeAcceptedEvent("history-complete");
      const event = {
        ...baseEvent,
        sequence: 12,
        eventId: EventId.make("event-history-complete"),
        commandId: CommandId.make("command-history-complete"),
        payload: {
          ...baseEvent.payload,
          messageId: MessageId.make("message-history-complete"),
        },
      };
      yield* repository.acceptFromEvent({
        event,
        message: {
          messageId: event.payload.messageId,
          threadId: event.payload.threadId,
          turnId: null,
          role: "user",
          text: "finish exactly once",
          attachments: [],
          isStreaming: false,
          sentByUserId: null,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        },
      });
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-history",
        now: () => Effect.succeed(event.occurredAt),
        loadEvent: () => Effect.succeed(event),
        dispatchOriginal: () =>
          Effect.fail(
            new DurableExecutionDispatchError({
              failureType: "transport-lost",
              detail: "provider accepted before the acknowledgement was persisted",
              retryable: true,
            }),
          ),
        recover: () =>
          Effect.succeed({
            providerTurnId: "provider-turn-complete",
            providerInstanceId: "codex",
            completed: true,
          }),
      });

      yield* coordinator.run(event.commandId ?? "");
      yield* coordinator.run(event.commandId ?? "");

      const reconciled = yield* repository.getByWorkItemId({
        workItemId: event.commandId ?? "",
      });
      assert.isTrue(reconciled._tag === "Some");
      if (reconciled._tag === "None") return;
      assert.strictEqual(reconciled.value.desiredState, "stopped");
      assert.strictEqual(reconciled.value.deliveryCertainty, "completed");
      assert.strictEqual(reconciled.value.providerTurnId, "provider-turn-complete");
      assert.strictEqual(reconciled.value.recoveryAttempts, 1);
    }),
  );

  it.effect("preserves committed order when an active queue-only provider defers busy sends", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const events = [
        makeSequentialAcceptedEvent("queue-1", 21, "queue"),
        makeSequentialAcceptedEvent("queue-2", 22, "queue"),
        makeSequentialAcceptedEvent("queue-3", 23, "queue"),
      ] as const;
      for (const event of events) yield* acceptEvent(repository, event);

      const providerBusy = yield* Ref.make(false);
      const dispatchOrder = yield* Ref.make<Array<string>>([]);
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-queue",
        now: () => Effect.succeed(events[0].occurredAt),
        loadEvent: (intent) =>
          Effect.succeed(events.find((event) => event.commandId === intent.workItemId)!),
        dispatchOriginal: ({ intent }) =>
          Effect.gen(function* () {
            if (yield* Ref.get(providerBusy)) {
              return { providerTurnId: null, providerInstanceId: "codex", deferred: true };
            }
            yield* Ref.set(providerBusy, true);
            yield* Ref.update(dispatchOrder, (order) => [...order, intent.workItemId]);
            return {
              providerTurnId: `provider-${intent.workItemId}`,
              providerInstanceId: "codex",
            };
          }),
        recover: () => Effect.die("recovery must not run"),
      });

      for (const event of events) yield* coordinator.run(event.commandId ?? "");
      assert.deepStrictEqual(yield* Ref.get(dispatchOrder), ["command-queue-1"]);
      const initiallyQueued = yield* repository.listByThreadId({
        threadId: events[0].payload.threadId,
      });
      assert.deepStrictEqual(
        initiallyQueued.map((intent) => [intent.workItemId, intent.phase, intent.runnable]),
        [
          ["command-queue-1", "running", true],
          ["command-queue-2", "queued", false],
          ["command-queue-3", "queued", true],
        ],
      );

      for (const expected of ["command-queue-2", "command-queue-3"]) {
        yield* Ref.set(providerBusy, false);
        yield* repository.observeSession({
          threadId: events[0].payload.threadId,
          status: "idle",
          providerTurnId: null,
          error: null,
          at: events[0].occurredAt,
        });
        yield* coordinator.runDue;
        assert.strictEqual((yield* Ref.get(dispatchOrder)).at(-1), expected);
      }
    }),
  );

  it.effect("steers busy work in the same committed sequence when the provider supports it", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const events = [
        makeSequentialAcceptedEvent("steer-1", 31, "steer"),
        makeSequentialAcceptedEvent("steer-2", 32, "steer"),
        makeSequentialAcceptedEvent("steer-3", 33, "steer"),
      ] as const;
      for (const event of events) yield* acceptEvent(repository, event);
      const dispatchOrder = yield* Ref.make<Array<string>>([]);
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-steer",
        now: () => Effect.succeed(events[0].occurredAt),
        loadEvent: (intent) =>
          Effect.succeed(events.find((event) => event.commandId === intent.workItemId)!),
        dispatchOriginal: ({ intent }) =>
          Ref.update(dispatchOrder, (order) => [...order, intent.workItemId]).pipe(
            Effect.as({
              providerTurnId: `provider-${intent.workItemId}`,
              providerInstanceId: "codex",
              adoptedExecutionId: "active-provider-execution",
            }),
          ),
        recover: () => Effect.die("recovery must not run"),
      });

      yield* coordinator.runDue;
      yield* coordinator.runDue;
      yield* coordinator.runDue;
      assert.deepStrictEqual(yield* Ref.get(dispatchOrder), [
        "command-steer-1",
        "command-steer-2",
        "command-steer-3",
      ]);
    }),
  );

  it.effect(
    "retries an accepted steer association after restart without resending the provider turn",
    () =>
      Effect.gen(function* () {
        const repository = yield* DurableExecutionIntentRepository;
        const event = makeSequentialAcceptedEvent("association-retry", 35, "association");
        yield* acceptEvent(repository, event);
        const sendTurnCalls = yield* Ref.make(0);
        const associationAttempts = yield* Ref.make(0);
        const associationFailures = yield* Ref.make(1);
        const dispatch = ({
          intent,
        }: {
          readonly intent: import("./DurableExecutionIntentRepository.ts").DurableExecutionIntent;
        }) =>
          Effect.gen(function* () {
            if (intent.lastFailureType === "turn-association-pending") {
              yield* Ref.update(associationAttempts, (count) => count + 1);
              if (
                (yield* Ref.getAndUpdate(associationFailures, (remaining) =>
                  Math.max(0, remaining - 1),
                )) > 0
              ) {
                return yield* new DurableExecutionDispatchError({
                  failureType: "association-persistence-interrupted",
                  detail: "association persistence interrupted",
                  retryable: true,
                });
              }
              return {
                providerTurnId: "provider-active",
                providerInstanceId: "codex",
                adoptedExecutionId: "active-execution",
                completed: true,
              };
            }
            yield* Ref.update(sendTurnCalls, (count) => count + 1);
            return {
              providerTurnId: "provider-active",
              providerInstanceId: "codex",
              adoptedExecutionId: "active-execution",
              associationPending: {
                providerTurnId: "provider-active",
                providerInstanceId: "codex",
                adoptedExecutionId: "active-execution",
              },
            };
          });
        const firstCoordinator = yield* makeDurableExecutionCoordinator({
          ownerId: "association-owner-a",
          now: () => Effect.succeed(event.occurredAt),
          loadEvent: () => Effect.succeed(event),
          dispatchOriginal: dispatch,
          recover: () => Effect.die("accepted steer must not enter guarded recovery"),
        });
        yield* firstCoordinator.run(event.commandId);
        const pending = yield* repository.getByWorkItemId({ workItemId: event.commandId });
        assert.isTrue(Option.isSome(pending));
        if (Option.isNone(pending)) return;
        assert.strictEqual(pending.value.phase, "retry-wait");
        assert.strictEqual(pending.value.lastFailureType, "turn-association-pending");
        assert.strictEqual(pending.value.providerTurnId, "provider-active");

        // A restart can happen after the accepted-association row is claimed and
        // marked starting. Reconciliation must retain the marker so the next
        // authority adopts the known provider turn instead of sending it again.
        const inFlightClaim = yield* repository.claim({
          workItemId: event.commandId,
          owner: "association-owner-crashed",
          now: event.occurredAt,
          expiresAt: "2026-01-01T00:01:00.000Z",
        });
        assert.isTrue(Option.isSome(inFlightClaim));
        if (Option.isNone(inFlightClaim)) return;
        assert.isTrue(
          yield* repository.markProviderStarting({
            workItemId: event.commandId,
            owner: "association-owner-crashed",
            generation: inFlightClaim.value.claimGeneration,
            at: event.occurredAt,
          }),
        );
        yield* repository.reconcileStartup({ at: "2026-01-01T00:00:01.000Z" });
        const preservedAfterRestart = yield* repository.getByWorkItemId({
          workItemId: event.commandId,
        });
        assert.isTrue(Option.isSome(preservedAfterRestart));
        if (Option.isNone(preservedAfterRestart)) return;
        assert.strictEqual(preservedAfterRestart.value.phase, "retry-wait");
        assert.strictEqual(preservedAfterRestart.value.lastFailureType, "turn-association-pending");
        assert.strictEqual(preservedAfterRestart.value.claimOwner, null);

        const restartedCoordinator = yield* makeDurableExecutionCoordinator({
          ownerId: "association-owner-b",
          now: () => Effect.succeed("2026-01-01T00:00:01.000Z"),
          loadEvent: () => Effect.succeed(event),
          dispatchOriginal: dispatch,
          recover: () => Effect.die("accepted steer must not enter guarded recovery"),
        });
        yield* restartedCoordinator.run(event.commandId);
        const stillPending = yield* repository.getByWorkItemId({ workItemId: event.commandId });
        assert.isTrue(Option.isSome(stillPending));
        if (Option.isNone(stillPending)) return;
        assert.strictEqual(stillPending.value.lastFailureType, "turn-association-pending");
        yield* restartedCoordinator.run(event.commandId);
        const completed = yield* repository.getByWorkItemId({ workItemId: event.commandId });
        assert.isTrue(Option.isSome(completed));
        if (Option.isNone(completed)) return;
        assert.strictEqual(completed.value.desiredState, "stopped");
        assert.strictEqual(completed.value.phase, "running");
        assert.strictEqual(completed.value.lastFailureType, null);
        assert.strictEqual(completed.value.adoptedExecutionId, "active-execution");
        assert.strictEqual(yield* Ref.get(sendTurnCalls), 1);
        assert.strictEqual(yield* Ref.get(associationAttempts), 2);
      }).pipe(Effect.scoped),
  );

  it.effect("retains an accepted association marker when stop races its acknowledgement", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeSequentialAcceptedEvent("association-stop", 36, "association-stop");
      yield* acceptEvent(repository, event);
      const claim = yield* repository.claim({
        workItemId: event.commandId,
        owner: "association-stop-owner",
        now: event.occurredAt,
        expiresAt: "2026-01-01T00:01:00.000Z",
      });
      assert.isTrue(Option.isSome(claim));
      if (Option.isNone(claim)) return;
      assert.isTrue(
        yield* repository.markAssociationPending({
          workItemId: event.commandId,
          owner: "association-stop-owner",
          generation: claim.value.claimGeneration,
          providerTurnId: "provider-stop",
          providerInstanceId: "codex",
          adoptedExecutionId: "execution-stop",
          at: event.occurredAt,
        }),
      );
      yield* repository.stopThread({
        threadId: event.payload.threadId,
        reason: "user-stop",
        at: "2026-01-01T00:00:01.000Z",
      });
      const retained = yield* repository.getByWorkItemId({ workItemId: event.commandId });
      assert.isTrue(Option.isSome(retained));
      if (Option.isNone(retained)) return;
      assert.strictEqual(retained.value.desiredState, "running");
      assert.strictEqual(retained.value.phase, "retry-wait");
      assert.isTrue(retained.value.runnable);
      assert.strictEqual(retained.value.lastFailureType, "turn-association-pending");
      assert.strictEqual(retained.value.providerTurnId, "provider-stop");
    }),
  );

  it.effect("settles another running intent while retaining a terminal association marker", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const sql = yield* SqlClient.SqlClient;
      const markerEvent = makeSequentialAcceptedEvent(
        "association-terminal",
        936,
        "shared-terminal",
      );
      const originalEvent = makeSequentialAcceptedEvent("original-terminal", 37, "shared-terminal");
      yield* acceptEvent(repository, markerEvent);
      yield* sql`
        INSERT INTO projection_thread_execution_intents (
          work_item_id, thread_id, message_id, command_id, request_event_sequence,
          message_text, attachments_json, desired_state, phase, delivery_certainty,
          runnable, adopted_execution_id, recovery_attempts, maximum_recovery_attempts,
          claim_generation, accepted_at, updated_at
        ) VALUES (
          ${originalEvent.commandId}, ${originalEvent.payload.threadId}, ${originalEvent.payload.messageId},
          ${originalEvent.commandId}, NULL, 'original', '[]', 'running', 'running',
          'provider-acknowledged', 1, ${originalEvent.commandId}, 0, 10, 0,
          ${originalEvent.occurredAt}, ${originalEvent.occurredAt}
        )
      `;
      const markerClaim = yield* repository.claim({
        workItemId: markerEvent.commandId,
        owner: "association-terminal-owner",
        now: markerEvent.occurredAt,
        expiresAt: "2026-01-01T00:01:00.000Z",
      });
      assert.isTrue(Option.isSome(markerClaim));
      if (Option.isNone(markerClaim)) return;
      yield* repository.markAssociationPending({
        workItemId: markerEvent.commandId,
        owner: "association-terminal-owner",
        generation: markerClaim.value.claimGeneration,
        providerTurnId: "provider-terminal",
        providerInstanceId: "codex",
        adoptedExecutionId: "execution-terminal",
        at: markerEvent.occurredAt,
      });
      // The projection can contain an older live intent while the marker is
      // waiting for adoption; model that committed state directly.
      yield* sql`
        UPDATE projection_thread_execution_intents
        SET phase = 'running', runnable = 1, delivery_certainty = 'provider-acknowledged'
        WHERE work_item_id = ${originalEvent.commandId}
      `;
      yield* repository.observeSession({
        threadId: markerEvent.payload.threadId,
        status: "ready",
        providerTurnId: null,
        error: null,
        at: "2026-01-01T00:00:01.000Z",
      });
      const intents = yield* repository.listByThreadId({ threadId: markerEvent.payload.threadId });
      const marker = intents.find((intent) => intent.workItemId === markerEvent.commandId);
      const original = intents.find((intent) => intent.workItemId === originalEvent.commandId);
      assert.strictEqual(marker?.lastFailureType, "turn-association-pending");
      assert.strictEqual(marker?.desiredState, "running");
      assert.strictEqual(original?.desiredState, "stopped");
      assert.strictEqual(original?.deliveryCertainty, "completed");
    }),
  );

  it.effect("keeps claiming work after the wait step fails", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeSequentialAcceptedEvent("wait-guard", 40);
      const workItemId = event.commandId ?? "";
      const remainingFailures = yield* Ref.make(1);
      // Receipts, so the test proves the ordering it cares about instead of
      // waiting on a clock: the wait has to fail before the work exists.
      const waitFailed = yield* Deferred.make<void>();
      const transitioned = yield* Deferred.make<string>();

      const flakyRepository: DurableExecutionIntentRepository["Service"] = {
        ...repository,
        nextRunnableAt: (input) =>
          Ref.getAndUpdate(remainingFailures, (remaining) => Math.max(0, remaining - 1)).pipe(
            Effect.flatMap((remaining) =>
              remaining > 0
                ? Deferred.succeed(waitFailed, undefined).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new PersistenceSqlError({
                          operation: "DurableExecutionIntentRepository.nextRunnableAt",
                          cause: "transient read failure",
                        }),
                      ),
                    ),
                  )
                : repository.nextRunnableAt(input),
            ),
          ),
      };

      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-wait-guard",
        now: () => Effect.succeed(event.occurredAt),
        loadEvent: () => Effect.succeed(event),
        dispatchOriginal: () =>
          Effect.succeed({
            providerTurnId: "provider-turn-wait-guard",
            providerInstanceId: "codex",
          }),
        recover: () => Effect.die("recovery must not run"),
        // Scoped to this work item: the in-memory database is shared across the
        // tests in this block, so the loop may legitimately claim an older one.
        onTransition: ({ workItemId: transitionedId }) =>
          transitionedId === workItemId
            ? Deferred.succeed(transitioned, transitionedId).pipe(Effect.asVoid)
            : Effect.void,
      }).pipe(Effect.provideService(DurableExecutionIntentRepository, flakyRepository));

      yield* coordinator.start();
      yield* Deferred.await(waitFailed);

      yield* acceptEvent(repository, event);
      yield* coordinator.wake(workItemId);

      // Only resolves if the loop outlived the failed wait. Before the guard
      // the fiber died here and the work item stayed `queued` forever.
      assert.strictEqual(yield* Deferred.await(transitioned), workItemId);
      const claimed = yield* repository.getByWorkItemId({ workItemId });
      assert.isTrue(claimed._tag === "Some");
      if (claimed._tag === "None") return;
      // Claimed, so it left the queue. Asserting a later phase would race the
      // acknowledgement; staying `queued` forever is the regression itself.
      assert.notStrictEqual(claimed.value.phase, "queued");
      assert.strictEqual(yield* Ref.get(remainingFailures), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("claims work accepted without a wake within the safety poll", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeSequentialAcceptedEvent("safety-poll", 910);
      const workItemId = event.commandId ?? "";
      const transitioned = yield* Deferred.make<string>();
      const parked = yield* Deferred.make<void>();
      const waitScans = yield* Ref.make(0);
      // Nothing scheduled: the loop has no timer to fall back on and relies on
      // a wake alone. `start` offers one wake, so the loop scans, drains that
      // wake, scans again, and only then parks. Signal after that second scan
      // has returned so the accept below cannot race the loop's own first pass.
      const observedRepository: DurableExecutionIntentRepository["Service"] = {
        ...repository,
        // The in-memory database is shared across this block; leftover rows
        // would be claimed here and each claim re-offers a wake, which would
        // hide a loop that never parks on its own.
        listRunnable: (input) =>
          repository
            .listRunnable(input)
            .pipe(
              Effect.map((rows) => rows.filter((row) => row.threadId === event.payload.threadId)),
            ),
        nextRunnableAt: () =>
          Ref.updateAndGet(waitScans, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              n >= 2 ? Deferred.succeed(parked, undefined).pipe(Effect.asVoid) : Effect.void,
            ),
            Effect.as(Option.none()),
          ),
      };

      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-safety-poll",
        now: () => Effect.succeed(event.occurredAt),
        safetyPollIntervalMs: 50,
        loadEvent: () => Effect.succeed(event),
        dispatchOriginal: () =>
          Effect.succeed({
            providerTurnId: "provider-turn-safety-poll",
            providerInstanceId: "codex",
          }),
        recover: () => Effect.die("recovery must not run"),
        onTransition: ({ workItemId: transitionedId }) =>
          transitionedId === workItemId
            ? Deferred.succeed(transitioned, transitionedId).pipe(Effect.asVoid)
            : Effect.void,
      }).pipe(Effect.provideService(DurableExecutionIntentRepository, observedRepository));

      yield* coordinator.start();
      yield* Deferred.await(parked);
      // Accept after the loop has parked and deliberately never call `wake`:
      // the lost-wake shape of the 2026-08-20 outage, where the reactor lane
      // that delivers wakes was wedged. Before the bounded wait this loop sat
      // in `Queue.take` forever and the work item stayed `queued`.
      yield* acceptEvent(repository, event);

      // Only the bounded wait's timer can move the loop now. Without it the
      // loop is parked in `Queue.take` and no amount of time helps.
      for (let i = 0; i < 20 && !(yield* Deferred.isDone(transitioned)); i += 1) {
        yield* TestClock.adjust(Duration.millis(60));
        yield* Effect.yieldNow;
      }

      assert.strictEqual(yield* Deferred.await(transitioned), workItemId);
      const claimed = yield* repository.getByWorkItemId({ workItemId });
      assert.isTrue(claimed._tag === "Some");
      if (claimed._tag === "None") return;
      assert.notStrictEqual(claimed.value.phase, "queued");
    }).pipe(Effect.scoped),
  );
});

it("uses the deterministic fast-then-patient ten-attempt schedule", () => {
  assert.strictEqual(durableExecutionRetryDelayMs("work-1", 1), 0);
  assert.strictEqual(durableExecutionRetryDelayMs("work-1", 11), null);
  for (const [attempt, base] of [
    [2, 1_000],
    [3, 2_000],
    [4, 5_000],
    [5, 10_000],
    [6, 30_000],
    [7, 60_000],
    [8, 120_000],
    [9, 300_000],
    [10, 600_000],
  ] as const) {
    const first = durableExecutionRetryDelayMs("work-1", attempt);
    const second = durableExecutionRetryDelayMs("work-1", attempt);
    assert.strictEqual(first, second);
    assert.isAtLeast(first ?? 0, Math.floor(base * 0.9));
    assert.isAtMost(first ?? 0, Math.ceil(base * 1.1));
  }
});

it("keeps individual retry attempts in diagnostics instead of the transcript", () => {
  assert.isTrue(shouldPublishRecoveryActivity("started", 1));
  for (let attempt = 2; attempt <= 10; attempt += 1) {
    assert.isFalse(shouldPublishRecoveryActivity("started", attempt));
  }
  assert.isTrue(shouldPublishRecoveryActivity("recovered", 7));
  assert.isTrue(shouldPublishRecoveryActivity("paused", 4));
  assert.isTrue(shouldPublishRecoveryActivity("exhausted", 10));
});
