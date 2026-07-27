import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  UserId,
  type ThreadExecutionSnapshot,
  type VcsStatusResult,
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
  phaseSidebarNeedsUserInput,
  reconcilePhaseSidebarFilters,
  resolvePhaseSidebarCheckoutMetadata,
  resolvePhaseSidebarDisplayPhase,
  resolvePhaseSidebarLinearIssue,
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

describe("resolvePhaseSidebarCheckoutMetadata", () => {
  it("shows the live branch for a current checkout", () => {
    expect(
      resolvePhaseSidebarCheckoutMetadata(
        { branch: "stale-branch", worktreePath: null },
        { refName: "dev", baseRef: "main", pr: null },
      ),
    ).toEqual({
      kind: "current",
      label: "dev",
      tooltip: "Current checkout on dev",
    });
  });

  it("shows a worktree's recorded starting ref instead of its current branch", () => {
    expect(
      resolvePhaseSidebarCheckoutMetadata(
        { branch: "t3code/generated-feature", worktreePath: "/repo/worktrees/feature" },
        { refName: "t3code/generated-feature", baseRef: "main", pr: null },
      ),
    ).toEqual({
      kind: "worktree",
      label: "from main",
      tooltip: "Worktree started from main",
    });
  });

  it("prefers a pull request base when one is available", () => {
    expect(
      resolvePhaseSidebarCheckoutMetadata(
        { branch: "feature/pr", worktreePath: "/repo/worktrees/pr" },
        {
          refName: "feature/pr",
          baseRef: "main",
          pr: {
            number: 42,
            title: "Feature",
            url: "https://example.com/pr/42",
            baseRef: "release",
            headRef: "feature/pr",
            state: "open",
          },
        },
      ).label,
    ).toBe("from release");
  });
});

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
    settledOverride: null,
    settledAt: null,
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
    attentionPriority: 5,
    unreadPriority: 1,
    ...overrides,
  };
}

describe("phase sidebar lifecycle", () => {
  it("keeps active execution in agent-work groups except urgent structured questions", () => {
    const settledTurn = {
      turnId: TurnId.make("turn-1"),
      state: "completed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
      durationMs: null,
    };

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
    ).toBe("planning");
    expect(
      resolvePhaseSidebarPhase(makeThread({ execution: makeActiveExecution() }), {
        pr: {
          number: 1,
          title: "Review",
          url: "https://github.com/acme/repo/pull/1",
          baseRef: "main",
          headRef: "feature/work",
          state: "open",
          autoMergeEnabled: true,
        },
      } as VcsStatusResult),
    ).toBe("implementing");
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
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          execution: makeActiveExecution("waiting-for-input"),
        }),
      ),
    ).toBe("needs_input");
  });

  it("promotes durable and live pending questions to the first lifecycle group", () => {
    const durableInput = makeThread({
      id: ThreadId.make("thread-durable-input"),
      hasPendingUserInput: true,
      execution: null,
    });
    const liveInput = makeThread({
      id: ThreadId.make("thread-live-input"),
      execution: makeActiveExecution("waiting-for-input"),
    });
    const ready = makeThread({ id: ThreadId.make("thread-ready") });

    expect(phaseSidebarNeedsUserInput(durableInput)).toBe(true);
    expect(phaseSidebarNeedsUserInput(liveInput)).toBe(true);
    expect(phaseSidebarNeedsUserInput(ready)).toBe(false);

    const groups = buildPhaseSidebarGroups(
      [
        makeRow({ thread: ready }),
        makeRow({ thread: liveInput }),
        makeRow({ thread: durableInput }),
      ],
      EMPTY_PHASE_SIDEBAR_FILTERS,
      "updated_at",
    );
    expect(groups[0]?.id).toBe("needs_input");
    expect(groups[0]?.rows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-durable-input"),
      ThreadId.make("thread-live-input"),
    ]);
  });

  it("advances review and merge states only from repository evidence", () => {
    const settledThread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
        durationMs: null,
      },
    });
    const status = {
      isRepo: true,
      sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/work",
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 1, deletions: 0 },
      hasUpstream: true,
      aheadCount: 1,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    } as const;
    expect(resolvePhaseSidebarPhase(settledThread, status)).toBe("ready_for_review");
    expect(
      resolvePhaseSidebarPhase(settledThread, {
        ...status,
        pr: {
          number: 1,
          title: "Review",
          url: "https://github.com/acme/repo/pull/1",
          baseRef: "main",
          headRef: "feature/work",
          state: "open",
          isDraft: false,
          mergeability: "mergeable",
          mergeStateStatus: "CLEAN",
          reviewDecision: "approved",
          checksStatus: "pass",
        },
      }),
    ).toBe("ready_to_merge");
    expect(
      resolvePhaseSidebarPhase(settledThread, {
        ...status,
        pr: {
          number: 1,
          title: "Review",
          url: "https://github.com/acme/repo/pull/1",
          baseRef: "main",
          headRef: "feature/work",
          state: "merged",
        },
      }),
    ).toBe("merged");
  });

  it("puts non-running lifecycle groups before agent work and sorts by thread id on ties", () => {
    const rows = [
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-a"), archivedAt: now }),
        phaseId: "plan_ready",
      }),
      makeRow({ thread: makeThread({ id: ThreadId.make("thread-a") }), phaseId: "ready" }),
      makeRow({ thread: makeThread({ id: ThreadId.make("thread-b") }), phaseId: "ready" }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-c") }),
        phaseId: "implementing",
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-d") }),
        phaseId: "ready_for_review",
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-e") }),
        phaseId: "ready_to_merge",
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-f") }),
        phaseId: "merged",
      }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at");
    expect(groups.map((group) => group.id)).toEqual([
      "ready",
      "ready_for_review",
      "ready_to_merge",
      "merged",
      "implementing",
    ]);
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-a"),
      ThreadId.make("thread-b"),
      ThreadId.make("thread-d"),
      ThreadId.make("thread-e"),
      ThreadId.make("thread-f"),
      ThreadId.make("thread-c"),
    ]);
    expect(PHASE_SIDEBAR_PHASE_IDS).toHaveLength(11);
  });

  it("uses ready only as the non-running fallback", () => {
    expect(resolvePhaseSidebarPhase(makeThread())).toBe("ready");
    expect(resolvePhaseSidebarPhase(makeThread({ execution: makeActiveExecution() }))).not.toBe(
      "ready",
    );
    expect(resolvePhaseSidebarPhase(makeThread({ execution: null }))).not.toBe("ready");
  });

  it("uses checking until an authoritative execution snapshot arrives", () => {
    expect(resolvePhaseSidebarPhase(makeThread({ execution: null }))).toBe("checking");
  });

  it("keeps the last known lifecycle phase while execution is resynchronizing", () => {
    expect(resolvePhaseSidebarDisplayPhase("checking", "implementing")).toBe("implementing");
    expect(resolvePhaseSidebarDisplayPhase("checking", "ready_for_review")).toBe(
      "ready_for_review",
    );
    expect(resolvePhaseSidebarDisplayPhase("checking", null)).toBe("checking");
    expect(resolvePhaseSidebarDisplayPhase("ready", "implementing")).toBe("ready");
  });
});

describe("phase sidebar metadata and filters", () => {
  it("resolves bridge-created branches to compact Linear issue links", () => {
    expect(resolvePhaseSidebarLinearIssue("linear/tec-145-improve-the-sidebar")).toEqual({
      identifier: "TEC-145",
      url: "https://linear.app/beknown/issue/TEC-145",
    });
    expect(resolvePhaseSidebarLinearIssue("linear/TEC-658")).toEqual({
      identifier: "TEC-658",
      url: "https://linear.app/beknown/issue/TEC-658",
    });
    expect(resolvePhaseSidebarLinearIssue("feature/tec-145")).toBeNull();
    expect(resolvePhaseSidebarLinearIssue(null)).toBeNull();
  });

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
        phaseIds: ["ready", "ready_for_review"],
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
