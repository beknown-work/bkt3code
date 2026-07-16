import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project, ThreadShell } from "../../types";
import {
  EMPTY_PHASE_SIDEBAR_FILTERS,
  PHASE_SIDEBAR_PHASE_IDS,
  buildPhaseSidebarFilterChips,
  buildPhaseSidebarGroups,
  derivePhaseSidebarRepositoryKey,
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

function makeSession(overrides: Partial<OrchestrationSession> = {}): OrchestrationSession {
  return {
    threadId,
    status: "ready",
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: threadId,
    environmentId,
    projectId,
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
    providerCode: "cx",
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
    };

    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          session: makeSession({ status: "running", lastError: "stale" }),
        }),
      ),
    ).toBe("approval_needed");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          hasPendingUserInput: true,
          session: makeSession({ status: "error", lastError: "failed" }),
        }),
      ),
    ).toBe("awaiting_input");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({ session: makeSession({ status: "running", lastError: "stale" }) }),
      ),
    ).toBe("implementing");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          session: makeSession({ status: "starting", lastError: "stale" }),
        }),
      ),
    ).toBe("drafting_plan");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({ session: makeSession({ status: "ready", lastError: "failed" }) }),
      ),
    ).toBe("failed");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          session: makeSession({ status: "error" }),
          latestTurn: settledTurn,
          hasActionableProposedPlan: true,
        }),
      ),
    ).toBe("failed");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          session: makeSession(),
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
    expect(PHASE_SIDEBAR_PHASE_IDS).toHaveLength(7);
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

  it("uses OR semantics within facets and AND semantics across them", () => {
    const row = makeRow({ repositoryKey: "repo-1", phaseId: "ready", providerKind: "codex" });
    expect(matchesPhaseSidebarFilters(row, EMPTY_PHASE_SIDEBAR_FILTERS)).toBe(true);
    expect(
      matchesPhaseSidebarFilters(row, {
        repositoryKeys: ["repo-2", "repo-1"],
        phaseIds: ["ready", "failed"],
        providerKinds: ["codex"],
      }),
    ).toBe(true);
    expect(
      matchesPhaseSidebarFilters(row, {
        repositoryKeys: ["repo-1"],
        phaseIds: ["ready"],
        providerKinds: ["opencode"],
      }),
    ).toBe(false);
    expect(
      buildPhaseSidebarGroups(
        [row],
        { repositoryKeys: ["missing"], phaseIds: [], providerKinds: [] },
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
    ).toEqual({ repositoryKeys: ["repo-1"], phaseIds: ["ready"], providerKinds: [] });

    expect(
      reconcilePhaseSidebarFilters(
        {
          repositoryKeys: ["repo-1", "stale-repo"],
          phaseIds: ["ready"],
          providerKinds: ["codex", "stale-provider"],
        },
        {
          repositoryKeys: new Set(["repo-1"]),
          providerKinds: new Set(["codex"]),
        },
      ),
    ).toEqual({ repositoryKeys: ["repo-1"], phaseIds: ["ready"], providerKinds: ["codex"] });
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
