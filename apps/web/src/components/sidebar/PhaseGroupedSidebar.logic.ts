import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import { deriveLogicalProjectKey } from "../../logicalProject";
import { isLatestTurnSettled } from "../../session-logic";
import type { Project, ThreadShell } from "../../types";
import { sortThreads } from "../../lib/threadSort";

export const PHASE_SIDEBAR_PHASE_IDS = [
  "approval_needed",
  "awaiting_input",
  "failed",
  "plan_ready",
  "drafting_plan",
  "implementing",
  "ready",
] as const;

export type PhaseSidebarPhaseId = (typeof PHASE_SIDEBAR_PHASE_IDS)[number];

export interface PhaseSidebarPhaseDefinition {
  readonly id: PhaseSidebarPhaseId;
  readonly label: string;
  readonly helperText: string;
}

export const PHASE_SIDEBAR_PHASES: ReadonlyArray<PhaseSidebarPhaseDefinition> = [
  { id: "approval_needed", label: "Approval Needed", helperText: "Needs a tool decision" },
  { id: "awaiting_input", label: "Awaiting Input", helperText: "Needs your response" },
  { id: "failed", label: "Failed", helperText: "Needs attention" },
  { id: "plan_ready", label: "Plan Ready", helperText: "Ready for review" },
  { id: "drafting_plan", label: "Drafting Plan", helperText: "Agent is planning" },
  { id: "implementing", label: "Implementing", helperText: "Agent is working" },
  { id: "ready", label: "Ready", helperText: "No active agent work" },
];

const PHASE_ID_SET = new Set<string>(PHASE_SIDEBAR_PHASE_IDS);

export interface PhaseSidebarFilters {
  readonly repositoryKeys: ReadonlyArray<string>;
  readonly phaseIds: ReadonlyArray<PhaseSidebarPhaseId>;
  readonly providerKinds: ReadonlyArray<string>;
}

export const EMPTY_PHASE_SIDEBAR_FILTERS: PhaseSidebarFilters = {
  repositoryKeys: [],
  phaseIds: [],
  providerKinds: [],
};

export interface PhaseSidebarRow {
  readonly thread: ThreadShell;
  readonly phaseId: PhaseSidebarPhaseId;
  readonly repositoryKey: string;
  readonly repositoryLabel: string;
  readonly providerKind: string;
  readonly providerName: string;
  readonly providerCode: string;
}

export interface PhaseSidebarGroup extends PhaseSidebarPhaseDefinition {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
}

export interface PhaseSidebarFilterChip {
  readonly facet: "repository" | "phase" | "provider";
  readonly value: string;
  readonly label: string;
}

export function resolvePhaseSidebarPhase(thread: ThreadShell): PhaseSidebarPhaseId {
  if (thread.hasPendingApprovals) return "approval_needed";
  if (thread.hasPendingUserInput) return "awaiting_input";

  const isActive = thread.session?.status === "starting" || thread.session?.status === "running";
  if (isActive) {
    return thread.interactionMode === "plan" ? "drafting_plan" : "implementing";
  }

  if (thread.session?.status === "error" || thread.session?.lastError) return "failed";

  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestTurnSettled(thread.latestTurn, thread.session)
  ) {
    return "plan_ready";
  }

  return "ready";
}

export function derivePhaseSidebarRepositoryKey(project: Project): string {
  return deriveLogicalProjectKey(project, { groupingMode: "repository" });
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
    (filters.providerKinds.length === 0 || filters.providerKinds.includes(row.providerKind))
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
    const phaseRows = sortThreads(
      visibleRows
        .filter((row) => row.phaseId === phase.id)
        .map((row) => ({
          row,
          id: row.thread.id,
          createdAt: row.thread.createdAt,
          updatedAt: row.thread.updatedAt,
          latestUserMessageAt: row.thread.latestUserMessageAt,
        })),
      sortOrder,
    ).map(({ row }) => row);
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
  };
}

export function reconcilePhaseSidebarFilters(
  filters: PhaseSidebarFilters,
  options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
  },
): PhaseSidebarFilters {
  return {
    repositoryKeys: filters.repositoryKeys.filter((key) => options.repositoryKeys.has(key)),
    phaseIds: filters.phaseIds.filter((phaseId) => PHASE_ID_SET.has(phaseId)),
    providerKinds: filters.providerKinds.filter((kind) => options.providerKinds.has(kind)),
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
