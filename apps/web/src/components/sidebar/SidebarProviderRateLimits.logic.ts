import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRateLimitSnapshot,
  type ProviderRateLimitWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const STALE_AFTER_MS = 10 * 60 * 1_000;
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const DISPLAY_ORDER = [CODEX, CLAUDE] as const;

export function selectProviderRateLimitEnvironmentId(
  activeEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  return activeEnvironmentId ?? primaryEnvironmentId;
}

export type ProviderRateLimitTone = "healthy" | "warning" | "danger" | "unknown";
export type ProviderRateLimitFreshness = "fresh" | "stale" | "unknown" | "not-applicable" | "error";

export interface ProviderRateLimitHeaderProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly enabled: boolean;
}

export interface ProviderRateLimitWindowView {
  readonly window: ProviderRateLimitWindow;
  readonly remainingPercent: number | null;
  readonly status: "active" | "stale" | "awaiting-refresh";
}

export interface ProviderRateLimitRowView {
  readonly driverKind: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly displayName: "Codex" | "Claude";
  readonly availability: ProviderRateLimitSnapshot["availability"];
  readonly remainingPercent: number | null;
  readonly tone: ProviderRateLimitTone;
  readonly freshness: ProviderRateLimitFreshness;
  readonly observedAt: DateTime.Utc | null;
  readonly lastRefreshFailed: boolean;
  readonly windows: ReadonlyArray<ProviderRateLimitWindowView>;
}

export function providerRateLimitTone(remainingPercent: number | null): ProviderRateLimitTone {
  if (remainingPercent === null) return "unknown";
  if (remainingPercent >= 50) return "healthy";
  if (remainingPercent >= 20) return "warning";
  return "danger";
}

function roundedRemaining(usedPercent: number): number {
  return Math.round(100 - usedPercent);
}

function isSnapshotStale(snapshot: ProviderRateLimitSnapshot, now: number): boolean {
  return (
    snapshot.observedAt !== null &&
    now - DateTime.toEpochMillis(snapshot.observedAt) > STALE_AFTER_MS
  );
}

function windowView(
  window: ProviderRateLimitWindow,
  now: number,
  stale: boolean,
): ProviderRateLimitWindowView {
  if (stale) return { window, remainingPercent: null, status: "stale" };
  if (window.resetsAt !== null && DateTime.toEpochMillis(window.resetsAt) <= now) {
    return { window, remainingPercent: null, status: "awaiting-refresh" };
  }
  return { window, remainingPercent: roundedRemaining(window.usedPercent), status: "active" };
}

function displayName(driver: ProviderDriverKind): "Codex" | "Claude" {
  return driver === CODEX ? "Codex" : "Claude";
}

function unknownRow(
  driverKind: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
): ProviderRateLimitRowView {
  return {
    driverKind,
    providerInstanceId,
    displayName: displayName(driverKind),
    availability: "unknown",
    remainingPercent: null,
    tone: "unknown",
    freshness: "unknown",
    observedAt: null,
    lastRefreshFailed: false,
    windows: [],
  };
}

function projectRow(snapshot: ProviderRateLimitSnapshot, now: number): ProviderRateLimitRowView {
  const stale = isSnapshotStale(snapshot, now);
  const windows = snapshot.windows
    .map((window) => windowView(window, now, stale))
    .toSorted(
      (left, right) =>
        (left.remainingPercent ?? Number.POSITIVE_INFINITY) -
        (right.remainingPercent ?? Number.POSITIVE_INFINITY),
    );
  const remainingValues = windows.flatMap((window) =>
    window.remainingPercent === null ? [] : [window.remainingPercent],
  );
  const remainingPercent =
    snapshot.availability === "available" && remainingValues.length > 0
      ? Math.min(...remainingValues)
      : null;
  const freshness: ProviderRateLimitFreshness = stale
    ? "stale"
    : snapshot.availability === "not-applicable"
      ? "not-applicable"
      : snapshot.availability === "error"
        ? "error"
        : snapshot.observedAt === null
          ? "unknown"
          : "fresh";

  return {
    driverKind: snapshot.driverKind,
    providerInstanceId: snapshot.providerInstanceId,
    displayName: displayName(snapshot.driverKind),
    availability: snapshot.availability,
    remainingPercent,
    tone: providerRateLimitTone(remainingPercent),
    freshness,
    observedAt: snapshot.observedAt,
    lastRefreshFailed: snapshot.lastRefreshFailed,
    windows,
  };
}

export function buildProviderRateLimitRows(input: {
  readonly providers: ReadonlyArray<ProviderRateLimitHeaderProvider>;
  readonly entries: ReadonlyArray<ProviderRateLimitSnapshot>;
  readonly now: number;
}): ReadonlyArray<ProviderRateLimitRowView> {
  const entryById = new Map(input.entries.map((entry) => [entry.providerInstanceId, entry]));
  const providerById = new Map(input.providers.map((provider) => [provider.instanceId, provider]));

  return DISPLAY_ORDER.flatMap((driverKind) => {
    const defaultId = defaultInstanceIdForDriver(driverKind);
    const provider = providerById.get(defaultId);
    if (!provider?.enabled) return [];
    const entry = entryById.get(defaultId);
    return [entry === undefined ? unknownRow(driverKind, defaultId) : projectRow(entry, input.now)];
  });
}

export function summarizeProviderRateLimitRows(
  rows: ReadonlyArray<ProviderRateLimitRowView>,
): string {
  const readings = rows.map((row) =>
    row.remainingPercent === null
      ? `${row.displayName} unavailable`
      : `${row.displayName} ${row.remainingPercent}% remaining`,
  );
  return `Provider usage limits: ${readings.join("; ")}`;
}

export function providerRateLimitBoundaryTimes(
  rows: ReadonlyArray<ProviderRateLimitRowView>,
): ReadonlyArray<number> {
  return rows.flatMap((row) => [
    ...(row.observedAt === null
      ? []
      : [DateTime.toEpochMillis(row.observedAt) + STALE_AFTER_MS + 1]),
    ...row.windows.flatMap(({ window }) =>
      window.resetsAt === null ? [] : [DateTime.toEpochMillis(window.resetsAt)],
    ),
  ]);
}
