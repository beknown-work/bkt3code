import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { UserId, VcsStatusResult } from "@t3tools/contracts";
import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "@t3tools/client-runtime/state/thread-settled";
// T3-CUSTOM(expbkt3): memorable worktree codenames.
import {
  disambiguateWorktreeCodenames,
  resolveWorktreeCodename,
  worktreeCodenameToneIndex,
} from "@t3tools/shared/worktreeCodename";

import { deriveLogicalProjectKey } from "../../logicalProject";
import type { Project, ThreadShell } from "../../types";
import { getThreadSortTimestamp } from "../../lib/threadSort";
import { cn } from "../../lib/utils";
import { resolveSettledTimestamp } from "../Sidebar.logic";

export const PHASE_SIDEBAR_PHASE_IDS = [
  "needs_input",
  "plan_ready",
  "ready",
  "planning",
  "implementing",
] as const;

export type PhaseSidebarPhaseId = (typeof PHASE_SIDEBAR_PHASE_IDS)[number];

export interface PhaseSidebarCheckoutMetadata {
  readonly kind: "current" | "worktree";
  readonly label: string;
  readonly tooltip: string;
  /**
   * Color bucket for the codename, or `null` for a current checkout. Consumers
   * map this through a static class table — see `PHASE_SIDEBAR_CHECKOUT_TONES`.
   */
  readonly toneIndex: number | null;
}

/**
 * T3-CUSTOM(expbkt3): Other threads sharing this thread's worktree. Two agents
 * editing one directory at the same time is a real hazard, and without this it
 * is invisible.
 */
export interface PhaseSidebarWorktreeSharing {
  /** Threads occupying the worktree. Always >= 2 when present. */
  readonly count: number;
  /**
   * Pre-joined thread titles for the tooltip. A string rather than an array so
   * it can cross the memo'd row boundary as a prop without defeating the memo.
   */
  readonly summary: string;
}

/**
 * T3-CUSTOM(expbkt3): Keep checkout semantics explicit in the experimental
 * sidebar. Current checkouts show their live branch; dedicated worktrees show
 * their codename — a short, memorable name derived from the worktree path, so
 * that two rows in the same worktree read identically and two rows in different
 * worktrees read differently at a glance. The ref the worktree was created from
 * moves into the tooltip, which is where it was actually being read anyway.
 */
export function resolvePhaseSidebarCheckoutMetadata(
  thread: Pick<ThreadShell, "branch" | "worktreePath">,
  vcsStatus: Pick<VcsStatusResult, "refName" | "baseRef" | "pr"> | null | undefined,
  options?: {
    /** Label from `disambiguateWorktreeCodenames`, when the view resolved one. */
    readonly codename?: string | null;
    readonly sharing?: PhaseSidebarWorktreeSharing | null;
  },
): PhaseSidebarCheckoutMetadata {
  if (thread.worktreePath) {
    const baseRef = vcsStatus?.pr?.baseRef ?? vcsStatus?.baseRef ?? null;
    const codename = options?.codename ?? resolveWorktreeCodename(thread.worktreePath);
    const sharing = options?.sharing ?? null;

    const tooltipParts = [`Worktree ${codename}`];
    if (baseRef) tooltipParts.push(`from ${baseRef}`);
    tooltipParts.push(thread.worktreePath);
    if (sharing) {
      tooltipParts.push(`Shared by ${sharing.count} threads: ${sharing.summary}`);
    }

    return {
      kind: "worktree",
      label: sharing ? `${codename} ×${sharing.count}` : codename,
      tooltip: tooltipParts.join(" · "),
      toneIndex: worktreeCodenameToneIndex(codename),
    };
  }

  const branch = vcsStatus?.refName ?? thread.branch;
  return {
    kind: "current",
    label: branch ?? "Current checkout",
    tooltip: branch ? `Current checkout on ${branch}` : "Current checkout",
    toneIndex: null,
  };
}

/**
 * T3-CUSTOM(expbkt3): Static tone table for worktree codenames. Tailwind scans
 * source for literal class names, so these cannot be interpolated hues.
 */
export const PHASE_SIDEBAR_CHECKOUT_TONES: readonly string[] = [
  "text-rose-600 dark:text-rose-300/90",
  "text-orange-600 dark:text-orange-300/90",
  "text-amber-600 dark:text-amber-300/90",
  "text-lime-600 dark:text-lime-300/90",
  "text-emerald-600 dark:text-emerald-300/90",
  "text-teal-600 dark:text-teal-300/90",
  "text-cyan-600 dark:text-cyan-300/90",
  "text-sky-600 dark:text-sky-300/90",
  "text-indigo-600 dark:text-indigo-300/90",
  "text-violet-600 dark:text-violet-300/90",
  "text-fuchsia-600 dark:text-fuchsia-300/90",
  "text-pink-600 dark:text-pink-300/90",
];

export function phaseSidebarCheckoutToneClassName(toneIndex: number | null): string {
  if (toneIndex === null) return "";
  return PHASE_SIDEBAR_CHECKOUT_TONES[toneIndex % PHASE_SIDEBAR_CHECKOUT_TONES.length] ?? "";
}

/**
 * T3-CUSTOM(expbkt3): Codename label and shared-worktree state for every thread
 * on screen, resolved together because both answers depend on the whole visible
 * set: codenames disambiguate against each other, and sharing is a count across
 * rows. Archived threads do not participate — the rest of the UI hides them, so
 * they must not inflate a worktree's occupancy.
 */
export interface PhaseSidebarWorktreeView {
  readonly codenameByPath: ReadonlyMap<string, string>;
  readonly sharingByPath: ReadonlyMap<string, PhaseSidebarWorktreeSharing>;
}

export function resolvePhaseSidebarWorktreeView(
  threads: ReadonlyArray<Pick<ThreadShell, "title" | "worktreePath" | "archivedAt">>,
): PhaseSidebarWorktreeView {
  const titlesByPath = new Map<string, string[]>();
  for (const thread of threads) {
    const worktreePath = thread.worktreePath?.trim();
    if (!worktreePath || thread.archivedAt != null) continue;
    titlesByPath.set(worktreePath, [...(titlesByPath.get(worktreePath) ?? []), thread.title]);
  }

  const sharingByPath = new Map<string, PhaseSidebarWorktreeSharing>();
  for (const [worktreePath, titles] of titlesByPath) {
    if (titles.length < 2) continue;
    sharingByPath.set(worktreePath, { count: titles.length, summary: titles.join(", ") });
  }

  return {
    codenameByPath: disambiguateWorktreeCodenames([...titlesByPath.keys()]),
    sharingByPath,
  };
}

/**
 * T3-CUSTOM(expbkt3): Flatten one thread's worktree state into primitives. The
 * row is memo'd and the sidebar re-renders on every shell event, so the props
 * crossing that boundary have to compare by value.
 */
export interface PhaseSidebarWorktreeRowProps {
  readonly worktreeCodename: string | null;
  /** 0 when the worktree is not shared. */
  readonly worktreeSharedCount: number;
  readonly worktreeSharedSummary: string | null;
}

export function phaseSidebarWorktreeRowProps(
  view: PhaseSidebarWorktreeView,
  worktreePath: string | null,
): PhaseSidebarWorktreeRowProps {
  const path = worktreePath?.trim();
  if (!path) {
    return { worktreeCodename: null, worktreeSharedCount: 0, worktreeSharedSummary: null };
  }
  const sharing = view.sharingByPath.get(path) ?? null;
  return {
    // An archived thread is absent from the view but still renders on the
    // shelf, so fall back to deriving its codename directly.
    worktreeCodename: view.codenameByPath.get(path) ?? resolveWorktreeCodename(path),
    worktreeSharedCount: sharing?.count ?? 0,
    worktreeSharedSummary: sharing?.summary ?? null,
  };
}

export interface PhaseSidebarPhaseDefinition {
  readonly id: PhaseSidebarPhaseId;
  readonly label: string;
  readonly helperText: string;
}

export const PHASE_SIDEBAR_PHASES: ReadonlyArray<PhaseSidebarPhaseDefinition> = [
  {
    id: "needs_input",
    label: "Needs Input",
    helperText: "Agent is waiting for your answer",
  },
  { id: "plan_ready", label: "Plan Ready", helperText: "Planning session is stopped" },
  { id: "ready", label: "Ready", helperText: "No active agent work" },
  { id: "planning", label: "Planning", helperText: "Agent is preparing a plan" },
  { id: "implementing", label: "Implementing", helperText: "Agent is changing code" },
];

/**
 * Theme-aware lifecycle header surfaces. The hue is intentionally restrained:
 * headers should make the groups scannable without competing with urgent row
 * badges or the selected-thread treatment.
 */
export function phaseSidebarGroupHeaderClassName(phaseId: PhaseSidebarPhaseId): string {
  const tone = {
    needs_input:
      "border-red-500/20 bg-red-500/8 text-red-700 dark:border-red-400/20 dark:bg-red-400/8 dark:text-red-300",
    plan_ready:
      "border-violet-500/20 bg-violet-500/9 text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/9 dark:text-violet-300",
    ready:
      "border-emerald-500/16 bg-emerald-500/7 text-emerald-700 dark:border-emerald-400/16 dark:bg-emerald-400/7 dark:text-emerald-300",
    planning:
      "border-indigo-500/18 bg-indigo-500/8 text-indigo-700 dark:border-indigo-400/18 dark:bg-indigo-400/8 dark:text-indigo-300",
    implementing:
      "border-sky-500/18 bg-sky-500/8 text-sky-700 dark:border-sky-400/18 dark:bg-sky-400/8 dark:text-sky-300",
  } satisfies Record<PhaseSidebarPhaseId, string>;

  return cn(
    "mb-1.5 flex min-h-7 items-center gap-2 rounded-md border px-2 py-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.025)]",
    tone[phaseId],
  );
}

export interface PhaseSidebarWorkBadge {
  readonly label: string;
  readonly monitoring: boolean;
}

/**
 * Mirror Sidebar V2's execution precedence in the experimental sidebar.
 * Foreground execution keeps its provider label (for example, Running),
 * background agent fleets read as Working, and only watch loops read as
 * Monitoring. Monitoring is steady and therefore does not trigger row
 * shimmer. Plan Ready remains actionable and outranks lingering background
 * liveness.
 */
export function resolvePhaseSidebarWorkBadge(input: {
  readonly phaseId: PhaseSidebarPhaseId;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
  readonly executionPresentation: {
    readonly active: boolean;
    readonly label: string | null;
  };
}): PhaseSidebarWorkBadge | null {
  if (input.executionPresentation.active && input.executionPresentation.label !== null) {
    return { label: input.executionPresentation.label, monitoring: false };
  }

  if (input.phaseId === "plan_ready") return null;

  if (input.backgroundLiveness === "working") {
    return { label: "Working", monitoring: false };
  }

  if (input.backgroundLiveness === "monitoring") {
    return { label: "Monitoring", monitoring: true };
  }

  return null;
}

const PHASE_ID_SET = new Set<string>(PHASE_SIDEBAR_PHASE_IDS);
const LINEAR_BRANCH_PATTERN = /^linear\/([a-z][a-z0-9]*-\d+)(?:-|$)/i;
const LINEAR_ISSUE_URL_PATTERN =
  /^https:\/\/linear\.app\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i;

export interface PhaseSidebarLinearIssue {
  readonly identifier: string;
  readonly url: string;
}

export function resolvePhaseSidebarLinearIssue(
  branch: string | null,
  manualUrl?: string | null,
): PhaseSidebarLinearIssue | null {
  const trimmedManualUrl = manualUrl?.trim();
  if (trimmedManualUrl) {
    const match = LINEAR_ISSUE_URL_PATTERN.exec(trimmedManualUrl);
    const workspace = match?.[1];
    const identifier = match?.[2]?.toUpperCase();
    if (workspace && identifier) {
      return {
        identifier,
        url: `https://linear.app/${workspace}/issue/${identifier}`,
      };
    }
  }
  if (branch === null) return null;
  const identifier = LINEAR_BRANCH_PATTERN.exec(branch)?.[1]?.toUpperCase();
  if (!identifier) return null;
  return {
    identifier,
    url: `https://linear.app/beknown/issue/${identifier}`,
  };
}

/** T3-CUSTOM(expbkt3): compact sidebar timestamps, including zero minutes. */
export function compactPhaseSidebarTimeLabel(label: string): string {
  return label === "just now" ? "0m" : label.replace(" ago", "");
}

export interface PhaseSidebarFilters {
  readonly repositoryKeys: ReadonlyArray<string>;
  readonly phaseIds: ReadonlyArray<PhaseSidebarPhaseId>;
  readonly providerKinds: ReadonlyArray<string>;
  /**
   * T3-CUSTOM(expbkt3): sessions this operator started.
   *
   * NOT "owner or tagged": that is the server's own visibility rule, so every
   * thread you can see already satisfies it and the filter selected everything.
   * Ownership is the distinction that means something — my sessions versus the
   * ones I was pulled into.
   */
  readonly ownedByMe: boolean;
  /**
   * T3-CUSTOM(expbkt3): show only sessions ALL of these people are on. Anyone
   * listed here is a co-participant on threads you can already see, since
   * visibility never widens — the filter narrows to shared work.
   */
  readonly participantUserIds: ReadonlyArray<string>;
}

export const EMPTY_PHASE_SIDEBAR_FILTERS: PhaseSidebarFilters = {
  repositoryKeys: [],
  phaseIds: [],
  providerKinds: [],
  ownedByMe: false,
  participantUserIds: [],
};

/** T3-CUSTOM(expbkt3): everyone on a thread, owner included. */
export function phaseSidebarThreadParticipantIds(
  thread: Pick<ThreadShell, "ownerUserId" | "memberUserIds">,
): ReadonlyArray<string> {
  return thread.ownerUserId === null
    ? thread.memberUserIds
    : [thread.ownerUserId, ...thread.memberUserIds.filter((id) => id !== thread.ownerUserId)];
}

/**
 * "Assigned to me" = owned by, or directly tagged on, the thread. A thread made
 * visible only by a project tag is not "assigned" (matches the server rule).
 */
export function isThreadAssignedToUser(
  thread: Pick<ThreadShell, "ownerUserId" | "memberUserIds">,
  userId: UserId,
): boolean {
  return thread.ownerUserId === userId || thread.memberUserIds.includes(userId);
}

export interface PhaseSidebarRow {
  readonly thread: ThreadShell;
  readonly phaseId: PhaseSidebarPhaseId;
  readonly repositoryKey: string;
  readonly repositoryLabel: string;
  readonly providerKind: string;
  readonly providerName: string;
  readonly isAssignedToMe: boolean;
  // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant facets.
  readonly isOwnedByMe: boolean;
  readonly participantUserIds: ReadonlyArray<string>;
  // T3-CUSTOM(expbkt3): END
  readonly attentionPriority: number;
  readonly isUnreadCompletion: boolean;
  /** False on environments whose server predates thread.settle/unsettle:
      the row can never be classified settled (the user could not undo it)
      and its lifecycle affordances stay hidden. */
  readonly settlementSupported: boolean;
  /** Same version-skew contract for thread.snooze/unsnooze. */
  readonly snoozeSupported: boolean;
  /** Same version-skew contract for priority on thread.meta.update. */
  readonly prioritySupported: boolean;
  /** Same version-skew contract for manual Linear tags on thread.meta.update. */
  readonly linearIssueSupported?: boolean;
  /** The row's pull-request state, when its VCS probe has reported one: a
      merged or closed change request auto-settles an idle thread. */
  readonly changeRequestState: ChangeRequestStateLike | null;
}

/**
 * T3-CUSTOM(expbkt3): Where a row renders in the experimental sidebar —
 * inside its lifecycle group, or parked on one of the two shelves below
 * them.
 */
export type PhaseSidebarSection = "active" | "snoozed" | "settled";

export interface PhaseSidebarPartition {
  readonly activeRows: ReadonlyArray<PhaseSidebarRow>;
  readonly snoozedRows: ReadonlyArray<PhaseSidebarRow>;
  readonly settledRows: ReadonlyArray<PhaseSidebarRow>;
}

function snoozeWakeMs(row: PhaseSidebarRow): number {
  const parsed = Date.parse(row.thread.snoozedUntil ?? "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** Soonest wake first: the shelf reads as a queue of what comes back next. */
export function sortSnoozedPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
): ReadonlyArray<PhaseSidebarRow> {
  return rows.toSorted(
    (left, right) =>
      snoozeWakeMs(left) - snoozeWakeMs(right) ||
      String(left.thread.id).localeCompare(String(right.thread.id)),
  );
}

/**
 * Settled rows are history, so they order by when the work ENDED — the same
 * timestamp their label reads, so order and label can never disagree.
 */
export function sortSettledPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
): ReadonlyArray<PhaseSidebarRow> {
  const timestampMs = (row: PhaseSidebarRow) => {
    const timestamp = resolveSettledTimestamp(row.thread);
    return timestamp === null ? 0 : Date.parse(timestamp);
  };
  return rows.toSorted(
    (left, right) =>
      timestampMs(right) - timestampMs(left) ||
      String(left.thread.id).localeCompare(String(right.thread.id)),
  );
}

/**
 * T3-CUSTOM(expbkt3): Split visible rows into the lifecycle inbox and the
 * two parked shelves. Snooze deliberately outranks settled classification:
 * an explicitly snoozed thread belongs on the snoozed shelf even when it
 * would also auto-settle, because the shelf carries its wake time.
 *
 * Both classifications are capability-gated per row — auto-settling a
 * thread on a server that cannot un-settle it would strand the row.
 *
 * `preciseNow` classifies snooze (wake times are second-precise) while
 * `now` may be quantized for the day-granular auto-settle window.
 */
export function partitionPhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
  options: {
    readonly now: string;
    readonly preciseNow: string;
    readonly autoSettleAfterDays: number | null;
  },
): PhaseSidebarPartition {
  const activeRows: PhaseSidebarRow[] = [];
  const snoozedRows: PhaseSidebarRow[] = [];
  const settledRows: PhaseSidebarRow[] = [];

  for (const row of rows) {
    if (row.snoozeSupported && effectiveSnoozed(row.thread, { now: options.preciseNow })) {
      snoozedRows.push(row);
      continue;
    }
    if (
      row.settlementSupported &&
      effectiveSettled(row.thread, {
        now: options.now,
        autoSettleAfterDays: options.autoSettleAfterDays,
        changeRequestState: row.changeRequestState,
      })
    ) {
      settledRows.push(row);
      continue;
    }
    activeRows.push(row);
  }

  return {
    activeRows,
    snoozedRows: sortSnoozedPhaseSidebarRows(snoozedRows),
    settledRows: sortSettledPhaseSidebarRows(settledRows),
  };
}

/**
 * Keep the routed thread visually distinct from multi-selected rows. The
 * persistent right-edge accent is rendered by PhaseThreadRow; these surfaces
 * provide enough contrast for the active row to remain obvious in both themes.
 */
export function phaseSidebarRowClassName(
  isActive: boolean,
  isSelected: boolean,
  needsUserInput: boolean,
): string {
  return cn(
    // T3-CUSTOM(expbkt3): Center the adaptive title/metadata content lane.
    "group/phase-row relative flex min-h-14 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2 text-left outline-hidden transition-[background-color,color,box-shadow] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
    // T3-CUSTOM(expbkt3): Row surfaces carry routing state only. Priority is
    // read off the P0..P4 badge, so a prioritised row keeps the same background
    // as everything else and the routed row stays the one tinted surface in
    // the list — see phaseSidebarPriorityBadgeClassName.
    isActive && isSelected
      ? "bg-primary/26 text-foreground font-semibold ring-1 ring-inset ring-primary/55 hover:bg-primary/30 dark:bg-primary/32"
      : isSelected
        ? "bg-primary/18 text-foreground dark:bg-primary/26"
        : isActive
          ? "bg-primary/18 text-foreground font-semibold ring-1 ring-inset ring-primary/45 hover:bg-primary/22 dark:bg-primary/24"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
    // T3-CUSTOM(expbkt3): Flash only structured-question rows in the experimental sidebar.
    needsUserInput &&
      "animate-[pulse_1.25s_ease-in-out_infinite] bg-red-500/20 text-foreground ring-1 ring-inset ring-red-500/60 shadow-[inset_3px_0_0_0_var(--color-red-500),0_0_14px_rgba(239,68,68,0.22)] hover:bg-red-500/30 motion-reduce:animate-none",
  );
}

/** A stopped projection can still hide a live provider, so any recorded session remains stoppable. */
export function phaseSidebarCanForceStopAgent(session: ThreadShell["session"]): boolean {
  return session !== null;
}

export interface PhaseSidebarRepositoryOption {
  readonly key: string;
  readonly label: string;
  readonly searchText: string;
  readonly project: Project;
}

export interface PhaseSidebarGroup extends PhaseSidebarPhaseDefinition {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
}

export interface PhaseSidebarFilterChip {
  // T3-CUSTOM(expbkt3): "person" is the co-participant facet.
  readonly facet: "repository" | "phase" | "provider" | "assignment" | "person";
  readonly value: string;
  readonly label: string;
}

export function isStrictlyMergeReady(status: VcsStatusResult | null | undefined): boolean {
  const pr = status?.pr;
  if (!pr || pr.state !== "open" || status?.sourceControlProvider?.kind !== "github") return false;
  if (pr.isDraft !== false || pr.mergeability !== "mergeable") return false;
  if (pr.mergeStateStatus?.toUpperCase() !== "CLEAN") return false;
  if (pr.reviewDecision === "changes-requested" || pr.reviewDecision === "review-required") {
    return false;
  }
  return pr.checksStatus === "pass";
}

export function resolvePhaseSidebarAttentionPriority(
  thread: ThreadShell,
  status?: VcsStatusResult | null,
): number {
  if (phaseSidebarNeedsUserInput(thread)) return 0;
  if (thread.execution?.turn?.state === "waiting-for-approval") return 1;
  if (thread.execution?.activity === "failed") return 2;
  if (
    status?.pr?.state === "open" &&
    (status.pr.mergeability === "conflicting" ||
      status.pr.checksStatus === "fail" ||
      status.pr.reviewDecision === "changes-requested")
  ) {
    return 3;
  }
  if (thread.execution === null || thread.execution === undefined) return 4;
  return 5;
}

/**
 * T3-CUSTOM(expbkt3): Treat both the durable pending-input bit and the live
 * execution state as authority. This keeps urgent questions promoted even
 * during short execution-snapshot reconnects.
 */
export function phaseSidebarNeedsUserInput(
  thread: Pick<ThreadShell, "hasPendingUserInput" | "execution">,
): boolean {
  return thread.hasPendingUserInput || thread.execution?.turn?.state === "waiting-for-input";
}

export type PhaseSidebarAttentionKind = "input" | "approval" | "error";

export function resolvePhaseSidebarAttentionKind(
  thread: Pick<ThreadShell, "execution" | "hasPendingApprovals" | "hasPendingUserInput">,
): PhaseSidebarAttentionKind | null {
  if (phaseSidebarNeedsUserInput(thread)) return "input";
  if (thread.hasPendingApprovals || thread.execution?.turn?.state === "waiting-for-approval") {
    return "approval";
  }
  if (thread.execution?.activity === "failed") return "error";
  return null;
}

export function resolvePhaseSidebarPhase(
  thread: ThreadShell,
  _status?: VcsStatusResult | null,
): PhaseSidebarPhaseId {
  if (phaseSidebarNeedsUserInput(thread)) return "needs_input";

  // A failed provider is actionable even if a stale durable intent or
  // background-liveness projection has not cleared yet.
  const hasFailure = thread.execution?.activity === "failed" || thread.session?.status === "error";
  if (hasFailure) {
    return thread.interactionMode === "plan" ? "plan_ready" : "ready";
  }

  // T3-CUSTOM(expbkt3): BEGIN — group from the same durable intent as the badge.
  const isActive =
    (thread.execution?.intent !== undefined &&
      thread.execution.intent.phase !== "recovery-exhausted") ||
    thread.execution?.activity === "active" ||
    thread.execution?.activity === "blocked" ||
    thread.execution?.activity === "stopping" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running";
  // T3-CUSTOM(expbkt3): END
  if (isActive) {
    return thread.interactionMode === "plan" ? "planning" : "implementing";
  }

  // Sidebar V2's reliability ordering: a failure or an actionable plan must
  // not be hidden by liveness that can linger while background work winds
  // down. Those states keep their ordinary group and attention treatment.
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) {
    return "plan_ready";
  }

  // A settled foreground turn can still own native subagents, workflows, or
  // watch scripts. Keep it among agent-work rows until the authoritative
  // server projection clears instead of prematurely dropping it into Ready.
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return thread.interactionMode === "plan" ? "planning" : "implementing";
  }

  return thread.interactionMode === "plan" ? "plan_ready" : "ready";
}

/**
 * Keep a thread in its last rendered lifecycle group while live execution
 * authority is temporarily unavailable. The underlying execution snapshot is
 * still cleared on disconnect; this only stabilizes sidebar presentation until
 * a fresh execution frame arrives.
 */
export function resolvePhaseSidebarDisplayPhase(
  currentPhase: PhaseSidebarPhaseId,
  _previousPhase: PhaseSidebarPhaseId | null,
): PhaseSidebarPhaseId {
  return currentPhase;
}

export function derivePhaseSidebarRepositoryKey(project: Project): string {
  return deriveLogicalProjectKey(project, { groupingMode: "repository" });
}

export function buildPhaseSidebarRepositoryOptions(
  projects: ReadonlyArray<Project>,
): ReadonlyArray<PhaseSidebarRepositoryOption> {
  const grouped = new Map<string, Project[]>();
  for (const project of projects) {
    const key = derivePhaseSidebarRepositoryKey(project);
    const members = grouped.get(key);
    if (members) members.push(project);
    else grouped.set(key, [project]);
  }

  return [...grouped.entries()]
    .map(([key, members]) => {
      const sortedMembers = members.toSorted((left, right) =>
        `${left.environmentId}:${left.id}`.localeCompare(`${right.environmentId}:${right.id}`),
      );
      const nicknames = [...new Set(sortedMembers.map((project) => project.title))].toSorted(
        (left, right) => left.localeCompare(right),
      );
      const canonicalLabels = [
        ...new Set(
          sortedMembers.flatMap((project) => {
            const identity = project.repositoryIdentity;
            if (!identity) return [];
            return [identity.displayName, identity.name].filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            );
          }),
        ),
      ].toSorted((left, right) => left.localeCompare(right));
      const label =
        nicknames.length === 1
          ? nicknames[0]!
          : (canonicalLabels[0] ?? nicknames[0] ?? "Unknown repository");
      const searchText = [
        ...nicknames,
        ...canonicalLabels,
        ...sortedMembers.flatMap((project) => {
          const identity = project.repositoryIdentity;
          return identity ? [identity.canonicalKey, identity.owner ?? ""] : [];
        }),
      ].join(" ");
      return { key, label, searchText, project: sortedMembers[0]! };
    })
    .toSorted(
      (left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key),
    );
}

const KNOWN_PROVIDER_CODES: Readonly<Record<string, string>> = {
  claudeAgent: "cc",
  codex: "cx",
  cursor: "cu",
  grok: "gr",
  opencode: "oc",
};

export function resolvePhaseSidebarProviderCode(providerKind: string): string {
  const known = KNOWN_PROVIDER_CODES[providerKind];
  if (known) return known;

  const normalized = providerKind
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (!normalized) return "uk";
  const words = normalized.split(/\s+/);
  if (words.length > 1) {
    return `${words[0]?.[0] ?? "?"}${words[1]?.[0] ?? "?"}`;
  }
  return normalized.length === 1 ? normalized.repeat(2) : normalized.slice(0, 2);
}

export function matchesPhaseSidebarFilters(
  row: PhaseSidebarRow,
  filters: PhaseSidebarFilters,
): boolean {
  return (
    (filters.repositoryKeys.length === 0 || filters.repositoryKeys.includes(row.repositoryKey)) &&
    (filters.phaseIds.length === 0 || filters.phaseIds.includes(row.phaseId)) &&
    (filters.providerKinds.length === 0 || filters.providerKinds.includes(row.providerKind)) &&
    // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant facets.
    (!filters.ownedByMe || row.isOwnedByMe) &&
    // Every selected person must be on the thread: selecting two people asks
    // for their shared sessions, not the union of their work.
    (filters.participantUserIds.length === 0 ||
      filters.participantUserIds.every((userId) => row.participantUserIds.includes(userId)))
    // T3-CUSTOM(expbkt3): END
  );
}

/**
 * The rows this sidebar may render at all. Shared by the lifecycle groups and
 * the parked shelves so a filter chip means the same thing everywhere.
 */
export function filterVisiblePhaseSidebarRows(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarFilters,
): ReadonlyArray<PhaseSidebarRow> {
  return rows.filter(
    (row) => row.thread.archivedAt === null && matchesPhaseSidebarFilters(row, filters),
  );
}

/**
 * T3-CUSTOM(expbkt3): sort rank for a thread's priority. Unprioritised rows
 * rank after P4 so an explicit P4 still outranks "no opinion".
 */
export function phaseSidebarPriorityRank(thread: ThreadShell): number {
  return thread.priority ?? PHASE_SIDEBAR_UNPRIORITISED_RANK;
}

export const PHASE_SIDEBAR_UNPRIORITISED_RANK = 5;

/** T3-CUSTOM(expbkt3): render label for a priority value ("P0".."P4"). */
export function formatThreadPriority(priority: number): string {
  return `P${priority}`;
}

/**
 * T3-CUSTOM(expbkt3): The badge is now the only place priority is expressed, so
 * it carries the whole scale on its own.
 *
 * P0 keeps the full Linear-attention orange. Each step down mixes ~20% more
 * neutral into it, landing on plain grey at P4. The mix runs in oklab against a
 * neutral of the same lightness, so the ladder reads as "less urgent" through
 * falling saturation while every rung keeps identical contrast against the black
 * label — dropping actual lightness instead would make P3/P4 unreadable in the
 * light theme.
 */
const PHASE_SIDEBAR_PRIORITY_BADGE_CLASS_NAMES = [
  "bg-orange-500 text-black shadow-sm",
  "bg-[color-mix(in_oklab,var(--color-orange-500)_80%,var(--color-neutral-400))] text-black shadow-sm",
  "bg-[color-mix(in_oklab,var(--color-orange-500)_60%,var(--color-neutral-400))] text-black shadow-sm",
  "bg-[color-mix(in_oklab,var(--color-orange-500)_40%,var(--color-neutral-400))] text-black shadow-sm",
  "bg-neutral-400 text-black shadow-sm",
] as const;

export function phaseSidebarPriorityBadgeClassName(priority: number): string {
  return (
    PHASE_SIDEBAR_PRIORITY_BADGE_CLASS_NAMES[priority] ??
    PHASE_SIDEBAR_PRIORITY_BADGE_CLASS_NAMES.at(-1)!
  );
}

/** T3-CUSTOM(expbkt3): the priority values offered in the row context menu. */
export const PHASE_SIDEBAR_PRIORITY_CHOICES = [
  { value: 0, label: "P0 — Urgent" },
  { value: 1, label: "P1 — High" },
  { value: 2, label: "P2 — Medium" },
  { value: 3, label: "P3 — Low" },
  { value: 4, label: "P4 — Lowest" },
] as const satisfies ReadonlyArray<{ readonly value: 0 | 1 | 2 | 3 | 4; readonly label: string }>;

/** T3-CUSTOM(expbkt3): Which end of the time axis leads inside a lifecycle group. */
export type PhaseSidebarSortDirection = "newest_first" | "oldest_first";

export interface PhaseSidebarSortPreferences {
  readonly direction: PhaseSidebarSortDirection;
  /** When true, P0 outranks every lower priority; ties fall through to time. */
  readonly priorityFirst: boolean;
}

export const DEFAULT_PHASE_SIDEBAR_SORT: PhaseSidebarSortPreferences = {
  direction: "newest_first",
  priorityFirst: true,
};

export const PHASE_SIDEBAR_SORT_DIRECTION_LABELS: Record<PhaseSidebarSortDirection, string> = {
  newest_first: "Most recent on top",
  oldest_first: "Oldest on top",
};

export function sanitizePhaseSidebarSort(value: unknown): PhaseSidebarSortPreferences {
  if (!value || typeof value !== "object") return DEFAULT_PHASE_SIDEBAR_SORT;
  const candidate = value as Partial<Record<keyof PhaseSidebarSortPreferences, unknown>>;
  return {
    direction:
      candidate.direction === "oldest_first" || candidate.direction === "newest_first"
        ? candidate.direction
        : DEFAULT_PHASE_SIDEBAR_SORT.direction,
    priorityFirst:
      typeof candidate.priorityFirst === "boolean"
        ? candidate.priorityFirst
        : DEFAULT_PHASE_SIDEBAR_SORT.priorityFirst,
  };
}

/**
 * T3-CUSTOM(expbkt3): Ordering inside a lifecycle group is deliberately STRICT —
 * it reads only the thread's priority, its sort timestamp, and stable tiebreaks.
 *
 * It used to also fold in `attentionPriority` and `isUnreadCompletion`. Both flip
 * the moment you open a row, so simply reading a thread reordered the group under
 * the pointer. Those states are already visible on the row (glint, unread dot) and
 * hoisted into their own groups upstream, so ordering does not need to repeat them
 * at the cost of a list that moves while you use it.
 */
export function comparePhaseSidebarRows(
  left: PhaseSidebarRow,
  right: PhaseSidebarRow,
  sortOrder: SidebarThreadSortOrder,
  sort: PhaseSidebarSortPreferences,
): number {
  const priorityDelta = sort.priorityFirst
    ? phaseSidebarPriorityRank(left.thread) - phaseSidebarPriorityRank(right.thread)
    : 0;
  const leftTime = getThreadSortTimestamp(left.thread, sortOrder);
  const rightTime = getThreadSortTimestamp(right.thread, sortOrder);
  const timeDelta = sort.direction === "oldest_first" ? leftTime - rightTime : rightTime - leftTime;
  return (
    priorityDelta ||
    timeDelta ||
    left.thread.title.localeCompare(right.thread.title) ||
    String(left.thread.id).localeCompare(String(right.thread.id))
  );
}

export function buildPhaseSidebarGroups(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarFilters,
  sortOrder: SidebarThreadSortOrder,
  sort: PhaseSidebarSortPreferences = DEFAULT_PHASE_SIDEBAR_SORT,
): ReadonlyArray<PhaseSidebarGroup> {
  const visibleRows = filterVisiblePhaseSidebarRows(rows, filters);

  return PHASE_SIDEBAR_PHASES.flatMap((phase) => {
    const phaseRows = visibleRows
      .filter((row) => row.phaseId === phase.id)
      .toSorted((left, right) => comparePhaseSidebarRows(left, right, sortOrder, sort));
    return phaseRows.length > 0 ? [{ ...phase, rows: phaseRows }] : [];
  });
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      ),
    ),
  ];
}

export function sanitizePhaseSidebarFilters(value: unknown): PhaseSidebarFilters {
  if (!value || typeof value !== "object") return EMPTY_PHASE_SIDEBAR_FILTERS;
  const candidate = value as Partial<Record<keyof PhaseSidebarFilters, unknown>>;
  return {
    repositoryKeys: sanitizeStringArray(candidate.repositoryKeys),
    phaseIds: sanitizeStringArray(candidate.phaseIds).filter(
      (phaseId): phaseId is PhaseSidebarPhaseId => PHASE_ID_SET.has(phaseId),
    ),
    providerKinds: sanitizeStringArray(candidate.providerKinds),
    // T3-CUSTOM(expbkt3): missing on blobs written before these facets existed,
    // so both default off; storage stays v1.
    ownedByMe: candidate.ownedByMe === true,
    participantUserIds: sanitizeStringArray(candidate.participantUserIds),
  };
}

export function reconcilePhaseSidebarFilters(
  filters: PhaseSidebarFilters,
  options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
    // False on single-user builds (no operator identity): a persisted
    // ownership filter would otherwise hide every thread.
    readonly assignmentAvailable: boolean;
    // T3-CUSTOM(expbkt3): people still present in the directory. A teammate who
    // leaves must not keep an invisible filter pinned over the sidebar.
    readonly participantUserIds?: ReadonlySet<string>;
  },
): PhaseSidebarFilters {
  const knownParticipants = options.participantUserIds;
  return {
    repositoryKeys: filters.repositoryKeys.filter((key) => options.repositoryKeys.has(key)),
    phaseIds: filters.phaseIds.filter((phaseId) => PHASE_ID_SET.has(phaseId)),
    providerKinds: filters.providerKinds.filter((kind) => options.providerKinds.has(kind)),
    ownedByMe: options.assignmentAvailable ? filters.ownedByMe : false,
    participantUserIds: !options.assignmentAvailable
      ? []
      : knownParticipants === undefined
        ? filters.participantUserIds
        : filters.participantUserIds.filter((userId) => knownParticipants.has(userId)),
  };
}

export function buildPhaseSidebarFilterChips(
  filters: PhaseSidebarFilters,
  labels: {
    readonly repositories: ReadonlyMap<string, string>;
    readonly providers: ReadonlyMap<string, string>;
    // T3-CUSTOM(expbkt3): display names for the co-participant facet.
    readonly people?: ReadonlyMap<string, string>;
  },
): ReadonlyArray<PhaseSidebarFilterChip> {
  const phaseLabels = new Map(PHASE_SIDEBAR_PHASES.map((phase) => [phase.id, phase.label]));
  return [
    ...filters.repositoryKeys.map((value) => ({
      facet: "repository" as const,
      value,
      label: labels.repositories.get(value) ?? value,
    })),
    ...filters.phaseIds.map((value) => ({
      facet: "phase" as const,
      value,
      label: phaseLabels.get(value) ?? value,
    })),
    ...filters.providerKinds.map((value) => ({
      facet: "provider" as const,
      value,
      label: labels.providers.get(value) ?? value,
    })),
    // T3-CUSTOM(expbkt3): BEGIN — ownership and co-participant chips.
    ...(filters.ownedByMe
      ? [{ facet: "assignment" as const, value: "owned-by-me", label: "Started by me" }]
      : []),
    ...filters.participantUserIds.map((value) => ({
      facet: "person" as const,
      value,
      label: labels.people?.get(value) ?? "Teammate",
    })),
    // T3-CUSTOM(expbkt3): END
  ];
}

export function flattenPhaseSidebarGroups(
  groups: ReadonlyArray<PhaseSidebarGroup>,
): ReadonlyArray<PhaseSidebarRow> {
  return groups.flatMap((group) => group.rows);
}

export function resolvePhaseSidebarTraversalTarget(input: {
  readonly visibleThreadKeys: ReadonlyArray<string>;
  readonly currentThreadKey: string | null;
  readonly direction: "previous" | "next";
}): string | null {
  if (input.visibleThreadKeys.length === 0) return null;
  const currentIndex = input.currentThreadKey
    ? input.visibleThreadKeys.indexOf(input.currentThreadKey)
    : -1;
  if (currentIndex === -1) {
    return input.direction === "previous"
      ? (input.visibleThreadKeys.at(-1) ?? null)
      : (input.visibleThreadKeys[0] ?? null);
  }
  if (input.direction === "previous") {
    return currentIndex > 0 ? (input.visibleThreadKeys[currentIndex - 1] ?? null) : null;
  }
  return currentIndex < input.visibleThreadKeys.length - 1
    ? (input.visibleThreadKeys[currentIndex + 1] ?? null)
    : null;
}
