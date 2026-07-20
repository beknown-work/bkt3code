import {
  computeTurnDurationMs,
  type OrchestrationLatestTurn,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";

const latestTurnState = (
  state: NonNullable<ThreadExecutionSnapshot["turn"]>["state"],
): OrchestrationLatestTurn["state"] => {
  switch (state) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "error";
    case "idle":
    case "starting":
    case "running":
    case "waiting-for-approval":
    case "waiting-for-input":
    case "stopping":
      return "running";
  }
};

/**
 * Projects observed execution transitions into historical turn presentation.
 * Provider routing/session metadata and message completion are deliberately
 * not consulted.
 */
export function withExecutionSnapshot<
  T extends { readonly latestTurn: OrchestrationLatestTurn | null },
>(thread: T, execution: ThreadExecutionSnapshot): T & { execution: ThreadExecutionSnapshot } {
  const turn = execution.turn;
  if (!turn?.providerTurnId) return { ...thread, execution };
  const previous = thread.latestTurn?.turnId === turn.providerTurnId ? thread.latestTurn : null;
  const completedAt = turn.completedAt;
  return {
    ...thread,
    execution,
    latestTurn: {
      ...(previous?.sourceProposedPlan ? { sourceProposedPlan: previous.sourceProposedPlan } : {}),
      turnId: turn.providerTurnId,
      state: latestTurnState(turn.state),
      requestedAt: previous?.requestedAt ?? turn.startedAt,
      startedAt: turn.startedAt,
      completedAt,
      assistantMessageId: previous?.assistantMessageId ?? null,
      durationMs: computeTurnDurationMs(turn.startedAt, completedAt),
    },
  };
}
