import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { UserId, VcsStatusResult } from "@t3tools/contracts";
import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "@t3tools/client-runtime/state/thread-settled";

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
}

/**
 * T3-CUSTOM(expbkt3): Keep checkout semantics explicit in the experimental
 * sidebar. Current checkouts show their live branch; dedicated worktrees show
 * the ref they were created from, never their generated feature branch.
 */
export function resolvePhaseSidebarCheckoutMetadata(
  thread: Pick<ThreadShell, "branch" | "worktreePath">,
  vcsStatus: Pick<VcsStatusResult, "refName" | "baseRef" | "pr"> | null | undefined,
): PhaseSidebarCheckoutMetadata {
  if (thread.worktreePath) {
    const baseRef = vcsStatus?.pr?.baseRef ?? vcsStatus?.baseRef ?? null;
    return {
      kind: "worktree",
      label: baseRef ? `from ${baseRef}` : "Worktree",
      tooltip: baseRef ? `Worktree started from ${baseRef}` : "Dedicated worktree",
    };
  }

  const branch = vcsStatus?.refName ?? thread.branch;
  return {
    kind: "current",
    label: branch ?? "Current checkout",
    tooltip: branch ? `Current checkout on ${branch}` : "Current checkout",
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
  readonly assignedToMe: boolean;
}

export const EMPTY_PHASE_SIDEBAR_FILTERS: PhaseSidebarFilters = {
  repositoryKeys: [],
  phaseIds: [],
  providerKinds: [],
  assignedToMe: false,
};

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
  priority: number | null = null,
): string {
  return cn(
    // T3-CUSTOM(expbkt3): Center the adaptive title/metadata content lane.
    "group/phase-row relative flex min-h-14 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2 text-left outline-hidden transition-[background-color,color,box-shadow] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
    isActive && isSelected
      ? "bg-primary/18 text-foreground font-semibold ring-1 ring-inset ring-primary/40 hover:bg-primary/22 dark:bg-primary/24"
      : isSelected
        ? "bg-primary/15 text-foreground dark:bg-primary/22"
        : isActive
          ? "bg-primary/10 text-foreground font-semibold ring-1 ring-inset ring-primary/30 hover:bg-primary/15 dark:bg-primary/16"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
    // T3-CUSTOM(expbkt3): Priority uses the Linear-attention orange; reserve
    // bright red for the user-input branch below.
    !needsUserInput &&
      priority === 0 &&
      cn(
        "bg-orange-500/40 text-foreground ring-1 ring-inset hover:bg-orange-500/50 dark:bg-orange-500/35",
        isActive
          ? cn(
              isSelected ? "ring-primary/80" : "ring-primary/70",
              "shadow-[inset_3px_0_0_0_var(--color-primary),0_0_10px_color-mix(in_oklab,var(--color-primary)_24%,transparent)]",
            )
          : "ring-orange-500/80 shadow-[inset_3px_0_0_0_var(--color-orange-500)]",
      ),
    !needsUserInput &&
      priority === 1 &&
      cn(
        "bg-orange-500/20 text-foreground ring-1 ring-inset hover:bg-orange-500/25 dark:bg-orange-500/18",
        isActive
          ? cn(
              isSelected ? "ring-primary/80" : "ring-primary/70",
              "shadow-[inset_3px_0_0_0_var(--color-primary),0_0_10px_color-mix(in_oklab,var(--color-primary)_24%,transparent)]",
            )
          : "ring-orange-500/40 shadow-[inset_3px_0_0_0_var(--color-orange-500)]",
      ),
    !needsUserInput &&
      priority === 2 &&
      cn(
        "bg-orange-500/10 text-foreground ring-1 ring-inset hover:bg-orange-500/15 dark:bg-orange-500/9",
        isActive
          ? cn(
              isSelected ? "ring-primary/80" : "ring-primary/70",
              "shadow-[inset_3px_0_0_0_var(--color-primary),0_0_10px_color-mix(in_oklab,var(--color-primary)_24%,transparent)]",
            )
          : "ring-orange-500/20 shadow-[inset_3px_0_0_0_var(--color-orange-500)]",
      ),
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
  readonly facet: "repository" | "phase" | "provider" | "assignment";
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
    (!filters.assignedToMe || row.isAssignedToMe)
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

/** T3-CUSTOM(expbkt3): Keep the priority pill aligned with the row's orange tone. */
export function phaseSidebarPriorityBadgeClassName(priority: number): string {
  return priority <= 2
    ? "bg-orange-500 text-black shadow-sm"
    : "bg-muted-foreground/15 text-muted-foreground";
}

/** T3-CUSTOM(expbkt3): the priority values offered in the row context menu. */
export const PHASE_SIDEBAR_PRIORITY_CHOICES = [
  { value: 0, label: "P0 — Urgent" },
  { value: 1, label: "P1 — High" },
  { value: 2, label: "P2 — Medium" },
  { value: 3, label: "P3 — Low" },
  { value: 4, label: "P4 — Lowest" },
] as const satisfies ReadonlyArray<{ readonly value: 0 | 1 | 2 | 3 | 4; readonly label: string }>;

export function buildPhaseSidebarGroups(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarFilters,
  sortOrder: SidebarThreadSortOrder,
): ReadonlyArray<PhaseSidebarGroup> {
  const visibleRows = filterVisiblePhaseSidebarRows(rows, filters);

  return PHASE_SIDEBAR_PHASES.flatMap((phase) => {
    const phaseRows = visibleRows
      .filter((row) => row.phaseId === phase.id)
      .toSorted(
        (left, right) =>
          // T3-CUSTOM(expbkt3): priority leads the ordering inside every
          // lifecycle group. Rows that need input are already hoisted into
          // their own group upstream of this comparator, so attention states
          // still surface — they just no longer outrank an explicit P0.
          phaseSidebarPriorityRank(left.thread) - phaseSidebarPriorityRank(right.thread) ||
          left.attentionPriority - right.attentionPriority ||
          Number(right.isUnreadCompletion) - Number(left.isUnreadCompletion) ||
          getThreadSortTimestamp(right.thread, sortOrder) -
            getThreadSortTimestamp(left.thread, sortOrder) ||
          left.thread.title.localeCompare(right.thread.title) ||
          String(left.thread.id).localeCompare(String(right.thread.id)),
      );
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
    // Missing on older persisted (v1) blobs ⇒ default off; storage stays v1.
    assignedToMe: candidate.assignedToMe === true,
  };
}

export function reconcilePhaseSidebarFilters(
  filters: PhaseSidebarFilters,
  options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
    // False on single-user builds (no operator identity): a persisted
    // "assigned to me" filter would otherwise hide every thread.
    readonly assignmentAvailable: boolean;
  },
): PhaseSidebarFilters {
  return {
    repositoryKeys: filters.repositoryKeys.filter((key) => options.repositoryKeys.has(key)),
    phaseIds: filters.phaseIds.filter((phaseId) => PHASE_ID_SET.has(phaseId)),
    providerKinds: filters.providerKinds.filter((kind) => options.providerKinds.has(kind)),
    assignedToMe: options.assignmentAvailable ? filters.assignedToMe : false,
  };
}

export function buildPhaseSidebarFilterChips(
  filters: PhaseSidebarFilters,
  labels: {
    readonly repositories: ReadonlyMap<string, string>;
    readonly providers: ReadonlyMap<string, string>;
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
    ...(filters.assignedToMe
      ? [{ facet: "assignment" as const, value: "assigned-to-me", label: "Assigned to me" }]
      : []),
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
