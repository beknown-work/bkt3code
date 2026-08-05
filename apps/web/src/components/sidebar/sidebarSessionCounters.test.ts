import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadShell } from "../../types";
import {
  summarizeSidebarSessions,
  threadIsRunning,
  threadNeedsHumanAttention,
} from "./sidebarSessionCounters";

const threadId = ThreadId.make("thread-1");
const now = "2026-07-26T12:00:00.000Z";
const futureWake = "2026-07-26T13:00:00.000Z";

const supportedSnoozeOptions = {
  now,
  snoozeSupported: () => true,
};

function makeThread(overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: threadId,
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    ownerUserId: null,
    memberUserIds: [],
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    latestTurn: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    execution: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeExecution(activity: ThreadExecutionSnapshot["activity"]): ThreadExecutionSnapshot {
  return {
    threadId,
    authorityEpoch: "epoch-1",
    revision: 1,
    observedAt: "2026-07-26T00:00:00.000Z",
    activity,
    canStop: activity !== "idle" && activity !== "failed",
    providerSession: {
      state: "ready",
      generation: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      startedAt: "2026-07-26T00:00:00.000Z",
      lastObservedAt: "2026-07-26T00:00:00.000Z",
      lastError: null,
    },
    turn: null,
  };
}

describe("sidebar session counters", () => {
  it("classifies approvals, input, plans, and failures as human attention", () => {
    expect(threadNeedsHumanAttention(makeThread({ hasPendingApprovals: true }))).toBe(true);
    expect(threadNeedsHumanAttention(makeThread({ hasPendingUserInput: true }))).toBe(true);
    expect(threadNeedsHumanAttention(makeThread({ hasActionableProposedPlan: true }))).toBe(true);
    expect(threadNeedsHumanAttention(makeThread({ execution: makeExecution("failed") }))).toBe(
      true,
    );
  });

  it("counts active and blocked work as running", () => {
    expect(threadIsRunning(makeThread({ execution: makeExecution("active") }))).toBe(true);
    expect(threadIsRunning(makeThread({ execution: makeExecution("blocked") }))).toBe(true);
    expect(threadIsRunning(makeThread({ execution: makeExecution("idle") }))).toBe(false);
  });

  it("keeps running work out of the non-running count", () => {
    expect(
      summarizeSidebarSessions(
        [
          makeThread({ hasPendingApprovals: true }),
          makeThread({
            id: ThreadId.make("thread-2"),
            execution: makeExecution("active"),
          }),
          makeThread({
            id: ThreadId.make("thread-3"),
            hasPendingUserInput: true,
            archivedAt: "2026-07-26T00:01:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-4"),
            settledAt: "2026-07-26T00:01:00.000Z",
            execution: makeExecution("active"),
          }),
        ],
        supportedSnoozeOptions,
      ),
    ).toEqual({ nonRunning: 1, running: 1, nextSnoozeWakeAt: null });
  });

  it("excludes quiet snoozed work from the non-running count", () => {
    expect(
      summarizeSidebarSessions(
        [makeThread({ snoozedAt: "2026-07-26T11:00:00.000Z", snoozedUntil: futureWake })],
        supportedSnoozeOptions,
      ),
    ).toEqual({ nonRunning: 0, running: 0, nextSnoozeWakeAt: futureWake });
  });

  it("keeps a snoozed running agent in the running count", () => {
    expect(
      summarizeSidebarSessions(
        [
          makeThread({
            execution: makeExecution("active"),
            snoozedAt: "2026-07-26T11:00:00.000Z",
            snoozedUntil: futureWake,
          }),
        ],
        supportedSnoozeOptions,
      ),
    ).toEqual({ nonRunning: 0, running: 1, nextSnoozeWakeAt: null });
  });

  it("counts snooze fields as active when the server does not support snooze", () => {
    expect(
      summarizeSidebarSessions(
        [makeThread({ snoozedAt: "2026-07-26T11:00:00.000Z", snoozedUntil: futureWake })],
        { now, snoozeSupported: () => false },
      ),
    ).toEqual({ nonRunning: 1, running: 0, nextSnoozeWakeAt: null });
  });

  it("returns expired and invalid snoozes to the non-running count", () => {
    expect(
      summarizeSidebarSessions(
        [
          makeThread({
            snoozedAt: "2026-07-26T10:00:00.000Z",
            snoozedUntil: "2026-07-26T11:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-2"),
            snoozedAt: "2026-07-26T10:00:00.000Z",
            snoozedUntil: "not-a-date",
          }),
        ],
        supportedSnoozeOptions,
      ),
    ).toEqual({ nonRunning: 2, running: 0, nextSnoozeWakeAt: null });
  });

  it("counts a snoozed thread again when it raises its hand", () => {
    expect(
      summarizeSidebarSessions(
        [
          makeThread({
            hasPendingUserInput: true,
            snoozedAt: "2026-07-26T11:00:00.000Z",
            snoozedUntil: futureWake,
          }),
        ],
        supportedSnoozeOptions,
      ),
    ).toEqual({ nonRunning: 1, running: 0, nextSnoozeWakeAt: null });
  });

  it("returns the earliest wake boundary across excluded snoozes", () => {
    expect(
      summarizeSidebarSessions(
        [
          makeThread({
            snoozedAt: "2026-07-26T11:00:00.000Z",
            snoozedUntil: "2026-07-26T14:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-2"),
            snoozedAt: "2026-07-26T11:00:00.000Z",
            snoozedUntil: futureWake,
          }),
        ],
        supportedSnoozeOptions,
      ),
    ).toEqual({ nonRunning: 0, running: 0, nextSnoozeWakeAt: futureWake });
  });
});
