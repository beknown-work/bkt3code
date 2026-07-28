/**
 * T3-CUSTOM(expbkt3): Regression coverage for the Plan → Build transition.
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  approvedPlanInteractionModeCommand,
  resolvePlannotatorLaunchLocation,
} from "./PlannotatorManager.ts";

const threadId = ThreadId.make("thread-plan-review");
const commandId = CommandId.make("plannotator:mode:test");
const createdAt = "2026-07-26T20:00:00.000Z";

describe("Plannotator decision interaction mode", () => {
  it("switches an approved plan to Build/default mode", () => {
    expect(
      approvedPlanInteractionModeCommand({
        decision: { kind: "approved", feedback: "" },
        threadId,
        commandId,
        createdAt,
      }),
    ).toEqual({
      type: "thread.interaction-mode.set",
      commandId,
      threadId,
      interactionMode: "default",
      createdAt,
    });
  });

  it.each([
    { kind: "feedback" as const, feedback: "Revise the rollout." },
    { kind: "denied" as const, feedback: "" },
  ])("does not change mode for a $kind decision", (decision) => {
    expect(
      approvedPlanInteractionModeCommand({
        decision,
        threadId,
        commandId,
        createdAt,
      }),
    ).toBeNull();
  });
});

describe("Plannotator durable review launch location", () => {
  it("reopens an archived worktree review from its archived shell", () => {
    expect(
      resolvePlannotatorLaunchLocation({
        threadId: "thread-archived",
        activeThread: null,
        activeProjects: [],
        archivedThreads: [
          {
            id: "thread-archived",
            projectId: "project-1",
            worktreePath: "/worktrees/archived-review",
          },
        ],
        archivedProjects: [{ id: "project-1", workspaceRoot: "/repos/project-1" }],
      }),
    ).toEqual({
      kind: "found",
      workingDirectory: "/worktrees/archived-review",
    });
  });

  it("uses an archived project's workspace for a current-checkout review", () => {
    expect(
      resolvePlannotatorLaunchLocation({
        threadId: "thread-archived",
        activeThread: null,
        activeProjects: [],
        archivedThreads: [
          {
            id: "thread-archived",
            projectId: "project-1",
            worktreePath: null,
          },
        ],
        archivedProjects: [{ id: "project-1", workspaceRoot: "/repos/project-1" }],
      }),
    ).toEqual({
      kind: "found",
      workingDirectory: "/repos/project-1",
    });
  });

  it("reports a missing archived thread without guessing a workspace", () => {
    expect(
      resolvePlannotatorLaunchLocation({
        threadId: "thread-missing",
        activeThread: null,
        activeProjects: [],
        archivedThreads: [],
        archivedProjects: [],
      }),
    ).toEqual({ kind: "thread-not-found" });
  });
});
