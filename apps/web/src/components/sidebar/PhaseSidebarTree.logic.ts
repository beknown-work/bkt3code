// T3-CUSTOM(expbkt3): session trees for the experimental sidebar.
//
// A session that fans work out — typically cross-repo, via the t3_create_session
// MCP tool — records the session that spawned it. This module turns that flat
// `parentThreadId` link into the nested rows the sidebar renders, and decides
// which lifecycle group a parent belongs in once its children are folded into it.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import {
  matchesPhaseSidebarFilters,
  PHASE_SIDEBAR_PHASES,
  type PhaseSidebarFilters,
  type PhaseSidebarPhaseDefinition,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./PhaseGroupedSidebar.logic";

/**
 * Indentation stops growing past this depth. Deep chains still nest logically —
 * traversal, counts and the phase override all keep working — but the sidebar is
 * ~260px wide, so past three levels the indent costs more title than it buys in
 * legibility.
 */
export const PHASE_SIDEBAR_TREE_MAX_INDENT_DEPTH = 3;

/**
 * Backstop for a projection that already contains a cycle. The server rejects
 * commands that would create one, but a client must never hang on bad data.
 */
export const PHASE_SIDEBAR_TREE_MAX_DEPTH = 16;

/**
 * A descendant counts as "busy" when its own phase says an agent is actively
 * working. This is the single input to the parent's phase override.
 */
const BUSY_PHASE_IDS: ReadonlySet<PhaseSidebarPhaseId> = new Set<PhaseSidebarPhaseId>([
  "planning",
  "implementing",
]);

export interface PhaseSidebarTreeNode {
  readonly row: PhaseSidebarRow;
  readonly key: string;
  readonly children: ReadonlyArray<PhaseSidebarTreeNode>;
  /** 0 for a root row; used for indentation and for the aria tree semantics. */
  readonly depth: number;
  /** Every descendant, not just direct children — this is the count the pill shows. */
  readonly descendantCount: number;
  /** True when any descendant is planning or implementing (see BUSY_PHASE_IDS). */
  readonly hasBusyDescendant: boolean;
  /**
   * Set only on a row whose recorded parent is not rendering in this section —
   * archived, settled, filtered out, in another environment, or deleted. The row
   * renders at the top level with this breadcrumb instead of silently losing its
   * lineage.
   */
  readonly orphanedFrom: { readonly key: string; readonly title: string } | null;
}

export function phaseSidebarRowKey(row: PhaseSidebarRow): string {
  return scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id));
}

/**
 * The parent link is a bare thread id: a session can only be created by a caller
 * on the same server, so parent and child always share an environment. Scoping
 * the lookup by the child's environment is therefore both correct and the only
 * way to avoid colliding ids across connected environments.
 */
function parentKeyOf(row: PhaseSidebarRow): string | null {
  const parentThreadId = row.thread.parentThreadId;
  if (parentThreadId == null) return null;
  return scopedThreadKey(scopeThreadRef(row.thread.environmentId, parentThreadId));
}

interface MutableNode {
  readonly row: PhaseSidebarRow;
  readonly key: string;
  readonly children: MutableNode[];
  depth: number;
  descendantCount: number;
  hasBusyDescendant: boolean;
  orphanedFrom: { readonly key: string; readonly title: string } | null;
}

function isBusy(row: PhaseSidebarRow): boolean {
  return BUSY_PHASE_IDS.has(row.phaseId);
}

/**
 * Resolve the row's effective parent, or null when it should render as a root.
 *
 * A row nests only if its parent is present in the SAME row set. That one rule
 * absorbs every edge case — parent archived, settled, snoozed, filtered out,
 * deleted, or in another environment — without special-casing any of them, and
 * guarantees the result is a forest rooted in rows that actually render.
 */
function resolveParent(
  node: MutableNode,
  byKey: ReadonlyMap<string, MutableNode>,
): MutableNode | null {
  const parentKey = parentKeyOf(node.row);
  if (parentKey === null) return null;
  const parent = byKey.get(parentKey);
  if (parent === undefined || parent.key === node.key) return null;

  // Walk to the root before accepting the link. A cycle here means the stored
  // data is already corrupt; promoting the row to a root keeps the sidebar
  // usable instead of dropping the row or looping forever.
  const seen = new Set<string>([node.key]);
  let cursor: MutableNode | undefined = parent;
  for (let depth = 0; cursor !== undefined && depth < PHASE_SIDEBAR_TREE_MAX_DEPTH; depth += 1) {
    if (seen.has(cursor.key)) return null;
    seen.add(cursor.key);
    const nextKey = parentKeyOf(cursor.row);
    cursor = nextKey === null ? undefined : byKey.get(nextKey);
  }
  return cursor === undefined ? parent : null;
}

/**
 * Bottom-up rollup of the two derived facts a parent row renders: how many
 * sessions live under it, and whether any of them is doing work.
 */
function finalize(node: MutableNode, depth: number): void {
  node.depth = depth;
  let descendantCount = 0;
  let hasBusyDescendant = false;
  for (const child of node.children) {
    finalize(child, depth + 1);
    descendantCount += 1 + child.descendantCount;
    hasBusyDescendant = hasBusyDescendant || isBusy(child.row) || child.hasBusyDescendant;
  }
  node.descendantCount = descendantCount;
  node.hasBusyDescendant = hasBusyDescendant;
}

function freeze(node: MutableNode): PhaseSidebarTreeNode {
  return {
    row: node.row,
    key: node.key,
    children: node.children.map(freeze),
    depth: node.depth,
    descendantCount: node.descendantCount,
    hasBusyDescendant: node.hasBusyDescendant,
    orphanedFrom: node.orphanedFrom,
  };
}

/**
 * Build the forest for one sidebar section (active / snoozed / settled).
 *
 * `compareSiblings` orders both the returned roots and every child list, so a
 * subtree reads with the same ordering rules as the list it sits in.
 * `titleForKey` resolves orphan breadcrumbs against the full thread set, not
 * just this section, so "↳ Parent title" still names a settled or filtered
 * parent.
 */
export function buildPhaseSidebarTree(
  rows: ReadonlyArray<PhaseSidebarRow>,
  options: {
    readonly compareSiblings: (left: PhaseSidebarRow, right: PhaseSidebarRow) => number;
    readonly titleForKey?: (key: string) => string | null;
  },
): ReadonlyArray<PhaseSidebarTreeNode> {
  const nodes: MutableNode[] = rows.map((row) => ({
    row,
    key: phaseSidebarRowKey(row),
    children: [],
    depth: 0,
    descendantCount: 0,
    hasBusyDescendant: false,
    orphanedFrom: null,
  }));
  const byKey = new Map(nodes.map((node) => [node.key, node]));

  const roots: MutableNode[] = [];
  for (const node of nodes) {
    const parent = resolveParent(node, byKey);
    if (parent === null) {
      const parentKey = parentKeyOf(node.row);
      if (parentKey !== null) {
        const title = options.titleForKey?.(parentKey) ?? null;
        if (title !== null) node.orphanedFrom = { key: parentKey, title };
      }
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const sortRecursively = (list: MutableNode[]): void => {
    list.sort((left, right) => options.compareSiblings(left.row, right.row));
    for (const node of list) sortRecursively(node.children);
  };
  sortRecursively(roots);
  for (const root of roots) finalize(root, 0);

  return roots.map(freeze);
}

/**
 * The phase a ROOT row is grouped under.
 *
 * A parent whose subtree contains active work is pulled into Implementing, no
 * matter what its own phase says — a session that fanned work out is not "Ready"
 * while that work is still running, and the operator scanning for live work
 * needs to find it. Every other state follows the parent's own lifecycle: a
 * child waiting on input does not move its parent, because the child is the
 * thing that needs answering and it is one disclosure away.
 */
export function resolvePhaseSidebarTreePhase(node: PhaseSidebarTreeNode): PhaseSidebarPhaseId {
  return node.hasBusyDescendant ? "implementing" : node.row.phaseId;
}

/**
 * Render order, minus the subtrees the user has collapsed.
 *
 * Keyboard traversal (thread.previous / thread.next) and the thread.jump.1..9
 * indices both read this, so a collapsed child can never be focused by a key
 * that does not visibly move the selection.
 */
export function flattenPhaseSidebarTree(
  nodes: ReadonlyArray<PhaseSidebarTreeNode>,
  isExpanded: (key: string) => boolean,
): ReadonlyArray<PhaseSidebarTreeNode> {
  const flattened: PhaseSidebarTreeNode[] = [];
  const visit = (node: PhaseSidebarTreeNode): void => {
    flattened.push(node);
    if (node.children.length === 0 || !isExpanded(node.key)) return;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return flattened;
}

/** Every key in a subtree except its root — backs "Expand/Collapse all children". */
export function collectPhaseSidebarSubtreeKeys(node: PhaseSidebarTreeNode): ReadonlyArray<string> {
  const keys: string[] = [];
  const visit = (current: PhaseSidebarTreeNode): void => {
    for (const child of current.children) {
      keys.push(child.key);
      visit(child);
    }
  };
  visit(node);
  return keys;
}

/**
 * Keys of parents that must be force-expanded because a filter matched
 * something inside them. Without this, filtering by repository would silently
 * hide matches nested under a collapsed parent from another repository — the
 * exact cross-repo case this feature exists to make visible.
 */
export function resolveForcedExpansionKeys(
  nodes: ReadonlyArray<PhaseSidebarTreeNode>,
  matches: (row: PhaseSidebarRow) => boolean,
): ReadonlySet<string> {
  const forced = new Set<string>();
  const visit = (node: PhaseSidebarTreeNode): boolean => {
    let descendantMatched = false;
    for (const child of node.children) {
      descendantMatched = visit(child) || descendantMatched;
    }
    if (descendantMatched) forced.add(node.key);
    return descendantMatched || matches(node.row);
  };
  for (const node of nodes) visit(node);
  return forced;
}

/** Indentation in px for a nested row, capped so deep chains stay readable. */
export function phaseSidebarTreeIndent(depth: number): number {
  return Math.min(depth, PHASE_SIDEBAR_TREE_MAX_INDENT_DEPTH) * 14;
}

export function phaseSidebarFiltersActive(filters: PhaseSidebarFilters): boolean {
  return (
    filters.repositoryKeys.length > 0 ||
    filters.phaseIds.length > 0 ||
    filters.providerKinds.length > 0 ||
    // T3-CUSTOM(expbkt3): ownership and co-participant facets.
    filters.participantUserIds.length > 0 ||
    filters.ownedByMe
  );
}

export interface PhaseSidebarTreeGroup extends PhaseSidebarPhaseDefinition {
  readonly nodes: ReadonlyArray<PhaseSidebarTreeNode>;
}

export interface PhaseSidebarTreeGroupsResult {
  readonly groups: ReadonlyArray<PhaseSidebarTreeGroup>;
  /**
   * Parents the user did not open but that must render open anyway, because a
   * filter matched something inside them. Transient — never written to the
   * expansion store, so clearing the filter restores the user's own state.
   */
  readonly forcedExpansionKeys: ReadonlySet<string>;
}

/**
 * The full pipeline for one section: filter, nest, then group the roots.
 *
 * Filtering runs against the tree rather than the flat row list so a match is
 * never hidden inside a collapsed parent that does not itself match. A row
 * survives when it matches, or when anything in its subtree matches (its
 * ancestors are carried along to keep the path renderable).
 */
export function buildPhaseSidebarTreeGroups(input: {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly filters: PhaseSidebarFilters;
  readonly compareSiblings: (left: PhaseSidebarRow, right: PhaseSidebarRow) => number;
  readonly titleForKey?: (key: string) => string | null;
}): PhaseSidebarTreeGroupsResult {
  const candidates = input.rows.filter((row) => row.thread.archivedAt === null);
  const matches = (row: PhaseSidebarRow) => matchesPhaseSidebarFilters(row, input.filters);
  const filtersActive = phaseSidebarFiltersActive(input.filters);

  let survivingRows = candidates;
  if (filtersActive) {
    // Nest against the UNFILTERED set first, so ancestry is true lineage rather
    // than an artefact of what the filter happened to leave behind. A row is
    // kept when it matches; its ancestors come along to keep the path to it
    // renderable.
    const keep = new Set<string>();
    const visit = (node: PhaseSidebarTreeNode, ancestorKeys: ReadonlyArray<string>): void => {
      if (matches(node.row)) {
        keep.add(node.key);
        for (const ancestorKey of ancestorKeys) keep.add(ancestorKey);
      }
      const nextAncestors = [...ancestorKeys, node.key];
      for (const child of node.children) visit(child, nextAncestors);
    };
    for (const node of buildPhaseSidebarTree(candidates, {
      compareSiblings: input.compareSiblings,
    })) {
      visit(node, []);
    }
    survivingRows = candidates.filter((row) => keep.has(phaseSidebarRowKey(row)));
  }

  // Descendant counts and the busy rollup describe what actually renders.
  const tree = buildPhaseSidebarTree(survivingRows, {
    compareSiblings: input.compareSiblings,
    ...(input.titleForKey ? { titleForKey: input.titleForKey } : {}),
  });

  const groups = PHASE_SIDEBAR_PHASES.flatMap((phase) => {
    const nodes = tree.filter((node) => resolvePhaseSidebarTreePhase(node) === phase.id);
    return nodes.length > 0 ? [{ ...phase, nodes }] : [];
  });

  return {
    groups,
    forcedExpansionKeys: filtersActive
      ? resolveForcedExpansionKeys(tree, matches)
      : new Set<string>(),
  };
}
