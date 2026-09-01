// T3-CUSTOM(expbkt3): Provider rate-limit presentation, shared by web and mobile.
//
// Moved out of apps/web (SidebarProviderRateLimits.logic.ts, which keeps a
// re-export shim) so the mobile status strip renders the same numbers as the
// web sidebar chip. Pure: contracts and effect/DateTime only.
//
// HERMES: this also runs under React Native. Sort a copy with `.sort()`,
// never `.toSorted()`.
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
const MINUTE_MS = 60 * 1_000;
const MINUTES_PER_DAY = 24 * 60;
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const DISPLAY_ORDER = [CODEX, CLAUDE] as const;

/**
 * T3-CUSTOM(expbkt3): the headline reading is the weekly window only.
 *
 * It used to be `min()` across every window, which meant the short rolling
 * window (Claude's five-hour, Codex's primary) almost always won and the
 * sidebar silently reported a five-hour number under a weekly-looking meter.
 * The rolling window is now surfaced separately, and only once it actually
 * constrains you -- see ROLLING_CHIP_VISIBLE_BELOW_PERCENT.
 */
const ROLLING_CHIP_VISIBLE_BELOW_PERCENT = 50;

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

/**
 * The short rolling window (five-hour on Claude, primary on Codex), shown beside
 * the weekly meter only while it is the tighter constraint.
 */
export interface ProviderRateLimitRollingView {
  readonly remainingPercent: number;
  readonly minutesUntilReset: number | null;
  readonly resetsAtMs: number | null;
  readonly tone: ProviderRateLimitTone;
  /** Compact window length, e.g. `5h`. Null when the provider omits a duration. */
  readonly windowLabel: string | null;
}

/**
 * Minutes as the shortest readable unit: `47m`, `1h 8m`, `5h`. Used for both the
 * window length and its reset countdown so the chip reads consistently.
 */
export function formatCompactMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * A single unit, rounded up: `6d`, `18h`, `45m`. The weekly countdown sits in the
 * sidebar permanently, so it trades the compound form's precision for a label
 * that never grows past three characters.
 */
export function formatSingleUnitMinutes(minutes: number): string {
  if (minutes >= MINUTES_PER_DAY) return `${Math.ceil(minutes / MINUTES_PER_DAY)}d`;
  if (minutes >= 60) return `${Math.ceil(minutes / 60)}h`;
  return `${Math.max(1, minutes)}m`;
}

/**
 * When {@link formatSingleUnitMinutes} would next print something different.
 * Rounding up means the label changes as the remaining time crosses each whole
 * unit, so the sidebar can wake exactly then instead of ticking every minute for
 * a week.
 */
export function singleUnitBoundaryMs(resetsAtMs: number, minutesUntilReset: number): number {
  const unitMinutes =
    minutesUntilReset >= MINUTES_PER_DAY ? MINUTES_PER_DAY : minutesUntilReset >= 60 ? 60 : 1;
  const wholeUnits = Math.ceil(minutesUntilReset / unitMinutes);
  return resetsAtMs - (wholeUnits - 1) * unitMinutes * MINUTE_MS;
}

export interface ProviderRateLimitRowView {
  readonly driverKind: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly displayName: "Codex" | "Claude";
  readonly availability: ProviderRateLimitSnapshot["availability"];
  /** Weekly window only. Null when the provider reports no weekly quota. */
  readonly remainingPercent: number | null;
  /**
   * When the window behind {@link remainingPercent} refills. Always rendered, so
   * the headline percentage is never read without knowing how long it has to last.
   */
  readonly headlineMinutesUntilReset: number | null;
  readonly headlineResetsAtMs: number | null;
  readonly rolling: ProviderRateLimitRollingView | null;
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

function minutesUntilReset(resetsAt: DateTime.Utc | null, now: number): number | null {
  if (resetsAt === null) return null;
  return Math.max(0, Math.ceil((DateTime.toEpochMillis(resetsAt) - now) / MINUTE_MS));
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
    headlineMinutesUntilReset: null,
    headlineResetsAtMs: null,
    rolling: null,
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
    .sort(
      (left, right) =>
        (left.remainingPercent ?? Number.POSITIVE_INFINITY) -
        (right.remainingPercent ?? Number.POSITIVE_INFINITY),
    );
  const activeRemainingValues = windows.flatMap((window) =>
    window.status !== "active" || window.remainingPercent === null ? [] : [window.remainingPercent],
  );
  // `windows` is already sorted ascending by remaining, so the head of a pool is
  // its lowest reading.
  const lowestOf = (
    views: ReadonlyArray<ProviderRateLimitWindowView>,
  ): ProviderRateLimitWindowView | null => {
    const known = views.filter((view) => view.remainingPercent !== null);
    const active = known.filter((view) => view.status === "active");
    const pool = stale ? known : active.length > 0 ? active : known;
    return pool[0] ?? null;
  };
  const weeklyWindows = windows.filter(({ window }) => window.category === "weekly");
  // Providers that report no weekly quota keep the previous all-window reading
  // rather than degrading the meter to an em dash.
  const headline = lowestOf(weeklyWindows.length > 0 ? weeklyWindows : windows);
  const remainingPercent =
    snapshot.availability === "available" ? (headline?.remainingPercent ?? null) : null;
  const headlineResetsAt = remainingPercent === null ? null : (headline?.window.resetsAt ?? null);
  const rollingLowest = lowestOf(windows.filter(({ window }) => window.category === "rolling"));
  const rollingRemaining = rollingLowest?.remainingPercent ?? null;
  const rolling: ProviderRateLimitRollingView | null =
    snapshot.availability === "available" &&
    rollingRemaining !== null &&
    rollingRemaining < ROLLING_CHIP_VISIBLE_BELOW_PERCENT
      ? {
          remainingPercent: rollingRemaining,
          minutesUntilReset: minutesUntilReset(rollingLowest?.window.resetsAt ?? null, now),
          resetsAtMs:
            rollingLowest?.window.resetsAt == null
              ? null
              : DateTime.toEpochMillis(rollingLowest.window.resetsAt),
          tone: providerRateLimitTone(rollingRemaining),
          windowLabel:
            rollingLowest?.window.windowDurationMinutes === undefined
              ? null
              : formatCompactMinutes(rollingLowest.window.windowDurationMinutes),
        }
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
    headlineMinutesUntilReset: minutesUntilReset(headlineResetsAt, now),
    headlineResetsAtMs: headlineResetsAt === null ? null : DateTime.toEpochMillis(headlineResetsAt),
    rolling:
      rolling === null ? null : freshness === "fresh" ? rolling : { ...rolling, tone: "unknown" },
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
  const readings = rows.map((row) => {
    const rolling =
      row.rolling === null
        ? ""
        : `, ${row.rolling.windowLabel ?? "rolling"} window ${
            row.rolling.remainingPercent
          }% remaining${
            row.rolling.minutesUntilReset === null
              ? ""
              : ` and resets in ${formatCompactMinutes(row.rolling.minutesUntilReset)}`
          }`;
    const headlineReset =
      row.headlineMinutesUntilReset === null
        ? ""
        : `, resets in ${formatSingleUnitMinutes(row.headlineMinutesUntilReset)}`;
    return row.remainingPercent === null
      ? `${row.displayName} unavailable${rolling}`
      : `${row.displayName} ${row.remainingPercent}% weekly remaining${headlineReset}${
          row.source === "cache" ? ", cached" : row.freshness === "stale" ? ", stale" : ""
        }${rolling}`;
  });
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
    ...rollingMinuteBoundaries(row.rolling),
    // The always-on weekly countdown moves a unit at a time, so one wake-up per
    // unit is enough — a per-minute schedule would be ~10k timers for a week.
    ...(row.headlineResetsAtMs === null || row.headlineMinutesUntilReset === null
      ? []
      : [singleUnitBoundaryMs(row.headlineResetsAtMs, row.headlineMinutesUntilReset)]),
  ]);
}

/**
 * While the rolling countdown is on screen it has to re-render every minute, so
 * emit each remaining minute boundary before its reset.
 */
function rollingMinuteBoundaries(
  rolling: ProviderRateLimitRollingView | null,
): ReadonlyArray<number> {
  const resetsAtMs = rolling?.resetsAtMs;
  const minutes = rolling?.minutesUntilReset;
  if (resetsAtMs == null || minutes == null) return [];
  return Array.from({ length: minutes }, (_, index) => resetsAtMs - (index + 1) * MINUTE_MS);
}
