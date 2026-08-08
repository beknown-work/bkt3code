/**
 * T3-CUSTOM(expbkt3): Coverage for the archived-worktree reclaim gates.
 *
 * These gates are the only thing standing between the feature and deleting
 * someone's running worktree, so each one is asserted directly rather than
 * through the service that calls them.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  evaluateReclaimEligibility,
  isPastRetention,
  normalizeWorktreePath,
  type ReclaimEligibilityInput,
} from "./reclaimEligibility.ts";

const NOW_MS = Date.parse("2026-08-07T00:00:00.000Z");
const ARCHIVED_LONG_AGO = "2026-01-01T00:00:00.000Z";
const WORKTREE = "/home/ubuntu/.t3/dev/worktrees/proj/feature";

const CLEAN_GIT = {
  hasUncommittedChanges: false,
  hasUntrackedFiles: false,
  hasUnpushedCommits: false,
};

const input = (overrides: Partial<ReclaimEligibilityInput> = {}): ReclaimEligibilityInput => ({
  thread: { threadId: "thread_1", worktreePath: WORKTREE, archivedAt: ARCHIVED_LONG_AGO },
  mode: "slim",
  git: CLEAN_GIT,
  liveWorktreePaths: new Set(),
  activeThreadWorktreePaths: new Set(),
  minArchivedDays: 0,
  nowMs: NOW_MS,
  force: false,
  ...overrides,
});

describe("evaluateReclaimEligibility", () => {
  it("allows a slim of a clean, solely-owned, archived worktree", () => {
    expect(evaluateReclaimEligibility(input())).toEqual({ eligible: true, blockedReason: null });
  });

  it("refuses a thread that is not archived", () => {
    const result = evaluateReclaimEligibility(
      input({ thread: { threadId: "thread_1", worktreePath: WORKTREE, archivedAt: null } }),
    );
    expect(result.blockedReason).toBe("not-archived");
  });

  it("refuses a thread with no worktree", () => {
    const result = evaluateReclaimEligibility(
      input({
        thread: { threadId: "thread_1", worktreePath: null, archivedAt: ARCHIVED_LONG_AGO },
      }),
    );
    expect(result.blockedReason).toBe("no-worktree");
  });

  it("refuses a worktree a session is running out of", () => {
    const result = evaluateReclaimEligibility(input({ liveWorktreePaths: new Set([WORKTREE]) }));
    expect(result.blockedReason).toBe("worktree-live");
  });

  it("refuses a worktree still referenced by an active thread", () => {
    const result = evaluateReclaimEligibility(
      input({ activeThreadWorktreePaths: new Set([WORKTREE]) }),
    );
    expect(result.blockedReason).toBe("worktree-shared");
  });

  it("keeps the live and shared gates un-forceable", () => {
    expect(
      evaluateReclaimEligibility(
        input({ force: true, mode: "remove", liveWorktreePaths: new Set([WORKTREE]) }),
      ).blockedReason,
    ).toBe("worktree-live");
    expect(
      evaluateReclaimEligibility(
        input({ force: true, mode: "remove", activeThreadWorktreePaths: new Set([WORKTREE]) }),
      ).blockedReason,
    ).toBe("worktree-shared");
  });

  it("reports the live gate ahead of a dirty tree", () => {
    const result = evaluateReclaimEligibility(
      input({
        mode: "remove",
        liveWorktreePaths: new Set([WORKTREE]),
        git: { ...CLEAN_GIT, hasUncommittedChanges: true },
      }),
    );
    expect(result.blockedReason).toBe("worktree-live");
  });

  it("holds a session inside the retention window", () => {
    const result = evaluateReclaimEligibility(
      input({
        minArchivedDays: 14,
        thread: {
          threadId: "thread_1",
          worktreePath: WORKTREE,
          archivedAt: "2026-08-01T00:00:00.000Z",
        },
      }),
    );
    expect(result.blockedReason).toBe("retention-window");
  });

  it("releases a session once the retention window has passed", () => {
    expect(evaluateReclaimEligibility(input({ minArchivedDays: 14 })).eligible).toBe(true);
  });

  describe("mode: remove", () => {
    it("refuses uncommitted changes", () => {
      const result = evaluateReclaimEligibility(
        input({ mode: "remove", git: { ...CLEAN_GIT, hasUncommittedChanges: true } }),
      );
      expect(result.blockedReason).toBe("dirty-worktree");
    });

    it("refuses untracked files", () => {
      const result = evaluateReclaimEligibility(
        input({ mode: "remove", git: { ...CLEAN_GIT, hasUntrackedFiles: true } }),
      );
      expect(result.blockedReason).toBe("dirty-worktree");
    });

    it("refuses unpushed commits", () => {
      const result = evaluateReclaimEligibility(
        input({ mode: "remove", git: { ...CLEAN_GIT, hasUnpushedCommits: true } }),
      );
      expect(result.blockedReason).toBe("unpushed-commits");
    });

    it("allows those to be forced", () => {
      const result = evaluateReclaimEligibility(
        input({
          mode: "remove",
          force: true,
          git: { hasUncommittedChanges: true, hasUntrackedFiles: true, hasUnpushedCommits: true },
        }),
      );
      expect(result.eligible).toBe(true);
    });

    it("refuses when git facts are unavailable", () => {
      const result = evaluateReclaimEligibility(input({ mode: "remove", git: null }));
      expect(result.blockedReason).toBe("no-worktree");
    });
  });

  describe("mode: slim", () => {
    it("ignores a dirty tree, because it only deletes ignored directories", () => {
      const result = evaluateReclaimEligibility(
        input({
          git: { hasUncommittedChanges: true, hasUntrackedFiles: true, hasUnpushedCommits: true },
        }),
      );
      expect(result.eligible).toBe(true);
    });
  });
});

describe("isPastRetention", () => {
  it("treats a zero window as always past", () => {
    expect(isPastRetention({ archivedAt: null, minArchivedDays: 0, nowMs: NOW_MS })).toBe(true);
  });

  it("fails closed on a missing timestamp", () => {
    expect(isPastRetention({ archivedAt: null, minArchivedDays: 1, nowMs: NOW_MS })).toBe(false);
  });

  it("fails closed on an unparseable timestamp", () => {
    expect(isPastRetention({ archivedAt: "not a date", minArchivedDays: 1, nowMs: NOW_MS })).toBe(
      false,
    );
  });

  it("is inclusive at the boundary", () => {
    // Exactly 14 days before NOW_MS (2026-08-07T00:00:00Z).
    const archivedAt = "2026-07-24T00:00:00.000Z";
    expect(isPastRetention({ archivedAt, minArchivedDays: 14, nowMs: NOW_MS })).toBe(true);
  });

  it("holds one millisecond short of the boundary", () => {
    const archivedAt = "2026-07-24T00:00:00.001Z";
    expect(isPastRetention({ archivedAt, minArchivedDays: 14, nowMs: NOW_MS })).toBe(false);
  });
});

describe("normalizeWorktreePath", () => {
  it("maps blank and whitespace-only paths to null", () => {
    expect(normalizeWorktreePath(null)).toBeNull();
    expect(normalizeWorktreePath("")).toBeNull();
    expect(normalizeWorktreePath("   ")).toBeNull();
  });

  it("trims so both tiers compare the same string", () => {
    expect(normalizeWorktreePath(`  ${WORKTREE}  `)).toBe(WORKTREE);
  });
});
