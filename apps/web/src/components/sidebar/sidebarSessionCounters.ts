/**
 * T3-CUSTOM(expbkt3): Pure lifecycle aggregation used by the experimental
 * wordmark counters and kept separate from upstream sidebar grouping.
 */
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import type { ThreadShell } from "../../types";

export interface SidebarSessionCounts {
  readonly nonRunning: number;
  readonly running: number;
  readonly nextSnoozeWakeAt: string | null;
}

export interface SidebarSessionCountOptions {
  readonly now: string;
  readonly snoozeSupported: (thread: ThreadShell) => boolean;
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
    thread.session?.status === "running" ||
    thread.backgroundLiveness === "working" ||
    thread.backgroundLiveness === "monitoring"
  );
}

export function summarizeSidebarSessions(
  threads: ReadonlyArray<ThreadShell>,
  options: SidebarSessionCountOptions,
): SidebarSessionCounts {
  let nonRunning = 0;
  let running = 0;
  let nextSnoozeWakeAt: string | null = null;
  let nextSnoozeWakeAtMs = Number.POSITIVE_INFINITY;

  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.settledAt !== null) continue;
    if (threadIsRunning(thread)) {
      running += 1;
      continue;
    }
    if (options.snoozeSupported(thread) && effectiveSnoozed(thread, { now: options.now })) {
      const wakeAtMs = Date.parse(thread.snoozedUntil ?? "");
      if (wakeAtMs < nextSnoozeWakeAtMs) {
        nextSnoozeWakeAt = thread.snoozedUntil ?? null;
        nextSnoozeWakeAtMs = wakeAtMs;
      }
      continue;
    }
    nonRunning += 1;
  }

  return { nonRunning, running, nextSnoozeWakeAt };
}
