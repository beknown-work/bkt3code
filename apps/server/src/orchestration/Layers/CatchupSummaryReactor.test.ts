import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  TextGenerationError,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { CatchupSummaryReactorLive } from "./CatchupSummaryReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { CatchupSummaryReactor } from "../Services/CatchupSummaryReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const THREAD_ID = ThreadId.make("thread-catchup");
const PROJECT_ID = ProjectId.make("project-catchup");
const TURN_ID = TurnId.make("turn-catchup");
const ASSISTANT_MESSAGE_ID = MessageId.make("message-assistant-catchup");
const USER_MESSAGE_ID = MessageId.make("message-user-catchup");
const CREATED_AT = "2026-01-01T00:00:00.000Z";
/** 10 minutes of work — comfortably past the 5 minute cutoff under test. */
const LONG_TURN_COMPLETED_AT = "2026-01-01T00:10:00.000Z";
/** 1 minute of work — below the cutoff. */
const SHORT_TURN_COMPLETED_AT = "2026-01-01T00:01:00.000Z";

const ROLLING_SUMMARY = "Rolling summary text.";
const DISPLAY_SUMMARY = "Wired the reactor.\nRemains: ship the card.";

const makeHarness = (options: {
  readonly enabled?: boolean;
  readonly minTurnDurationMinutes?: number;
  readonly failCatchup?: boolean;
}) =>
  Effect.gen(function* () {
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>({ replay: 1 });
    const rollingCalls = yield* Ref.make(0);
    const catchupCalls = yield* Ref.make(0);

    const providerService = {
      listSessions: () => Effect.succeed([]),
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } as unknown as ProviderServiceShape;

    const textGeneration = {
      updateRollingSummary: () =>
        Ref.update(rollingCalls, (count) => count + 1).pipe(
          Effect.as({ summary: ROLLING_SUMMARY }),
        ),
      generateCatchupSummary: () =>
        Ref.update(catchupCalls, (count) => count + 1).pipe(
          Effect.andThen(
            options.failCatchup
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "generateCatchupSummary",
                    detail: "summarizer unavailable in test",
                  }),
                )
              : Effect.succeed({ summary: DISPLAY_SUMMARY }),
          ),
        ),
    } as unknown as TextGeneration["Service"];

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
    );

    const reactorLayer = CatchupSummaryReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provide(Layer.succeed(ProviderService, providerService)),
      Layer.provide(Layer.succeed(TextGeneration, textGeneration)),
      Layer.provide(
        ServerSettingsService.layerTest({
          experimental: {
            sessionSummary: {
              enabled: options.enabled ?? true,
              minTurnDurationMinutes: options.minTurnDurationMinutes ?? 5,
            },
          },
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-catchup-reactor-test-" })),
      Layer.provide(NodeServices.layer),
    );

    return {
      reactorLayer,
      rollingCalls,
      catchupCalls,
      emit: (event: ProviderRuntimeEvent) => PubSub.publish(runtimeEvents, event),
    };
  });

const seedThread = Effect.fn("seedThread")(function* () {
  const engine = yield* OrchestrationEngineService;

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project-create-catchup"),
    projectId: PROJECT_ID,
    title: "Catch-up Project",
    workspaceRoot: process.cwd(),
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread-create-catchup"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Catch-up Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: process.cwd(),
    sourceControlProfileId: null,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-turn-start-catchup"),
    threadId: THREAD_ID,
    message: {
      messageId: USER_MESSAGE_ID,
      role: "user",
      text: "Add the catch-up card",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.message.assistant.delta",
    commandId: CommandId.make("cmd-assistant-delta-catchup"),
    threadId: THREAD_ID,
    messageId: ASSISTANT_MESSAGE_ID,
    delta: "Done: the reactor now writes summaries.",
    turnId: TURN_ID,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.message.assistant.complete",
    commandId: CommandId.make("cmd-assistant-complete-catchup"),
    threadId: THREAD_ID,
    messageId: ASSISTANT_MESSAGE_ID,
    turnId: TURN_ID,
    createdAt: CREATED_AT,
  });
});

const completeTurn = Effect.fn("completeTurn")(function* (suffix: string, completedAt: string) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.turn.diff.complete",
    commandId: CommandId.make(`cmd-turn-diff-catchup-${suffix}`),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    completedAt,
    checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-catchup/1"),
    status: "ready",
    files: [],
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    checkpointTurnCount: 1,
    createdAt: completedAt,
  });
});

const emitTurnStarted = (emit: (event: ProviderRuntimeEvent) => Effect.Effect<boolean>) =>
  emit({
    type: "turn.started",
    eventId: "event-turn-started-catchup",
    provider: ProviderDriverKind.make("codex"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    createdAt: CREATED_AT,
    payload: {},
  } as unknown as ProviderRuntimeEvent);

const readThread = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot = yield* snapshotQuery.getSnapshot();
  return snapshot.threads.find((thread) => thread.id === THREAD_ID) ?? null;
});

const layer = it.layer(SqlitePersistenceMemory);

layer("CatchupSummaryReactor", (it) => {
  it.effect("makes no summarizer calls at all while the feature is disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });

      yield* Effect.gen(function* () {
        const reactor = yield* CatchupSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* emitTurnStarted(harness.emit);
        yield* completeTurn("disabled", LONG_TURN_COMPLETED_AT);
        yield* reactor.drain;

        assert.strictEqual(yield* Ref.get(harness.rollingCalls), 0);
        assert.strictEqual(yield* Ref.get(harness.catchupCalls), 0);

        const thread = yield* readThread;
        assert.strictEqual(thread?.rollingSummary ?? null, null);
        assert.deepEqual(thread?.turnSummaries ?? [], []);
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("advances the rolling summary but writes no card under the cutoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ minTurnDurationMinutes: 5 });

      yield* Effect.gen(function* () {
        const reactor = yield* CatchupSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* emitTurnStarted(harness.emit);
        yield* completeTurn("short", SHORT_TURN_COMPLETED_AT);
        yield* reactor.drain;

        assert.strictEqual(yield* Ref.get(harness.rollingCalls), 1);
        assert.strictEqual(yield* Ref.get(harness.catchupCalls), 0);

        const thread = yield* readThread;
        assert.strictEqual(thread?.rollingSummary, ROLLING_SUMMARY);
        assert.deepEqual(thread?.turnSummaries ?? [], []);
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("writes a catch-up card for a turn that ran past the cutoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ minTurnDurationMinutes: 5 });

      yield* Effect.gen(function* () {
        const reactor = yield* CatchupSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* emitTurnStarted(harness.emit);
        yield* completeTurn("long", LONG_TURN_COMPLETED_AT);
        yield* reactor.drain;

        assert.strictEqual(yield* Ref.get(harness.rollingCalls), 1);
        assert.strictEqual(yield* Ref.get(harness.catchupCalls), 1);

        const thread = yield* readThread;
        assert.strictEqual(thread?.rollingSummary, ROLLING_SUMMARY);
        assert.strictEqual(thread?.turnSummaries.length, 1);
        assert.strictEqual(thread?.turnSummaries[0]?.turnId, TURN_ID);
        assert.strictEqual(thread?.turnSummaries[0]?.assistantMessageId, ASSISTANT_MESSAGE_ID);
        assert.strictEqual(thread?.turnSummaries[0]?.summary, DISPLAY_SUMMARY);
        assert.strictEqual(thread?.turnSummaries[0]?.status, "ready");
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("summarizes every settled turn at a zero-minute cutoff without a start event", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ minTurnDurationMinutes: 0 });

      yield* Effect.gen(function* () {
        const reactor = yield* CatchupSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        // Deliberately omit the live turn.started event. Replays and reconnects
        // can have a transcript without a measurable live duration.
        yield* completeTurn("zero-cutoff", SHORT_TURN_COMPLETED_AT);
        yield* reactor.drain;

        assert.strictEqual(yield* Ref.get(harness.catchupCalls), 1);
        const thread = yield* readThread;
        assert.strictEqual(thread?.turnSummaries[0]?.status, "ready");
        assert.strictEqual(thread?.turnSummaries[0]?.summary, DISPLAY_SUMMARY);
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("regenerates on request even for a turn under the cutoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ minTurnDurationMinutes: 5 });

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const reactor = yield* CatchupSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* emitTurnStarted(harness.emit);
        yield* completeTurn("short", SHORT_TURN_COMPLETED_AT);
        yield* reactor.drain;

        // Under the cutoff: no card yet.
        assert.strictEqual(yield* Ref.get(harness.catchupCalls), 0);

        yield* engine.dispatch({
          type: "thread.catchup-summary.request",
          commandId: CommandId.make("cmd-catchup-request"),
          threadId: THREAD_ID,
          turnId: TURN_ID,
          createdAt: SHORT_TURN_COMPLETED_AT,
        });
        yield* reactor.drain;

        assert.strictEqual(yield* Ref.get(harness.catchupCalls), 1);
        const thread = yield* readThread;
        assert.strictEqual(thread?.turnSummaries[0]?.summary, DISPLAY_SUMMARY);
        assert.strictEqual(thread?.turnSummaries[0]?.status, "ready");
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("honors an explicit request even when automatic summaries are disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const reactor = yield* CatchupSummaryReactor;
        yield* reactor.start();
        yield* seedThread();

        yield* engine.dispatch({
          type: "thread.catchup-summary.request",
          commandId: CommandId.make("cmd-disabled-catchup-request"),
          threadId: THREAD_ID,
          turnId: TURN_ID,
          createdAt: SHORT_TURN_COMPLETED_AT,
        });
        yield* reactor.drain;

        assert.strictEqual(yield* Ref.get(harness.catchupCalls), 1);
        const thread = yield* readThread;
        assert.strictEqual(thread?.turnSummaries[0]?.status, "ready");
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("replaces the pending marker with an inline error when summarization fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ minTurnDurationMinutes: 5, failCatchup: true });

      yield* Effect.gen(function* () {
        const reactor = yield* CatchupSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* emitTurnStarted(harness.emit);
        yield* completeTurn("failing", LONG_TURN_COMPLETED_AT);
        yield* reactor.drain;

        const thread = yield* readThread;
        assert.strictEqual(thread?.turnSummaries.length, 1);
        assert.strictEqual(thread?.turnSummaries[0]?.status, "error");
        assert.strictEqual(thread?.turnSummaries[0]?.summary, "summarizer unavailable in test");
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("summarizes a turn once even when completion is signalled twice", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ minTurnDurationMinutes: 5 });

      yield* Effect.gen(function* () {
        const reactor = yield* CatchupSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* emitTurnStarted(harness.emit);
        yield* completeTurn("first", LONG_TURN_COMPLETED_AT);
        yield* reactor.drain;
        yield* completeTurn("second", LONG_TURN_COMPLETED_AT);
        yield* reactor.drain;

        assert.strictEqual(yield* Ref.get(harness.rollingCalls), 1);
        assert.strictEqual(yield* Ref.get(harness.catchupCalls), 1);
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );
});
