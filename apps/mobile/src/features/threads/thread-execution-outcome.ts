// T3-CUSTOM(expbkt3): durable execution terminal state is the authority for
// the visible outcome; latestTurn can have already advanced after a stop.
import type { ThreadExecutionSnapshot } from "@t3tools/contracts";

export function getThreadExecutionOutcome(execution: ThreadExecutionSnapshot | null | undefined) {
  const turn = execution?.turn;
  if (!turn?.completedAt) return null;
  // Providers can report a successful terminal event after honoring an
  // interrupt. The stop timestamp preserves the user's intent in that case.
  if (turn.state === "interrupted" || (turn.state === "completed" && turn.stopRequestedAt)) {
    return {
      kind: "stopped" as const,
      providerTurnId: turn.providerTurnId,
      detail: "This response was stopped before it completed.",
      title: "Agent stopped",
    };
  }
  if (turn.state === "failed") {
    return {
      kind: "failed" as const,
      providerTurnId: turn.providerTurnId,
      detail: turn.lastError ?? "The provider ended this response with an error.",
      title: "Agent failed",
    };
  }
  return null;
}
