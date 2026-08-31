// T3-CUSTOM(expbkt3): pure rules for dragging a row onto another.
//
// Kept free of gesture and react-native imports so the rules are testable
// without a renderer — a bad drop re-parents real work, so this is the part that
// has to be right before any animation exists.
//
// Two drop kinds, matching the web sidebar's two operations: dropping ON a row
// re-parents (move-under), dropping BETWEEN rows reorders a pin.
import {
  collectDescendantThreadIds,
  type PhaseSidebarRow,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { PHASE_SIDEBAR_TREE_MAX_DEPTH } from "@t3tools/client-runtime/state/phase-sidebar-tree";

export type PhaseSidebarDropTarget =
  | { readonly kind: "reparent"; readonly parentKey: string | null }
  | { readonly kind: "reorder"; readonly beforeKey: string | null };

export type PhaseSidebarDropRejection =
  | "same-thread"
  | "cross-environment"
  | "own-descendant"
  | "already-parent"
  | "too-deep"
  | "not-pinned";

export type PhaseSidebarDropVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: PhaseSidebarDropRejection };

const ALLOWED: PhaseSidebarDropVerdict = { allowed: true };
const reject = (reason: PhaseSidebarDropRejection): PhaseSidebarDropVerdict => ({
  allowed: false,
  reason,
});

/**
 * Whether `subject` may be re-parented under `target`.
 *
 * Rejects rather than clamps: a drop the reviewer did not intend is worse than
 * a drop that visibly refuses. Order matters — the cheapest identity checks run
 * before the descendant walk.
 */
export function validateReparent(input: {
  readonly subject: PhaseSidebarRow;
  readonly target: PhaseSidebarRow | null;
  readonly allRows: ReadonlyArray<PhaseSidebarRow>;
  /** Depth of the prospective parent, 0 for a root row. */
  readonly targetDepth: number;
}): PhaseSidebarDropVerdict {
  const subject = input.subject.thread;

  // Dropping on empty space means "make this a root thread".
  if (input.target === null) {
    return (subject.parentThreadId ?? null) === null ? reject("already-parent") : ALLOWED;
  }

  const target = input.target.thread;
  if (target.id === subject.id) return reject("same-thread");
  // Lineage is per environment: a thread cannot parent one on another server.
  if (target.environmentId !== subject.environmentId) return reject("cross-environment");
  if ((subject.parentThreadId ?? null) === target.id) return reject("already-parent");

  // The subject would become its own ancestor, which would orphan the subtree.
  const descendants = collectDescendantThreadIds(
    input.allRows.map((row) => row.thread),
    subject.id,
  );
  if (descendants.has(target.id)) return reject("own-descendant");

  // The subject's own subtree moves with it, so the deepest leaf decides.
  const subjectSubtreeDepth = measureSubtreeDepth(input.allRows, subject.id);
  if (input.targetDepth + 1 + subjectSubtreeDepth > PHASE_SIDEBAR_TREE_MAX_DEPTH) {
    return reject("too-deep");
  }

  return ALLOWED;
}

/** How many levels sit below `threadId`; 0 when it is a leaf. */
export function measureSubtreeDepth(
  rows: ReadonlyArray<PhaseSidebarRow>,
  threadId: string,
): number {
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    const parent = row.thread.parentThreadId ?? null;
    if (parent === null) continue;
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(row.thread.id);
    else childrenByParent.set(parent, [row.thread.id]);
  }

  const walk = (id: string, seen: ReadonlySet<string>): number => {
    const children = childrenByParent.get(id) ?? [];
    let deepest = 0;
    for (const child of children) {
      // Defensive: a cycle in server data must not hang the gesture.
      if (seen.has(child)) continue;
      deepest = Math.max(deepest, 1 + walk(child, new Set([...seen, child])));
    }
    return deepest;
  };

  return walk(threadId, new Set([threadId]));
}

/**
 * Whether `subject` may be reordered to sit before `beforeKey`.
 *
 * Reordering is a pin operation, so an unpinned row has nothing to reorder —
 * the affordance is hidden rather than offered and then refused.
 */
export function validateReorder(input: {
  readonly subject: PhaseSidebarRow;
  readonly target: PhaseSidebarRow | null;
}): PhaseSidebarDropVerdict {
  if (input.subject.thread.pinnedAt == null) return reject("not-pinned");
  if (input.target === null) return ALLOWED;
  if (input.target.thread.id === input.subject.thread.id) return reject("same-thread");
  if (input.target.thread.environmentId !== input.subject.thread.environmentId) {
    return reject("cross-environment");
  }
  if (input.target.thread.pinnedAt == null) return reject("not-pinned");
  return ALLOWED;
}

/** Wording for the drag overlay when a drop is refused. */
export function describePhaseSidebarDropRejection(reason: PhaseSidebarDropRejection): string {
  switch (reason) {
    case "same-thread":
      return "Already here";
    case "cross-environment":
      return "Different environment";
    case "own-descendant":
      return "Cannot nest under its own child";
    case "already-parent":
      return "Already there";
    case "too-deep":
      return "Nested too deep";
    case "not-pinned":
      return "Only pinned threads reorder";
  }
}
