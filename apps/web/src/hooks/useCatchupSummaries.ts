import { useMemo } from "react";
import type { TurnId } from "@t3tools/contracts";
import type { CatchupSummary, Thread } from "../types";

/**
 * Index the thread's catch-up summaries by turn.
 *
 * Keying by turn (rather than by the assistant message id recorded when the
 * summary was written) is deliberate: a turn can finish streaming more
 * assistant messages after the summary is produced, so the recorded id is not
 * reliably the terminal message the card renders under.
 */
export function useCatchupSummaries(activeThread: Thread | null | undefined) {
  return useMemo(() => {
    const byTurnId = new Map<TurnId, CatchupSummary>();
    if (!activeThread) {
      return byTurnId;
    }
    for (const summary of activeThread.turnSummaries) {
      byTurnId.set(summary.turnId, summary);
    }
    return byTurnId;
  }, [activeThread]);
}
