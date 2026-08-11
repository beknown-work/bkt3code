import { useMemo, useRef } from "react";
import type { ThreadId, TurnId } from "@t3tools/contracts";
import type { CatchupSummary, Thread } from "../types";

/**
 * Index the thread's catch-up summaries by turn, holding finished notes steady.
 *
 * Keying by turn (rather than by the assistant message id recorded when the
 * summary was written) is deliberate: a turn can finish streaming more
 * assistant messages after the summary is produced, so the recorded id is not
 * reliably the terminal message the card renders under.
 *
 * A finished ("ready" or "error") note is also cached for the lifetime of the mounted
 * thread. Thread detail and thread shell arrive on independent subscriptions,
 * so on reload or reconnect the detail can momentarily resolve without its
 * summaries — without this cache the card blinks out and back in. Notes are
 * immutable facts about a settled turn, so serving the last known one is always
 * correct; a regenerate replaces it as soon as the new text arrives.
 *
 * Pending markers are deliberately NOT cached: a spinner must be able to
 * disappear when the server retracts it (summarization failed, or the turn came
 * in under the cutoff).
 */
export function useCatchupSummaries(activeThread: Thread | null | undefined) {
  const threadId = activeThread?.id ?? null;
  const cacheRef = useRef<{
    threadId: ThreadId | null;
    settledByTurnId: Map<TurnId, CatchupSummary>;
  }>({ threadId: null, settledByTurnId: new Map() });

  return useMemo(() => {
    const cache = cacheRef.current;
    if (cache.threadId !== threadId) {
      cache.threadId = threadId;
      cache.settledByTurnId = new Map();
    }

    // Start from cached settled notes so a transient absence cannot blank them.
    const byTurnId = new Map<TurnId, CatchupSummary>(cache.settledByTurnId);
    for (const summary of activeThread?.turnSummaries ?? []) {
      byTurnId.set(summary.turnId, summary);
      if (summary.status === "ready" || summary.status === "error") {
        cache.settledByTurnId.set(summary.turnId, summary);
      } else {
        // A turn that went back to pending (regenerate) must not keep showing
        // the stale note underneath once the new one lands.
        cache.settledByTurnId.delete(summary.turnId);
      }
    }

    return byTurnId;
  }, [activeThread, threadId]);
}
