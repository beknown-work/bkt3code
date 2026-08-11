import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadExecutionSnapshot,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import { projectThreadAwareness } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<OrchestrationProjectShell, "title">;

function thread(
  overrides: Partial<OrchestrationThreadShell> = {},
): Pick<
  OrchestrationThreadShell,
  | "id"
  | "title"
  | "modelSelection"
  | "execution"
  | "latestTurn"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
> {
  return {
    id: "thread-1" as ThreadId,
    title: "Fix failing CI",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    execution: idleExecution(),
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function idleExecution(overrides: Partial<ThreadExecutionSnapshot> = {}): ThreadExecutionSnapshot {
  return {
    threadId: "thread-1" as ThreadId,
    authorityEpoch: "server-epoch",
    revision: 1,
    observedAt: NOW,
    activity: "idle",
    canStop: false,
    providerSession: {
      state: "ready",
      generation: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      startedAt: NOW,
      lastObservedAt: NOW,
      lastError: null,
    },
    turn: null,
    ...overrides,
  };
}

function activeExecution(
  state: NonNullable<ThreadExecutionSnapshot["turn"]>["state"] = "running",
): ThreadExecutionSnapshot {
  return idleExecution({
    activity:
      state === "waiting-for-approval" || state === "waiting-for-input" ? "blocked" : "active",
    canStop: true,
    turn: {
      executionId: "execution-1",
      providerTurnId: "turn-1" as TurnId,
      state,
      startedAt: NOW,
      stopRequestedAt: null,
      completedAt: null,
      lastError: null,
    },
  });
}

describe("projectThreadAwareness", () => {
  it("returns null for idle threads without an active awareness state", () => {
    expect(
      projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread({ execution: idleExecution() }),
      }),
    ).toBeNull();
  });

  it("prioritizes approval requests over running state", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        execution: activeExecution("waiting-for-approval"),
      }),
    });

    expect(state?.phase).toBe("waiting_for_approval");
    expect(state?.headline).toBe("Approval needed");
  });

  it("projects running provider sessions", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        execution: activeExecution(),
      }),
    });

    expect(state).toMatchObject({
      phase: "running",
      headline: "Agent is working",
      detail: "codex is active.",
      modelTitle: "gpt-5.4",
      deepLink: "/threads/env-1/thread-1",
    });
  });

  it("projects only observed completed execution transitions as completed", () => {
    const finishedTurn = {
      turnId: "turn-1" as TurnId,
      state: "interrupted" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
      durationMs: null,
    };
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        latestTurn: finishedTurn,
        execution: idleExecution({
          turn: {
            executionId: "execution-1",
            providerTurnId: "turn-1" as TurnId,
            state: "completed",
            startedAt: NOW,
            stopRequestedAt: null,
            completedAt: NOW,
            lastError: null,
          },
        }),
      }),
    });

    expect(state?.phase).toBe("completed");

    const trulyInterrupted = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        latestTurn: { ...finishedTurn, completedAt: null },
        execution: idleExecution({
          turn: {
            executionId: "execution-1",
            providerTurnId: "turn-1" as TurnId,
            state: "interrupted",
            startedAt: NOW,
            stopRequestedAt: NOW,
            completedAt: NOW,
            lastError: null,
          },
        }),
      }),
    });
    expect(trulyInterrupted).toBeNull();
  });

  it("does not treat a reusable ready provider session as completed work", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ execution: idleExecution() }),
    });

    expect(state).toBeNull();
  });

  it("projects failures with the session error detail", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        execution: idleExecution({
          activity: "failed",
          canStop: false,
          providerSession: {
            ...idleExecution().providerSession,
            state: "failed",
            lastError: "Provider process exited.",
          },
        }),
      }),
    });

    expect(state).toMatchObject({
      phase: "failed",
      headline: "Agent failed",
      detail: "Provider process exited.",
    });
  });
});
