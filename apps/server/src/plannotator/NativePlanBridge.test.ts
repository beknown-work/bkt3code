import {
  OrchestrationProposedPlanId,
  ThreadId,
  type OrchestrationProposedPlan,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { PlannotatorSession } from "./PlannotatorManager.ts";
import {
  attachNativePlanReview,
  latestPlansForNativeReview,
  type NativePlanBridgeDependencies,
} from "./NativePlanBridge.ts";

const CREATED_AT = "2026-07-26T10:00:00.000Z";
const UPDATED_AT = "2026-07-26T10:01:00.000Z";
const ATTACHED_AT = "2026-07-26T10:02:00.000Z";
const threadId = ThreadId.make("thread-native-plan");

function makePlan(
  id: string,
  overrides: Partial<OrchestrationProposedPlan> = {},
): OrchestrationProposedPlan {
  return {
    id: OrchestrationProposedPlanId.make(id),
    turnId: null,
    planMarkdown: "# Native plan\n\n1. Build it.",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function makeSession(
  planId: OrchestrationProposedPlan["id"],
  overrides: Partial<PlannotatorSession> = {},
): PlannotatorSession {
  return {
    id: "review-session",
    threadId,
    planId,
    format: "md",
    planPath: "/private/plan.md",
    logPath: "/private/plan.log",
    proxyPath: "/plannotator/native_token/",
    pid: 123,
    port: 4321,
    directUrl: null,
    status: "running",
    feedback: "",
    annotationHistory: [],
    error: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function makeDependencies(input: {
  readonly sessions?: ReadonlyArray<PlannotatorSession>;
  readonly startedSession: PlannotatorSession;
  readonly discarded: string[];
  readonly commands: unknown[];
  readonly reopened?: unknown[];
}): NativePlanBridgeDependencies {
  return {
    manager: {
      list: () => Effect.succeed(input.sessions ?? []),
      start: () => Effect.succeed(input.startedSession),
      reopen: (reopenInput) =>
        Effect.sync(() => {
          input.reopened?.push(reopenInput);
          return input.startedSession;
        }),
      discard: (id) =>
        Effect.sync(() => {
          input.discarded.push(id);
        }),
    },
    dispatcher: {
      dispatch: (command) =>
        Effect.sync(() => {
          input.commands.push(command);
          return { sequence: 42 };
        }),
    },
    randomUuid: Effect.succeed("native-uuid"),
    now: Effect.succeed(ATTACHED_AT),
  };
}

describe("native Plannotator plan bridge", () => {
  it.effect("attaches a review to the same native proposed-plan record", () =>
    Effect.gen(function* () {
      const proposedPlan = makePlan("plan-native");
      const startedSession = makeSession(proposedPlan.id);
      const discarded: string[] = [];
      const commands: unknown[] = [];

      const result = yield* attachNativePlanReview(
        makeDependencies({ startedSession, discarded, commands }),
        {
          threadId,
          proposedPlan,
        },
      );

      expect(result).toEqual({ status: "attached", session: startedSession });
      expect(discarded).toEqual([]);
      expect(commands).toEqual([
        {
          type: "thread.proposed-plan.upsert",
          commandId: "plannotator:native-plan:native-uuid",
          threadId,
          proposedPlan: {
            ...proposedPlan,
            planMarkdown:
              "# Native plan\n\n1. Build it.\n\n<!-- t3-plannotator:/plannotator/native_token/ -->",
            updatedAt: ATTACHED_AT,
          },
          createdAt: ATTACHED_AT,
        },
      ]);
    }),
  );

  it.effect("does not reopen an already-running attached review", () =>
    Effect.gen(function* () {
      const proposedPlan = makePlan("plan-attached", {
        planMarkdown: "# Attached\n\n<!-- t3-plannotator:/plannotator/native_token/ -->",
      });
      const startedSession = makeSession(proposedPlan.id);
      const discarded: string[] = [];
      const commands: unknown[] = [];

      const result = yield* attachNativePlanReview(
        makeDependencies({
          sessions: [startedSession],
          startedSession,
          discarded,
          commands,
        }),
        { threadId, proposedPlan },
      );

      expect(result).toEqual({ status: "already-attached", session: startedSession });
      expect(discarded).toEqual([]);
      expect(commands).toEqual([]);
    }),
  );

  it.effect("reopens the same review when the provider revises an unmarked plan", () =>
    Effect.gen(function* () {
      const proposedPlan = makePlan("plan-revised");
      const oldSession = makeSession(proposedPlan.id, { id: "old-review" });
      const reopenedSession = makeSession(proposedPlan.id, { id: "old-review" });
      const discarded: string[] = [];
      const commands: unknown[] = [];
      const reopened: unknown[] = [];

      const result = yield* attachNativePlanReview(
        makeDependencies({
          sessions: [oldSession],
          startedSession: reopenedSession,
          discarded,
          commands,
          reopened,
        }),
        { threadId, proposedPlan },
      );

      expect(result).toEqual({ status: "reopened", session: reopenedSession });
      expect(reopened).toEqual([
        {
          tokenOrId: "old-review",
          planId: proposedPlan.id,
          content: proposedPlan.planMarkdown,
        },
      ]);
      expect(discarded).toEqual([]);
      expect(commands).toHaveLength(1);
    }),
  );

  it.effect("carries a feedback review and its annotations into the next plan turn", () =>
    Effect.gen(function* () {
      const previousPlan = makePlan("plan-round-1");
      const revisedPlan = makePlan("plan-round-2", {
        planMarkdown: "# Native plan\n\n1. Build the revised version.",
      });
      const feedbackSession = makeSession(previousPlan.id, {
        id: "durable-review",
        status: "feedback",
        feedback: "Revise the rollout.",
        annotationHistory: [
          {
            id: "annotation-1",
            type: "COMMENT",
            text: "Revise the rollout.",
            originalText: "Build it.",
            author: "Reviewer",
            submittedAt: UPDATED_AT,
          },
        ],
      });
      const reopenedSession = makeSession(revisedPlan.id, {
        ...feedbackSession,
        planId: revisedPlan.id,
        status: "running",
      });
      const reopened: unknown[] = [];
      const commands: unknown[] = [];

      const result = yield* attachNativePlanReview(
        makeDependencies({
          sessions: [feedbackSession],
          startedSession: reopenedSession,
          discarded: [],
          commands,
          reopened,
        }),
        { threadId, proposedPlan: revisedPlan },
      );

      expect(result).toEqual({ status: "reopened", session: reopenedSession });
      expect(reopened).toEqual([
        {
          tokenOrId: "durable-review",
          planId: revisedPlan.id,
          content: revisedPlan.planMarkdown,
        },
      ]);
      expect(commands).toHaveLength(1);
      expect(
        (
          commands[0] as {
            proposedPlan: OrchestrationProposedPlan;
          }
        ).proposedPlan.planMarkdown,
      ).toContain("/plannotator/native_token/");
    }),
  );

  it("reconciles only each thread's newest actionable plan", () => {
    const older = makePlan("older", { updatedAt: CREATED_AT });
    const newest = makePlan("newest", { updatedAt: UPDATED_AT });
    const completedNewest = makePlan("implemented", {
      updatedAt: ATTACHED_AT,
      implementedAt: ATTACHED_AT,
    });

    expect(
      latestPlansForNativeReview([
        {
          id: threadId,
          archivedAt: null,
          deletedAt: null,
          proposedPlans: [newest, older],
        },
        {
          id: ThreadId.make("thread-implemented"),
          archivedAt: null,
          deletedAt: null,
          proposedPlans: [older, completedNewest],
        },
        {
          id: ThreadId.make("thread-archived"),
          archivedAt: ATTACHED_AT,
          deletedAt: null,
          proposedPlans: [newest],
        },
        {
          id: ThreadId.make("thread-deleted"),
          archivedAt: null,
          deletedAt: ATTACHED_AT,
          proposedPlans: [newest],
        },
      ]),
    ).toEqual([{ threadId, proposedPlan: newest }]);
  });
});
