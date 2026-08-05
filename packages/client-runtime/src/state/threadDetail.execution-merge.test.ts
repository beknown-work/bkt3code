import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { EnvironmentThread, EnvironmentThreadShell } from "./models.ts";
import { mergeEnvironmentThread } from "./threadDetail.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");
const timestamp = "2026-08-04T18:46:22.343Z";

function executionSnapshot(activity: "active" | "idle", revision: number) {
  return {
    threadId,
    authorityEpoch: "authority-1",
    revision,
    observedAt: timestamp,
    activity,
    canStop: activity === "active",
    providerSession: {
      state: "ready",
      generation: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      startedAt: timestamp,
      lastObservedAt: timestamp,
      lastError: null,
    },
    turn: {
      executionId: "execution-1",
      providerTurnId: TurnId.make("turn-1"),
      state: activity === "active" ? "running" : "completed",
      startedAt: timestamp,
      stopRequestedAt: null,
      completedAt: activity === "active" ? null : timestamp,
      lastError: null,
    },
  } satisfies ThreadExecutionSnapshot;
}

function recoveryFailedSnapshot(revision: number): ThreadExecutionSnapshot {
  return {
    ...executionSnapshot("idle", revision),
    intent: {
      workItemId: "work-item-1",
      messageId: MessageId.make("message-1"),
      desiredState: "stopped",
      phase: "recovery-exhausted",
      acceptedAt: timestamp,
      updatedAt: timestamp,
      recovery: {
        attempt: 1,
        maximumAttempts: 3,
        nextAttemptAt: null,
        reason: "The configured worktree base is no longer available.",
        userActionRequired: true,
      },
    },
  };
}

function threadShell(execution: ThreadExecutionSnapshot): EnvironmentThreadShell {
  return {
    environmentId,
    id: threadId,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    sourceControlProfileId: null,
    branch: "branch",
    worktreePath: "/repo/worktree",
    latestTurn: null,
    ownerUserId: null,
    memberUserIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    execution,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function threadDetail(execution: ThreadExecutionSnapshot): EnvironmentThread {
  return {
    ...threadShell(execution),
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    rollingSummary: null,
    turnSummaries: [],
  } satisfies OrchestrationThread & { readonly environmentId: EnvironmentId };
}

describe("thread detail execution merge", () => {
  it("uses the newer shell execution after an agent stops", () => {
    const staleRunningDetail = threadDetail(executionSnapshot("active", 1));
    const stoppedShell = threadShell(executionSnapshot("idle", 2));

    const merged = mergeEnvironmentThread(staleRunningDetail, stoppedShell);

    expect(merged?.execution).toBe(stoppedShell.execution);
    expect(merged?.execution?.activity).toBe("idle");
  });

  it("uses a newer detail execution when recovery fails before the shell refreshes", () => {
    const recoveryFailedDetail = threadDetail(recoveryFailedSnapshot(2));
    const staleRunningShell = threadShell(executionSnapshot("active", 1));

    const merged = mergeEnvironmentThread(recoveryFailedDetail, staleRunningShell);

    expect(merged?.execution).toBe(recoveryFailedDetail.execution);
    expect(merged?.execution?.intent?.phase).toBe("recovery-exhausted");
  });

  it("keeps detail execution when an older shell omits execution snapshots", () => {
    const runningDetail = threadDetail(executionSnapshot("active", 1));
    const { execution: _execution, ...legacyShell } = threadShell(executionSnapshot("idle", 2));

    const merged = mergeEnvironmentThread(runningDetail, legacyShell);

    expect(merged?.execution).toBe(runningDetail.execution);
  });
});
