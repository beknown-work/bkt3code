// T3-CUSTOM(expbkt3): bulk session manager work summary decider coverage.
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadWorkSummary,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeReadModel(workSummary: ThreadWorkSummary | null = null): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        ownerUserId: null,
        memberUserIds: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        sourceControlProfileId: null,
        latestTurn: null,
        ownerUserId: null,
        memberUserIds: [],
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        priority: null,
        workSummary,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        rollingSummary: null,
        turnSummaries: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const READY_SUMMARY: ThreadWorkSummary = {
  status: "ready",
  summary: "Wired the bulk session manager server path end to end.",
  stage: "awaiting-review",
  remaining: "Land the client table",
  percent: 80,
  error: null,
  requestId: CommandId.make("cmd-work-summary-request"),
  updatedAt: NOW,
};

it.layer(NodeServices.layer)("thread work summary decider", (it) => {
  it.effect("reuses the request command id as the request id", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.work-summary.request",
          commandId: CommandId.make("cmd-work-summary-request"),
          threadId: THREAD_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.work-summary-requested");
      if (events[0]?.type === "thread.work-summary-requested") {
        // One id ties the pending marker, the reactor dispatch, and the
        // projector's supersede check together without a second round trip.
        expect(events[0].payload.requestId).toBe("cmd-work-summary-request");
        expect(events[0].payload.requestedAt).toBe(NOW);
        expect(events[0].payload.threadId).toBe(THREAD_ID);
      }
    }),
  );

  it.effect("rejects a request for a thread that does not exist", () =>
    Effect.gen(function* () {
      const outcome = yield* decideOrchestrationCommand({
        command: {
          type: "thread.work-summary.request",
          commandId: CommandId.make("cmd-work-summary-missing"),
          threadId: ThreadId.make("thread-missing"),
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.result);
      expect(outcome._tag).toBe("Failure");
    }),
  );

  it.effect("carries the reactor's result through work-summary.update", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.work-summary.update",
          commandId: CommandId.make("cmd-work-summary-update"),
          threadId: THREAD_ID,
          requestId: CommandId.make("cmd-work-summary-request"),
          workSummary: READY_SUMMARY,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.work-summary-updated");
      if (events[0]?.type === "thread.work-summary-updated") {
        expect(events[0].payload.requestId).toBe("cmd-work-summary-request");
        expect(events[0].payload.workSummary).toEqual(READY_SUMMARY);
      }
    }),
  );

  it.effect("emits a superseded result too, leaving the drop to the projector", () =>
    Effect.gen(function* () {
      // The decider has no opinion on staleness: it records what the reactor
      // produced. Dropping it belongs where the current request id is stored.
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.work-summary.update",
          commandId: CommandId.make("cmd-work-summary-update-stale"),
          threadId: THREAD_ID,
          requestId: CommandId.make("cmd-work-summary-old"),
          workSummary: { ...READY_SUMMARY, requestId: CommandId.make("cmd-work-summary-old") },
          createdAt: NOW,
        },
        readModel: makeReadModel({
          ...READY_SUMMARY,
          status: "pending",
          requestId: CommandId.make("cmd-work-summary-new"),
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.work-summary-updated");
      if (events[0]?.type === "thread.work-summary-updated") {
        expect(events[0].payload.requestId).toBe("cmd-work-summary-old");
      }
    }),
  );
});
