export interface ThreadVisitTimestampInput {
  readonly threadUpdatedAt: string;
  readonly latestTurnCompletedAt: string | null | undefined;
}

export function resolveThreadVisitTimestamp(input: ThreadVisitTimestampInput): string {
  const threadUpdatedAtMs = Date.parse(input.threadUpdatedAt);
  const latestTurnCompletedAt = input.latestTurnCompletedAt;
  const latestTurnCompletedAtMs = latestTurnCompletedAt
    ? Date.parse(latestTurnCompletedAt)
    : Number.NaN;
  if (
    latestTurnCompletedAt != null &&
    Number.isFinite(latestTurnCompletedAtMs) &&
    (!Number.isFinite(threadUpdatedAtMs) || latestTurnCompletedAtMs > threadUpdatedAtMs)
  ) {
    return latestTurnCompletedAt;
  }
  return input.threadUpdatedAt;
}
