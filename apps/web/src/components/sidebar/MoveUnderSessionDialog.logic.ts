// T3-CUSTOM(expbkt3): candidate resolution for the "move under session" picker.
//
// Kept separate from the dialog so the rule that decides which sessions may
// become a parent is testable on its own — it is the client-side mirror of the
// server's cycle guard, and the two must not drift.
import type { ThreadShell } from "../../types";

export interface MoveUnderCandidate {
  readonly thread: ThreadShell;
  readonly label: string;
  readonly repositoryLabel: string;
}

/**
 * Every thread reachable downwards from `threadId`, excluding itself. Bounded
 * by the thread count: each id is enqueued at most once, so a corrupt cycle in
 * the projection cannot make this loop forever.
 */
export function collectDescendantThreadIds(
  threads: ReadonlyArray<ThreadShell>,
  threadId: string,
): ReadonlySet<string> {
  const descendants = new Set<string>();
  const queue: string[] = [threadId];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const thread of threads) {
      if ((thread.parentThreadId ?? null) !== current) continue;
      if (thread.id === threadId || descendants.has(thread.id)) continue;
      descendants.add(thread.id);
      queue.push(thread.id);
    }
  }
  return descendants;
}

/**
 * Candidate parents for `subject`, newest first, filtered by `query`.
 *
 * Excluded: the thread itself, its descendants (the server would reject those
 * as cycles, so offering them would only produce a confusing failure toast),
 * archived threads, its current parent (already there), and — because lineage
 * is a bare thread id resolved within one environment — anything from a
 * different environment.
 */
export function resolveMoveUnderCandidates(input: {
  readonly threads: ReadonlyArray<ThreadShell>;
  readonly subject: ThreadShell;
  readonly query: string;
  readonly repositoryLabelFor: (thread: ThreadShell) => string;
  readonly limit?: number;
}): ReadonlyArray<MoveUnderCandidate> {
  const sameEnvironment = input.threads.filter(
    (thread) => thread.environmentId === input.subject.environmentId,
  );
  const blocked = collectDescendantThreadIds(sameEnvironment, input.subject.id);
  const needle = input.query.trim().toLowerCase();

  return sameEnvironment
    .filter(
      (thread) =>
        thread.id !== input.subject.id &&
        !blocked.has(thread.id) &&
        thread.archivedAt === null &&
        thread.id !== (input.subject.parentThreadId ?? null) &&
        (needle.length === 0 || thread.title.toLowerCase().includes(needle)),
    )
    .toSorted(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, input.limit ?? 50)
    .map((thread) => ({
      thread,
      label: thread.title,
      repositoryLabel: input.repositoryLabelFor(thread),
    }));
}
