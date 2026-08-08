// T3-CUSTOM(expbkt3): bulk session manager work summary projection coverage.
//
// Covers both halves of the durable path in one harness, because they are only
// meaningful together: the pipeline writes `projection_threads.work_summary`
// and `ProjectionSnapshotQuery` is the only thing that reads it back into a
// shell. Testing either alone would pass while the pair was broken.
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadWorkSummary,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const CREATED_AT = "2026-02-01T00:00:00.000Z";

// The suite shares one in-memory database and the engine dedupes by command id,
// so every case works on its own thread with its own command ids. Reusing them
// would silently replay an earlier case's receipts instead of failing.
const projectIdFor = (suffix: string) => ProjectId.make(`project-work-summary-${suffix}`);
const threadIdFor = (suffix: string) => ThreadId.make(`thread-work-summary-${suffix}`);
const requestIdFor = (suffix: string, index: number) =>
  CommandId.make(`cmd-work-summary-request-${suffix}-${index}`);

function readySummary(requestId: CommandId, summary: string): ThreadWorkSummary {
  return {
    status: "ready",
    summary,
    stage: "implementing",
    remaining: "Finish the projector",
    percent: 60,
    error: null,
    requestId,
    updatedAt: "2026-02-01T00:05:00.000Z",
  };
}

const seed = Effect.fn("seedWorkSummaryThread")(function* (suffix: string) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-work-summary-project-${suffix}`),
    projectId: projectIdFor(suffix),
    title: "Work summary project",
    workspaceRoot: `/tmp/project-work-summary-${suffix}`,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: CREATED_AT,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-work-summary-thread-${suffix}`),
    threadId: threadIdFor(suffix),
    projectId: projectIdFor(suffix),
    title: "Work summary thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    createdAt: CREATED_AT,
  });
});

const readStoredColumn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly work_summary: string | null }>`
      SELECT work_summary FROM projection_threads WHERE thread_id = ${threadId}
    `;
    return rows[0]?.work_summary ?? null;
  });

const readShell = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const shell = yield* snapshotQuery.getThreadShellById(threadId);
    return Option.getOrNull(shell);
  });

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-work-summary-projection-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("ProjectionPipeline work summary", (it) => {
  it.effect("leaves a fresh thread with no work summary at all", () =>
    Effect.gen(function* () {
      const threadId = threadIdFor("fresh");
      yield* seed("fresh");

      assert.strictEqual(yield* readStoredColumn(threadId), null);
      // Distinguishable from "generated and empty": the table renders a dash.
      assert.strictEqual((yield* readShell(threadId))?.workSummary ?? null, null);
    }),
  );

  it.effect("installs a pending record from the request event alone", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = threadIdFor("pending");
      const requestId = requestIdFor("pending", 1);
      yield* seed("pending");

      yield* engine.dispatch({
        type: "thread.work-summary.request",
        commandId: requestId,
        threadId,
        createdAt: CREATED_AT,
      });

      // The reactor has not run yet; the spinner must already be visible.
      const shell = yield* readShell(threadId);
      assert.strictEqual(shell?.workSummary?.status, "pending");
      assert.strictEqual(shell?.workSummary?.requestId, requestId);
      assert.strictEqual(shell?.workSummary?.summary, null);
      assert.strictEqual(shell?.workSummary?.percent, null);
    }),
  );

  it.effect("persists a ready result and exposes it on every shell read", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const threadId = threadIdFor("ready");
      const requestId = requestIdFor("ready", 1);
      yield* seed("ready");

      yield* engine.dispatch({
        type: "thread.work-summary.request",
        commandId: requestId,
        threadId,
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "thread.work-summary.update",
        commandId: CommandId.make("cmd-work-summary-update-ready"),
        threadId,
        requestId,
        workSummary: readySummary(requestId, "Built the projection path."),
        createdAt: "2026-02-01T00:05:00.000Z",
      });

      assert.isNotNull(yield* readStoredColumn(threadId));

      const shell = yield* readShell(threadId);
      assert.strictEqual(shell?.workSummary?.status, "ready");
      assert.strictEqual(shell?.workSummary?.summary, "Built the projection path.");
      assert.strictEqual(shell?.workSummary?.stage, "implementing");
      assert.strictEqual(shell?.workSummary?.remaining, "Finish the projector");
      assert.strictEqual(shell?.workSummary?.percent, 60);

      // The bulk table reads the list snapshot, not the single-thread read.
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const listed = snapshot.threads.find((thread) => thread.id === threadId);
      assert.strictEqual(listed?.workSummary?.summary, "Built the projection path.");

      // Thread detail carries the same record for the session view and MCP.
      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.strictEqual(
        Option.getOrNull(detail)?.workSummary?.summary,
        "Built the projection path.",
      );
    }),
  );

  it.effect("drops a result whose request was superseded by a newer one", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = threadIdFor("supersede");
      const firstRequest = requestIdFor("supersede", 1);
      const secondRequest = requestIdFor("supersede", 2);
      yield* seed("supersede");

      yield* engine.dispatch({
        type: "thread.work-summary.request",
        commandId: firstRequest,
        threadId,
        createdAt: CREATED_AT,
      });
      // Operator re-selects the row while the first generation is still running.
      yield* engine.dispatch({
        type: "thread.work-summary.request",
        commandId: secondRequest,
        threadId,
        createdAt: "2026-02-01T00:01:00.000Z",
      });
      // The first generation finishes late.
      yield* engine.dispatch({
        type: "thread.work-summary.update",
        commandId: CommandId.make("cmd-work-summary-update-stale"),
        threadId,
        requestId: firstRequest,
        workSummary: readySummary(firstRequest, "Stale answer."),
        createdAt: "2026-02-01T00:05:00.000Z",
      });

      const superseded = yield* readShell(threadId);
      assert.strictEqual(superseded?.workSummary?.status, "pending");
      assert.strictEqual(superseded?.workSummary?.requestId, secondRequest);

      // The owning request still lands.
      yield* engine.dispatch({
        type: "thread.work-summary.update",
        commandId: CommandId.make("cmd-work-summary-update-current"),
        threadId,
        requestId: secondRequest,
        workSummary: readySummary(secondRequest, "Current answer."),
        createdAt: "2026-02-01T00:06:00.000Z",
      });
      const current = yield* readShell(threadId);
      assert.strictEqual(current?.workSummary?.status, "ready");
      assert.strictEqual(current?.workSummary?.summary, "Current answer.");
    }),
  );

  it.effect("persists an error result so a reconnecting table stops spinning", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const threadId = threadIdFor("error");
      const requestId = requestIdFor("error", 1);
      yield* seed("error");

      yield* engine.dispatch({
        type: "thread.work-summary.request",
        commandId: requestId,
        threadId,
        createdAt: CREATED_AT,
      });
      yield* engine.dispatch({
        type: "thread.work-summary.update",
        commandId: CommandId.make("cmd-work-summary-update-error"),
        threadId,
        requestId,
        workSummary: {
          status: "error",
          summary: null,
          stage: null,
          remaining: null,
          percent: null,
          error: "summarizer unavailable in test",
          requestId,
          updatedAt: "2026-02-01T00:05:00.000Z",
        },
        createdAt: "2026-02-01T00:05:00.000Z",
      });

      const shell = yield* readShell(threadId);
      assert.strictEqual(shell?.workSummary?.status, "error");
      assert.strictEqual(shell?.workSummary?.error, "summarizer unavailable in test");
    }),
  );
});
