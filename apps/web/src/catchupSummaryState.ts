/**
 * T3-CUSTOM(expbkt3): Optimistic catch-up request state. The server remains
 * authoritative, while this small layer makes the existing card appear before
 * the command round trip and keeps command failures inside that same card.
 */
import type { TurnId } from "@t3tools/contracts";

import type { CatchupSummary } from "./types";

const CATCHUP_REQUEST_ERROR_FALLBACK =
  "The catch-up request could not be sent. Check the connection and try again.";

export function makePendingCatchupSummary(turnId: TurnId, createdAt: string): CatchupSummary {
  return {
    turnId,
    assistantMessageId: null,
    summary: null,
    status: "pending",
    createdAt,
  };
}

export function makeCatchupRequestError(
  turnId: TurnId,
  createdAt: string,
  error: unknown,
): CatchupSummary {
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    turnId,
    assistantMessageId: null,
    summary: message.length > 0 ? message : CATCHUP_REQUEST_ERROR_FALLBACK,
    status: "error",
    createdAt,
  };
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The optimistic entry wins only until the server publishes an equally-new or
 * newer pending/ready/error record for the same request.
 */
export function mergeCatchupSummaryMaps(
  serverByTurnId: ReadonlyMap<TurnId, CatchupSummary>,
  transientByTurnId: ReadonlyMap<TurnId, CatchupSummary>,
): ReadonlyMap<TurnId, CatchupSummary> {
  const merged = new Map(serverByTurnId);
  for (const [turnId, transient] of transientByTurnId) {
    const server = serverByTurnId.get(turnId);
    if (!server || timestamp(transient.createdAt) > timestamp(server.createdAt)) {
      merged.set(turnId, transient);
    }
  }
  return merged;
}
