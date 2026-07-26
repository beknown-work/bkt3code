import type { ThreadShell } from "../../types";

export interface SidebarSessionCounts {
  readonly attention: number;
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
  let attention = 0;
  let running = 0;

  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    if (threadNeedsHumanAttention(thread)) attention += 1;
    if (threadIsRunning(thread)) running += 1;
  }

  return { attention, running };
}
