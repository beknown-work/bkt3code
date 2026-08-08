/**
 * T3-CUSTOM(expbkt3): Presentation logic for the archived-worktree reclaim panel.
 *
 * Kept out of the component so the interesting decisions — what a selection is
 * allowed to do, what the totals say, how a byte count reads — are testable
 * without rendering anything.
 */
import type {
  SessionArchiveEntry,
  SessionArchiveReclaimMode,
  SessionArchiveScanResult,
} from "@t3tools/contracts";

/** Human-readable byte count. Null sizes render as an explicit unknown. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "size unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // One decimal below 10 keeps "1.4 GB" informative without "1.437 GB" noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

export interface EntrySelectionSummary {
  readonly selectedCount: number;
  readonly eligibleCount: number;
  readonly blockedCount: number;
  readonly reclaimableBytes: number;
  readonly canSlim: boolean;
  readonly canRemove: boolean;
}

/**
 * What the action buttons should do for the current selection.
 *
 * Blocked entries are counted but never enable an action: the server re-checks
 * every gate anyway, and offering a button that will certainly be refused
 * reads as a bug rather than as a safeguard.
 */
export function summarizeSelection(
  entries: ReadonlyArray<SessionArchiveEntry>,
  selectedThreadIds: ReadonlySet<string>,
): EntrySelectionSummary {
  const selected = entries.filter((entry) => selectedThreadIds.has(entry.threadId));
  const eligible = selected.filter((entry) => entry.blockedReason === null);
  const reclaimableBytes = eligible.reduce(
    (total, entry) => total + (entry.reclaimableBytes ?? 0),
    0,
  );
  const hasWorktree = eligible.some((entry) => entry.worktreePath !== null);

  return {
    selectedCount: selected.length,
    eligibleCount: eligible.length,
    blockedCount: selected.length - eligible.length,
    reclaimableBytes,
    // A slim of an already-slim worktree is a no-op, not an error, so it stays
    // available; removing needs a worktree that is actually still there.
    canSlim: eligible.length > 0,
    canRemove: eligible.length > 0 && hasWorktree,
  };
}

/** Entries worth showing first: biggest reclaim, then biggest worktree. */
export function sortEntriesForDisplay(
  entries: ReadonlyArray<SessionArchiveEntry>,
): ReadonlyArray<SessionArchiveEntry> {
  return [...entries].sort((left, right) => {
    const leftReclaim = left.reclaimableBytes ?? -1;
    const rightReclaim = right.reclaimableBytes ?? -1;
    if (leftReclaim !== rightReclaim) {
      return rightReclaim - leftReclaim;
    }
    const leftSize = left.worktreeBytes ?? -1;
    const rightSize = right.worktreeBytes ?? -1;
    if (leftSize !== rightSize) {
      return rightSize - leftSize;
    }
    return (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "");
  });
}

/** Short badge text for an entry's current state. */
export function describeReclaimState(entry: SessionArchiveEntry): string {
  switch (entry.reclaimState) {
    case "present":
      return "Worktree on disk";
    case "slimmed":
      return "Already slim";
    case "removed":
      return "Worktree removed";
    case "missing":
      return "Worktree missing";
  }
}

/** One line summarising a completed reclaim, for the toast. */
export function describeReclaimResult(input: {
  readonly mode: SessionArchiveReclaimMode;
  readonly reclaimedCount: number;
  readonly skippedCount: number;
  readonly freedBytes: number;
}): string {
  const verb = input.mode === "slim" ? "Slimmed" : "Removed";
  const parts = [`${verb} ${input.reclaimedCount} session${input.reclaimedCount === 1 ? "" : "s"}`];
  if (input.freedBytes > 0) {
    parts.push(`freed ${formatBytes(input.freedBytes)}`);
  }
  if (input.skippedCount > 0) {
    parts.push(`${input.skippedCount} skipped`);
  }
  return `${parts.join(", ")}.`;
}

/** Header line above the list. */
export function describeScanSummary(result: SessionArchiveScanResult): string {
  const eligible = result.entries.filter((entry) => entry.blockedReason === null).length;
  const parts = [
    `${result.entries.length} archived session${result.entries.length === 1 ? "" : "s"}`,
    `${eligible} reclaimable`,
    `${formatBytes(result.totalReclaimableBytes)} to free`,
  ];
  if (result.orphanedWorktrees.length > 0) {
    parts.push(`${result.orphanedWorktrees.length} orphaned worktrees`);
  }
  if (result.sizingIncomplete) {
    parts.push("some sizes not measured");
  }
  return parts.join(" · ");
}
