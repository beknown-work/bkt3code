import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  UserId,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project, ThreadShell } from "../../types";
import {
  EMPTY_PHASE_SIDEBAR_FILTERS,
  PHASE_SIDEBAR_PHASE_IDS,
  buildPhaseSidebarFilterChips,
  buildPhaseSidebarGroups,
  buildPhaseSidebarRepositoryOptions,
  derivePhaseSidebarRepositoryKey,
  isThreadAssignedToUser,
  matchesPhaseSidebarFilters,
  reconcilePhaseSidebarFilters,
  resolvePhaseSidebarPhase,
  resolvePhaseSidebarProviderCode,
  resolvePhaseSidebarTraversalTarget,
  sanitizePhaseSidebarFilters,
  type PhaseSidebarRow,
} from "./PhaseGroupedSidebar.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-07-16T10:00:00.000Z";

function makeExecution(overrides: Partial<ThreadExecutionSnapshot> = {}): ThreadExecutionSnapshot {
  return {
    threadId,
    authorityEpoch: "server-epoch",
    revision: 1,
    observedAt: now,
    activity: "idle",
    canStop: false,
    providerSession: {
      state: "ready",
      generation: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      startedAt: now,
      lastObservedAt: now,
      lastError: null,
    },
    turn: null,
    ...overrides,
  };
}

function makeActiveExecution(
  state: NonNullable<ThreadExecutionSnapshot["turn"]>["state"] = "running",
): ThreadExecutionSnapshot {
  return makeExecution({
    activity:
      state === "waiting-for-approval" || state === "waiting-for-input" ? "blocked" : "active",
    canStop: true,
    turn: {
      executionId: "execution-1",
      providerTurnId: TurnId.make("turn-1"),
      state,
      startedAt: now,
      stopRequestedAt: null,
      completedAt: null,
      lastError: null,
    },
  });
}

function makeThread(overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: threadId,
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
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: null,
    execution: makeExecution(),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeRow(overrides: Partial<PhaseSidebarRow> = {}): PhaseSidebarRow {
  const thread = overrides.thread ?? makeThread();
  return {
    thread,
    phaseId: overrides.phaseId ?? resolvePhaseSidebarPhase(thread),
    repositoryKey: "repo-1",
    repositoryLabel: "repo-one",
    providerKind: "codex",
    providerName: "Codex",
    isAssignedToMe: false,
    ...overrides,
  };
}

describe("phase sidebar lifecycle", () => {
  it("applies attention, active, failure, and plan-ready precedence", () => {
    const settledTurn = {
      turnId: TurnId.make("turn-1"),
      state: "completed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
      durationMs: null,
    };

    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          execution: makeActiveExecution("waiting-for-approval"),
        }),
      ),
    ).toBe("approval_needed");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          hasPendingUserInput: true,
          execution: makeActiveExecution("waiting-for-input"),
        }),
      ),
    ).toBe("awaiting_input");
    expect(resolvePhaseSidebarPhase(makeThread({ execution: makeActiveExecution() }))).toBe(
      "implementing",
    );
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          execution: makeActiveExecution("starting"),
        }),
      ),
    ).toBe("drafting_plan");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          execution: makeExecution({
            activity: "failed",
            canStop: true,
            providerSession: {
              ...makeExecution().providerSession,
              state: "failed",
              lastError: "failed",
            },
          }),
        }),
      ),
    ).toBe("failed");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          execution: makeExecution({ activity: "failed", canStop: true }),
          latestTurn: settledTurn,
          hasActionableProposedPlan: true,
        }),
      ),
    ).toBe("failed");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          execution: makeExecution(),
          latestTurn: settledTurn,
          hasActionableProposedPlan: true,
        }),
      ),
    ).toBe("plan_ready");
    expect(resolvePhaseSidebarPhase(makeThread({ interactionMode: "plan" }))).toBe("ready");
  });

  it("excludes archived threads, uses fixed group order, and sorts by thread id on ties", () => {
    const rows = [
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-a"), archivedAt: now }),
        phaseId: "approval_needed",
      }),
      makeRow({ thread: makeThread({ id: ThreadId.make("thread-a") }), phaseId: "ready" }),
      makeRow({ thread: makeThread({ id: ThreadId.make("thread-b") }), phaseId: "ready" }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-c") }),
        phaseId: "implementing",
      }),
      makeRow({ thread: makeThread({ id: ThreadId.make("thread-d") }), phaseId: "failed" }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at");
    expect(groups.map((group) => group.id)).toEqual(["failed", "implementing", "ready"]);
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-d"),
      ThreadId.make("thread-c"),
      ThreadId.make("thread-b"),
      ThreadId.make("thread-a"),
    ]);
    expect(PHASE_SIDEBAR_PHASE_IDS).toHaveLength(8);
  });

  it("uses checking until an authoritative execution snapshot arrives", () => {
    expect(resolvePhaseSidebarPhase(makeThread({ execution: null }))).toBe("checking");
  });
});

describe("phase sidebar metadata and filters", () => {
  it("maps known provider codes and creates deterministic unknown codes", () => {
    expect(resolvePhaseSidebarProviderCode("claudeAgent")).toBe("cc");
    expect(resolvePhaseSidebarProviderCode("codex")).toBe("cx");
    expect(resolvePhaseSidebarProviderCode("opencode")).toBe("oc");
    expect(resolvePhaseSidebarProviderCode("cursor")).toBe("cu");
    expect(resolvePhaseSidebarProviderCode("grok")).toBe("gr");
    expect(resolvePhaseSidebarProviderCode("ollama_local")).toBe("ol");
    expect(resolvePhaseSidebarProviderCode("x")).toBe("xx");
  });

  it("uses canonical repository identity across environments and physical fallback otherwise", () => {
    const baseProject: Project = {
      id: projectId,
      environmentId,
      ownerUserId: null,
      memberUserIds: [],
      title: "repo",
      workspaceRoot: "/tmp/repo",
      repositoryIdentity: {
        canonicalKey: "github.com/example/repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/example/repo.git",
        },
      },
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    };
    expect(derivePhaseSidebarRepositoryKey(baseProject)).toBe("github.com/example/repo");
    expect(
      derivePhaseSidebarRepositoryKey({
        ...baseProject,
        id: ProjectId.make("project-2"),
        environmentId: EnvironmentId.make("environment-remote"),
      }),
    ).toBe("github.com/example/repo");
    expect(derivePhaseSidebarRepositoryKey({ ...baseProject, repositoryIdentity: null })).not.toBe(
      "github.com/example/repo",
    );
  });

  it("uses project nicknames for repository facets and searches every canonical member", () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/example/repo",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/repo.git",
      },
      displayName: "example/repo",
      name: "repo",
    };
    const projects: Project[] = [
      {
        id: ProjectId.make("project-a"),
        environmentId: EnvironmentId.make("env-a"),
        ownerUserId: null,
        memberUserIds: [],
        title: "Frontend",
        workspaceRoot: "/work/repo",
        repositoryIdentity,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ProjectId.make("project-b"),
        environmentId: EnvironmentId.make("env-b"),
        ownerUserId: null,
        memberUserIds: [],
        title: "Backend",
        workspaceRoot: "/srv/repo",
        repositoryIdentity,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    ];

    const [option] = buildPhaseSidebarRepositoryOptions(projects);
    expect(option).toMatchObject({
      key: "github.com/example/repo",
      label: "example/repo",
    });
    expect(option?.searchText).toContain("Frontend");
    expect(option?.searchText).toContain("Backend");
    expect(option?.searchText).toContain("github.com/example/repo");

    const sameNicknameOptions = buildPhaseSidebarRepositoryOptions(
      projects.map((project) => ({ ...project, title: "Work" })),
    );
    expect(sameNicknameOptions[0]?.label).toBe("Work");
  });

  it("uses OR semantics within facets and AND semantics across them", () => {
    const row = makeRow({ repositoryKey: "repo-1", phaseId: "ready", providerKind: "codex" });
    expect(matchesPhaseSidebarFilters(row, EMPTY_PHASE_SIDEBAR_FILTERS)).toBe(true);
    expect(
      matchesPhaseSidebarFilters(row, {
        repositoryKeys: ["repo-2", "repo-1"],
        phaseIds: ["ready", "failed"],
        providerKinds: ["codex"],
        assignedToMe: false,
      }),
    ).toBe(true);
    expect(
      matchesPhaseSidebarFilters(row, {
        repositoryKeys: ["repo-1"],
        phaseIds: ["ready"],
        providerKinds: ["opencode"],
        assignedToMe: false,
      }),
    ).toBe(false);
    expect(
      buildPhaseSidebarGroups(
        [row],
        { repositoryKeys: ["missing"], phaseIds: [], providerKinds: [], assignedToMe: false },
        "updated_at",
      ),
    ).toEqual([]);
  });

  it("builds removable chip metadata for every active selection", () => {
    expect(
      buildPhaseSidebarFilterChips(
        {
          repositoryKeys: ["repo-1"],
          phaseIds: ["plan_ready"],
          providerKinds: ["codex"],
          assignedToMe: false,
        },
        {
          repositories: new Map([["repo-1", "T3 Code"]]),
          providers: new Map([["codex", "Codex"]]),
        },
      ),
    ).toEqual([
      { facet: "repository", value: "repo-1", label: "T3 Code" },
      { facet: "phase", value: "plan_ready", label: "Plan Ready" },
      { facet: "provider", value: "codex", label: "Codex" },
    ]);
  });

  it("sanitizes malformed persisted values and reconciles stale options", () => {
    expect(sanitizePhaseSidebarFilters(null)).toEqual(EMPTY_PHASE_SIDEBAR_FILTERS);
    expect(
      sanitizePhaseSidebarFilters({
        repositoryKeys: ["repo-1", "repo-1", 1],
        phaseIds: ["ready", "unknown"],
        providerKinds: "codex",
      }),
    ).toEqual({
      repositoryKeys: ["repo-1"],
      phaseIds: ["ready"],
      providerKinds: [],
      assignedToMe: false,
    });

    expect(
      reconcilePhaseSidebarFilters(
        {
          repositoryKeys: ["repo-1", "stale-repo"],
          phaseIds: ["ready"],
          providerKinds: ["codex", "stale-provider"],
          assignedToMe: false,
        },
        {
          repositoryKeys: new Set(["repo-1"]),
          providerKinds: new Set(["codex"]),
          assignmentAvailable: true,
        },
      ),
    ).toEqual({
      repositoryKeys: ["repo-1"],
      phaseIds: ["ready"],
      providerKinds: ["codex"],
      assignedToMe: false,
    });
  });

  it("treats the owner and directly tagged members as assigned and everyone else as not", () => {
    const owner = UserId.make("user_owner");
    const member = UserId.make("user_member");
    const stranger = UserId.make("user_stranger");
    const thread = makeThread({ ownerUserId: owner, memberUserIds: [member] });

    expect(isThreadAssignedToUser(thread, owner)).toBe(true);
    expect(isThreadAssignedToUser(thread, member)).toBe(true);
    expect(isThreadAssignedToUser(thread, stranger)).toBe(false);
    expect(
      isThreadAssignedToUser(makeThread({ ownerUserId: null, memberUserIds: [] }), owner),
    ).toBe(false);
  });

  it("keeps only assigned rows when assignedToMe is on and all rows when off", () => {
    const assignedRow = makeRow({ isAssignedToMe: true });
    const unassignedRow = makeRow({ isAssignedToMe: false });
    const assignedFilters = { ...EMPTY_PHASE_SIDEBAR_FILTERS, assignedToMe: true };

    expect(matchesPhaseSidebarFilters(assignedRow, assignedFilters)).toBe(true);
    expect(matchesPhaseSidebarFilters(unassignedRow, assignedFilters)).toBe(false);
    expect(matchesPhaseSidebarFilters(assignedRow, EMPTY_PHASE_SIDEBAR_FILTERS)).toBe(true);
    expect(matchesPhaseSidebarFilters(unassignedRow, EMPTY_PHASE_SIDEBAR_FILTERS)).toBe(true);
  });

  it("defaults assignedToMe to false when missing and reads it when present", () => {
    expect(
      sanitizePhaseSidebarFilters({
        repositoryKeys: [],
        phaseIds: [],
        providerKinds: [],
      }).assignedToMe,
    ).toBe(false);
    expect(
      sanitizePhaseSidebarFilters({
        repositoryKeys: [],
        phaseIds: [],
        providerKinds: [],
        assignedToMe: true,
      }).assignedToMe,
    ).toBe(true);
  });

  it("forces assignedToMe off when assignment is unavailable and preserves it otherwise", () => {
    const filters = { ...EMPTY_PHASE_SIDEBAR_FILTERS, assignedToMe: true };
    const options = { repositoryKeys: new Set<string>(), providerKinds: new Set<string>() };

    expect(
      reconcilePhaseSidebarFilters(filters, { ...options, assignmentAvailable: false })
        .assignedToMe,
    ).toBe(false);
    expect(
      reconcilePhaseSidebarFilters(filters, { ...options, assignmentAvailable: true }).assignedToMe,
    ).toBe(true);
  });

  it("traverses only visible filtered rows and starts at an edge when the active row is hidden", () => {
    const visibleThreadKeys = ["environment:thread-a", "environment:thread-c"];
    expect(
      resolvePhaseSidebarTraversalTarget({
        visibleThreadKeys,
        currentThreadKey: "environment:thread-a",
        direction: "next",
      }),
    ).toBe("environment:thread-c");
    expect(
      resolvePhaseSidebarTraversalTarget({
        visibleThreadKeys,
        currentThreadKey: "environment:thread-b",
        direction: "next",
      }),
    ).toBe("environment:thread-a");
    expect(
      resolvePhaseSidebarTraversalTarget({
        visibleThreadKeys,
        currentThreadKey: "environment:thread-b",
        direction: "previous",
      }),
    ).toBe("environment:thread-c");
  });
});
