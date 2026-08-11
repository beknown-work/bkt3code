/**
 * T3-CUSTOM(expbkt3): Pure logic for the bulk session manager table.
 *
 * Everything here is DOM-free and deterministic so the table's real decisions —
 * which rows a filter set admits, how a column sorts, what the chip bar says,
 * and how row order freezes under a live selection — are unit-testable without
 * mounting 100+ virtualized rows. The component keeps only React state.
 *
 * Row *derivation* deliberately reuses the phase sidebar's helpers
 * (`resolvePhaseSidebarPhase`, `resolvePhaseSidebarAttentionKind`,
 * `phaseSidebarPriorityRank`, …) rather than re-deriving phase/attention here:
 * two answers to "what phase is this session in" is exactly the drift this page
 * is supposed to remove.
 */
import type { ThreadWorkSummary, ThreadWorkSummaryStage } from "@t3tools/contracts";

import type { ThreadShell } from "../../types";
import {
  PHASE_SIDEBAR_PHASES,
  PHASE_SIDEBAR_PHASE_IDS,
  PHASE_SIDEBAR_UNPRIORITISED_RANK,
  formatThreadPriority,
  type PhaseSidebarAttentionKind,
  type PhaseSidebarPhaseId,
} from "../sidebar/PhaseGroupedSidebar.logic";

/* --------------------------------- shape ---------------------------------- */

/**
 * Where a session sits in the parking lifecycle. Mirrors the sidebar's
 * active/snoozed/settled shelves and adds `archived`, which the sidebar never
 * shows but a management table must.
 */
export type SessionManagerLifecycle = "active" | "snoozed" | "settled" | "archived";

export const SESSION_MANAGER_LIFECYCLES: ReadonlyArray<SessionManagerLifecycle> = [
  "active",
  "snoozed",
  "settled",
  "archived",
];

export const SESSION_MANAGER_ATTENTION_KINDS: ReadonlyArray<PhaseSidebarAttentionKind> = [
  "approval",
  "input",
  "error",
];

export const SESSION_MANAGER_ATTENTION_LABELS: Record<PhaseSidebarAttentionKind, string> = {
  approval: "Approval",
  input: "Input",
  error: "Error",
};

/** Per-environment capability gates, resolved once per row. */
export interface SessionManagerRowCapabilities {
  readonly settlement: boolean;
  readonly snooze: boolean;
  readonly pinning: boolean;
  readonly priority: boolean;
  readonly titleRegeneration: boolean;
  readonly workSummary: boolean;
}

export interface SessionManagerRow {
  /** Scoped thread key — the identity used by selection, freezing and pruning. */
  readonly key: string;
  readonly thread: ThreadShell;
  readonly lifecycle: SessionManagerLifecycle;
  readonly phaseId: PhaseSidebarPhaseId;
  readonly attentionKind: PhaseSidebarAttentionKind | null;
  readonly repositoryKey: string;
  readonly repositoryLabel: string;
  readonly providerKind: string;
  readonly providerName: string;
  readonly modelLabel: string;
  readonly ownerUserId: string | null;
  readonly ownerLabel: string;
  /** `thread.priority ?? 5`; 5 sorts and filters as "unprioritised". */
  readonly priorityRank: number;
  readonly lastActivityAt: string | null;
  readonly isUnreadCompletion: boolean;
  readonly isPinned: boolean;
  readonly workSummary: ThreadWorkSummary | null;
  readonly capabilities: SessionManagerRowCapabilities;
  /** Whether a running agent turn can be stopped on this row right now. */
  readonly canStop: boolean;
  /** Pre-lowercased haystack for the free-text search box. */
  readonly searchText: string;
}

/* -------------------------------- filters --------------------------------- */

export interface SessionManagerFilters {
  readonly search: string;
  readonly repositoryKeys: ReadonlyArray<string>;
  readonly phaseIds: ReadonlyArray<PhaseSidebarPhaseId>;
  readonly providerKinds: ReadonlyArray<string>;
  /** 0..4 plus `PHASE_SIDEBAR_UNPRIORITISED_RANK` (5) for "no priority". */
  readonly priorities: ReadonlyArray<number>;
  readonly attentionKinds: ReadonlyArray<PhaseSidebarAttentionKind>;
  readonly ownerUserIds: ReadonlyArray<string>;
  readonly lifecycles: ReadonlyArray<SessionManagerLifecycle>;
  /** Only rows idle for at least this many days. */
  readonly staleDays: number | null;
}

export const DEFAULT_SESSION_MANAGER_FILTERS: SessionManagerFilters = {
  search: "",
  repositoryKeys: [],
  phaseIds: [],
  providerKinds: [],
  priorities: [],
  attentionKinds: [],
  ownerUserIds: [],
  lifecycles: ["active"],
  staleDays: null,
};

export const SESSION_MANAGER_STALE_DAY_CHOICES: ReadonlyArray<number | null> = [null, 1, 3, 7, 14];

export const SESSION_MANAGER_PRIORITY_CHOICES: ReadonlyArray<{
  readonly value: number;
  readonly label: string;
}> = [0, 1, 2, 3, 4].map((value) => ({ value, label: formatThreadPriority(value) }));

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * `true` when the row survives every active facet. Facets are AND-ed, values
 * within one facet are OR-ed — the same contract as the sidebar's filter bar,
 * so a chip means the same thing in both places.
 */
export function matchesSessionManagerFilters(
  row: SessionManagerRow,
  filters: SessionManagerFilters,
  options: { readonly now: string },
): boolean {
  if (!filters.lifecycles.includes(row.lifecycle)) return false;
  if (filters.repositoryKeys.length > 0 && !filters.repositoryKeys.includes(row.repositoryKey)) {
    return false;
  }
  if (filters.phaseIds.length > 0 && !filters.phaseIds.includes(row.phaseId)) return false;
  if (filters.providerKinds.length > 0 && !filters.providerKinds.includes(row.providerKind)) {
    return false;
  }
  if (filters.priorities.length > 0 && !filters.priorities.includes(row.priorityRank)) return false;
  if (filters.attentionKinds.length > 0) {
    if (row.attentionKind === null || !filters.attentionKinds.includes(row.attentionKind)) {
      return false;
    }
  }
  if (filters.ownerUserIds.length > 0) {
    if (row.ownerUserId === null || !filters.ownerUserIds.includes(row.ownerUserId)) return false;
  }
  if (filters.staleDays !== null) {
    // A row with no activity timestamp at all has been idle since forever, so
    // it always satisfies an idle-for filter rather than being hidden by it.
    if (row.lastActivityAt !== null) {
      const activityMs = Date.parse(row.lastActivityAt);
      const nowMs = Date.parse(options.now);
      if (Number.isNaN(activityMs) || Number.isNaN(nowMs)) return true;
      if (nowMs - activityMs < filters.staleDays * DAY_MS) return false;
    }
  }
  const query = filters.search.trim().toLowerCase();
  if (query.length > 0 && !row.searchText.includes(query)) return false;
  return true;
}

export function filterSessionManagerRows(
  rows: ReadonlyArray<SessionManagerRow>,
  filters: SessionManagerFilters,
  options: { readonly now: string },
): ReadonlyArray<SessionManagerRow> {
  return rows.filter((row) => matchesSessionManagerFilters(row, filters, options));
}

/* --------------------------------- sorting -------------------------------- */

export type SessionManagerSortColumn =
  | "title"
  | "repository"
  | "phase"
  | "priority"
  | "progress"
  | "activity"
  | "created";

export interface SessionManagerSort {
  readonly column: SessionManagerSortColumn;
  readonly direction: "asc" | "desc";
}

/**
 * Most-recently-active first. `asc` reads as "closest to now" for the two time
 * columns, which is what a table user expects from a first click on "Activity"
 * even though the underlying timestamps sort the other way.
 */
export const DEFAULT_SESSION_MANAGER_SORT: SessionManagerSort = {
  column: "activity",
  direction: "asc",
};

export const SESSION_MANAGER_STAGE_ORDER: ReadonlyArray<ThreadWorkSummaryStage> = [
  "planning",
  "implementing",
  "blocked",
  "awaiting-review",
  "done",
];

export const SESSION_MANAGER_STAGE_LABELS: Record<ThreadWorkSummaryStage, string> = {
  planning: "Planning",
  implementing: "Implementing",
  blocked: "Blocked",
  "awaiting-review": "Awaiting review",
  done: "Done",
};

const PHASE_ORDER = new Map<PhaseSidebarPhaseId, number>(
  PHASE_SIDEBAR_PHASE_IDS.map((phaseId, index) => [phaseId, index]),
);

export const SESSION_MANAGER_PHASE_LABELS: Record<PhaseSidebarPhaseId, string> = Object.fromEntries(
  PHASE_SIDEBAR_PHASES.map((phase) => [phase.id, phase.label]),
) as Record<PhaseSidebarPhaseId, string>;

function timestampValue(value: string | null | undefined): number {
  if (value == null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** Rows with no summary sort after every staged row, in both directions. */
function progressValue(row: SessionManagerRow): number {
  const stage = row.workSummary?.stage ?? null;
  if (stage === null) return Number.POSITIVE_INFINITY;
  const index = SESSION_MANAGER_STAGE_ORDER.indexOf(stage);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

export function compareSessionManagerRows(
  left: SessionManagerRow,
  right: SessionManagerRow,
  sort: SessionManagerSort,
): number {
  const factor = sort.direction === "asc" ? 1 : -1;
  switch (sort.column) {
    case "title":
      return factor * left.thread.title.localeCompare(right.thread.title);
    case "repository":
      return (
        factor *
        (left.repositoryLabel.localeCompare(right.repositoryLabel) || compareKeys(left, right))
      );
    case "phase":
      return (
        factor *
        ((PHASE_ORDER.get(left.phaseId) ?? 0) - (PHASE_ORDER.get(right.phaseId) ?? 0) ||
          compareKeys(left, right))
      );
    case "priority":
      return factor * (left.priorityRank - right.priorityRank || compareKeys(left, right));
    case "progress":
      return factor * (progressValue(left) - progressValue(right) || compareKeys(left, right));
    case "created":
      // Newest first under `asc`, matching the activity column's reading.
      return (
        factor *
        (timestampValue(right.thread.createdAt) - timestampValue(left.thread.createdAt) ||
          compareKeys(left, right))
      );
    case "activity":
    default:
      return (
        factor *
        (timestampValue(right.lastActivityAt) - timestampValue(left.lastActivityAt) ||
          compareKeys(left, right))
      );
  }
}

/** Ties break on the stable row key so a re-sort never shuffles equal rows. */
function compareKeys(left: SessionManagerRow, right: SessionManagerRow): number {
  return left.key.localeCompare(right.key);
}

export function sortSessionManagerRows(
  rows: ReadonlyArray<SessionManagerRow>,
  sort: SessionManagerSort,
): ReadonlyArray<SessionManagerRow> {
  return [...rows].sort((left, right) => compareSessionManagerRows(left, right, sort));
}

export function nextSessionManagerSort(
  current: SessionManagerSort,
  column: SessionManagerSortColumn,
): SessionManagerSort {
  if (current.column !== column) return { column, direction: "asc" };
  return { column, direction: current.direction === "asc" ? "desc" : "asc" };
}

/* ------------------------------ frozen order ------------------------------ */

/**
 * Hold row ORDER still while a selection is live.
 *
 * Rows are live atoms: a bulk retitle or summarize rewrites the very fields the
 * table sorts on, so an unfrozen table would reshuffle under the user's cursor
 * mid-run and the next click would land on a different session. Freezing order
 * (never content — rows still update in place) makes a bulk run safe.
 *
 * Rows that appear while frozen are appended in their sorted order rather than
 * inserted, so nothing above the user's cursor ever moves. Rows that vanish are
 * dropped.
 */
export function applyFrozenRowOrder(
  rows: ReadonlyArray<SessionManagerRow>,
  frozenKeys: ReadonlyArray<string> | null,
): ReadonlyArray<SessionManagerRow> {
  if (frozenKeys === null || frozenKeys.length === 0) return rows;
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const ordered: SessionManagerRow[] = [];
  const seen = new Set<string>();
  for (const key of frozenKeys) {
    const row = byKey.get(key);
    if (row === undefined || seen.has(key)) continue;
    ordered.push(row);
    seen.add(key);
  }
  for (const row of rows) {
    if (!seen.has(row.key)) ordered.push(row);
  }
  return ordered;
}

/* --------------------------------- chips ---------------------------------- */

export type SessionManagerFilterFacet =
  | "search"
  | "repository"
  | "phase"
  | "provider"
  | "priority"
  | "attention"
  | "owner"
  | "lifecycle"
  | "stale";

export interface SessionManagerFilterChip {
  /** Stable identity for React keys and for the component's clear handler. */
  readonly id: string;
  readonly facet: SessionManagerFilterFacet;
  readonly label: string;
  /** The facet value to remove; `null` for scalar facets (search, stale). */
  readonly value: string | null;
}

export interface SessionManagerChipLabels {
  readonly repositories: ReadonlyMap<string, string>;
  readonly providers: ReadonlyMap<string, string>;
  readonly owners: ReadonlyMap<string, string>;
}

const LIFECYCLE_LABELS: Record<SessionManagerLifecycle, string> = {
  active: "Active",
  snoozed: "Snoozed",
  settled: "Settled",
  archived: "Archived",
};

export function formatPriorityRankLabel(rank: number): string {
  return rank >= PHASE_SIDEBAR_UNPRIORITISED_RANK ? "No priority" : formatThreadPriority(rank);
}

/**
 * One removable chip per *deviation from the default*. The lifecycle facet only
 * chips when it differs from the default (`active`), because a chip reading
 * "Active" on a fresh page would be noise the user can't meaningfully clear.
 */
export function buildSessionManagerFilterChips(
  filters: SessionManagerFilters,
  labels: SessionManagerChipLabels,
): ReadonlyArray<SessionManagerFilterChip> {
  const chips: SessionManagerFilterChip[] = [];
  const search = filters.search.trim();
  if (search.length > 0) {
    chips.push({ id: "search", facet: "search", label: `“${search}”`, value: null });
  }
  for (const key of filters.repositoryKeys) {
    chips.push({
      id: `repository:${key}`,
      facet: "repository",
      label: labels.repositories.get(key) ?? key,
      value: key,
    });
  }
  for (const phaseId of filters.phaseIds) {
    chips.push({
      id: `phase:${phaseId}`,
      facet: "phase",
      label: SESSION_MANAGER_PHASE_LABELS[phaseId] ?? phaseId,
      value: phaseId,
    });
  }
  for (const kind of filters.attentionKinds) {
    chips.push({
      id: `attention:${kind}`,
      facet: "attention",
      label: SESSION_MANAGER_ATTENTION_LABELS[kind],
      value: kind,
    });
  }
  for (const rank of filters.priorities) {
    chips.push({
      id: `priority:${rank}`,
      facet: "priority",
      label: formatPriorityRankLabel(rank),
      value: String(rank),
    });
  }
  for (const providerKind of filters.providerKinds) {
    chips.push({
      id: `provider:${providerKind}`,
      facet: "provider",
      label: labels.providers.get(providerKind) ?? providerKind,
      value: providerKind,
    });
  }
  for (const ownerUserId of filters.ownerUserIds) {
    chips.push({
      id: `owner:${ownerUserId}`,
      facet: "owner",
      label: labels.owners.get(ownerUserId) ?? ownerUserId,
      value: ownerUserId,
    });
  }
  if (!isDefaultLifecycleSelection(filters.lifecycles)) {
    for (const lifecycle of filters.lifecycles) {
      chips.push({
        id: `lifecycle:${lifecycle}`,
        facet: "lifecycle",
        label: LIFECYCLE_LABELS[lifecycle],
        value: lifecycle,
      });
    }
  }
  if (filters.staleDays !== null) {
    chips.push({
      id: "stale",
      facet: "stale",
      label: `idle ${filters.staleDays}d+`,
      value: null,
    });
  }
  return chips;
}

function isDefaultLifecycleSelection(lifecycles: ReadonlyArray<SessionManagerLifecycle>): boolean {
  const defaults = DEFAULT_SESSION_MANAGER_FILTERS.lifecycles;
  if (lifecycles.length !== defaults.length) return false;
  return defaults.every((lifecycle) => lifecycles.includes(lifecycle));
}

export function hasActiveSessionManagerFilters(filters: SessionManagerFilters): boolean {
  return (
    filters.search.trim().length > 0 ||
    filters.repositoryKeys.length > 0 ||
    filters.phaseIds.length > 0 ||
    filters.providerKinds.length > 0 ||
    filters.priorities.length > 0 ||
    filters.attentionKinds.length > 0 ||
    filters.ownerUserIds.length > 0 ||
    filters.staleDays !== null ||
    !isDefaultLifecycleSelection(filters.lifecycles)
  );
}

/* ------------------------------- saved views ------------------------------ */

export interface SessionManagerSavedView {
  readonly id: string;
  readonly label: string;
  readonly filters: SessionManagerFilters;
  readonly sort?: SessionManagerSort;
  /** Which live count to badge the pill with, if any. */
  readonly countKey?: SessionManagerCountKey;
}

export type SessionManagerCountKey = "attention" | "running" | "stale" | "blocked" | "review";

export const SESSION_MANAGER_SAVED_VIEWS: ReadonlyArray<SessionManagerSavedView> = [
  {
    id: "attention",
    label: "Needs me",
    countKey: "attention",
    filters: {
      ...DEFAULT_SESSION_MANAGER_FILTERS,
      attentionKinds: ["approval", "input", "error"],
    },
    sort: { column: "priority", direction: "asc" },
  },
  {
    id: "running",
    label: "Running now",
    countKey: "running",
    filters: { ...DEFAULT_SESSION_MANAGER_FILTERS, phaseIds: ["planning", "implementing"] },
    sort: { column: "activity", direction: "asc" },
  },
  {
    id: "stale",
    label: "Stale 7d+",
    countKey: "stale",
    filters: { ...DEFAULT_SESSION_MANAGER_FILTERS, staleDays: 7 },
    sort: { column: "activity", direction: "desc" },
  },
  {
    id: "blocked",
    label: "Needs input",
    countKey: "blocked",
    filters: { ...DEFAULT_SESSION_MANAGER_FILTERS, phaseIds: ["needs_input"] },
  },
  {
    id: "review",
    label: "Plan ready",
    countKey: "review",
    filters: { ...DEFAULT_SESSION_MANAGER_FILTERS, phaseIds: ["plan_ready"] },
  },
];

export interface SessionManagerCounts {
  readonly total: number;
  readonly active: number;
  readonly attention: number;
  readonly running: number;
  readonly stale: number;
  readonly blocked: number;
  readonly review: number;
}

export function buildSessionManagerCounts(
  rows: ReadonlyArray<SessionManagerRow>,
  options: { readonly now: string; readonly staleDays: number },
): SessionManagerCounts {
  const nowMs = Date.parse(options.now);
  let active = 0;
  let attention = 0;
  let running = 0;
  let stale = 0;
  let blocked = 0;
  let review = 0;
  for (const row of rows) {
    if (row.lifecycle !== "active") continue;
    active += 1;
    if (row.attentionKind !== null) attention += 1;
    if (row.phaseId === "planning" || row.phaseId === "implementing") running += 1;
    if (row.phaseId === "needs_input") blocked += 1;
    if (row.phaseId === "plan_ready") review += 1;
    const activityMs = row.lastActivityAt === null ? null : Date.parse(row.lastActivityAt);
    if (activityMs === null || Number.isNaN(activityMs)) {
      stale += 1;
    } else if (!Number.isNaN(nowMs) && nowMs - activityMs >= options.staleDays * DAY_MS) {
      stale += 1;
    }
  }
  return { total: rows.length, active, attention, running, stale, blocked, review };
}

/* -------------------------- persistence sanitizers ------------------------ */

function sanitizeStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) seen.add(entry);
  }
  return [...seen];
}

function sanitizeMemberArray<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return sanitizeStringArray(value).filter((entry): entry is T =>
    (allowed as ReadonlyArray<string>).includes(entry),
  );
}

function sanitizePriorities(value: unknown): ReadonlyArray<number> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) continue;
    if (entry < 0 || entry > PHASE_SIDEBAR_UNPRIORITISED_RANK) continue;
    seen.add(entry);
  }
  return [...seen].sort((left, right) => left - right);
}

/**
 * Persisted filter blobs outlive the code that wrote them. Anything
 * unrecognised is dropped rather than trusted, and an empty lifecycle set falls
 * back to the default — a persisted "no lifecycles" would render a permanently
 * empty table with no obvious way out.
 */
export function sanitizeSessionManagerFilters(value: unknown): SessionManagerFilters {
  if (value === null || typeof value !== "object") return DEFAULT_SESSION_MANAGER_FILTERS;
  const raw = value as Record<string, unknown>;
  const lifecycles = sanitizeMemberArray(raw.lifecycles, SESSION_MANAGER_LIFECYCLES);
  const staleDaysRaw = raw.staleDays;
  const staleDays =
    typeof staleDaysRaw === "number" && Number.isFinite(staleDaysRaw) && staleDaysRaw > 0
      ? staleDaysRaw
      : null;
  return {
    search: typeof raw.search === "string" ? raw.search : "",
    repositoryKeys: sanitizeStringArray(raw.repositoryKeys),
    phaseIds: sanitizeMemberArray(raw.phaseIds, PHASE_SIDEBAR_PHASE_IDS),
    providerKinds: sanitizeStringArray(raw.providerKinds),
    priorities: sanitizePriorities(raw.priorities),
    attentionKinds: sanitizeMemberArray(raw.attentionKinds, SESSION_MANAGER_ATTENTION_KINDS),
    ownerUserIds: sanitizeStringArray(raw.ownerUserIds),
    lifecycles: lifecycles.length > 0 ? lifecycles : DEFAULT_SESSION_MANAGER_FILTERS.lifecycles,
    staleDays,
  };
}

export function sanitizeSessionManagerSort(value: unknown): SessionManagerSort {
  if (value === null || typeof value !== "object") return DEFAULT_SESSION_MANAGER_SORT;
  const raw = value as Record<string, unknown>;
  const columns: ReadonlyArray<SessionManagerSortColumn> = [
    "title",
    "repository",
    "phase",
    "priority",
    "progress",
    "activity",
    "created",
  ];
  const column = columns.includes(raw.column as SessionManagerSortColumn)
    ? (raw.column as SessionManagerSortColumn)
    : DEFAULT_SESSION_MANAGER_SORT.column;
  const direction = raw.direction === "desc" ? "desc" : "asc";
  return { column, direction };
}

/**
 * Drop facet values whose option disappeared (a project was deleted, a provider
 * instance was removed, a teammate left). A filter nobody can see in the UI but
 * that still hides rows is the worst kind of stale state.
 */
export function reconcileSessionManagerFilters(
  filters: SessionManagerFilters,
  options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
    readonly ownerUserIds: ReadonlySet<string>;
  },
): SessionManagerFilters {
  const repositoryKeys = filters.repositoryKeys.filter((key) => options.repositoryKeys.has(key));
  const providerKinds = filters.providerKinds.filter((kind) => options.providerKinds.has(kind));
  const ownerUserIds = filters.ownerUserIds.filter((id) => options.ownerUserIds.has(id));
  if (
    repositoryKeys.length === filters.repositoryKeys.length &&
    providerKinds.length === filters.providerKinds.length &&
    ownerUserIds.length === filters.ownerUserIds.length
  ) {
    return filters;
  }
  return { ...filters, repositoryKeys, providerKinds, ownerUserIds };
}

/* -------------------------------- run plan -------------------------------- */

/**
 * Split rows into the ones an action can actually run on and the ones it
 * can't, with a single reason string for the disabled tooltip. The toolbar
 * needs both halves: the count to show, and the reason to explain.
 */
export interface SessionManagerActionPlan {
  readonly eligible: ReadonlyArray<SessionManagerRow>;
  readonly blocked: ReadonlyArray<SessionManagerRow>;
  readonly disabledReason: string | null;
}

export function planSessionManagerAction(
  rows: ReadonlyArray<SessionManagerRow>,
  predicate: (row: SessionManagerRow) => boolean,
  reason: string,
): SessionManagerActionPlan {
  const eligible: SessionManagerRow[] = [];
  const blocked: SessionManagerRow[] = [];
  for (const row of rows) {
    if (predicate(row)) eligible.push(row);
    else blocked.push(row);
  }
  return {
    eligible,
    blocked,
    disabledReason: eligible.length === 0 && rows.length > 0 ? reason : null,
  };
}

/* ------------------------------ misc helpers ------------------------------ */

/** Clamp a model-reported percent into something a progress bar can render. */
export function clampWorkSummaryPercent(percent: number | null | undefined): number | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * One-line preview of a ready summary. The full text lives in the expandable
 * row detail; the cell must not wrap or the table's row height stops being
 * predictable for the virtualizer.
 */
export function workSummaryPreview(summary: string | null | undefined): string | null {
  if (summary == null) return null;
  const collapsed = summary.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? null : collapsed;
}

export function buildSessionManagerSearchText(input: {
  readonly title: string;
  readonly branch: string | null;
  readonly repositoryLabel: string;
  readonly worktreePath: string | null;
  readonly summary: string | null;
  readonly remaining: string | null;
  readonly linearIssueUrl: string | null | undefined;
  readonly providerName: string;
  readonly model: string;
}): string {
  return [
    input.title,
    input.branch ?? "",
    input.repositoryLabel,
    input.worktreePath ?? "",
    input.summary ?? "",
    input.remaining ?? "",
    input.linearIssueUrl ?? "",
    input.providerName,
    input.model,
  ]
    .join(" ")
    .toLowerCase();
}
