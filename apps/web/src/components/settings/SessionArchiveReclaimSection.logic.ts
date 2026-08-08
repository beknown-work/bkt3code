/**
 * T3-CUSTOM(expbkt3): Presentation logic for the archived-worktree reclaim panel.
 *
 * Kept out of the component so the interesting decisions — what a selection is
 * allowed to do, what the totals say, how a byte count reads — are testable
 * without rendering anything.
 */
import {
  isForceableBlockedReason,
  type SessionArchiveEntry,
  type SessionArchiveReclaimMode,
  type SessionArchiveScanResult,
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
  /** Selected entries a plain remove refuses but a forced one would take. */
  readonly forceableCount: number;
  /** Entries that would be removed by a forced remove, plain plus forceable. */
  readonly forceRemoveCount: number;
  readonly canForceRemove: boolean;
}

/**
 * What the action buttons should do for the current selection.
 *
 * Blocked entries are counted but never enable a *plain* action: the server
 * re-checks every gate anyway, and offering a button that will certainly be
 * refused reads as a bug rather than as a safeguard. Entries held only by a
 * forceable gate are counted separately, because those the operator can
 * deliberately override.
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

  // Removal has its own gate, so a plain remove is offered only for entries the
  // server evaluated as removable — not merely slimmable.
  const removable = selected.filter(
    (entry) => entry.removeBlockedReason === null && entry.worktreePath !== null,
  );
  const forceable = selected.filter(
    (entry) => isForceableBlockedReason(entry.removeBlockedReason) && entry.worktreePath !== null,
  );

  return {
    selectedCount: selected.length,
    eligibleCount: eligible.length,
    blockedCount: selected.length - eligible.length,
    reclaimableBytes,
    // A slim of an already-slim worktree is a no-op, not an error, so it stays
    // available; removing needs a worktree that is actually still there.
    canSlim: eligible.length > 0,
    canRemove: removable.length > 0,
    forceableCount: forceable.length,
    forceRemoveCount: removable.length + forceable.length,
    canForceRemove: forceable.length > 0,
  };
}

/**
 * Whether any of the three actions would accept this entry.
 *
 * Drives whether its checkbox is usable — an entry nothing can act on is not
 * worth selecting, but one that only a *forced* remove would take still is.
 */
export function isEntryActionable(entry: SessionArchiveEntry): boolean {
  return (
    entry.blockedReason === null ||
    entry.removeBlockedReason === null ||
    isForceableBlockedReason(entry.removeBlockedReason)
  );
}

/**
 * Thread ids a given action would actually be sent for.
 *
 * Returns the branded id straight off the entry so the result can be handed to
 * the RPC without a cast.
 */
export function selectionTargets(
  entries: ReadonlyArray<SessionArchiveEntry>,
  selectedThreadIds: ReadonlySet<string>,
  action: "slim" | "remove" | "force-remove",
): ReadonlyArray<SessionArchiveEntry["threadId"]> {
  return entries
    .filter((entry) => {
      if (!selectedThreadIds.has(entry.threadId)) return false;
      if (action === "slim") return entry.blockedReason === null;
      if (entry.worktreePath === null) return false;
      if (action === "remove") return entry.removeBlockedReason === null;
      // force-remove: cleanly removable, plus those held only by a forceable gate.
      return (
        entry.removeBlockedReason === null || isForceableBlockedReason(entry.removeBlockedReason)
      );
    })
    .map((entry) => entry.threadId);
}

/** How a bulk-select control narrows the list. */
export type SelectionScope =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "reclaimable" }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "state"; readonly state: SessionArchiveEntry["reclaimState"] };

/**
 * Apply a bulk-select scope, returning the new selection.
 *
 * Replaces rather than unions: "select all in project X" reads as a jump to
 * that set, and a control that silently accumulated across presses would make
 * a destructive selection hard to reason about.
 */
export function applySelectionScope(
  entries: ReadonlyArray<SessionArchiveEntry>,
  scope: SelectionScope,
): ReadonlySet<string> {
  if (scope.kind === "none") {
    return new Set();
  }
  const matches = entries.filter((entry) => {
    switch (scope.kind) {
      case "all":
        return true;
      case "reclaimable":
        return entry.blockedReason === null;
      case "project":
        return entry.projectId === scope.projectId;
      case "state":
        return entry.reclaimState === scope.state;
    }
  });
  return new Set(matches.map((entry) => entry.threadId));
}

export interface SelectionGroup {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

/** Distinct projects in the scan, for the "select by project" control. */
export function projectGroups(
  entries: ReadonlyArray<SessionArchiveEntry>,
): ReadonlyArray<SelectionGroup> {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const entry of entries) {
    counts.set(entry.projectId, (counts.get(entry.projectId) ?? 0) + 1);
    // A blank name means an older server that predates the field; the id is a
    // poor label but a working one.
    if (entry.projectName.trim().length > 0) {
      labels.set(entry.projectId, entry.projectName);
    }
  }
  return [...counts.entries()]
    .map(([projectId, count]) => ({
      id: projectId,
      label: labels.get(projectId) ?? projectId,
      count,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

/** Distinct reclaim states in the scan, for the "select by state" control. */
export function stateGroups(
  entries: ReadonlyArray<SessionArchiveEntry>,
): ReadonlyArray<SelectionGroup> {
  const counts = new Map<SessionArchiveEntry["reclaimState"], number>();
  for (const entry of entries) {
    counts.set(entry.reclaimState, (counts.get(entry.reclaimState) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([state, count]) => ({
      id: state,
      label: describeReclaimState({ reclaimState: state } as SessionArchiveEntry),
      count,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
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
