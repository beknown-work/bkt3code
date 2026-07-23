import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { UserId, VcsStatusResult } from "@t3tools/contracts";

import { deriveLogicalProjectKey } from "../../logicalProject";
import { isLatestTurnSettled } from "../../session-logic";
import type { Project, ThreadShell } from "../../types";
import { getThreadSortTimestamp } from "../../lib/threadSort";

export const PHASE_SIDEBAR_PHASE_IDS = [
  "plan_ready",
  "ready_for_review",
  "ready_to_merge",
  "planning",
  "implementing",
  "in_review",
  "merging",
  "merged",
  "checking",
  "ready",
] as const;

export type PhaseSidebarPhaseId = (typeof PHASE_SIDEBAR_PHASE_IDS)[number];

export interface PhaseSidebarPhaseDefinition {
  readonly id: PhaseSidebarPhaseId;
  readonly label: string;
  readonly helperText: string;
}

export const PHASE_SIDEBAR_PHASES: ReadonlyArray<PhaseSidebarPhaseDefinition> = [
  { id: "plan_ready", label: "Plan Ready", helperText: "Plan awaits approval" },
  { id: "ready_for_review", label: "Ready for Review", helperText: "Changes await review" },
  { id: "ready_to_merge", label: "Ready to Merge", helperText: "Approved and checks passing" },
  { id: "planning", label: "Planning", helperText: "Agent is preparing a plan" },
  { id: "implementing", label: "Implementing", helperText: "Agent is changing code" },
  { id: "in_review", label: "In Review", helperText: "Pull request needs review or checks" },
  { id: "merging", label: "Merging", helperText: "Merge is queued or automatic" },
  { id: "merged", label: "Merged", helperText: "Changes landed" },
  { id: "checking", label: "Checking", helperText: "Checking agent status" },
  { id: "ready", label: "Ready", helperText: "No active agent work" },
];

const PHASE_ID_SET = new Set<string>(PHASE_SIDEBAR_PHASE_IDS);
const LINEAR_BRANCH_PATTERN = /^linear\/([a-z][a-z0-9]*-\d+)(?:-|$)/i;

export interface PhaseSidebarLinearIssue {
  readonly identifier: string;
  readonly url: string;
}

export function resolvePhaseSidebarLinearIssue(
  branch: string | null,
): PhaseSidebarLinearIssue | null {
  if (branch === null) return null;
  const identifier = LINEAR_BRANCH_PATTERN.exec(branch)?.[1]?.toUpperCase();
  if (!identifier) return null;
  return {
    identifier,
    url: `https://linear.app/beknown/issue/${identifier}`,
  };
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
  readonly unreadPriority: number;
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

function hasReviewableChanges(thread: ThreadShell, status: VcsStatusResult | null | undefined) {
  return (
    thread.execution?.activity !== "failed" &&
    thread.latestTurn?.state === "completed" &&
    thread.latestTurn.completedAt !== null &&
    status !== null &&
    status !== undefined &&
    (status.hasWorkingTreeChanges || status.aheadCount > 0 || (status.aheadOfDefaultCount ?? 0) > 0)
  );
}

export function resolvePhaseSidebarAttentionPriority(
  thread: ThreadShell,
  status?: VcsStatusResult | null,
): number {
  if (thread.execution?.turn?.state === "waiting-for-approval") return 0;
  if (thread.execution?.turn?.state === "waiting-for-input") return 1;
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

export function resolvePhaseSidebarPhase(
  thread: ThreadShell,
  status?: VcsStatusResult | null,
): PhaseSidebarPhaseId {
  if (thread.execution === null || thread.execution === undefined) return "checking";

  const isActive =
    thread.execution?.activity === "active" ||
    thread.execution?.activity === "blocked" ||
    thread.execution?.activity === "stopping";
  if (isActive) {
    if (thread.interactionMode === "plan") return "planning";
    if (status?.pr?.state === "open") {
      return status.pr.autoMergeEnabled === true ? "merging" : "in_review";
    }
    return "implementing";
  }

  if (
    thread.interactionMode === "plan" &&
    thread.execution.activity !== "failed" &&
    thread.hasActionableProposedPlan &&
    isLatestTurnSettled(thread.latestTurn, thread.execution ?? null)
  ) {
    return "plan_ready";
  }

  if (status?.pr?.state === "merged") return "merged";
  if (status?.pr?.state === "open") {
    if (status.pr.autoMergeEnabled === true) return "merging";
    return isStrictlyMergeReady(status) ? "ready_to_merge" : "in_review";
  }
  if (hasReviewableChanges(thread, status)) return "ready_for_review";

  return "ready";
}

/**
 * Keep a thread in its last rendered lifecycle group while live execution
 * authority is temporarily unavailable. The underlying execution snapshot is
 * still cleared on disconnect; this only stabilizes sidebar presentation until
 * a fresh execution frame arrives.
 */
export function resolvePhaseSidebarDisplayPhase(
  currentPhase: PhaseSidebarPhaseId,
  previousPhase: PhaseSidebarPhaseId | null,
): PhaseSidebarPhaseId {
  return currentPhase === "checking" && previousPhase !== null && previousPhase !== "checking"
    ? previousPhase
    : currentPhase;
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

export function buildPhaseSidebarGroups(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarFilters,
  sortOrder: SidebarThreadSortOrder,
): ReadonlyArray<PhaseSidebarGroup> {
  const visibleRows = rows.filter(
    (row) => row.thread.archivedAt === null && matchesPhaseSidebarFilters(row, filters),
  );

  return PHASE_SIDEBAR_PHASES.flatMap((phase) => {
    const phaseRows = visibleRows
      .filter((row) => row.phaseId === phase.id)
      .toSorted(
        (left, right) =>
          left.attentionPriority - right.attentionPriority ||
          left.unreadPriority - right.unreadPriority ||
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
