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
  readonly source: "live" | "cache";
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
  if (window.resetsAt !== null && DateTime.toEpochMillis(window.resetsAt) <= now) {
    return {
      window,
      remainingPercent: roundedRemaining(window.usedPercent),
      status: "awaiting-refresh",
    };
  }
  if (stale) {
    return { window, remainingPercent: roundedRemaining(window.usedPercent), status: "stale" };
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
    source: "live",
    windows: [],
  };
}

function projectRow(
  snapshot: ProviderRateLimitSnapshot,
  now: number,
  source: "live" | "cache",
): ProviderRateLimitRowView {
  const stale =
    snapshot.availability === "available" &&
    (source === "cache" || snapshot.lastRefreshFailed || isSnapshotStale(snapshot, now));
  const windows = snapshot.windows
    .map((window) => windowView(window, now, stale))
    .toSorted(
      (left, right) =>
        (left.remainingPercent ?? Number.POSITIVE_INFINITY) -
        (right.remainingPercent ?? Number.POSITIVE_INFINITY),
    );
  const activeRemainingValues = windows.flatMap((window) =>
    window.status !== "active" || window.remainingPercent === null ? [] : [window.remainingPercent],
  );
  const lastKnownRemainingValues = windows.flatMap((window) =>
    window.remainingPercent === null ? [] : [window.remainingPercent],
  );
  const remainingValues = stale
    ? lastKnownRemainingValues
    : activeRemainingValues.length > 0
      ? activeRemainingValues
      : lastKnownRemainingValues;
  const remainingPercent =
    snapshot.availability === "available" && remainingValues.length > 0
      ? Math.min(...remainingValues)
      : null;
  const hasOnlyExpiredWindows =
    snapshot.availability === "available" &&
    windows.length > 0 &&
    activeRemainingValues.length === 0;
  const freshness: ProviderRateLimitFreshness =
    snapshot.availability === "not-applicable"
      ? "not-applicable"
      : snapshot.availability === "error"
        ? "error"
        : stale || hasOnlyExpiredWindows
          ? "stale"
          : snapshot.observedAt === null
            ? "unknown"
            : "fresh";

  return {
    driverKind: snapshot.driverKind,
    providerInstanceId: snapshot.providerInstanceId,
    displayName: displayName(snapshot.driverKind),
    availability: snapshot.availability,
    remainingPercent,
    tone: freshness === "fresh" ? providerRateLimitTone(remainingPercent) : "unknown",
    freshness,
    observedAt: snapshot.observedAt,
    lastRefreshFailed: snapshot.lastRefreshFailed,
    source,
    windows,
  };
}

function canUseLiveSnapshot(snapshot: ProviderRateLimitSnapshot): boolean {
  return (
    snapshot.availability === "not-applicable" ||
    (snapshot.availability === "available" &&
      snapshot.observedAt !== null &&
      snapshot.windows.length > 0)
  );
}

export function buildProviderRateLimitRows(input: {
  readonly providers: ReadonlyArray<ProviderRateLimitHeaderProvider>;
  readonly entries: ReadonlyArray<ProviderRateLimitSnapshot>;
  readonly cachedEntries?: ReadonlyArray<ProviderRateLimitSnapshot>;
  readonly now: number;
}): ReadonlyArray<ProviderRateLimitRowView> {
  const entryById = new Map(input.entries.map((entry) => [entry.providerInstanceId, entry]));
  const cachedEntryById = new Map(
    (input.cachedEntries ?? []).map((entry) => [entry.providerInstanceId, entry]),
  );
  const providerById = new Map(input.providers.map((provider) => [provider.instanceId, provider]));

  return DISPLAY_ORDER.flatMap((driverKind) => {
    const defaultId = defaultInstanceIdForDriver(driverKind);
    const provider = providerById.get(defaultId);
    if (!provider?.enabled) return [];
    const liveEntry = entryById.get(defaultId);
    if (liveEntry !== undefined && canUseLiveSnapshot(liveEntry)) {
      return [projectRow(liveEntry, input.now, "live")];
    }
    const cachedEntry = cachedEntryById.get(defaultId);
    if (cachedEntry !== undefined && cachedEntry.availability === "available") {
      return [projectRow(cachedEntry, input.now, "cache")];
    }
    return [
      liveEntry === undefined
        ? unknownRow(driverKind, defaultId)
        : projectRow(liveEntry, input.now, "live"),
    ];
  });
}

export function summarizeProviderRateLimitRows(
  rows: ReadonlyArray<ProviderRateLimitRowView>,
): string {
  const readings = rows.map((row) =>
    row.remainingPercent === null
      ? `${row.displayName} unavailable`
      : `${row.displayName} ${row.remainingPercent}% remaining${
          row.source === "cache" ? ", cached" : row.freshness === "stale" ? ", stale" : ""
        }`,
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
