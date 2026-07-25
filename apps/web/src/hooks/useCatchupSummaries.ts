import { useMemo } from "react";
import type { MessageId } from "@t3tools/contracts";
import type { CatchupSummary, Thread } from "../types";

/**
 * Index the thread's catch-up summaries by the assistant message they belong
 * under. Summaries recorded without an assistant message id are dropped: the
 * card is anchored to a turn's final output, so there is nowhere to render them.
 */
export function useCatchupSummaries(activeThread: Thread | null | undefined) {
  return useMemo(() => {
    const byMessageId = new Map<MessageId, CatchupSummary>();
    if (!activeThread) {
      return byMessageId;
    }
    for (const summary of activeThread.turnSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [activeThread]);
}
