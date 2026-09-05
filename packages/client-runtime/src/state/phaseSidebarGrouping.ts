// T3-CUSTOM(expbkt3): how the phase sidebar is sectioned.
//
// The sidebar has always grouped by lifecycle phase. This module generalises
// that into three modes — lifecycle, project, and user-defined custom groups —
// and owns everything the modes share: the section model both clients render,
// the operations that edit custom groups, which sections are collapsed, and
// the sanitizer that reads all of it back from storage.
//
// Custom groups are client-local. They key threads by scoped thread key
// (`environmentId:threadId`), so a single group can hold sessions from every
// connected environment; the trade-off is that the groups themselves live on
// the device that made them rather than syncing between devices.
//
// HERMES: this also runs under React Native. Sort a copy with `.sort()`,
// never `.toSorted()`.
//
// @effect-diagnostics globalDate:off globalRandom:off -- a per-device group id
// needs a cheap unique-enough string, not an injectable clock or RNG.
import {
  isRunningSessionPhase,
  type PhaseSidebarFilters,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./phaseSidebar.ts";
import {
  buildPhaseSidebarFilteredTree,
  buildPhaseSidebarTree,
  groupPhaseSidebarTreeByPhase,
  phaseSidebarRowKey,
  resolvePhaseSidebarTreePhase,
  type PhaseSidebarTreeNode,
} from "./phaseSidebarTree.ts";

export const PHASE_SIDEBAR_GROUP_BY_MODES = ["lifecycle", "project", "custom"] as const;
export type PhaseSidebarGroupBy = (typeof PHASE_SIDEBAR_GROUP_BY_MODES)[number];

export const PHASE_SIDEBAR_GROUP_BY_LABELS: Readonly<Record<PhaseSidebarGroupBy, string>> = {
  lifecycle: "Lifecycle",
  project: "Projects",
  custom: "Custom",
};

/**
 * How sections are ordered in the project and custom modes. Lifecycle keeps
 * its fixed, urgency-first order regardless.
 *
 * - manual: custom groups in the order the user arranged them (projects fall
 *   back to name, having no manual order).
 * - name: alphabetical.
 * - activity: the section with the most recently touched session first.
 */
export const PHASE_SIDEBAR_GROUP_ORDERS = ["manual", "name", "activity"] as const;
export type PhaseSidebarGroupOrder = (typeof PHASE_SIDEBAR_GROUP_ORDERS)[number];

export const PHASE_SIDEBAR_GROUP_ORDER_LABELS: Readonly<Record<PhaseSidebarGroupOrder, string>> = {
  manual: "Manual",
  name: "Name",
  activity: "Recent activity",
};

export interface PhaseSidebarCustomGroup {
  readonly id: string;
  readonly label: string;
  /** Scoped thread keys, in no particular order; rows still sort by the row sort. */
  readonly threadKeys: ReadonlyArray<string>;
}

/** The section every custom-mode thread lands in until it is placed. */
export const PHASE_SIDEBAR_UNGROUPED_ID = "ungrouped";

export interface PhaseSidebarGroupingPreferences {
  readonly groupBy: PhaseSidebarGroupBy;
  readonly groupOrder: PhaseSidebarGroupOrder;
  readonly customGroups: ReadonlyArray<PhaseSidebarCustomGroup>;
  /** Section keys (see `PhaseSidebarSection.key`) the user closed. */
  readonly collapsedSectionKeys: ReadonlyArray<string>;
}

export const DEFAULT_PHASE_SIDEBAR_GROUPING: PhaseSidebarGroupingPreferences = {
  groupBy: "lifecycle",
  groupOrder: "manual",
  customGroups: [],
  collapsedSectionKeys: [],
};

/** Longest label a custom group keeps; anything past it is truncated on save. */
export const PHASE_SIDEBAR_GROUP_LABEL_MAX_LENGTH = 40;

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

export function sanitizePhaseSidebarGroupLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, PHASE_SIDEBAR_GROUP_LABEL_MAX_LENGTH);
}

function sanitizeCustomGroups(value: unknown): PhaseSidebarCustomGroup[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const claimedThreadKeys = new Set<string>();
  const groups: PhaseSidebarCustomGroup[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as {
      readonly id?: unknown;
      readonly label?: unknown;
      readonly threadKeys?: unknown;
    };
    if (typeof candidate.id !== "string" || candidate.id.length === 0) continue;
    if (candidate.id === PHASE_SIDEBAR_UNGROUPED_ID || seenIds.has(candidate.id)) continue;
    const label =
      typeof candidate.label === "string" ? sanitizePhaseSidebarGroupLabel(candidate.label) : "";
    if (label.length === 0) continue;
    seenIds.add(candidate.id);
    // A thread belongs to at most one group; the first claim wins so a
    // corrupted blob never renders one session twice.
    const threadKeys = sanitizeStringList(candidate.threadKeys).filter((key) => {
      if (claimedThreadKeys.has(key)) return false;
      claimedThreadKeys.add(key);
      return true;
    });
    groups.push({ id: candidate.id, label, threadKeys });
  }
  return groups;
}

export function sanitizePhaseSidebarGrouping(value: unknown): PhaseSidebarGroupingPreferences {
  if (value === null || typeof value !== "object") return DEFAULT_PHASE_SIDEBAR_GROUPING;
  const candidate = value as {
    readonly groupBy?: unknown;
    readonly groupOrder?: unknown;
    readonly customGroups?: unknown;
    readonly collapsedSectionKeys?: unknown;
  };
  const groupBy = PHASE_SIDEBAR_GROUP_BY_MODES.find((mode) => mode === candidate.groupBy);
  const groupOrder = PHASE_SIDEBAR_GROUP_ORDERS.find((order) => order === candidate.groupOrder);
  return {
    groupBy: groupBy ?? DEFAULT_PHASE_SIDEBAR_GROUPING.groupBy,
    groupOrder: groupOrder ?? DEFAULT_PHASE_SIDEBAR_GROUPING.groupOrder,
    customGroups: sanitizeCustomGroups(candidate.customGroups),
    collapsedSectionKeys: sanitizeStringList(candidate.collapsedSectionKeys),
  };
}

// ---------------------------------------------------------------------------
// Editing — every operation is pure and returns the next preferences, so web's
// zustand store and mobile's preference file apply the same rules.
// ---------------------------------------------------------------------------

/** Short, unique enough for a per-device list; never leaves the device. */
export function generatePhaseSidebarGroupId(): string {
  return `g${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

export function setPhaseSidebarGroupBy(
  preferences: PhaseSidebarGroupingPreferences,
  groupBy: PhaseSidebarGroupBy,
): PhaseSidebarGroupingPreferences {
  return preferences.groupBy === groupBy ? preferences : { ...preferences, groupBy };
}

export function setPhaseSidebarGroupOrder(
  preferences: PhaseSidebarGroupingPreferences,
  groupOrder: PhaseSidebarGroupOrder,
): PhaseSidebarGroupingPreferences {
  return preferences.groupOrder === groupOrder ? preferences : { ...preferences, groupOrder };
}

export function createPhaseSidebarCustomGroup(
  preferences: PhaseSidebarGroupingPreferences,
  input: {
    readonly label: string;
    readonly id?: string;
    readonly threadKeys?: ReadonlyArray<string>;
  },
): { readonly preferences: PhaseSidebarGroupingPreferences; readonly id: string | null } {
  const label = sanitizePhaseSidebarGroupLabel(input.label);
  if (label.length === 0) return { preferences, id: null };
  const id = input.id ?? generatePhaseSidebarGroupId();
  if (preferences.customGroups.some((group) => group.id === id)) return { preferences, id: null };
  const threadKeys = input.threadKeys ?? [];
  // Claim the seeded threads away from wherever they were.
  const customGroups = preferences.customGroups.map((group) => ({
    ...group,
    threadKeys: group.threadKeys.filter((key) => !threadKeys.includes(key)),
  }));
  // The mode is left alone: a group made from a row while grouping by
  // lifecycle is simply waiting when the user switches to Custom.
  return {
    preferences: {
      ...preferences,
      customGroups: [...customGroups, { id, label, threadKeys: [...new Set(threadKeys)] }],
    },
    id,
  };
}

export function renamePhaseSidebarCustomGroup(
  preferences: PhaseSidebarGroupingPreferences,
  id: string,
  label: string,
): PhaseSidebarGroupingPreferences {
  const nextLabel = sanitizePhaseSidebarGroupLabel(label);
  if (nextLabel.length === 0) return preferences;
  let changed = false;
  const customGroups = preferences.customGroups.map((group) => {
    if (group.id !== id || group.label === nextLabel) return group;
    changed = true;
    return { ...group, label: nextLabel };
  });
  return changed ? { ...preferences, customGroups } : preferences;
}

/** Deleting a group sends its sessions back to Ungrouped; nothing is lost. */
export function deletePhaseSidebarCustomGroup(
  preferences: PhaseSidebarGroupingPreferences,
  id: string,
): PhaseSidebarGroupingPreferences {
  if (!preferences.customGroups.some((group) => group.id === id)) return preferences;
  const sectionKey = phaseSidebarSectionKey("custom", id);
  return {
    ...preferences,
    customGroups: preferences.customGroups.filter((group) => group.id !== id),
    collapsedSectionKeys: preferences.collapsedSectionKeys.filter((key) => key !== sectionKey),
  };
}

export function movePhaseSidebarCustomGroup(
  preferences: PhaseSidebarGroupingPreferences,
  id: string,
  direction: "up" | "down",
): PhaseSidebarGroupingPreferences {
  const index = preferences.customGroups.findIndex((group) => group.id === id);
  if (index === -1) return preferences;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= preferences.customGroups.length) return preferences;
  const customGroups = [...preferences.customGroups];
  const [moved] = customGroups.splice(index, 1);
  customGroups.splice(target, 0, moved!);
  return { ...preferences, customGroups };
}

/** Null `groupId` means "back to Ungrouped". Unknown group ids are ignored. */
export function assignPhaseSidebarThreadToGroup(
  preferences: PhaseSidebarGroupingPreferences,
  threadKey: string,
  groupId: string | null,
): PhaseSidebarGroupingPreferences {
  if (groupId !== null && !preferences.customGroups.some((group) => group.id === groupId)) {
    return preferences;
  }
  if (phaseSidebarCustomGroupIdForThread(preferences, threadKey) === groupId) return preferences;
  const customGroups = preferences.customGroups.map((group) => {
    const without = group.threadKeys.filter((key) => key !== threadKey);
    if (group.id === groupId) return { ...group, threadKeys: [...without, threadKey] };
    return without.length === group.threadKeys.length ? group : { ...group, threadKeys: without };
  });
  return { ...preferences, customGroups };
}

export function phaseSidebarCustomGroupIdForThread(
  preferences: PhaseSidebarGroupingPreferences,
  threadKey: string,
): string | null {
  for (const group of preferences.customGroups) {
    if (group.threadKeys.includes(threadKey)) return group.id;
  }
  return null;
}

export function togglePhaseSidebarSectionCollapsed(
  preferences: PhaseSidebarGroupingPreferences,
  sectionKey: string,
): PhaseSidebarGroupingPreferences {
  const collapsed = preferences.collapsedSectionKeys.includes(sectionKey);
  return {
    ...preferences,
    collapsedSectionKeys: collapsed
      ? preferences.collapsedSectionKeys.filter((key) => key !== sectionKey)
      : [...preferences.collapsedSectionKeys, sectionKey],
  };
}

/**
 * Drops thread keys that no longer exist on any connected environment, so a
 * group does not carry ghosts forever. Only call this with the FULL set of
 * live keys — a partial set (one environment offline) would strip real
 * membership. Archived threads count as live: they can come back.
 */
export function prunePhaseSidebarGrouping(
  preferences: PhaseSidebarGroupingPreferences,
  liveThreadKeys: ReadonlySet<string>,
): PhaseSidebarGroupingPreferences {
  let changed = false;
  const customGroups = preferences.customGroups.map((group) => {
    const threadKeys = group.threadKeys.filter((key) => liveThreadKeys.has(key));
    if (threadKeys.length === group.threadKeys.length) return group;
    changed = true;
    return { ...group, threadKeys };
  });
  return changed ? { ...preferences, customGroups } : preferences;
}

// ---------------------------------------------------------------------------
// Sections — what the list renders
// ---------------------------------------------------------------------------

export function phaseSidebarSectionKey(kind: PhaseSidebarGroupBy, id: string): string {
  return `${kind}:${id}`;
}

/** What a closed section still has to say for itself. */
export interface PhaseSidebarSectionSummary {
  readonly running: number;
  readonly attention: number;
  readonly unread: number;
}

export interface PhaseSidebarSection {
  readonly key: string;
  readonly kind: PhaseSidebarGroupBy;
  readonly id: string;
  readonly label: string;
  readonly helperText: string;
  /** Set for lifecycle sections, which keep their phase tone. */
  readonly phaseId: PhaseSidebarPhaseId | null;
  readonly nodes: ReadonlyArray<PhaseSidebarTreeNode>;
  readonly summary: PhaseSidebarSectionSummary;
  /** True for the custom-mode catch-all, which cannot be renamed or deleted. */
  readonly isUngrouped: boolean;
  /**
   * Parked shelves (snoozed, settled) start closed: out of the way, never
   * gone. `collapsedSectionKeys` then records a toggle AWAY from this default,
   * so one list serves both kinds of section.
   */
  readonly collapsedByDefault: boolean;
}

export interface PhaseSidebarSectionsResult {
  readonly sections: ReadonlyArray<PhaseSidebarSection>;
  readonly forcedExpansionKeys: ReadonlySet<string>;
}

export interface BuildPhaseSidebarSectionsInput {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly filters: PhaseSidebarFilters;
  readonly compareSiblings: (left: PhaseSidebarRow, right: PhaseSidebarRow) => number;
  readonly titleForKey?: (key: string) => string | null;
  readonly grouping: PhaseSidebarGroupingPreferences;
  /** Project title lookup; falls back to the row's repository label. */
  readonly projectLabelFor?: (environmentId: string, projectId: string) => string | null;
  /**
   * Environment label, appended to project sections when more than one
   * environment is connected so two "t3code" projects on two machines read
   * apart.
   */
  readonly environmentLabelFor?: (environmentId: string) => string | null;
}

function summarizeNodes(nodes: ReadonlyArray<PhaseSidebarTreeNode>): PhaseSidebarSectionSummary {
  let running = 0;
  let attention = 0;
  let unread = 0;
  const visit = (node: PhaseSidebarTreeNode): void => {
    if (isRunningSessionPhase(node.row.phaseId)) running += 1;
    if (node.row.phaseId === "needs_input") attention += 1;
    if (node.row.isUnreadCompletion) unread += 1;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return { running, attention, unread };
}

function latestActivity(nodes: ReadonlyArray<PhaseSidebarTreeNode>): number {
  let latest = Number.NEGATIVE_INFINITY;
  const visit = (node: PhaseSidebarTreeNode): void => {
    const at = Date.parse(node.row.thread.updatedAt ?? "");
    if (Number.isFinite(at) && at > latest) latest = at;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return latest;
}

function orderSections(
  sections: ReadonlyArray<PhaseSidebarSection>,
  order: PhaseSidebarGroupOrder,
  manualIndex: (section: PhaseSidebarSection) => number,
): ReadonlyArray<PhaseSidebarSection> {
  const sorted = [...sections];
  // The catch-all stays last in every order: it is where things go when they
  // have not been placed, not a peer of the groups the user made.
  const rank = (section: PhaseSidebarSection) => (section.isUngrouped ? 1 : 0);
  sorted.sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    switch (order) {
      case "manual": {
        const byIndex = manualIndex(left) - manualIndex(right);
        return byIndex !== 0 ? byIndex : left.label.localeCompare(right.label);
      }
      case "name":
        return left.label.localeCompare(right.label);
      case "activity": {
        const byActivity = latestActivity(right.nodes) - latestActivity(left.nodes);
        return byActivity !== 0 ? byActivity : left.label.localeCompare(right.label);
      }
    }
  });
  return sorted;
}

function pluralSessions(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

export function buildPhaseSidebarSections(
  input: BuildPhaseSidebarSectionsInput,
): PhaseSidebarSectionsResult {
  const { tree, forcedExpansionKeys } = buildPhaseSidebarFilteredTree(input);
  const { grouping } = input;

  switch (grouping.groupBy) {
    case "lifecycle": {
      const sections = groupPhaseSidebarTreeByPhase(tree).map((group): PhaseSidebarSection => ({
        key: phaseSidebarSectionKey("lifecycle", group.id),
        kind: "lifecycle",
        id: group.id,
        label: group.label,
        helperText: group.helperText,
        phaseId: group.id,
        nodes: group.nodes,
        summary: summarizeNodes(group.nodes),
        isUngrouped: false,
        collapsedByDefault: false,
      }));
      return { sections, forcedExpansionKeys };
    }

    case "project": {
      const byProject = new Map<string, PhaseSidebarTreeNode[]>();
      for (const node of tree) {
        const { environmentId, projectId } = node.row.thread;
        const id = `${environmentId}:${projectId}`;
        byProject.set(id, [...(byProject.get(id) ?? []), node]);
      }
      const environmentIds = new Set(tree.map((node) => node.row.thread.environmentId));
      const sections = [...byProject.entries()].map(([id, nodes]): PhaseSidebarSection => {
        const first = nodes[0]!.row;
        const { environmentId, projectId } = first.thread;
        const label = input.projectLabelFor?.(environmentId, projectId) ?? first.repositoryLabel;
        const environmentLabel =
          environmentIds.size > 1 ? (input.environmentLabelFor?.(environmentId) ?? null) : null;
        return {
          key: phaseSidebarSectionKey("project", id),
          kind: "project",
          id,
          label,
          helperText: environmentLabel ?? pluralSessions(nodes.length),
          phaseId: null,
          nodes,
          summary: summarizeNodes(nodes),
          isUngrouped: false,
          collapsedByDefault: false,
        };
      });
      // Projects have no manual order, so "manual" reads as "name".
      return {
        sections: orderSections(
          sections,
          grouping.groupOrder === "manual" ? "name" : grouping.groupOrder,
          () => 0,
        ),
        forcedExpansionKeys,
      };
    }

    case "custom": {
      const groupIdByThreadKey = new Map<string, string>();
      for (const group of grouping.customGroups) {
        for (const key of group.threadKeys) groupIdByThreadKey.set(key, group.id);
      }
      // Placement is decided per ROOT: a child stays under its parent, which
      // is what nesting means. Assigning a nested session moves nothing until
      // it is detached.
      const nodesByGroupId = new Map<string, PhaseSidebarTreeNode[]>();
      for (const node of tree) {
        const groupId = groupIdByThreadKey.get(node.key) ?? PHASE_SIDEBAR_UNGROUPED_ID;
        nodesByGroupId.set(groupId, [...(nodesByGroupId.get(groupId) ?? []), node]);
      }
      const sections: PhaseSidebarSection[] = grouping.customGroups.map((group) => {
        const nodes = nodesByGroupId.get(group.id) ?? [];
        return {
          key: phaseSidebarSectionKey("custom", group.id),
          kind: "custom",
          id: group.id,
          label: group.label,
          helperText: nodes.length === 0 ? "Empty" : pluralSessions(nodes.length),
          phaseId: null,
          nodes,
          summary: summarizeNodes(nodes),
          isUngrouped: false,
          collapsedByDefault: false,
        };
      });
      const ungrouped = nodesByGroupId.get(PHASE_SIDEBAR_UNGROUPED_ID) ?? [];
      if (ungrouped.length > 0) {
        sections.push({
          key: phaseSidebarSectionKey("custom", PHASE_SIDEBAR_UNGROUPED_ID),
          kind: "custom",
          id: PHASE_SIDEBAR_UNGROUPED_ID,
          label: "Ungrouped",
          helperText: "Not placed in a group yet",
          phaseId: null,
          nodes: ungrouped,
          summary: summarizeNodes(ungrouped),
          isUngrouped: true,
          collapsedByDefault: false,
        });
      }
      const manualIndex = new Map(grouping.customGroups.map((group, index) => [group.id, index]));
      return {
        sections: orderSections(
          sections,
          grouping.groupOrder,
          (section) => manualIndex.get(section.id) ?? Number.MAX_SAFE_INTEGER,
        ),
        forcedExpansionKeys,
      };
    }
  }
}

/** Whether a section is closed, honouring its default and the user's toggles. */
export function isPhaseSidebarSectionCollapsed(
  section: Pick<PhaseSidebarSection, "key" | "collapsedByDefault">,
  collapsedSectionKeys: ReadonlySet<string>,
): boolean {
  return collapsedSectionKeys.has(section.key) !== section.collapsedByDefault;
}

/**
 * The parked shelves under the grouped sections: snoozed and settled sessions,
 * as flat lists in the order the caller partitioned them (wake time, then
 * settle time). They exist in every grouping mode — parking is orthogonal to
 * how live work is grouped — and start collapsed.
 */
export function buildPhaseSidebarShelfSections(input: {
  readonly snoozedRows: ReadonlyArray<PhaseSidebarRow>;
  readonly settledRows: ReadonlyArray<PhaseSidebarRow>;
}): ReadonlyArray<PhaseSidebarSection> {
  const keepOrder = (rows: ReadonlyArray<PhaseSidebarRow>) => {
    const index = new Map(rows.map((row, position) => [phaseSidebarRowKey(row), position]));
    return (left: PhaseSidebarRow, right: PhaseSidebarRow) =>
      (index.get(phaseSidebarRowKey(left)) ?? 0) - (index.get(phaseSidebarRowKey(right)) ?? 0);
  };
  const shelf = (
    id: "snoozed" | "settled",
    label: string,
    helperText: string,
    rows: ReadonlyArray<PhaseSidebarRow>,
  ): PhaseSidebarSection | null => {
    if (rows.length === 0) return null;
    const nodes = buildPhaseSidebarTree(rows, { compareSiblings: keepOrder(rows) });
    return {
      key: phaseSidebarSectionKey("lifecycle", id),
      kind: "lifecycle",
      id,
      label,
      helperText,
      phaseId: null,
      nodes,
      summary: summarizeNodes(nodes),
      isUngrouped: false,
      collapsedByDefault: true,
    };
  };
  return [
    shelf("snoozed", "Snoozed", "Parked until they wake", input.snoozedRows),
    shelf("settled", "Settled", "Wrapped up", input.settledRows),
  ].filter((section): section is PhaseSidebarSection => section !== null);
}

/** Where a row's section sits in the list, for the collapsed-header phase tone. */
export function phaseSidebarSectionPhase(section: PhaseSidebarSection): PhaseSidebarPhaseId | null {
  if (section.phaseId !== null) return section.phaseId;
  if (section.summary.attention > 0) return "needs_input";
  if (section.summary.running > 0) return "implementing";
  return null;
}

/** Re-exported so callers grouping by hand can match the section builder. */
export { phaseSidebarRowKey, resolvePhaseSidebarTreePhase };
