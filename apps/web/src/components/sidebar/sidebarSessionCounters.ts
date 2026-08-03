/**
 * T3-CUSTOM(expbkt3): Pure lifecycle aggregation used by the experimental
 * wordmark counters and kept separate from upstream sidebar grouping.
 */
import type { ThreadShell } from "../../types";

export interface SidebarSessionCounts {
  readonly nonRunning: number;
  readonly running: number;
}

export function threadNeedsHumanAttention(thread: ThreadShell): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.execution?.turn?.state === "waiting-for-approval" ||
    thread.execution?.turn?.state === "waiting-for-input" ||
    thread.execution?.activity === "failed" ||
    thread.session?.status === "error"
  );
}

export function threadIsRunning(thread: ThreadShell): boolean {
  return (
    thread.execution?.activity === "active" ||
    thread.execution?.activity === "blocked" ||
    thread.execution?.activity === "stopping" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  );
}

export function summarizeSidebarSessions(
  threads: ReadonlyArray<ThreadShell>,
): SidebarSessionCounts {
  let nonRunning = 0;
  let running = 0;

  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.settledAt !== null) continue;
    if (threadIsRunning(thread)) {
      running += 1;
    } else {
      nonRunning += 1;
    }
  }

  return { nonRunning, running };
}
