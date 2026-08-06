import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRateLimitSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderRateLimitRows,
  providerRateLimitBoundaryTimes,
  providerRateLimitTone,
  selectProviderRateLimitEnvironmentId,
  summarizeProviderRateLimitRows,
} from "./SidebarProviderRateLimits.logic.ts";

const now = Date.parse("2026-08-01T10:00:00.000Z");
const at = (value: string) => DateTime.makeUnsafe(value);
const provider = (driver: "codex" | "claudeAgent", enabled = true) => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled,
});
const snapshot = (
  driver: "codex" | "claudeAgent",
  usedPercents: ReadonlyArray<number>,
  overrides: Partial<ProviderRateLimitSnapshot> = {},
): ProviderRateLimitSnapshot => ({
  providerInstanceId: ProviderInstanceId.make(driver),
  driverKind: ProviderDriverKind.make(driver),
  availability: "available",
  windows: usedPercents.map((usedPercent, index) => ({
    windowId: `${driver}:${index}`,
    label: `Window ${index}`,
    usedPercent,
    resetsAt: at("2026-08-02T00:00:00.000Z"),
    category: "rolling",
  })),
  observedAt: at("2026-08-01T09:55:00.000Z"),
  lastRefreshFailed: false,
  ...overrides,
});
const limitWindow = (
  category: "rolling" | "weekly",
  usedPercent: number,
  resetsAt = "2026-08-02T00:00:00.000Z",
) => ({
  windowId: `codex:${category}`,
  label: category === "weekly" ? "Weekly" : "Rolling",
  usedPercent,
  resetsAt: at(resetsAt),
  category,
});

describe("weekly headline and rolling companion", () => {
  const weeklyRow = (windows: ReadonlyArray<ReturnType<typeof limitWindow>>) => {
    const [row] = buildProviderRateLimitRows({
      providers: [provider("codex")],
      entries: [snapshot("codex", [], { windows })],
      now,
    });
    if (row === undefined) throw new Error("expected a Codex row");
    return row;
  };

  it("reports the weekly window and ignores a healthier-looking rolling window", () => {
    const row = weeklyRow([limitWindow("rolling", 33), limitWindow("weekly", 6)]);

    expect(row.remainingPercent).toBe(94);
    expect(row.tone).toBe("healthy");
    expect(row.rolling).toBeNull();
  });

  it("surfaces the rolling window only once it drops below 50% remaining", () => {
    expect(weeklyRow([limitWindow("rolling", 50), limitWindow("weekly", 6)]).rolling).toBeNull();

    const row = weeklyRow([
      limitWindow("rolling", 60, "2026-08-01T11:08:00.000Z"),
      limitWindow("weekly", 6),
    ]);
    expect(row.remainingPercent).toBe(94);
    expect(row.rolling).toMatchObject({
      remainingPercent: 40,
      minutesUntilReset: 68,
      tone: "warning",
    });
    expect(summarizeProviderRateLimitRows([row])).toBe(
      "Provider usage limits: Codex 94% weekly remaining, rolling window 40% remaining and resets in 68 minutes",
    );
  });

  it("keeps the rolling countdown ticking by emitting per-minute boundaries", () => {
    const row = weeklyRow([
      limitWindow("rolling", 60, "2026-08-01T10:03:00.000Z"),
      limitWindow("weekly", 6),
    ]);
    const boundaries = providerRateLimitBoundaryTimes([row]);

    expect(boundaries).toContain(Date.parse("2026-08-01T10:02:00.000Z"));
    expect(boundaries).toContain(Date.parse("2026-08-01T10:01:00.000Z"));
    expect(boundaries).toContain(Date.parse("2026-08-01T10:00:00.000Z"));
  });

  it("falls back to the lowest window when the provider reports no weekly quota", () => {
    const row = weeklyRow([limitWindow("rolling", 26)]);

    expect(row.remainingPercent).toBe(74);
    expect(row.rolling).toBeNull();
  });
});

describe("buildProviderRateLimitRows", () => {
  it("orders Codex before Claude and uses the lowest remaining active window", () => {
    const rows = buildProviderRateLimitRows({
      providers: [provider("claudeAgent"), provider("codex")],
      entries: [snapshot("claudeAgent", [64]), snapshot("codex", [26, 41])],
      now,
    });

    expect(rows.map((row) => [row.driverKind, row.remainingPercent])).toEqual([
      ["codex", 59],
      ["claudeAgent", 36],
    ]);
    expect(rows[0]?.windows.map((window) => window.remainingPercent)).toEqual([59, 74]);
  });

  it("selects only enabled built-in default instances", () => {
    const rows = buildProviderRateLimitRows({
      providers: [
        provider("codex", false),
        provider("claudeAgent"),
        {
          instanceId: ProviderInstanceId.make("claude_work"),
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
        },
      ],
      entries: [
        snapshot("codex", [10]),
        snapshot("claudeAgent", [20]),
        {
          ...snapshot("claudeAgent", [90]),
          providerInstanceId: ProviderInstanceId.make("claude_work"),
        },
      ],
      now,
    });

    expect(rows.map((row) => row.driverKind)).toEqual(["claudeAgent"]);
    expect(rows[0]?.remainingPercent).toBe(80);
  });

  it("shows stale and reset windows as awaiting refresh instead of inferring 100%", () => {
    const staleRows = buildProviderRateLimitRows({
      providers: [provider("codex")],
      entries: [
        snapshot("codex", [25], {
          observedAt: at("2026-08-01T09:49:59.000Z"),
        }),
      ],
      now,
    });
    expect(staleRows[0]?.remainingPercent).toBe(75);
    expect(staleRows[0]?.freshness).toBe("stale");
    expect(staleRows[0]?.tone).toBe("unknown");
    expect(staleRows[0]?.windows[0]?.remainingPercent).toBe(75);

    const resetRows = buildProviderRateLimitRows({
      providers: [provider("codex")],
      entries: [
        snapshot("codex", [25], {
          windows: [
            {
              windowId: "codex:expired",
              label: "Expired",
              usedPercent: 25,
              resetsAt: at("2026-08-01T09:59:59.000Z"),
              category: "rolling",
            },
          ],
        }),
      ],
      now,
    });
    expect(resetRows[0]?.remainingPercent).toBe(75);
    expect(resetRows[0]?.freshness).toBe("stale");
    expect(resetRows[0]?.tone).toBe("unknown");
    expect(resetRows[0]?.windows[0]?.status).toBe("awaiting-refresh");
  });

  it("falls back to cached results when live data is unavailable and marks them stale", () => {
    const rows = buildProviderRateLimitRows({
      providers: [provider("codex")],
      entries: [],
      cachedEntries: [snapshot("codex", [26])],
      now,
    });

    expect(rows[0]).toMatchObject({
      remainingPercent: 74,
      freshness: "stale",
      tone: "unknown",
      source: "cache",
    });
    expect(summarizeProviderRateLimitRows(rows)).toBe(
      "Provider usage limits: Codex 74% weekly remaining, cached",
    );

    const failedRows = buildProviderRateLimitRows({
      providers: [provider("codex")],
      entries: [
        snapshot("codex", [], {
          availability: "error",
          windows: [],
          observedAt: null,
          lastRefreshFailed: true,
        }),
      ],
      cachedEntries: [snapshot("codex", [26])],
      now,
    });
    expect(failedRows[0]).toMatchObject({
      remainingPercent: 74,
      freshness: "stale",
      tone: "unknown",
      source: "cache",
    });
  });

  it("lets a live not-applicable result override an older cached subscription result", () => {
    const rows = buildProviderRateLimitRows({
      providers: [provider("codex")],
      entries: [
        snapshot("codex", [], {
          availability: "not-applicable",
          windows: [],
        }),
      ],
      cachedEntries: [snapshot("codex", [26])],
      now,
    });

    expect(rows[0]).toMatchObject({
      remainingPercent: null,
      freshness: "not-applicable",
      source: "live",
    });
  });

  it("retains enabled rows with an em dash when no reading is available", () => {
    const rows = buildProviderRateLimitRows({
      providers: [provider("codex"), provider("claudeAgent")],
      entries: [],
      now,
    });
    expect(rows.map((row) => row.remainingPercent)).toEqual([null, null]);
    expect(summarizeProviderRateLimitRows(rows)).toBe(
      "Provider usage limits: Codex unavailable; Claude unavailable",
    );
  });
});

it("uses the approved remaining-percentage thresholds", () => {
  expect(providerRateLimitTone(100)).toBe("healthy");
  expect(providerRateLimitTone(50)).toBe("healthy");
  expect(providerRateLimitTone(49)).toBe("warning");
  expect(providerRateLimitTone(20)).toBe("warning");
  expect(providerRateLimitTone(19)).toBe("danger");
  expect(providerRateLimitTone(0)).toBe("danger");
  expect(providerRateLimitTone(null)).toBe("unknown");
});

it("prefers the active environment and otherwise uses the primary environment", () => {
  const active = EnvironmentId.make("active-environment");
  const primary = EnvironmentId.make("primary-environment");

  expect(selectProviderRateLimitEnvironmentId(active, primary)).toBe(active);
  expect(selectProviderRateLimitEnvironmentId(null, primary)).toBe(primary);
  expect(selectProviderRateLimitEnvironmentId(null, null)).toBeNull();
});
