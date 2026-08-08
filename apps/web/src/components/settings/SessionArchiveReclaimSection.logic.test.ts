/**
 * T3-CUSTOM(expbkt3): Coverage for the reclaim panel's presentation logic.
 *
 * The selection summary is what enables the destructive buttons, so it gets the
 * most attention here — a blocked entry must never make one clickable.
 */
import {
  ThreadId,
  type SessionArchiveEntry,
  type SessionArchiveScanResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeReclaimResult,
  describeReclaimState,
  describeScanSummary,
  formatBytes,
  sortEntriesForDisplay,
  summarizeSelection,
} from "./SessionArchiveReclaimSection.logic";

const entry = (overrides: Partial<SessionArchiveEntry> = {}): SessionArchiveEntry =>
  ({
    threadId: ThreadId.make("thread_1"),
    projectId: "project_1",
    title: "A session",
    branch: "feature",
    worktreePath: "/worktrees/proj/feature",
    archivedAt: "2026-07-01T00:00:00.000Z",
    worktreeBytes: 1_000_000,
    reclaimableBytes: 800_000,
    reclaimState: "present",
    blockedReason: null,
    historyPath: null,
    ...overrides,
  }) as SessionArchiveEntry;

describe("formatBytes", () => {
  it("reports a null size as unknown rather than zero", () => {
    expect(formatBytes(null)).toBe("size unknown");
  });

  it("keeps small counts in bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("uses one decimal below ten and none above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024)).toBe("50 KB");
  });

  it("scales into gigabytes", () => {
    expect(formatBytes(3.6 * 1024 ** 3)).toBe("3.6 GB");
  });
});

describe("summarizeSelection", () => {
  it("counts only selected entries", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a") }),
      entry({ threadId: ThreadId.make("b") }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.selectedCount).toBe(1);
    expect(summary.reclaimableBytes).toBe(800_000);
  });

  it("never enables an action for a blocked entry", () => {
    const entries = [entry({ threadId: ThreadId.make("a"), blockedReason: "worktree-live" })];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.blockedCount).toBe(1);
    expect(summary.canSlim).toBe(false);
    expect(summary.canRemove).toBe(false);
  });

  it("excludes a blocked entry's bytes from the total", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a"), reclaimableBytes: 100 }),
      entry({
        threadId: ThreadId.make("b"),
        blockedReason: "worktree-shared",
        reclaimableBytes: 900,
      }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a"), ThreadId.make("b")]));
    expect(summary.reclaimableBytes).toBe(100);
    expect(summary.eligibleCount).toBe(1);
  });

  it("keeps slim available for an already-slim worktree", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a"), reclaimState: "slimmed", reclaimableBytes: 0 }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.canSlim).toBe(true);
  });

  it("disables remove when nothing selected still has a worktree", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a"), worktreePath: null, reclaimState: "removed" }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.canRemove).toBe(false);
  });

  it("reports an empty selection as doing nothing", () => {
    const summary = summarizeSelection([entry()], new Set());
    expect(summary).toMatchObject({ selectedCount: 0, canSlim: false, canRemove: false });
  });
});

describe("sortEntriesForDisplay", () => {
  it("puts the biggest reclaim first", () => {
    const sorted = sortEntriesForDisplay([
      entry({ threadId: ThreadId.make("small"), reclaimableBytes: 10 }),
      entry({ threadId: ThreadId.make("big"), reclaimableBytes: 1000 }),
    ]);
    expect(sorted[0]?.threadId).toBe("big");
  });

  it("sorts unmeasured entries last", () => {
    const sorted = sortEntriesForDisplay([
      entry({ threadId: ThreadId.make("unknown"), reclaimableBytes: null, worktreeBytes: null }),
      entry({ threadId: ThreadId.make("known"), reclaimableBytes: 0, worktreeBytes: 0 }),
    ]);
    expect(sorted[0]?.threadId).toBe("known");
  });
});

describe("describeReclaimState", () => {
  it("names each state", () => {
    expect(describeReclaimState(entry({ reclaimState: "present" }))).toBe("Worktree on disk");
    expect(describeReclaimState(entry({ reclaimState: "slimmed" }))).toBe("Already slim");
    expect(describeReclaimState(entry({ reclaimState: "removed" }))).toBe("Worktree removed");
    expect(describeReclaimState(entry({ reclaimState: "missing" }))).toBe("Worktree missing");
  });
});

describe("describeReclaimResult", () => {
  it("reports what was freed", () => {
    expect(
      describeReclaimResult({
        mode: "slim",
        reclaimedCount: 3,
        skippedCount: 0,
        freedBytes: 2 * 1024 ** 3,
      }),
    ).toBe("Slimmed 3 sessions, freed 2.0 GB.");
  });

  it("mentions skipped sessions", () => {
    expect(
      describeReclaimResult({ mode: "remove", reclaimedCount: 1, skippedCount: 2, freedBytes: 0 }),
    ).toBe("Removed 1 session, 2 skipped.");
  });
});

describe("describeScanSummary", () => {
  it("summarizes the scan in one line", () => {
    const result = {
      scannedAt: "2026-08-07T00:00:00.000Z",
      entries: [
        entry({ threadId: ThreadId.make("a") }),
        entry({ threadId: ThreadId.make("b"), blockedReason: "worktree-live" }),
      ],
      orphanedWorktrees: [{ worktreePath: "/x", sizeBytes: null, lastModifiedAt: null }],
      totalReclaimableBytes: 800_000,
      historyDir: "/history",
      sizingIncomplete: true,
    } as SessionArchiveScanResult;
    const summary = describeScanSummary(result);
    expect(summary).toContain("2 archived sessions");
    expect(summary).toContain("1 reclaimable");
    expect(summary).toContain("1 orphaned worktrees");
    expect(summary).toContain("some sizes not measured");
  });
});
