type LatestTurnTiming = {
  readonly turnId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

type ExecutionActivityState = {
  readonly activity: "idle" | "active" | "blocked" | "stopping" | "failed";
  readonly turn: { readonly startedAt: string } | null;
};

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  execution: ExecutionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  return !execution || execution.activity === "idle" || execution.activity === "failed";
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  execution: ExecutionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (
    execution &&
    (execution.activity === "active" ||
      execution.activity === "blocked" ||
      execution.activity === "stopping")
  ) {
    return execution.turn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}
