/**
 * T3-CUSTOM(expbkt3): Reclaim disk from archived sessions' worktrees.
 *
 * Upstream removes a worktree only when a thread is *deleted*, so archived
 * worktrees accumulate until the only way to free the disk is to destroy the
 * history. This panel offers the middle path: every action exports the
 * session's history first, then either slims the worktree (deleting only what a
 * package manager can rebuild) or removes it outright.
 *
 * The scan is behind a button rather than run on mount because it walks the
 * filesystem — on a busy host that is seconds of IO nobody asked for.
 */
import type { EnvironmentId, SessionArchiveScanResult } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { HardDriveIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { sessionArchiveEnvironment } from "../../state/sessionArchive";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  describeReclaimResult,
  describeReclaimState,
  describeScanSummary,
  formatBytes,
  sortEntriesForDisplay,
  summarizeSelection,
} from "./SessionArchiveReclaimSection.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Entries rendered before the list is truncated. */
const VISIBLE_ENTRY_LIMIT = 25;

export function SessionArchiveReclaimSection({
  environmentIds,
  onReclaimed,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly onReclaimed: () => void;
}) {
  const [scanResult, setScanResult] = useState<SessionArchiveScanResult | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<ReadonlySet<string>>(new Set());
  const [isBusy, setIsBusy] = useState(false);
  const [showOrphans, setShowOrphans] = useState(false);

  const scan = useAtomCommand(sessionArchiveEnvironment.scan, {
    label: "session archive scan",
  });
  const reclaim = useAtomCommand(sessionArchiveEnvironment.reclaim, {
    label: "session archive reclaim",
  });

  // The panel is single-environment on purpose: reclaim is a disk operation on
  // the machine hosting that server, and mixing hosts in one list would make
  // "3.6 GB to free" mean nothing in particular.
  const environmentId = environmentIds[0] ?? null;

  const entries = useMemo(
    () => (scanResult === null ? [] : sortEntriesForDisplay(scanResult.entries)),
    [scanResult],
  );
  const selection = useMemo(
    () => summarizeSelection(entries, selectedThreadIds),
    [entries, selectedThreadIds],
  );

  const reportFailure = useCallback((title: string, result: unknown) => {
    if (isAtomCommandInterrupted(result as never)) {
      return;
    }
    const error = squashAtomCommandFailure(result as never);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  const runScan = useCallback(async () => {
    if (environmentId === null) {
      return;
    }
    setIsBusy(true);
    const result = await scan({ environmentId, input: {} });
    setIsBusy(false);
    if (result._tag === "Success") {
      setScanResult(result.value);
      // A stale selection would point at threads the new scan may not contain.
      setSelectedThreadIds(new Set());
      return;
    }
    reportFailure("Could not scan archived sessions", result);
  }, [environmentId, reportFailure, scan]);

  const runReclaim = useCallback(
    async (mode: "slim" | "remove") => {
      if (environmentId === null || selection.eligibleCount === 0) {
        return;
      }
      const eligibleIds = entries
        .filter((entry) => selectedThreadIds.has(entry.threadId) && entry.blockedReason === null)
        .map((entry) => entry.threadId);

      const confirmed = globalThis.confirm(
        mode === "slim"
          ? `Delete regenerable directories (node_modules, build output, caches) from ${eligibleIds.length} session worktree(s)?\n\nEach session's history is exported first. The checkouts and branches stay intact.`
          : `Remove ${eligibleIds.length} session worktree(s) entirely?\n\nEach session's history is exported first. Reopening one of these sessions will have to re-create its worktree.`,
      );
      if (!confirmed) {
        return;
      }

      setIsBusy(true);
      const result = await reclaim({
        environmentId,
        input: { threadIds: eligibleIds, mode, force: false },
      });
      setIsBusy(false);

      if (result._tag !== "Success") {
        reportFailure("Reclaim failed", result);
        return;
      }

      const reclaimedCount = result.value.outcomes.filter((outcome) => outcome.reclaimed).length;
      const skipped = result.value.outcomes.filter((outcome) => !outcome.reclaimed);
      toastManager.add(
        stackedThreadToast({
          type: skipped.length > 0 && reclaimedCount === 0 ? "error" : "success",
          title: "Archived sessions reclaimed",
          description: [
            describeReclaimResult({
              mode,
              reclaimedCount,
              skippedCount: skipped.length,
              freedBytes: result.value.totalFreedBytes,
            }),
            // The first skip reason is far more useful than a count alone.
            skipped[0]?.skippedReason ?? "",
          ]
            .filter(Boolean)
            .join(" "),
        }),
      );

      onReclaimed();
      await runScan();
    },
    [
      entries,
      environmentId,
      onReclaimed,
      reclaim,
      reportFailure,
      runScan,
      selectedThreadIds,
      selection.eligibleCount,
    ],
  );

  const toggleEntry = useCallback((threadId: string) => {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  const selectAllEligible = useCallback(() => {
    setSelectedThreadIds((current) => {
      const eligible = entries.filter((entry) => entry.blockedReason === null);
      // Second press clears, so the control works as a toggle.
      if (eligible.every((entry) => current.has(entry.threadId)) && current.size > 0) {
        return new Set();
      }
      return new Set(eligible.map((entry) => entry.threadId));
    });
  }, [entries]);

  if (environmentId === null) {
    return null;
  }

  const visibleEntries = entries.slice(0, VISIBLE_ENTRY_LIMIT);

  return (
    <SettingsSection
      title="Worktree disk"
      headerAction={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
          disabled={isBusy}
          onClick={() => void runScan()}
        >
          {isBusy ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          <span>{scanResult === null ? "Scan" : "Rescan"}</span>
        </Button>
      }
    >
      {scanResult === null ? (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <HardDriveIcon className="size-3.5 text-muted-foreground" />
              Reclaim disk from archived sessions
            </span>
          }
          description="Archived sessions keep their worktree on disk indefinitely. Scanning measures what each one still occupies and what can be given back. Every reclaim exports the session's history first, so nothing you did is lost."
        />
      ) : (
        <>
          <SettingsRow
            title="Scan results"
            description={describeScanSummary(scanResult)}
            status={`History is written to ${scanResult.historyDir}`}
            control={
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  onClick={selectAllEligible}
                  disabled={isBusy || entries.length === 0}
                >
                  Select reclaimable
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  disabled={isBusy || !selection.canSlim}
                  onClick={() => void runReclaim("slim")}
                >
                  Slim ({formatBytes(selection.reclaimableBytes)})
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="h-7 cursor-pointer px-2.5"
                  disabled={isBusy || !selection.canRemove}
                  onClick={() => void runReclaim("remove")}
                >
                  Remove worktree
                </Button>
              </div>
            }
          />

          {visibleEntries.map((entry) => (
            <SettingsRow
              key={entry.threadId}
              title={
                <span className="inline-flex items-center gap-2">
                  <Checkbox
                    checked={selectedThreadIds.has(entry.threadId)}
                    disabled={isBusy || entry.blockedReason !== null}
                    onCheckedChange={() => toggleEntry(entry.threadId)}
                    aria-label={`Select ${entry.title}`}
                  />
                  <span className="truncate">{entry.title}</span>
                </span>
              }
              description={
                <>
                  {formatBytes(entry.worktreeBytes)} on disk
                  {entry.reclaimableBytes !== null && entry.reclaimableBytes > 0
                    ? ` · ${formatBytes(entry.reclaimableBytes)} reclaimable`
                    : ""}
                  {entry.branch ? ` · ${entry.branch}` : ""}
                </>
              }
              status={
                entry.blockedReason === null
                  ? describeReclaimState(entry)
                  : blockedText(entry.blockedReason)
              }
              control={
                <Badge
                  variant={entry.blockedReason === null ? "success" : "warning"}
                  className="shrink-0"
                >
                  {entry.blockedReason === null ? "Reclaimable" : "Held"}
                </Badge>
              }
            />
          ))}

          {entries.length > VISIBLE_ENTRY_LIMIT ? (
            <SettingsRow
              title={`${entries.length - VISIBLE_ENTRY_LIMIT} more archived sessions`}
              description="Only the largest are listed. Reclaim these, then rescan to see the rest."
            />
          ) : null}

          {scanResult.orphanedWorktrees.length > 0 ? (
            <SettingsRow
              title={`${scanResult.orphanedWorktrees.length} orphaned worktrees`}
              description="Worktree directories on disk that no session points at. They are never reclaimed automatically, because nothing in the database can say what is safe about them — inspect and remove these by hand."
              status={
                showOrphans
                  ? scanResult.orphanedWorktrees
                      .slice(0, 10)
                      .map((orphan) => orphan.worktreePath)
                      .join("\n")
                  : undefined
              }
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer px-2.5"
                  onClick={() => setShowOrphans((current) => !current)}
                >
                  {showOrphans ? "Hide paths" : "Show paths"}
                </Button>
              }
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

/** Mirrors the server's `describeBlockedReason`, phrased for this list. */
function blockedText(reason: string): string {
  switch (reason) {
    case "worktree-shared":
      return "Held — another active session uses this worktree.";
    case "worktree-live":
      return "Held — a session is running out of this worktree.";
    case "dirty-worktree":
      return "Held — uncommitted or untracked changes.";
    case "unpushed-commits":
      return "Held — commits are not on any remote.";
    case "retention-window":
      return "Held — archived too recently.";
    case "no-worktree":
      return "Nothing on disk to reclaim.";
    default:
      return "Held.";
  }
}
