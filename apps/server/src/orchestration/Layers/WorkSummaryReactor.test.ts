// T3-CUSTOM(expbkt3): bulk session manager work summary reactor coverage.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorkSummaryReactor } from "../Services/WorkSummaryReactor.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { WorkSummaryReactorLive } from "./WorkSummaryReactor.ts";

const PROJECT_ID = ProjectId.make("project-work-summary-reactor");
const THREAD_ID = ThreadId.make("thread-work-summary-reactor");
const ARCHIVED_THREAD_ID = ThreadId.make("thread-work-summary-archived");
const TURN_ID = TurnId.make("turn-work-summary-reactor");
const USER_MESSAGE_ID = MessageId.make("message-user-work-summary");
const ASSISTANT_MESSAGE_ID = MessageId.make("message-assistant-work-summary");
const CREATED_AT = "2026-03-01T00:00:00.000Z";

const GENERATED = {
  summary: "Added the projection column and wired the reactor.",
  stage: "implementing" as const,
  remaining: "Ship the client table",
  percent: 55,
};

const makeHarness = (options: {
  readonly enabled?: boolean;
  readonly fail?: boolean;
  /** Completed by the stub when the first generation starts. */
  readonly firstCallStarted?: Deferred.Deferred<void>;
  /** Awaited by the first generation, so the test controls the queue window. */
  readonly releaseFirstCall?: Deferred.Deferred<void>;
}) =>
  Effect.gen(function* () {
    const generateCalls = yield* Ref.make(0);

    const textGeneration = {
      generateWorkSummary: () =>
        Ref.update(generateCalls, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (options.firstCallStarted === undefined) {
                return;
              }
              const alreadyStarted = yield* Deferred.isDone(options.firstCallStarted);
              if (alreadyStarted) {
                return;
              }
              yield* Deferred.done(options.firstCallStarted, Exit.void);
              if (options.releaseFirstCall !== undefined) {
                yield* Deferred.await(options.releaseFirstCall);
              }
            }),
          ),
          Effect.andThen(
            options.fail
              ? Effect.fail(
                  new TextGenerationError({
                    operation: "generateWorkSummary",
                    detail: "summarizer unavailable in test",
                  }),
                )
              : Effect.succeed(GENERATED),
          ),
        ),
    } as unknown as TextGeneration["Service"];

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
    );

    const reactorLayer = WorkSummaryReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provide(Layer.succeed(TextGeneration, textGeneration)),
      Layer.provide(
        ServerSettingsService.layerTest({
          experimental: {
            sessionWorkSummary: {
              enabled: options.enabled ?? true,
            },
          },
        }),
      ),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-work-summary-reactor-test-" }),
      ),
      Layer.provide(NodeServices.layer),
    );

    return { reactorLayer, generateCalls };
  });

const seedThread = Effect.fn("seedThread")(function* () {
  const engine = yield* OrchestrationEngineService;

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project-create-work-summary"),
    projectId: PROJECT_ID,
    title: "Work summary project",
    workspaceRoot: process.cwd(),
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread-create-work-summary"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Work summary thread",
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
    commandId: CommandId.make("cmd-turn-start-work-summary"),
    threadId: THREAD_ID,
    message: {
      messageId: USER_MESSAGE_ID,
      role: "user",
      text: "Build the bulk session manager",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.message.assistant.delta",
    commandId: CommandId.make("cmd-assistant-delta-work-summary"),
    threadId: THREAD_ID,
    messageId: ASSISTANT_MESSAGE_ID,
    delta: "Added the projection column.",
    turnId: TURN_ID,
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.message.assistant.complete",
    commandId: CommandId.make("cmd-assistant-complete-work-summary"),
    threadId: THREAD_ID,
    messageId: ASSISTANT_MESSAGE_ID,
    turnId: TURN_ID,
    createdAt: CREATED_AT,
  });
});

const requestWorkSummary = (commandId: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.work-summary.request",
      commandId: CommandId.make(commandId),
      threadId: THREAD_ID,
      createdAt: CREATED_AT,
    });
  });

const readWorkSummary = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot = yield* snapshotQuery.getSnapshot();
  return snapshot.threads.find((thread) => thread.id === THREAD_ID)?.workSummary ?? null;
});

const layer = it.layer(SqlitePersistenceMemory);

layer("WorkSummaryReactor", (it) => {
  it.effect("writes a ready work summary with the assigned progress", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});

      yield* Effect.gen(function* () {
        const reactor = yield* WorkSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* requestWorkSummary("cmd-work-summary-ready");
        yield* reactor.drain;

        assert.strictEqual(yield* Ref.get(harness.generateCalls), 1);
        const workSummary = yield* readWorkSummary;
        assert.strictEqual(workSummary?.status, "ready");
        assert.strictEqual(workSummary?.summary, GENERATED.summary);
        assert.strictEqual(workSummary?.stage, GENERATED.stage);
        assert.strictEqual(workSummary?.remaining, GENERATED.remaining);
        assert.strictEqual(workSummary?.percent, GENERATED.percent);
        assert.strictEqual(workSummary?.error, null);
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("replaces the spinner with an error when generation fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ fail: true });

      yield* Effect.gen(function* () {
        const reactor = yield* WorkSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* requestWorkSummary("cmd-work-summary-failure");
        yield* reactor.drain;

        const workSummary = yield* readWorkSummary;
        assert.strictEqual(workSummary?.status, "error");
        assert.strictEqual(workSummary?.error, "summarizer unavailable in test");
        assert.strictEqual(workSummary?.summary, null);
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("reports the disabled feature instead of leaving the row spinning", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });

      yield* Effect.gen(function* () {
        const reactor = yield* WorkSummaryReactor;
        yield* reactor.start();
        yield* seedThread();
        yield* requestWorkSummary("cmd-work-summary-disabled");
        yield* reactor.drain;

        // No tokens spent, but the pending marker must still be resolved.
        assert.strictEqual(yield* Ref.get(harness.generateCalls), 0);
        const workSummary = yield* readWorkSummary;
        assert.strictEqual(workSummary?.status, "error");
        assert.include(workSummary?.error ?? "", "turned off");
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  // Regression: on expbkt3 an archived session left the table spinning on
  // "Summarizing…" forever. Archived threads are absent from the detail read
  // model, and the reactor returned quietly after the projector had already
  // written the pending marker.
  //
  // Uses its own thread: every test in this layer shares one in-memory database,
  // so archiving THREAD_ID here would strand the later concurrency test.
  it.effect("reports an archived session instead of leaving the row spinning", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});

      yield* Effect.gen(function* () {
        const reactor = yield* WorkSummaryReactor;
        yield* reactor.start();
        yield* seedThread();

        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-work-summary-archived"),
          threadId: ARCHIVED_THREAD_ID,
          projectId: PROJECT_ID,
          title: "Archived work summary thread",
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
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-work-summary"),
          threadId: ARCHIVED_THREAD_ID,
        });

        yield* engine.dispatch({
          type: "thread.work-summary.request",
          commandId: CommandId.make("cmd-work-summary-archived"),
          threadId: ARCHIVED_THREAD_ID,
          createdAt: CREATED_AT,
        });
        yield* reactor.drain;

        // No tokens spent, but the spinner must still be replaced.
        assert.strictEqual(yield* Ref.get(harness.generateCalls), 0);
        // Archived threads only appear in the archived snapshot — which is
        // exactly the list the manager page reads when "Archived" is toggled on.
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const archived = yield* snapshotQuery.getArchivedShellSnapshot();
        const workSummary =
          archived.threads.find((thread) => thread.id === ARCHIVED_THREAD_ID)?.workSummary ?? null;
        assert.strictEqual(workSummary?.status, "error");
        assert.include(workSummary?.error ?? "", "archived");
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );

  it.effect("skips queued duplicates and keeps only the newest request's result", () =>
    Effect.gen(function* () {
      const firstCallStarted = yield* Deferred.make<void>();
      const releaseFirstCall = yield* Deferred.make<void>();
      const harness = yield* makeHarness({ firstCallStarted, releaseFirstCall });

      yield* Effect.gen(function* () {
        const reactor = yield* WorkSummaryReactor;
        yield* reactor.start();
        yield* seedThread();

        // Hold the first generation open so the next two requests are certainly
        // queued behind it — the shape a bulk selection produces in production.
        yield* requestWorkSummary("cmd-work-summary-dup-1");
        yield* Deferred.await(firstCallStarted);
        yield* requestWorkSummary("cmd-work-summary-dup-2");
        yield* requestWorkSummary("cmd-work-summary-dup-3");
        yield* Deferred.done(releaseFirstCall, Exit.void);
        yield* reactor.drain;

        // Three requests, two model calls: the queued middle request is skipped
        // because the row already belonged to a newer one by the time the
        // worker reached it. The first was already running and cannot be taken
        // back, but its result is discarded below.
        assert.strictEqual(yield* Ref.get(harness.generateCalls), 2);

        const workSummary = yield* readWorkSummary;
        assert.strictEqual(workSummary?.status, "ready");
        assert.strictEqual(workSummary?.requestId, "cmd-work-summary-dup-3");
      }).pipe(Effect.provide(harness.reactorLayer), Effect.scoped);
    }),
  );
});
