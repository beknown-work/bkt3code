// T3-CUSTOM(expbkt3): real durable-service regression from the queue audit.
import { CommandId, CorrelationId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeDurableExecutionCoordinator } from "./DurableExecutionCoordinator.ts";
import {
  DurableExecutionIntentRepository,
  DurableExecutionIntentRepositoryLive,
} from "./DurableExecutionIntentRepository.ts";

const layer = it.layer(
  DurableExecutionIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const event = (id: string, threadId: ThreadId, sequence: number) => ({
  type: "thread.turn-start-requested" as const,
  sequence,
  eventId: EventId.make(`event-${id}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: CommandId.make(id),
  causationEventId: null,
  correlationId: CorrelationId.make(id),
  metadata: {},
  payload: {
    threadId,
    messageId: MessageId.make(`message-${id}`),
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});

layer("durable audit regressions", (it) => {
  it.effect("runs another thread while a real durable setup preparation is held", () =>
    Effect.gen(function* () {
      const repository = yield* DurableExecutionIntentRepository;
      const held = event("audit-held-setup", ThreadId.make("audit-held-thread"), 60);
      const other = event("audit-other-thread", ThreadId.make("audit-other-thread"), 61);
      const setupStarted = yield* Deferred.make<void>();
      const releaseSetup = yield* Deferred.make<void>();
      const otherDispatched = yield* Deferred.make<void>();
      for (const accepted of [held, other]) {
        yield* repository.acceptFromEvent({
          event: accepted,
          message: {
            messageId: accepted.payload.messageId,
            threadId: accepted.payload.threadId,
            turnId: null,
            role: "user",
            text: accepted.commandId,
            attachments: [],
            isStreaming: false,
            sentByUserId: null,
            createdAt: accepted.occurredAt,
            updatedAt: accepted.occurredAt,
          },
        });
      }
      const coordinator = yield* makeDurableExecutionCoordinator({
        ownerId: "audit-owner",
        loadEvent: (intent) => Effect.succeed(intent.workItemId === held.commandId ? held : other),
        prepare: ({ intent }) =>
          intent.workItemId === held.commandId
            ? Deferred.succeed(setupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSetup)),
              )
            : Effect.void,
        dispatchOriginal: ({ intent }) =>
          (intent.workItemId === other.commandId
            ? Deferred.succeed(otherDispatched, undefined)
            : Effect.void
          ).pipe(Effect.as({ providerTurnId: "audit-provider-turn", providerInstanceId: "codex" })),
        recover: () => Effect.die("unexpected recovery"),
      });
      yield* coordinator.start();
      yield* Deferred.await(setupStarted);
      yield* coordinator.wake(other.commandId);
      yield* Deferred.await(otherDispatched);
      yield* Deferred.succeed(releaseSetup, undefined);
      assert.isTrue(true);
    }),
  );
});
