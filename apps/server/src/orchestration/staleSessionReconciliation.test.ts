import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { runStaleSessionReconciliation } from "./staleSessionReconciliation.ts";
import { ServerConfig } from "../config.ts";

const AT = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("11111111-1111-4111-8111-111111111111");
const THREAD_ID = ThreadId.make("22222222-2222-4222-8222-222222222222");
const TURN_ID = TurnId.make("33333333-3333-4333-8333-333333333333");

const reconciliationLayer = it.layer(
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-stale-session-test-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/**
 * The turn projection is what the composer's "working" indicator reads;
 * latest_turn_id is only populated by provider ingestion, so assert here.
 */
const readTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql`
    SELECT turn_id, state, completed_at FROM projection_turns WHERE thread_id = ${THREAD_ID}
  `) as ReadonlyArray<{
    readonly turn_id: string | null;
    readonly state: string;
    readonly completed_at: string | null;
  }>;
});

/** Project + thread + a turn left mid-flight with a running session. */
const seedRunningTurn = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId: PROJECT_ID,
    title: "Project",
    workspaceRoot: process.cwd(),
    createWorkspaceRootIfMissing: false,
    createdAt: AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    createdAt: AT,
  });
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-turn"),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make("44444444-4444-4444-8444-444444444444"),
      role: "user",
      text: "go",
      attachments: [],
    },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    titleSeed: "Thread",
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: AT,
  });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make("cmd-session-running"),
    threadId: THREAD_ID,
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: TURN_ID,
      lastError: null,
      updatedAt: AT,
    },
    createdAt: AT,
  });
});

reconciliationLayer("runStaleSessionReconciliation", (it) => {
  it.effect("settles a session left running by a previous process", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* seedRunningTurn;

      const before = yield* snapshotQuery.getShellSnapshot();
      assert.strictEqual(before.threads[0]?.session?.status, "running");
      assert.include(
        (yield* readTurns).map((turn) => turn.state),
        "running",
      );

      yield* runStaleSessionReconciliation;

      const after = yield* snapshotQuery.getShellSnapshot();
      assert.strictEqual(after.threads[0]?.session?.status, "interrupted");
      assert.isNull(after.threads[0]?.session?.activeTurnId ?? null);

      // The orphaned turn must stop reading as in-progress, otherwise the
      // composer keeps counting up from a turn whose process is long gone.
      const turns = yield* readTurns;
      assert.notInclude(
        turns.map((turn) => turn.state),
        "running",
      );
      const settled = turns.find((turn) => turn.turn_id === TURN_ID);
      assert.strictEqual(settled?.state, "interrupted");
      assert.isNotNull(settled?.completed_at ?? null);

      // The settle must be stamped at the thread's last recorded activity, not
      // at boot time. session.updatedAt becomes the turn's completedAt, so
      // stamping "now" would record the whole gap since the crash as turn
      // duration — a turn orphaned yesterday would read "Worked for 17h".
      assert.strictEqual(settled?.completed_at, AT);
    }),
  );

  it.effect("leaves an already-settled session untouched", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* seedRunningTurn;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-ready"),
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: AT,
        },
        createdAt: AT,
      });
      const before = yield* snapshotQuery.getShellSnapshot();

      yield* runStaleSessionReconciliation;

      const after = yield* snapshotQuery.getShellSnapshot();
      assert.strictEqual(after.threads[0]?.session?.status, "ready");
      assert.strictEqual(
        after.threads[0]?.session?.updatedAt,
        before.threads[0]?.session?.updatedAt,
      );
    }),
  );
});
