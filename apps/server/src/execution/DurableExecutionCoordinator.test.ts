import { CommandId, CorrelationId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

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

  // T3-CUSTOM(expbkt3): BEGIN — bounds on a delivery that never answers.
  it.effect("charges a delivery that never acknowledges to the retry budget", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeSequentialAcceptedEvent("timeout", 40, "timeout");
      yield* acceptEvent(repository, event);
      const workItemId = String(event.commandId);
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-timeout",
        now: () => Effect.succeed(event.occurredAt),
        loadEvent: () => Effect.succeed(event),
        // The stuck shape this exists for: a dispatch that neither fails nor
        // returns, holding its claim alive by renewing the lease forever.
        dispatchOriginal: () => Effect.never,
        recover: () => Effect.die("recovery must not run"),
        dispatchDeadlineMs: () => Effect.succeed(300_000),
      });

      const running = yield* coordinator
        .run(workItemId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 minutes");
      yield* Fiber.join(running);

      const intent = yield* repository.getByWorkItemId({ workItemId });
      assert.isTrue(intent._tag === "Some");
      if (intent._tag === "None") return;
      assert.strictEqual(intent.value.phase, "recovering");
      assert.strictEqual(intent.value.lastFailureType, "provider-dispatch-timeout");
      assert.include(intent.value.lastFailureDetail ?? "", "The agent never started");
      // Delivery may have happened after the deadline, so the retry has to
      // inspect and adopt rather than replay the prompt.
      assert.strictEqual(intent.value.deliveryCertainty, "uncertain");
    }),
  );

  it.effect("does not count worktree bootstrap against the delivery deadline", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeSequentialAcceptedEvent("bootstrap", 41, "bootstrap");
      yield* acceptEvent(repository, event);
      const workItemId = String(event.commandId);
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-bootstrap",
        now: () => Effect.succeed(event.occurredAt),
        loadEvent: () => Effect.succeed(event),
        // A real worktree clone plus install honestly takes this long.
        prepare: () => Effect.sleep("12 minutes"),
        dispatchOriginal: () =>
          Effect.succeed({ providerTurnId: "provider-turn-slow", providerInstanceId: "codex" }),
        recover: () => Effect.die("recovery must not run"),
        dispatchDeadlineMs: () => Effect.succeed(300_000),
      });

      const running = yield* coordinator
        .run(workItemId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("13 minutes");
      yield* Fiber.join(running);

      const intent = yield* repository.getByWorkItemId({ workItemId });
      assert.isTrue(intent._tag === "Some");
      if (intent._tag === "None") return;
      assert.strictEqual(intent.value.phase, "running");
      assert.strictEqual(intent.value.lastFailureType, null);
    }),
  );

  it.effect("spends the shared budget on observed stalls and then fails the execution", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeSequentialAcceptedEvent("observed", 42, "observed");
      yield* acceptEvent(repository, event);
      const workItemId = String(event.commandId);
      const clock = yield* Ref.make(event.occurredAt);
      const exhausted = yield* Ref.make<Array<string>>([]);
      const terminated = yield* Ref.make<Array<string>>([]);
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-observed",
        now: () => Ref.get(clock),
        loadEvent: () => Effect.succeed(event),
        dispatchOriginal: () =>
          Effect.succeed({ providerTurnId: "provider-turn-observed", providerInstanceId: "codex" }),
        recover: () => Effect.die("recovery must not run in this test"),
        onExhausted: ({ detail }) => Ref.update(exhausted, (all) => [...all, detail]),
        terminateObserved: (intent) => Ref.update(terminated, (all) => [...all, intent.workItemId]),
      });

      // Deliver once so the work item is acknowledged and the coordinator is
      // finished with it — the state nothing else watches.
      yield* coordinator.run(workItemId);
      const acknowledged = yield* repository.getByWorkItemId({ workItemId });
      assert.isTrue(acknowledged._tag === "Some");
      if (acknowledged._tag === "None") return;
      assert.strictEqual(acknowledged.value.phase, "running");

      const report = (index: number) =>
        Effect.gen(function* () {
          // Each report is separated by more than any backoff step, the way a
          // once-a-minute sweep with a ninety-minute backstop would be.
          yield* Ref.set(
            clock,
            DateTime.formatIso(
              DateTime.makeUnsafe(Date.parse(event.occurredAt) + index * 3_600_000),
            ),
          );
          yield* coordinator.failObserved({
            workItemId,
            failureType: "provider-output-silent",
            detail: "No output from the agent for 94 minutes.",
          });
        });

      yield* report(1);
      const afterFirst = yield* repository.getByWorkItemId({ workItemId });
      assert.isTrue(afterFirst._tag === "Some");
      if (afterFirst._tag === "None") return;
      // One unit of the existing budget, and back in the coordinator's queue.
      assert.strictEqual(afterFirst.value.recoveryAttempts, 1);
      assert.strictEqual(afterFirst.value.phase, "retry-wait");
      assert.strictEqual(afterFirst.value.desiredState, "running");
      assert.strictEqual(afterFirst.value.lastFailureType, "provider-output-silent");
      assert.deepStrictEqual(yield* Ref.get(exhausted), []);

      for (let index = 2; index <= 10; index += 1) yield* report(index);

      const final = yield* repository.getByWorkItemId({ workItemId });
      assert.isTrue(final._tag === "Some");
      if (final._tag === "None") return;
      assert.strictEqual(final.value.recoveryAttempts, 10);
      assert.strictEqual(final.value.phase, "recovery-exhausted");
      assert.strictEqual(final.value.desiredState, "stopped");
      assert.strictEqual(final.value.runnable, false);

      // Exactly one terminal error, readable, and the provider is stopped after
      // the execution has been failed rather than before it.
      const details = yield* Ref.get(exhausted);
      assert.strictEqual(details.length, 1);
      assert.include(details[0] ?? "", "No output from the agent for 94 minutes.");
      assert.include(details[0] ?? "", "Automatic recovery gave up after 10 attempts.");
      assert.deepStrictEqual(yield* Ref.get(terminated), [workItemId]);
    }),
  );
  it.effect("hands a not-yet-delivered work item back runnable instead of parking it", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const event = makeSequentialAcceptedEvent("queued-stall", 43, "queued-stall");
      yield* acceptEvent(repository, event);
      const workItemId = String(event.commandId);
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "coordinator-queued",
        now: () => Effect.succeed(event.occurredAt),
        loadEvent: () => Effect.succeed(event),
        dispatchOriginal: () => Effect.die("dispatch must not run"),
        recover: () => Effect.die("recovery must not run"),
      });

      // Nothing was delivered, so there is no attempt to charge — but the item
      // must stay claimable by the coordinator's own loop.
      yield* coordinator.failObserved({
        workItemId,
        failureType: "provider-output-silent",
        detail: "No output from the agent for 94 minutes.",
      });

      const intent = yield* repository.getByWorkItemId({ workItemId });
      assert.isTrue(intent._tag === "Some");
      if (intent._tag === "None") return;
      assert.strictEqual(intent.value.recoveryAttempts, 0);
      assert.strictEqual(intent.value.runnable, true);
      assert.strictEqual(intent.value.claimOwner, null);
      assert.strictEqual(intent.value.deliveryCertainty, "never-delivered");

      const due = yield* repository.listRunnable({ now: event.occurredAt, limit: 10 });
      assert.isTrue(due.some((candidate) => candidate.workItemId === workItemId));
    }),
  );
  // T3-CUSTOM(expbkt3): END
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
