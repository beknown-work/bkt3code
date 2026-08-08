// T3-CUSTOM(expbkt3): session tree coverage for the experimental sidebar.
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadShell } from "../../types";
import {
  EMPTY_PHASE_SIDEBAR_FILTERS,
  type PhaseSidebarFilters,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./PhaseGroupedSidebar.logic";
import {
  buildPhaseSidebarTree,
  buildPhaseSidebarTreeGroups,
  collectPhaseSidebarSubtreeKeys,
  flattenPhaseSidebarTree,
  phaseSidebarRowKey,
  phaseSidebarTreeIndent,
  resolvePhaseSidebarTreePhase,
  PHASE_SIDEBAR_TREE_MAX_INDENT_DEPTH,
} from "./PhaseSidebarTree.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
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
    projectId,
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
    readonly repositoryKey?: string;
    readonly archived?: boolean;
  } = {},
): PhaseSidebarRow {
  const thread = makeThread(id, {
    ...(options.parent !== undefined
      ? { parentThreadId: options.parent === null ? null : ThreadId.make(options.parent) }
      : {}),
    ...(options.archived ? { archivedAt: now } : {}),
  });
  return {
    thread,
    phaseId: options.phaseId ?? "ready",
    repositoryKey: options.repositoryKey ?? "repo-1",
    repositoryLabel: options.repositoryKey ?? "repo-one",
    providerKind: "codex",
    providerName: "Codex",
    isAssignedToMe: false,
    isOwnedByMe: false,
    participantUserIds: [],
    attentionPriority: 5,
    isUnreadCompletion: false,
    settlementSupported: true,
    snoozeSupported: true,
    prioritySupported: true,
    changeRequestState: null,
  };
}

const byId = (left: PhaseSidebarRow, right: PhaseSidebarRow) =>
  String(left.thread.id).localeCompare(String(right.thread.id));

const key = (id: string) => phaseSidebarRowKey(makeRow(id));

describe("buildPhaseSidebarTree", () => {
  it("nests a session under the session that spawned it", () => {
    const tree = buildPhaseSidebarTree(
      [makeRow("parent"), makeRow("child", { parent: "parent" })],
      { compareSiblings: byId },
    );

    expect(tree).toHaveLength(1);
    expect(tree[0]?.row.thread.id).toBe("parent");
    expect(tree[0]?.children.map((node) => node.row.thread.id)).toEqual(["child"]);
    expect(tree[0]?.descendantCount).toBe(1);
    expect(tree[0]?.children[0]?.depth).toBe(1);
  });

  it("counts the whole subtree, not just direct children", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root"),
        makeRow("child-a", { parent: "root" }),
        makeRow("child-b", { parent: "root" }),
        makeRow("grandchild", { parent: "child-a" }),
      ],
      { compareSiblings: byId },
    );

    expect(tree[0]?.descendantCount).toBe(3);
    expect(tree[0]?.children[0]?.descendantCount).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it("promotes a row to the top level when its parent is not in this section", () => {
    // The parent is settled (a different section) — the child must still render.
    const tree = buildPhaseSidebarTree([makeRow("orphan", { parent: "elsewhere" })], {
      compareSiblings: byId,
      titleForKey: (candidate) => (candidate === key("elsewhere") ? "Settled parent" : null),
    });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.depth).toBe(0);
    expect(tree[0]?.orphanedFrom).toEqual({ key: key("elsewhere"), title: "Settled parent" });
  });

  it("leaves no breadcrumb when the parent cannot be named at all", () => {
    const tree = buildPhaseSidebarTree([makeRow("orphan", { parent: "deleted" })], {
      compareSiblings: byId,
    });

    expect(tree[0]?.orphanedFrom).toBeNull();
  });

  it("promotes both rows to roots rather than looping on a corrupt cycle", () => {
    const tree = buildPhaseSidebarTree(
      [makeRow("a", { parent: "b" }), makeRow("b", { parent: "a" })],
      { compareSiblings: byId },
    );

    expect(tree.map((node) => node.row.thread.id).toSorted()).toEqual(["a", "b"]);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });

  it("never treats a self-parented row as its own child", () => {
    const tree = buildPhaseSidebarTree([makeRow("self", { parent: "self" })], {
      compareSiblings: byId,
    });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(0);
  });

  it("orders siblings with the same comparator used for roots", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root"),
        makeRow("child-z", { parent: "root" }),
        makeRow("child-a", { parent: "root" }),
      ],
      { compareSiblings: byId },
    );

    expect(tree[0]?.children.map((node) => node.row.thread.id)).toEqual(["child-a", "child-z"]);
  });
});

describe("resolvePhaseSidebarTreePhase", () => {
  it("pulls a parent into Implementing while any descendant is working", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "implementing" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("implementing");
  });

  it("treats a planning child as working too", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "planning" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("implementing");
  });

  it("rolls up through a grandchild", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root", { phaseId: "ready" }),
        makeRow("mid", { parent: "root", phaseId: "ready" }),
        makeRow("leaf", { parent: "mid", phaseId: "implementing" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("implementing");
  });

  it("leaves the parent in its own phase when a child merely needs input", () => {
    // Deliberate: the child is the thing that needs answering, and it is one
    // disclosure away. Only live work moves the parent.
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "needs_input" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("ready");
  });

  it("leaves a childless row in its own phase", () => {
    const tree = buildPhaseSidebarTree([makeRow("solo", { phaseId: "plan_ready" })], {
      compareSiblings: byId,
    });

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("plan_ready");
  });
});

describe("flattenPhaseSidebarTree", () => {
  const tree = buildPhaseSidebarTree(
    [
      makeRow("root"),
      makeRow("child", { parent: "root" }),
      makeRow("grandchild", { parent: "child" }),
      makeRow("other"),
    ],
    { compareSiblings: byId },
  );

  it("omits collapsed subtrees so keyboard traversal skips hidden rows", () => {
    const flattened = flattenPhaseSidebarTree(tree, () => false);

    expect(flattened.map((node) => node.row.thread.id)).toEqual(["other", "root"]);
  });

  it("walks an expanded subtree in render order", () => {
    const flattened = flattenPhaseSidebarTree(tree, () => true);

    expect(flattened.map((node) => node.row.thread.id)).toEqual([
      "other",
      "root",
      "child",
      "grandchild",
    ]);
  });

  it("stops descending at the first collapsed ancestor", () => {
    const flattened = flattenPhaseSidebarTree(tree, (candidate) => candidate === key("root"));

    expect(flattened.map((node) => node.row.thread.id)).toEqual(["other", "root", "child"]);
  });
});

describe("buildPhaseSidebarTreeGroups", () => {
  const filtersFor = (overrides: Partial<PhaseSidebarFilters>): PhaseSidebarFilters => ({
    ...EMPTY_PHASE_SIDEBAR_FILTERS,
    ...overrides,
  });

  it("groups a parent by its rolled-up phase, keeping children nested", () => {
    const { groups } = buildPhaseSidebarTreeGroups({
      rows: [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "implementing" }),
      ],
      filters: EMPTY_PHASE_SIDEBAR_FILTERS,
      compareSiblings: byId,
    });

    expect(groups.map((group) => group.id)).toEqual(["implementing"]);
    expect(groups[0]?.nodes).toHaveLength(1);
    expect(groups[0]?.nodes[0]?.children).toHaveLength(1);
  });

  it("drops archived rows before nesting", () => {
    const { groups } = buildPhaseSidebarTreeGroups({
      rows: [makeRow("parent"), makeRow("child", { parent: "parent", archived: true })],
      filters: EMPTY_PHASE_SIDEBAR_FILTERS,
      compareSiblings: byId,
    });

    expect(groups[0]?.nodes[0]?.descendantCount).toBe(0);
  });

  it("keeps a non-matching parent so a matching child stays reachable", () => {
    const { groups, forcedExpansionKeys } = buildPhaseSidebarTreeGroups({
      rows: [
        makeRow("parent", { repositoryKey: "repo-a" }),
        makeRow("child", { parent: "parent", repositoryKey: "repo-b" }),
      ],
      filters: filtersFor({ repositoryKeys: ["repo-b"] }),
      compareSiblings: byId,
    });

    const roots = groups.flatMap((group) => group.nodes);
    expect(roots.map((node) => node.row.thread.id)).toEqual(["parent"]);
    expect(roots[0]?.children.map((node) => node.row.thread.id)).toEqual(["child"]);
    // The cross-repo match must not stay hidden inside a collapsed parent.
    expect(forcedExpansionKeys.has(key("parent"))).toBe(true);
  });

  it("recomputes the child count over what survives the filter", () => {
    const { groups } = buildPhaseSidebarTreeGroups({
      rows: [
        makeRow("parent", { repositoryKey: "repo-a" }),
        makeRow("kept", { parent: "parent", repositoryKey: "repo-b" }),
        makeRow("dropped", { parent: "parent", repositoryKey: "repo-c" }),
      ],
      filters: filtersFor({ repositoryKeys: ["repo-b"] }),
      compareSiblings: byId,
    });

    expect(groups.flatMap((group) => group.nodes)[0]?.descendantCount).toBe(1);
  });

  it("forces no expansion when no filter is active", () => {
    const { forcedExpansionKeys } = buildPhaseSidebarTreeGroups({
      rows: [makeRow("parent"), makeRow("child", { parent: "parent" })],
      filters: EMPTY_PHASE_SIDEBAR_FILTERS,
      compareSiblings: byId,
    });

    expect(forcedExpansionKeys.size).toBe(0);
  });

  it("omits phases with no roots", () => {
    const { groups } = buildPhaseSidebarTreeGroups({
      rows: [makeRow("solo", { phaseId: "ready" })],
      filters: EMPTY_PHASE_SIDEBAR_FILTERS,
      compareSiblings: byId,
    });

    expect(groups.map((group) => group.id)).toEqual(["ready"]);
  });
});

describe("collectPhaseSidebarSubtreeKeys", () => {
  it("returns every descendant key and never the root itself", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root"),
        makeRow("child", { parent: "root" }),
        makeRow("grandchild", { parent: "child" }),
      ],
      { compareSiblings: byId },
    );

    expect(collectPhaseSidebarSubtreeKeys(tree[0] as never).toSorted()).toEqual(
      [key("child"), key("grandchild")].toSorted(),
    );
  });
});

describe("phaseSidebarTreeIndent", () => {
  it("grows with depth and then stops so deep chains keep their titles", () => {
    expect(phaseSidebarTreeIndent(0)).toBe(0);
    expect(phaseSidebarTreeIndent(1)).toBeGreaterThan(phaseSidebarTreeIndent(0));
    expect(phaseSidebarTreeIndent(9)).toBe(
      phaseSidebarTreeIndent(PHASE_SIDEBAR_TREE_MAX_INDENT_DEPTH),
    );
  });
});
