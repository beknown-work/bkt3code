import {
  computeTurnDurationMs,
  type OrchestrationLatestTurn,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";

export function describeThreadExecution(
  execution: ThreadExecutionSnapshot | null | undefined,
  providerLabel = "agent",
): string | null {
  if (!execution) return null;
  const turn = execution.turn;
  if (execution.activity === "failed") {
    return turn?.lastError ?? execution.providerSession.lastError ?? "Agent execution failed.";
  }
  if (execution.activity === "stopping" || turn?.state === "stopping") {
    return "Stopping agent";
  }
  if (turn?.state === "waiting-for-approval") return "Waiting for approval";
  if (turn?.state === "waiting-for-input") return "Waiting for your input";
  if (execution.providerSession.state === "starting") {
    return `Starting ${providerLabel} session`;
  }
  if (turn?.state === "starting") return "Sending prompt to agent";
  if (turn?.state === "running") return "Agent is working";
  return null;
}

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
