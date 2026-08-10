// T3-CUSTOM(expbkt3): "Create new thread" from an experimental-sidebar row.
//
// The point of this entry point is side-by-side sessions that behave like tabs:
// you start one from the session you are already in, type into it later, and
// switching away and back finds it exactly where you left it. That rules out the
// local draft the "New thread" button creates — a draft is one-per-project,
// lives only in this browser, and never appears in the session tree, so it
// cannot be returned to from another row.
//
// So the thread is created for real, eagerly, with no first turn: a durable
// bootstrap request parented to the row that was right-clicked. The server
// persists it, the sidebar nests it under that row, and the chat view opens on
// an empty composer.
import type { RequestThreadBootstrapInput } from "@t3tools/client-runtime/state/threads";
import type { ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";

/** Which workspace the new session runs in. */
export type NewThreadWorkspaceChoice = "same-worktree" | "new-worktree";

/** The session the new thread is started from. */
export interface NewThreadParentThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly modelSelection: ModelSelection;
}

/**
 * Placeholder title. Sending the first message retitles the thread from that
 * message, so this only has to read sensibly while the thread is still empty.
 */
export const NEW_THREAD_FROM_ROW_TITLE = "New thread";

/**
 * Deterministic per-thread bootstrap id. The coordinator keys duplicate
 * requests off it, so a double-click resolves to the same bootstrap instead of
 * failing with "already has a different bootstrap request".
 */
export function newThreadFromRowBootstrapId(threadId: ThreadId): string {
  return `sidebar-new-thread:${threadId}`;
}

/**
 * "Same worktree" follows the parent wherever it runs: its worktree when it has
 * one, otherwise the project checkout it shares. "New worktree" leaves the base
 * ref unset so the server applies the project's own creation defaults, exactly
 * as pressing "New thread" would.
 */
export function buildNewThreadFromRowBootstrapInput(input: {
  readonly parent: NewThreadParentThread;
  readonly threadId: ThreadId;
  readonly choice: NewThreadWorkspaceChoice;
  readonly createdAt: string;
}): RequestThreadBootstrapInput {
  const { parent, threadId, choice, createdAt } = input;
  const workspace =
    choice === "new-worktree"
      ? ({ mode: "new-worktree" } as const)
      : parent.worktreePath !== null
        ? ({
            mode: "existing-worktree",
            path: parent.worktreePath,
            ...(parent.branch !== null ? { branch: parent.branch } : {}),
          } as const)
        : ({ mode: "local" } as const);
  return {
    bootstrapId: newThreadFromRowBootstrapId(threadId),
    threadId,
    projectId: parent.projectId,
    title: NEW_THREAD_FROM_ROW_TITLE,
    // A tab of the same work should answer with the same agent, so the provider
    // and model come from the parent rather than from the app defaults. Runtime
    // and interaction mode deliberately do not: inheriting Plan mode into a
    // fresh session surprises far more often than it helps.
    overrides: { modelSelection: parent.modelSelection, workspace },
    parentThreadId: parent.id,
    createdAt,
  };
}
