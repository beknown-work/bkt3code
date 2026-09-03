// T3-CUSTOM(expbkt3): coverage for the sidebar's grouping modes and custom groups.
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
  EMPTY_PHASE_SIDEBAR_FILTERS,
  summarizeSidebarSessions,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./phaseSidebar.ts";
import {
  assignPhaseSidebarThreadToGroup,
  buildPhaseSidebarSections,
  buildPhaseSidebarShelfSections,
  createPhaseSidebarCustomGroup,
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  deletePhaseSidebarCustomGroup,
  isPhaseSidebarSectionCollapsed,
  movePhaseSidebarCustomGroup,
  phaseSidebarCustomGroupIdForThread,
  phaseSidebarSectionKey,
  prunePhaseSidebarGrouping,
  renamePhaseSidebarCustomGroup,
  sanitizePhaseSidebarGrouping,
  togglePhaseSidebarSectionCollapsed,
  type PhaseSidebarGroupingPreferences,
} from "./phaseSidebarGrouping.ts";
import { phaseSidebarRowKey } from "./phaseSidebarTree.ts";
import type { EnvironmentThreadShell as ThreadShell } from "./shell.ts";

const environmentId = EnvironmentId.make("environment-local");
const otherEnvironmentId = EnvironmentId.make("environment-remote");
const now = "2026-07-16T10:00:00.000Z";

function makeExecution(): ThreadExecutionSnapshot {
  return {
    threadId: ThreadId.make("thread-x"),
    activity: "idle",
    intent: null,
    updatedAt: now,
  } as unknown as ThreadExecutionSnapshot;
}

function makeThread(id: string, overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("project-1"),
    ownerUserId: null,
    memberUserIds: [],
    title: `Thread ${id}`,
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
  } as ThreadShell;
}

function makeRow(
  id: string,
  options: {
    readonly parent?: string | null;
    readonly phaseId?: PhaseSidebarPhaseId;
    readonly projectId?: string;
    readonly environmentId?: EnvironmentId;
    readonly updatedAt?: string;
    readonly unread?: boolean;
  } = {},
): PhaseSidebarRow {
  const thread = makeThread(id, {
    ...(options.parent !== undefined
      ? { parentThreadId: options.parent === null ? null : ThreadId.make(options.parent) }
      : {}),
    ...(options.projectId !== undefined ? { projectId: ProjectId.make(options.projectId) } : {}),
    ...(options.environmentId !== undefined ? { environmentId: options.environmentId } : {}),
    ...(options.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
  });
  return {
    thread,
    phaseId: options.phaseId ?? "ready",
    repositoryKey: `repo-${options.projectId ?? "project-1"}`,
    repositoryLabel: `Repo ${options.projectId ?? "project-1"}`,
    providerKind: "codex",
    providerName: "Codex",
    isAssignedToMe: false,
    isOwnedByMe: false,
    participantUserIds: [],
    attentionPriority: 5,
    isUnreadCompletion: options.unread === true,
    settlementSupported: true,
    snoozeSupported: true,
    prioritySupported: true,
    changeRequestState: null,
  };
}

const byId = (left: PhaseSidebarRow, right: PhaseSidebarRow) =>
  String(left.thread.id).localeCompare(String(right.thread.id));

const key = (id: string, env: EnvironmentId = environmentId) =>
  phaseSidebarRowKey(makeRow(id, { environmentId: env }));

function sections(
  rows: ReadonlyArray<PhaseSidebarRow>,
  grouping: PhaseSidebarGroupingPreferences,
  extra: Partial<Parameters<typeof buildPhaseSidebarSections>[0]> = {},
) {
  return buildPhaseSidebarSections({
    rows,
    filters: EMPTY_PHASE_SIDEBAR_FILTERS,
    compareSiblings: byId,
    grouping,
    ...extra,
  }).sections;
}

describe("buildPhaseSidebarSections", () => {
  it("lifecycle mode keeps the canonical phase order with phase tones", () => {
    const result = sections(
      [makeRow("a", { phaseId: "ready" }), makeRow("b", { phaseId: "needs_input" })],
      DEFAULT_PHASE_SIDEBAR_GROUPING,
    );
    expect(result.map((section) => section.id)).toEqual(["needs_input", "ready"]);
    expect(result[0]?.phaseId).toBe("needs_input");
    expect(result[0]?.key).toBe(phaseSidebarSectionKey("lifecycle", "needs_input"));
  });

  it("project mode groups roots by environment and project, sorted by name", () => {
    const result = sections(
      [
        makeRow("a", { projectId: "zeta" }),
        makeRow("b", { projectId: "alpha" }),
        makeRow("c", { projectId: "alpha", environmentId: otherEnvironmentId }),
      ],
      { ...DEFAULT_PHASE_SIDEBAR_GROUPING, groupBy: "project" },
      {
        projectLabelFor: (_environmentId, projectId) => `Project ${projectId}`,
        environmentLabelFor: (id) => (id === otherEnvironmentId ? "Remote" : "Local"),
      },
    );
    expect(result.map((section) => section.label)).toEqual([
      "Project alpha",
      "Project alpha",
      "Project zeta",
    ]);
    // Two environments are connected, so the project sections carry the machine.
    expect(result.map((section) => section.helperText)).toEqual(["Local", "Remote", "Local"]);
    expect(result.every((section) => section.phaseId === null)).toBe(true);
  });

  it("project mode can order by recent activity", () => {
    const result = sections(
      [
        makeRow("a", { projectId: "old", updatedAt: "2026-07-01T00:00:00.000Z" }),
        makeRow("b", { projectId: "fresh", updatedAt: "2026-07-15T00:00:00.000Z" }),
      ],
      { ...DEFAULT_PHASE_SIDEBAR_GROUPING, groupBy: "project", groupOrder: "activity" },
    );
    expect(result.map((section) => section.id)).toEqual([
      `${environmentId}:fresh`,
      `${environmentId}:old`,
    ]);
  });

  it("custom mode renders groups in manual order, empty ones included, with Ungrouped last", () => {
    const grouping: PhaseSidebarGroupingPreferences = {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      groupBy: "custom",
      customGroups: [
        { id: "later", label: "Later", threadKeys: [] },
        { id: "now", label: "Now", threadKeys: [key("a"), key("remote", otherEnvironmentId)] },
      ],
    };
    const result = sections(
      [makeRow("a"), makeRow("b"), makeRow("remote", { environmentId: otherEnvironmentId })],
      grouping,
    );
    expect(result.map((section) => [section.label, section.nodes.length])).toEqual([
      ["Later", 0],
      ["Now", 2],
      ["Ungrouped", 1],
    ]);
    expect(result[2]?.isUngrouped).toBe(true);
    expect(result[0]?.helperText).toBe("Empty");
  });

  it("custom mode keeps a nested session under its parent even when assigned elsewhere", () => {
    const grouping: PhaseSidebarGroupingPreferences = {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      groupBy: "custom",
      customGroups: [{ id: "g", label: "Group", threadKeys: [key("child")] }],
    };
    const result = sections([makeRow("parent"), makeRow("child", { parent: "parent" })], grouping);
    expect(result.map((section) => [section.label, section.nodes.length])).toEqual([
      ["Group", 0],
      ["Ungrouped", 1],
    ]);
    expect(result[1]?.nodes[0]?.children).toHaveLength(1);
  });

  it("custom mode can sort groups by name while Ungrouped stays last", () => {
    const grouping: PhaseSidebarGroupingPreferences = {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      groupBy: "custom",
      groupOrder: "name",
      customGroups: [
        { id: "z", label: "Zulu", threadKeys: [] },
        { id: "a", label: "Alpha", threadKeys: [] },
      ],
    };
    const result = sections([makeRow("x")], grouping);
    expect(result.map((section) => section.label)).toEqual(["Alpha", "Zulu", "Ungrouped"]);
  });

  it("summarises what a closed section hides", () => {
    const result = sections(
      [
        makeRow("a", { phaseId: "implementing" }),
        makeRow("b", { phaseId: "needs_input", unread: true }),
        makeRow("c", { parent: "a", phaseId: "planning" }),
      ],
      { ...DEFAULT_PHASE_SIDEBAR_GROUPING, groupBy: "project" },
    );
    expect(result[0]?.summary).toEqual({ running: 2, attention: 1, unread: 1 });
  });
});

describe("buildPhaseSidebarShelfSections", () => {
  it("builds collapsed-by-default snoozed and settled shelves in the given order", () => {
    const shelves = buildPhaseSidebarShelfSections({
      snoozedRows: [makeRow("b"), makeRow("a")],
      settledRows: [],
    });
    expect(shelves.map((section) => section.id)).toEqual(["snoozed"]);
    expect(shelves[0]?.collapsedByDefault).toBe(true);
    expect(shelves[0]?.nodes.map((node) => String(node.row.thread.id))).toEqual(["b", "a"]);
    // The toggle list records a move away from the default.
    expect(isPhaseSidebarSectionCollapsed(shelves[0]!, new Set())).toBe(true);
    expect(isPhaseSidebarSectionCollapsed(shelves[0]!, new Set([shelves[0]!.key]))).toBe(false);
  });
});

describe("custom group operations", () => {
  const base = DEFAULT_PHASE_SIDEBAR_GROUPING;

  it("creates a group and seeds it without changing the mode", () => {
    const { preferences, id } = createPhaseSidebarCustomGroup(base, {
      label: "  Sprint   42  ",
      threadKeys: [key("a"), key("a")],
    });
    expect(id).not.toBeNull();
    expect(preferences.groupBy).toBe(base.groupBy);
    expect(preferences.customGroups).toEqual([{ id, label: "Sprint 42", threadKeys: [key("a")] }]);
  });

  it("refuses a blank label", () => {
    expect(createPhaseSidebarCustomGroup(base, { label: "   " })).toEqual({
      preferences: base,
      id: null,
    });
  });

  it("assigning moves a thread between groups and back to ungrouped", () => {
    let prefs = createPhaseSidebarCustomGroup(base, { label: "One", id: "one" }).preferences;
    prefs = createPhaseSidebarCustomGroup(prefs, { label: "Two", id: "two" }).preferences;
    prefs = assignPhaseSidebarThreadToGroup(prefs, key("a"), "one");
    expect(phaseSidebarCustomGroupIdForThread(prefs, key("a"))).toBe("one");
    prefs = assignPhaseSidebarThreadToGroup(prefs, key("a"), "two");
    expect(prefs.customGroups.map((group) => group.threadKeys)).toEqual([[], [key("a")]]);
    prefs = assignPhaseSidebarThreadToGroup(prefs, key("a"), null);
    expect(phaseSidebarCustomGroupIdForThread(prefs, key("a"))).toBeNull();
    // Unknown target: untouched.
    expect(assignPhaseSidebarThreadToGroup(prefs, key("a"), "missing")).toBe(prefs);
  });

  it("renames, reorders and deletes", () => {
    let prefs = createPhaseSidebarCustomGroup(base, { label: "One", id: "one" }).preferences;
    prefs = createPhaseSidebarCustomGroup(prefs, { label: "Two", id: "two" }).preferences;
    prefs = renamePhaseSidebarCustomGroup(prefs, "one", "Uno");
    expect(prefs.customGroups[0]?.label).toBe("Uno");
    prefs = movePhaseSidebarCustomGroup(prefs, "two", "up");
    expect(prefs.customGroups.map((group) => group.id)).toEqual(["two", "one"]);
    expect(movePhaseSidebarCustomGroup(prefs, "two", "up")).toBe(prefs);
    prefs = togglePhaseSidebarSectionCollapsed(prefs, phaseSidebarSectionKey("custom", "one"));
    prefs = deletePhaseSidebarCustomGroup(prefs, "one");
    expect(prefs.customGroups.map((group) => group.id)).toEqual(["two"]);
    // The deleted group's collapse state goes with it.
    expect(prefs.collapsedSectionKeys).toEqual([]);
  });

  it("collapse toggles round-trip", () => {
    const sectionKey = phaseSidebarSectionKey("lifecycle", "ready");
    const closed = togglePhaseSidebarSectionCollapsed(base, sectionKey);
    expect(closed.collapsedSectionKeys).toEqual([sectionKey]);
    expect(togglePhaseSidebarSectionCollapsed(closed, sectionKey).collapsedSectionKeys).toEqual([]);
  });

  it("pruning drops keys no environment knows", () => {
    const prefs = createPhaseSidebarCustomGroup(base, {
      label: "G",
      id: "g",
      threadKeys: [key("live"), key("gone")],
    }).preferences;
    const pruned = prunePhaseSidebarGrouping(prefs, new Set([key("live")]));
    expect(pruned.customGroups[0]?.threadKeys).toEqual([key("live")]);
    expect(prunePhaseSidebarGrouping(pruned, new Set([key("live")]))).toBe(pruned);
  });
});

describe("sanitizePhaseSidebarGrouping", () => {
  it("falls back to defaults for garbage", () => {
    expect(sanitizePhaseSidebarGrouping(null)).toEqual(DEFAULT_PHASE_SIDEBAR_GROUPING);
    expect(sanitizePhaseSidebarGrouping({ groupBy: "bogus", groupOrder: 3 })).toEqual(
      DEFAULT_PHASE_SIDEBAR_GROUPING,
    );
  });

  it("drops duplicate ids, reserved ids, blank labels and double-claimed threads", () => {
    const result = sanitizePhaseSidebarGrouping({
      groupBy: "custom",
      groupOrder: "name",
      customGroups: [
        { id: "a", label: "A", threadKeys: ["t1", "t2", 4] },
        { id: "a", label: "Dup", threadKeys: [] },
        { id: "ungrouped", label: "Reserved", threadKeys: [] },
        { id: "b", label: "   ", threadKeys: [] },
        { id: "c", label: "C", threadKeys: ["t2", "t3"] },
      ],
      collapsedSectionKeys: ["custom:a", "custom:a", ""],
    });
    expect(result).toEqual({
      groupBy: "custom",
      groupOrder: "name",
      customGroups: [
        { id: "a", label: "A", threadKeys: ["t1", "t2"] },
        { id: "c", label: "C", threadKeys: ["t3"] },
      ],
      collapsedSectionKeys: ["custom:a"],
    });
  });
});

describe("summarizeSidebarSessions unread", () => {
  it("counts sessions whose last turn finished after the viewer last opened them", () => {
    const seen = makeThread("seen", {
      latestTurn: { completedAt: "2026-07-16T09:00:00.000Z" } as ThreadShell["latestTurn"],
    });
    const unseen = makeThread("unseen", {
      latestTurn: { completedAt: "2026-07-16T09:30:00.000Z" } as ThreadShell["latestTurn"],
    });
    const counts = summarizeSidebarSessions([seen, unseen], {
      now,
      snoozeSupported: () => false,
      lastVisitedAtByThreadKey: {
        [key("seen")]: "2026-07-16T09:10:00.000Z",
        [key("unseen")]: "2026-07-16T09:00:00.000Z",
      },
    });
    expect(counts.unread).toBe(1);
    expect(counts.nonRunning).toBe(2);
    // Without visit data the count is zero, never a guess.
    expect(summarizeSidebarSessions([unseen], { now, snoozeSupported: () => false }).unread).toBe(
      0,
    );
  });
});
