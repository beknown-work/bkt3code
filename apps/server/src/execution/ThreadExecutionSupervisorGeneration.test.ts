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
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as SessionRecoveryStateLayer } from "../persistence/SessionRecoveryState.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ThreadExecutionSupervisor } from "./ThreadExecutionSupervisor.ts";
import { ThreadExecutionSupervisorLive } from "./ThreadExecutionSupervisorLive.ts";

const threadId = ThreadId.make("replacement-generation-thread");
const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const createdAt = "2026-08-06T00:00:00.000Z";

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

const publishAndDrain = Effect.fn("publishAndDrain")(function* (
  runtimeEvents: PubSub.PubSub<ProviderRuntimeEvent>,
  event: ProviderRuntimeEvent,
) {
  yield* PubSub.publish(runtimeEvents, event);
  for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;
});

it.effect("adopts a replacement generation while a ready session starts a turn", () =>
  Effect.gen(function* () {
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>({ replay: 1 });
    const providerService = {
      inspectSession: () => Effect.succeed(null),
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } as unknown as ProviderServiceShape;
    const orchestration = {
      readEvents: () => Stream.empty,
      dispatch: () => Effect.succeed({ sequence: 0 }),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as OrchestrationEngineService["Service"];
    const supervisorLayer = ThreadExecutionSupervisorLive.pipe(
      Layer.provide(SessionRecoveryStateLayer),
      Layer.provide(Layer.succeed(ProviderService, providerService)),
      Layer.provide(Layer.succeed(OrchestrationEngineService, orchestration)),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const supervisor = yield* ThreadExecutionSupervisor;
      yield* Effect.yieldNow;
      yield* supervisor.prepareExecution(startEvent("initial"));
      yield* publishAndDrain(runtimeEvents, {
        type: "turn.started",
        eventId: EventId.make("initial-turn-started"),
        provider,
        providerInstanceId,
        threadId,
        sessionGeneration: 3,
        turnId: TurnId.make("initial-provider-turn"),
        createdAt,
        payload: {},
      });
      yield* publishAndDrain(runtimeEvents, {
        type: "turn.completed",
        eventId: EventId.make("initial-turn-completed"),
        provider,
        providerInstanceId,
        threadId,
        sessionGeneration: 3,
        turnId: TurnId.make("initial-provider-turn"),
        createdAt,
        payload: { state: "completed" },
      });
      assert.strictEqual((yield* supervisor.getSnapshot(threadId)).activity, "idle");

      yield* supervisor.prepareExecution(startEvent("replacement"));
      yield* publishAndDrain(runtimeEvents, {
        type: "session.started",
        eventId: EventId.make("replacement-session-started"),
        provider,
        providerInstanceId,
        threadId,
        sessionGeneration: 4,
        createdAt,
        payload: {},
      });
      yield* publishAndDrain(runtimeEvents, {
        type: "turn.started",
        eventId: EventId.make("replacement-turn-started"),
        provider,
        providerInstanceId,
        threadId,
        sessionGeneration: 4,
        turnId: TurnId.make("replacement-provider-turn"),
        createdAt,
        payload: {},
      });
      yield* publishAndDrain(runtimeEvents, {
        type: "turn.completed",
        eventId: EventId.make("replacement-turn-completed"),
        provider,
        providerInstanceId,
        threadId,
        sessionGeneration: 4,
        turnId: TurnId.make("replacement-provider-turn"),
        createdAt,
        payload: { state: "completed" },
      });

      const settled = yield* supervisor.getSnapshot(threadId);
      assert.strictEqual(settled.providerSession.generation, 4);
      assert.strictEqual(settled.activity, "idle");
      assert.strictEqual(settled.turn?.state, "completed");
    }).pipe(Effect.provide(supervisorLayer));
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
