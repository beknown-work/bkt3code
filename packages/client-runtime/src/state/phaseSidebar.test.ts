import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPhaseSidebarGroups,
  collectDescendantThreadIds,
  DEFAULT_PHASE_SIDEBAR_SORT,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  isRunningSessionPhase,
  isThreadUnread,
  partitionPhaseSidebarRows,
  resolveMoveUnderCandidates,
  resolvePhaseSidebarPhase,
  resolveThreadVisitTimestamp,
  runningSessionDividerPhase,
  shouldShowRunningSessionGlint,
  summarizeSidebarSessions,
  type PhaseSidebarRow,
} from "./phaseSidebar.ts";
import type { EnvironmentThreadShell } from "./shell.ts";

// The bulk of this module's behaviour is covered by the web suite that has
// exercised it since it lived under apps/web (it still imports it, through the
// re-export shim). What is asserted here is what the MOVE is responsible for:
// that the shared code runs under React Native's engine, and that the pieces
// folded in from sibling web modules survived intact.

const now = "2026-01-01T00:00:00.000Z";
const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

function makeExecution(
  overrides: Partial<ThreadExecutionSnapshot> = {},
): ThreadExecutionSnapshot {
  return {
    activity: "idle",
    canStop: false,
    // `intent` is an optionalKey on the contract, so absent — not null — is the
    // shape the wire produces when a thread has no durable intent.
    providerSession: {
      state: "stopped",
      providerInstanceId: ProviderInstanceId.make("codex"),
      startedAt: now,
      lastObservedAt: now,
      lastError: null,
    },
    turn: null,
    ...overrides,
  } as ThreadExecutionSnapshot;
}

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    environmentId,
    projectId,
    ownerUserId: null,
    memberUserIds: [],
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    execution: makeExecution(),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

function makeRow(thread: EnvironmentThreadShell): PhaseSidebarRow {
  return {
    thread,
    phaseId: resolvePhaseSidebarPhase(thread),
    repositoryKey: "repo",
    repositoryLabel: "repo",
    providerKind: "codex",
    providerName: "Codex",
    isAssignedToMe: false,
    isOwnedByMe: false,
    participantUserIds: [],
    attentionPriority: 0,
    isUnreadCompletion: false,
    settlementSupported: true,
    snoozeSupported: true,
    prioritySupported: true,
    changeRequestState: null,
  };
}

/**
 * Runs `body` with Array.prototype.toSorted removed.
 *
 * Hermes — the engine the React Native app runs on — does not ship the ES2023
 * change-array-by-copy methods. This module used to live in apps/web, where a
 * browser always has them, so every sort in it is exactly the kind of thing
 * that would work in every test and then crash on a phone.
 */
function withoutHermesUnsafeArrayMethods<A>(body: () => A): A {
  const descriptors = (["toSorted", "toReversed", "toSpliced", "with"] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(Array.prototype, name)] as const,
  );
  for (const [name] of descriptors) Reflect.deleteProperty(Array.prototype, name);
  try {
    return body();
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor !== undefined) Reflect.defineProperty(Array.prototype, name, descriptor);
    }
  }
}

describe("Hermes compatibility", () => {
  it("groups and partitions without ES2023 array methods", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), title: "Alpha" }),
      makeThread({
        id: ThreadId.make("thread-2"),
        title: "Beta",
        execution: makeExecution({ activity: "active" }),
      }),
      // settledOverride is the explicit settle; settledAt alone only stamps
      // when it happened.
      makeThread({
        id: ThreadId.make("thread-3"),
        title: "Gamma",
        settledOverride: "settled",
        settledAt: now,
      }),
    ];

    const result = withoutHermesUnsafeArrayMethods(() => {
      const partition = partitionPhaseSidebarRows(threads.map(makeRow), {
        now,
        preciseNow: now,
        autoSettleAfterDays: null,
      });
      return {
        partition,
        groups: buildPhaseSidebarGroups(
          partition.activeRows,
          EMPTY_PHASE_SIDEBAR_FILTERS,
          "updated_at",
          DEFAULT_PHASE_SIDEBAR_SORT,
        ),
      };
    });

    expect(result.partition.settledRows).toHaveLength(1);
    expect(result.partition.activeRows).toHaveLength(2);
    expect(result.groups.flatMap((group) => group.rows)).toHaveLength(2);
  });

  it("resolves move-under candidates without ES2023 array methods", () => {
    const subject = makeThread({ id: ThreadId.make("subject") });
    const other = makeThread({ id: ThreadId.make("other"), title: "Other session" });

    const candidates = withoutHermesUnsafeArrayMethods(() =>
      resolveMoveUnderCandidates({
        threads: [subject, other],
        subject,
        query: "",
        repositoryLabelFor: () => "repo",
      }),
    );

    expect(candidates.map((candidate) => candidate.thread.id)).toEqual([other.id]);
  });
});

describe("move-under candidates", () => {
  it("refuses a descendant, mirroring the server's cycle guard", () => {
    const parent = makeThread({ id: ThreadId.make("parent") });
    const child = makeThread({ id: ThreadId.make("child"), parentThreadId: parent.id });
    const grandchild = makeThread({ id: ThreadId.make("grandchild"), parentThreadId: child.id });

    expect([...collectDescendantThreadIds([parent, child, grandchild], parent.id)]).toEqual([
      child.id,
      grandchild.id,
    ]);

    const candidates = resolveMoveUnderCandidates({
      threads: [parent, child, grandchild],
      subject: parent,
      query: "",
      repositoryLabelFor: () => "repo",
    });
    expect(candidates).toHaveLength(0);
  });

  it("never offers a thread from another environment", () => {
    // Lineage is a bare thread id resolved within one environment.
    const subject = makeThread({ id: ThreadId.make("subject") });
    const foreign = makeThread({
      id: ThreadId.make("foreign"),
      environmentId: EnvironmentId.make("env-2"),
    });

    const candidates = resolveMoveUnderCandidates({
      threads: [subject, foreign],
      subject,
      query: "",
      repositoryLabelFor: () => "repo",
    });
    expect(candidates).toHaveLength(0);
  });
});

describe("lifecycle counters", () => {
  it("splits running from idle and reports the next wake", () => {
    const counts = summarizeSidebarSessions(
      [
        makeThread({ id: ThreadId.make("a"), execution: makeExecution({ activity: "active" }) }),
        makeThread({ id: ThreadId.make("b") }),
        makeThread({
          id: ThreadId.make("c"),
          snoozedUntil: "2026-01-01T03:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("d"),
          snoozedUntil: "2026-01-01T01:00:00.000Z",
        }),
        // Archived and settled threads are not part of the working set.
        makeThread({ id: ThreadId.make("e"), archivedAt: now }),
        makeThread({ id: ThreadId.make("f"), settledAt: now }),
      ],
      { now, snoozeSupported: () => true },
    );

    expect(counts.running).toBe(1);
    expect(counts.nonRunning).toBe(1);
    expect(counts.nextSnoozeWakeAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("counts a snoozed thread as idle where the server cannot snooze", () => {
    const counts = summarizeSidebarSessions(
      [makeThread({ snoozedUntil: "2026-01-01T01:00:00.000Z" })],
      { now, snoozeSupported: () => false },
    );
    expect(counts.nonRunning).toBe(1);
    expect(counts.nextSnoozeWakeAt).toBeNull();
  });
});

describe("running-session emphasis", () => {
  it("marks only live lifecycle phases", () => {
    expect(isRunningSessionPhase("planning")).toBe(true);
    expect(isRunningSessionPhase("implementing")).toBe(true);
    expect(isRunningSessionPhase("ready")).toBe(false);
  });

  it("never emphasises parked history", () => {
    expect(shouldShowRunningSessionGlint("planning", "active")).toBe(true);
    expect(shouldShowRunningSessionGlint("planning", "settled")).toBe(false);
    expect(shouldShowRunningSessionGlint("planning", "snoozed")).toBe(false);
  });

  it("places one divider before running work, and none when all rows run", () => {
    expect(runningSessionDividerPhase(["ready", "planning", "implementing"])).toBe("planning");
    expect(runningSessionDividerPhase(["planning", "implementing"])).toBeNull();
    expect(runningSessionDividerPhase(["ready"])).toBeNull();
  });
});

describe("unread tracking", () => {
  it("prefers the newer of thread update and turn completion", () => {
    expect(
      resolveThreadVisitTimestamp({
        threadUpdatedAt: "2026-01-01T00:00:00.000Z",
        latestTurnCompletedAt: "2026-01-01T01:00:00.000Z",
      }),
    ).toBe("2026-01-01T01:00:00.000Z");

    expect(
      resolveThreadVisitTimestamp({
        threadUpdatedAt: "2026-01-01T02:00:00.000Z",
        latestTurnCompletedAt: "2026-01-01T01:00:00.000Z",
      }),
    ).toBe("2026-01-01T02:00:00.000Z");
  });

  it("is unread only when activity is newer than this device's last visit", () => {
    const base = {
      threadUpdatedAt: "2026-01-01T02:00:00.000Z",
      latestTurnCompletedAt: null,
    };
    expect(isThreadUnread({ ...base, lastVisitedAt: "2026-01-01T01:00:00.000Z" })).toBe(true);
    expect(isThreadUnread({ ...base, lastVisitedAt: "2026-01-01T03:00:00.000Z" })).toBe(false);
  });

  it("treats a never-visited thread as read", () => {
    // Otherwise a fresh install marks every row in the list unread.
    expect(
      isThreadUnread({
        threadUpdatedAt: now,
        latestTurnCompletedAt: null,
        lastVisitedAt: null,
      }),
    ).toBe(false);
  });

  it("does not mark a row unread on an unparseable timestamp", () => {
    expect(
      isThreadUnread({
        threadUpdatedAt: "not-a-date",
        latestTurnCompletedAt: null,
        lastVisitedAt: now,
      }),
    ).toBe(false);
  });
});
