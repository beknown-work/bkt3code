import { describe, expect, it } from "vite-plus/test";

import type { ThreadShell } from "../../types";
import {
  DEFAULT_SESSION_MANAGER_FILTERS,
  applyFrozenRowOrder,
  buildSessionManagerCounts,
  buildSessionManagerFilterChips,
  buildSessionManagerSearchText,
  clampWorkSummaryPercent,
  compareSessionManagerRows,
  filterSessionManagerRows,
  hasActiveSessionManagerFilters,
  matchesSessionManagerFilters,
  nextSessionManagerSort,
  planSessionManagerAction,
  reconcileSessionManagerFilters,
  sanitizeSessionManagerFilters,
  sanitizeSessionManagerSort,
  sortSessionManagerRows,
  workSummaryPreview,
  type SessionManagerFilters,
  type SessionManagerRow,
} from "./SessionManagerPage.logic";

const NOW = "2026-08-08T12:00:00.000Z";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1_000).toISOString();
}

function makeRow(overrides: Partial<SessionManagerRow> & { key: string }): SessionManagerRow {
  const { thread: threadOverride, ...rest } = overrides;
  const title = threadOverride?.title ?? `Session ${overrides.key}`;
  const thread = {
    id: overrides.key,
    title,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(1),
    branch: null,
    worktreePath: null,
    priority: null,
    linearIssueUrl: null,
    ...threadOverride,
  } as unknown as ThreadShell;
  return {
    thread,
    lifecycle: "active",
    phaseId: "ready",
    attentionKind: null,
    repositoryKey: "repo-a",
    repositoryLabel: "Repo A",
    providerKind: "codex",
    providerName: "Codex",
    modelLabel: "gpt-5.6-sol",
    ownerUserId: "user_1",
    ownerLabel: "Tushar",
    priorityRank: 5,
    lastActivityAt: daysAgo(1),
    isUnreadCompletion: false,
    isPinned: false,
    workSummary: null,
    capabilities: {
      settlement: true,
      snooze: true,
      pinning: true,
      priority: true,
      titleRegeneration: true,
      workSummary: true,
    },
    canStop: false,
    searchText: title.toLowerCase(),
    ...rest,
  };
}

describe("session manager filter matching", () => {
  it("keeps a row only when every active facet admits it", () => {
    const row = makeRow({
      key: "a",
      repositoryKey: "repo-a",
      phaseId: "implementing",
      providerKind: "codex",
      priorityRank: 1,
      attentionKind: "approval",
      ownerUserId: "user_1",
    });
    const filters: SessionManagerFilters = {
      ...DEFAULT_SESSION_MANAGER_FILTERS,
      repositoryKeys: ["repo-a"],
      phaseIds: ["implementing"],
      providerKinds: ["codex"],
      priorities: [1],
      attentionKinds: ["approval"],
      ownerUserIds: ["user_1"],
    };
    expect(matchesSessionManagerFilters(row, filters, { now: NOW })).toBe(true);
    expect(
      matchesSessionManagerFilters(row, { ...filters, repositoryKeys: ["repo-b"] }, { now: NOW }),
    ).toBe(false);
    expect(matchesSessionManagerFilters(row, { ...filters, priorities: [0] }, { now: NOW })).toBe(
      false,
    );
  });

  it("ORs values inside one facet", () => {
    const row = makeRow({ key: "a", repositoryKey: "repo-b" });
    expect(
      matchesSessionManagerFilters(
        row,
        { ...DEFAULT_SESSION_MANAGER_FILTERS, repositoryKeys: ["repo-a", "repo-b"] },
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("hides every lifecycle the filter does not list", () => {
    const archived = makeRow({ key: "a", lifecycle: "archived" });
    expect(
      matchesSessionManagerFilters(archived, DEFAULT_SESSION_MANAGER_FILTERS, { now: NOW }),
    ).toBe(false);
    expect(
      matchesSessionManagerFilters(
        archived,
        { ...DEFAULT_SESSION_MANAGER_FILTERS, lifecycles: ["archived"] },
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("treats the unprioritised rank as a filterable value", () => {
    const row = makeRow({ key: "a", priorityRank: 5 });
    expect(
      matchesSessionManagerFilters(
        row,
        { ...DEFAULT_SESSION_MANAGER_FILTERS, priorities: [5] },
        { now: NOW },
      ),
    ).toBe(true);
  });

  it("admits only rows idle for at least staleDays, and never hides rows with no activity", () => {
    const fresh = makeRow({ key: "fresh", lastActivityAt: daysAgo(1) });
    const stale = makeRow({ key: "stale", lastActivityAt: daysAgo(9) });
    const never = makeRow({ key: "never", lastActivityAt: null });
    const filters = { ...DEFAULT_SESSION_MANAGER_FILTERS, staleDays: 7 };
    expect(matchesSessionManagerFilters(fresh, filters, { now: NOW })).toBe(false);
    expect(matchesSessionManagerFilters(stale, filters, { now: NOW })).toBe(true);
    expect(matchesSessionManagerFilters(never, filters, { now: NOW })).toBe(true);
  });

  it("matches the search box against the row's precomputed haystack", () => {
    const row = makeRow({ key: "a", searchText: "converge execution state on resume bk-412" });
    const filters = { ...DEFAULT_SESSION_MANAGER_FILTERS, search: "  BK-412 " };
    expect(matchesSessionManagerFilters(row, filters, { now: NOW })).toBe(true);
    expect(
      matchesSessionManagerFilters(row, { ...filters, search: "nonexistent" }, { now: NOW }),
    ).toBe(false);
  });

  it("filters a list down to the matching rows", () => {
    const rows = [
      makeRow({ key: "a", repositoryKey: "repo-a" }),
      makeRow({ key: "b", repositoryKey: "repo-b" }),
    ];
    const filtered = filterSessionManagerRows(
      rows,
      { ...DEFAULT_SESSION_MANAGER_FILTERS, repositoryKeys: ["repo-b"] },
      { now: NOW },
    );
    expect(filtered.map((row) => row.key)).toEqual(["b"]);
  });

  it("builds a search haystack that is lowercased and covers every searchable field", () => {
    const haystack = buildSessionManagerSearchText({
      title: "Bulk Session Manager",
      branch: "t3code/56e26545",
      repositoryLabel: "t3code",
      worktreePath: "/home/ubuntu/worktrees/x",
      summary: "Client column landed",
      remaining: "Run the fork marker check",
      linearIssueUrl: "https://linear.app/x/issue/BK-9",
      providerName: "Claude",
      model: "opus-5",
    });
    expect(haystack).toContain("bulk session manager");
    expect(haystack).toContain("t3code/56e26545");
    expect(haystack).toContain("fork marker");
    expect(haystack).toContain("bk-9");
    expect(haystack).toBe(haystack.toLowerCase());
  });
});

describe("session manager sorting", () => {
  it("sorts activity newest-first under asc and oldest-first under desc", () => {
    const rows = [
      makeRow({ key: "old", lastActivityAt: daysAgo(9) }),
      makeRow({ key: "new", lastActivityAt: daysAgo(1) }),
      makeRow({ key: "mid", lastActivityAt: daysAgo(4) }),
    ];
    expect(
      sortSessionManagerRows(rows, { column: "activity", direction: "asc" }).map((row) => row.key),
    ).toEqual(["new", "mid", "old"]);
    expect(
      sortSessionManagerRows(rows, { column: "activity", direction: "desc" }).map((row) => row.key),
    ).toEqual(["old", "mid", "new"]);
  });

  it("sorts priority with P0 first and unprioritised last", () => {
    const rows = [
      makeRow({ key: "none", priorityRank: 5 }),
      makeRow({ key: "p2", priorityRank: 2 }),
      makeRow({ key: "p0", priorityRank: 0 }),
    ];
    expect(
      sortSessionManagerRows(rows, { column: "priority", direction: "asc" }).map((row) => row.key),
    ).toEqual(["p0", "p2", "none"]);
  });

  it("sorts rows with no work-summary stage after every staged row in both directions", () => {
    const staged = makeRow({
      key: "staged",
      workSummary: {
        status: "ready",
        summary: "x",
        stage: "planning",
        remaining: null,
        percent: 10,
        error: null,
        requestId: null,
        updatedAt: NOW,
      } as SessionManagerRow["workSummary"],
    });
    const bare = makeRow({ key: "bare" });
    expect(
      sortSessionManagerRows([bare, staged], { column: "progress", direction: "asc" }).map(
        (row) => row.key,
      ),
    ).toEqual(["staged", "bare"]);
  });

  it("breaks ties on the stable row key so equal rows never shuffle", () => {
    const left = makeRow({ key: "aaa", priorityRank: 1 });
    const right = makeRow({ key: "bbb", priorityRank: 1 });
    expect(
      compareSessionManagerRows(left, right, { column: "priority", direction: "asc" }),
    ).toBeLessThan(0);
  });

  it("cycles a column asc → desc and resets direction when the column changes", () => {
    const first = nextSessionManagerSort({ column: "activity", direction: "asc" }, "title");
    expect(first).toEqual({ column: "title", direction: "asc" });
    expect(nextSessionManagerSort(first, "title")).toEqual({ column: "title", direction: "desc" });
  });
});

describe("frozen row order", () => {
  const rows = [makeRow({ key: "a" }), makeRow({ key: "b" }), makeRow({ key: "c" })];

  it("returns the live order when nothing is frozen", () => {
    expect(applyFrozenRowOrder(rows, null).map((row) => row.key)).toEqual(["a", "b", "c"]);
    expect(applyFrozenRowOrder(rows, []).map((row) => row.key)).toEqual(["a", "b", "c"]);
  });

  it("holds the frozen order even after the live sort changes", () => {
    const reordered = [rows[2]!, rows[0]!, rows[1]!];
    expect(applyFrozenRowOrder(reordered, ["a", "b", "c"]).map((row) => row.key)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops vanished rows and appends new ones at the end", () => {
    const live = [makeRow({ key: "a" }), makeRow({ key: "c" }), makeRow({ key: "d" })];
    expect(applyFrozenRowOrder(live, ["a", "b", "c"]).map((row) => row.key)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("never emits a row twice when the frozen list repeats a key", () => {
    expect(applyFrozenRowOrder(rows, ["a", "a", "b"]).map((row) => row.key)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("session manager chips", () => {
  const labels = {
    repositories: new Map([["repo-a", "Repo A"]]),
    providers: new Map([["codex", "Codex"]]),
    owners: new Map([["user_1", "Tushar"]]),
  };

  it("emits nothing for the default filter set", () => {
    expect(buildSessionManagerFilterChips(DEFAULT_SESSION_MANAGER_FILTERS, labels)).toEqual([]);
    expect(hasActiveSessionManagerFilters(DEFAULT_SESSION_MANAGER_FILTERS)).toBe(false);
  });

  it("labels each facet value and carries the value needed to clear it", () => {
    const chips = buildSessionManagerFilterChips(
      {
        ...DEFAULT_SESSION_MANAGER_FILTERS,
        search: " resume ",
        repositoryKeys: ["repo-a"],
        phaseIds: ["implementing"],
        providerKinds: ["codex"],
        priorities: [0, 5],
        attentionKinds: ["approval"],
        ownerUserIds: ["user_1"],
        staleDays: 7,
      },
      labels,
    );
    expect(chips.map((chip) => [chip.facet, chip.label, chip.value])).toEqual([
      ["search", "“resume”", null],
      ["repository", "Repo A", "repo-a"],
      ["phase", "Implementing", "implementing"],
      ["attention", "Approval", "approval"],
      ["priority", "P0", "0"],
      ["priority", "No priority", "5"],
      ["provider", "Codex", "codex"],
      ["owner", "Tushar", "user_1"],
      ["stale", "idle 7d+", null],
    ]);
  });

  it("chips the lifecycle facet only once it differs from the default", () => {
    expect(
      buildSessionManagerFilterChips(
        { ...DEFAULT_SESSION_MANAGER_FILTERS, lifecycles: ["active", "archived"] },
        labels,
      ).map((chip) => chip.label),
    ).toEqual(["Active", "Archived"]);
  });

  it("falls back to the raw key when a label is missing", () => {
    const chips = buildSessionManagerFilterChips(
      { ...DEFAULT_SESSION_MANAGER_FILTERS, repositoryKeys: ["repo-unknown"] },
      labels,
    );
    expect(chips[0]?.label).toBe("repo-unknown");
  });
});

describe("session manager counts", () => {
  it("counts only active rows and buckets them by phase and staleness", () => {
    const counts = buildSessionManagerCounts(
      [
        makeRow({ key: "a", phaseId: "implementing", attentionKind: null }),
        makeRow({ key: "b", phaseId: "needs_input", attentionKind: "input" }),
        makeRow({ key: "c", phaseId: "plan_ready", lastActivityAt: daysAgo(30) }),
        makeRow({ key: "d", lifecycle: "archived", phaseId: "implementing" }),
      ],
      { now: NOW, staleDays: 7 },
    );
    expect(counts).toEqual({
      total: 4,
      active: 3,
      attention: 1,
      running: 1,
      stale: 1,
      blocked: 1,
      review: 1,
    });
  });
});

describe("session manager persistence", () => {
  it("drops unknown members and restores the default lifecycle set", () => {
    expect(
      sanitizeSessionManagerFilters({
        search: 42,
        repositoryKeys: ["repo-a", 7],
        phaseIds: ["implementing", "not-a-phase"],
        priorities: [0, 9, "x", 5],
        attentionKinds: ["approval", "nope"],
        lifecycles: ["not-a-lifecycle"],
        staleDays: -3,
      }),
    ).toEqual({
      search: "",
      repositoryKeys: ["repo-a"],
      phaseIds: ["implementing"],
      providerKinds: [],
      priorities: [0, 5],
      attentionKinds: ["approval"],
      ownerUserIds: [],
      lifecycles: ["active"],
      staleDays: null,
    });
  });

  it("falls back to the default filters for a non-object blob", () => {
    expect(sanitizeSessionManagerFilters(null)).toEqual(DEFAULT_SESSION_MANAGER_FILTERS);
    expect(sanitizeSessionManagerFilters("nope")).toEqual(DEFAULT_SESSION_MANAGER_FILTERS);
  });

  it("sanitizes a persisted sort and rejects unknown columns", () => {
    expect(sanitizeSessionManagerSort({ column: "title", direction: "desc" })).toEqual({
      column: "title",
      direction: "desc",
    });
    expect(sanitizeSessionManagerSort({ column: "bogus", direction: "sideways" })).toEqual({
      column: "activity",
      direction: "asc",
    });
  });

  it("reconciles away facet values whose option disappeared", () => {
    const filters: SessionManagerFilters = {
      ...DEFAULT_SESSION_MANAGER_FILTERS,
      repositoryKeys: ["repo-a", "gone"],
      providerKinds: ["codex"],
      ownerUserIds: ["user_1", "left"],
    };
    expect(
      reconcileSessionManagerFilters(filters, {
        repositoryKeys: new Set(["repo-a"]),
        providerKinds: new Set(["codex"]),
        ownerUserIds: new Set(["user_1"]),
      }),
    ).toMatchObject({
      repositoryKeys: ["repo-a"],
      providerKinds: ["codex"],
      ownerUserIds: ["user_1"],
    });
  });

  it("returns the same object when nothing needs reconciling", () => {
    const filters = { ...DEFAULT_SESSION_MANAGER_FILTERS, repositoryKeys: ["repo-a"] };
    expect(
      reconcileSessionManagerFilters(filters, {
        repositoryKeys: new Set(["repo-a"]),
        providerKinds: new Set<string>(),
        ownerUserIds: new Set<string>(),
      }),
    ).toBe(filters);
  });
});

describe("session manager action planning", () => {
  it("splits eligible from blocked rows and only reports a reason when nothing is eligible", () => {
    const rows = [makeRow({ key: "a", canStop: true }), makeRow({ key: "b", canStop: false })];
    const mixed = planSessionManagerAction(rows, (row) => row.canStop, "nothing to stop");
    expect(mixed.eligible.map((row) => row.key)).toEqual(["a"]);
    expect(mixed.blocked.map((row) => row.key)).toEqual(["b"]);
    expect(mixed.disabledReason).toBeNull();

    const none = planSessionManagerAction([rows[1]!], (row) => row.canStop, "nothing to stop");
    expect(none.disabledReason).toBe("nothing to stop");
  });

  it("reports no reason for an empty selection", () => {
    expect(planSessionManagerAction([], () => true, "reason").disabledReason).toBeNull();
  });
});

describe("work summary presentation helpers", () => {
  it("clamps a percent into 0..100 and rejects non-finite values", () => {
    expect(clampWorkSummaryPercent(42.4)).toBe(42);
    expect(clampWorkSummaryPercent(-5)).toBe(0);
    expect(clampWorkSummaryPercent(180)).toBe(100);
    expect(clampWorkSummaryPercent(null)).toBeNull();
    expect(clampWorkSummaryPercent(Number.NaN)).toBeNull();
  });

  it("collapses whitespace into a single-line preview and treats blank text as absent", () => {
    expect(workSummaryPreview("  landed the\n  client   column\n")).toBe(
      "landed the client column",
    );
    expect(workSummaryPreview("   ")).toBeNull();
    expect(workSummaryPreview(null)).toBeNull();
  });
});
