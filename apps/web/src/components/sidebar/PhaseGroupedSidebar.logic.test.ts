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
  filterVisiblePhaseSidebarRows,
  matchesPhaseSidebarFilters,
  partitionPhaseSidebarRows,
  phaseSidebarRowClassName,
  phaseSidebarNeedsUserInput,
  phaseSidebarPriorityRank,
  formatThreadPriority,
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

describe("phaseSidebarRowClassName", () => {
  it("gives the routed row a restrained primary surface and focus ring", () => {
    const className = phaseSidebarRowClassName(true, false, false);

    expect(className).toContain("bg-primary/10");
    expect(className).toContain("ring-primary/30");
    expect(className).toContain("font-semibold");
  });

  it("keeps multi-selection distinct and strengthens the routed selected row", () => {
    const selected = phaseSidebarRowClassName(false, true, false);
    const activeSelected = phaseSidebarRowClassName(true, true, false);

    expect(selected).toContain("bg-primary/15");
    expect(selected).not.toContain("ring-primary/40");
    expect(activeSelected).toContain("bg-primary/18");
    expect(activeSelected).toContain("ring-primary/40");
  });

  it("preserves the urgent input treatment on an active row", () => {
    const className = phaseSidebarRowClassName(true, false, true);

    expect(className).toContain("bg-red-500/20");
    expect(className).toContain("ring-red-500/60");
    expect(className).toContain("motion-reduce:animate-none");
  });
});

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
    // Settlement and snooze default ON: most cases exercise the partition,
    // and the capability-gating cases opt out explicitly.
    settlementSupported: true,
    snoozeSupported: true,
    prioritySupported: true,
    changeRequestState: null,
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

describe("partitionPhaseSidebarRows", () => {
  const future = "2026-07-16T14:00:00.000Z";
  const past = "2026-07-16T09:00:00.000Z";
  const partitionOptions = { now, preciseNow: now, autoSettleAfterDays: null };
  const keysOf = (rows: ReadonlyArray<PhaseSidebarRow>) => rows.map((row) => row.thread.id);

  it("moves an explicitly settled thread off the lifecycle groups", () => {
    const row = makeRow({
      thread: makeThread({ settledOverride: "settled", settledAt: now }),
    });

    const { activeRows, settledRows } = partitionPhaseSidebarRows([row], partitionOptions);

    expect(activeRows).toHaveLength(0);
    expect(settledRows).toHaveLength(1);
    expect(
      buildPhaseSidebarGroups(activeRows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at"),
    ).toHaveLength(0);
  });

  it("lets snooze outrank settled classification", () => {
    const row = makeRow({
      thread: makeThread({
        snoozedUntil: future,
        snoozedAt: past,
        settledOverride: "settled",
        settledAt: past,
      }),
    });

    const { snoozedRows, settledRows } = partitionPhaseSidebarRows([row], partitionOptions);

    expect(snoozedRows).toHaveLength(1);
    expect(settledRows).toHaveLength(0);
  });

  it("keeps a snoozed thread active once it raises its hand for user input", () => {
    const row = makeRow({
      thread: makeThread({ snoozedUntil: future, snoozedAt: past, hasPendingUserInput: true }),
    });

    const { activeRows, snoozedRows } = partitionPhaseSidebarRows([row], partitionOptions);

    expect(snoozedRows).toHaveLength(0);
    expect(activeRows).toHaveLength(1);
    expect(phaseSidebarNeedsUserInput(activeRows[0]!.thread)).toBe(true);
  });

  it("never parks rows whose server lacks the matching capability", () => {
    const settled = makeRow({
      thread: makeThread({ settledOverride: "settled", settledAt: now }),
      settlementSupported: false,
    });
    const snoozed = makeRow({
      thread: makeThread({ id: ThreadId.make("thread-2"), snoozedUntil: future }),
      snoozeSupported: false,
    });

    const partition = partitionPhaseSidebarRows([settled, snoozed], partitionOptions);

    expect(partition.activeRows).toHaveLength(2);
    expect(partition.settledRows).toHaveLength(0);
    expect(partition.snoozedRows).toHaveLength(0);
  });

  it("returns an elapsed snooze to the lifecycle groups", () => {
    const row = makeRow({ thread: makeThread({ snoozedUntil: past, snoozedAt: past }) });

    const { activeRows, snoozedRows } = partitionPhaseSidebarRows([row], partitionOptions);

    expect(snoozedRows).toHaveLength(0);
    expect(activeRows).toHaveLength(1);
  });

  it("orders snoozed rows by soonest wake and settled rows by most recently ended", () => {
    const soon = makeRow({
      thread: makeThread({
        id: ThreadId.make("wake-soon"),
        snoozedUntil: "2026-07-16T11:00:00.000Z",
      }),
    });
    const later = makeRow({
      thread: makeThread({ id: ThreadId.make("wake-later"), snoozedUntil: future }),
    });
    const older = makeRow({
      thread: makeThread({
        id: ThreadId.make("settled-older"),
        settledOverride: "settled",
        settledAt: past,
      }),
    });
    const newer = makeRow({
      thread: makeThread({
        id: ThreadId.make("settled-newer"),
        settledOverride: "settled",
        settledAt: now,
      }),
    });

    const partition = partitionPhaseSidebarRows([later, soon, older, newer], partitionOptions);

    expect(keysOf(partition.snoozedRows)).toEqual(["wake-soon", "wake-later"]);
    expect(keysOf(partition.settledRows)).toEqual(["settled-newer", "settled-older"]);
  });

  it("applies sidebar filters to parked rows, not just lifecycle groups", () => {
    const rows = [
      makeRow({
        thread: makeThread({ settledOverride: "settled", settledAt: now }),
        repositoryKey: "repo-1",
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-2"), snoozedUntil: future }),
        repositoryKey: "repo-2",
      }),
    ];
    const filters = { ...EMPTY_PHASE_SIDEBAR_FILTERS, repositoryKeys: ["repo-1"] };

    const partition = partitionPhaseSidebarRows(
      filterVisiblePhaseSidebarRows(rows, filters),
      partitionOptions,
    );

    expect(partition.settledRows).toHaveLength(1);
    expect(partition.snoozedRows).toHaveLength(0);
  });

  it("excludes archived rows from every section", () => {
    const rows = [makeRow({ thread: makeThread({ archivedAt: now }) })];

    const partition = partitionPhaseSidebarRows(
      filterVisiblePhaseSidebarRows(rows, EMPTY_PHASE_SIDEBAR_FILTERS),
      partitionOptions,
    );

    expect(partition.activeRows).toHaveLength(0);
    expect(partition.settledRows).toHaveLength(0);
    expect(partition.snoozedRows).toHaveLength(0);
  });
});

// T3-CUSTOM(expbkt3): session priority.
describe("phase sidebar priority", () => {
  it("ranks unprioritised threads after an explicit P4", () => {
    expect(phaseSidebarPriorityRank(makeThread({ priority: 0 }))).toBe(0);
    expect(phaseSidebarPriorityRank(makeThread({ priority: 4 }))).toBe(4);
    expect(phaseSidebarPriorityRank(makeThread())).toBeGreaterThan(4);
  });

  it("formats priorities for display", () => {
    expect(formatThreadPriority(0)).toBe("P0");
    expect(formatThreadPriority(4)).toBe("P4");
  });

  it("sorts by priority ahead of attention and recency inside a group", () => {
    const rows = [
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-unset"), updatedAt: now }),
        phaseId: "ready",
        attentionPriority: 1,
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-p4"), priority: 4, updatedAt: now }),
        phaseId: "ready",
        attentionPriority: 1,
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-p0"), priority: 0, updatedAt: now }),
        phaseId: "ready",
        // Deliberately the *worst* attention rank: priority must still win.
        attentionPriority: 5,
      }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at");
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-p0"),
      ThreadId.make("thread-p4"),
      ThreadId.make("thread-unset"),
    ]);
  });

  it("falls back to attention order when priorities tie", () => {
    const rows = [
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-late"), priority: 1 }),
        phaseId: "ready",
        attentionPriority: 4,
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-early"), priority: 1 }),
        phaseId: "ready",
        attentionPriority: 2,
      }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at");
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-early"),
      ThreadId.make("thread-late"),
    ]);
  });

  it("highlights P0 rows unless they are already flashing for input", () => {
    expect(phaseSidebarRowClassName(false, false, false, true)).toContain("amber");
    expect(phaseSidebarRowClassName(false, false, true, true)).not.toContain("amber");
    expect(phaseSidebarRowClassName(false, false, false, false)).not.toContain("amber");
  });
});
