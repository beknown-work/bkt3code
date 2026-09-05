/**
 * T3-CUSTOM(expbkt3): Claude provider rate-limit normalisation.
 *
 * Pure helpers translating Claude SDK usage/rate-limit payloads into the fork's
 * ProviderRateLimitUpdate shape. Extracted from ClaudeAdapter.ts so the
 * upstream-owned adapter keeps a single marked import seam.
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRateLimitUpdate, ProviderRateLimitWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const CLAUDE_RATE_LIMIT_WINDOWS = {
  five_hour: {
    windowId: "claude:five-hour",
    label: "Five-hour",
    windowDurationMinutes: 300,
    category: "rolling",
  },
  seven_day: {
    windowId: "claude:seven-day",
    label: "Seven-day",
    windowDurationMinutes: 10_080,
    category: "weekly",
  },
  seven_day_oauth_apps: {
    windowId: "claude:oauth-apps",
    label: "OAuth apps",
    windowDurationMinutes: 10_080,
    category: "weekly",
  },
  seven_day_overage_included: {
    windowId: "claude:overage-included",
    label: "Weekly · included overage",
    windowDurationMinutes: 10_080,
    category: "model",
  },
  seven_day_opus: {
    windowId: "claude:opus",
    label: "Opus",
    windowDurationMinutes: 10_080,
    category: "model",
  },
  seven_day_sonnet: {
    windowId: "claude:sonnet",
    label: "Sonnet",
    windowDurationMinutes: 10_080,
    category: "model",
  },
  overage: {
    windowId: "claude:overage",
    label: "Extra usage",
    category: "overage",
  },
} as const;

function validUsedPercent(value: number | null | undefined): value is number {
  return (
    value !== null && value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100
  );
}

function resetAtFromIso(value: string | null | undefined): DateTime.Utc | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return DateTime.makeUnsafe(value);
}

function resetAtFromEpochSeconds(value: number | undefined): DateTime.Utc | null {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? DateTime.makeUnsafe(value * 1_000)
    : null;
}

export function normalizeClaudeUsageResponse(
  response: SDKControlGetUsageResponse,
  observedAt: DateTime.Utc,
): ProviderRateLimitUpdate {
  if (!response.rate_limits_available || response.rate_limits === null) {
    return {
      mode: "replace",
      availability: "not-applicable",
      windows: [],
      observedAt,
    };
  }

  const limits = response.rate_limits;
  const windowKeys = [
    "five_hour",
    "seven_day",
    "seven_day_oauth_apps",
    "seven_day_opus",
    "seven_day_sonnet",
  ] as const;
  const windows: Array<ProviderRateLimitWindow> = windowKeys.flatMap((key) => {
    const source = limits[key];
    if (!source || !validUsedPercent(source.utilization)) return [];
    const definition = CLAUDE_RATE_LIMIT_WINDOWS[key];
    return [
      {
        ...definition,
        usedPercent: source.utilization,
        resetsAt: resetAtFromIso(source.resets_at),
      },
    ];
  });

  const overage = limits.extra_usage;
  if (overage?.is_enabled && validUsedPercent(overage.utilization)) {
    windows.push({
      ...CLAUDE_RATE_LIMIT_WINDOWS.overage,
      usedPercent: overage.utilization,
      resetsAt: null,
    });
  }

  return {
    mode: "replace",
    availability: "available",
    windows,
    observedAt,
  };
}

export function normalizeClaudeRateLimitEvent(
  info: SDKRateLimitInfo,
  observedAt: DateTime.Utc,
): ProviderRateLimitUpdate {
  const type = info.rateLimitType;
  if (type === undefined || !validUsedPercent(info.utilization)) {
    return { mode: "merge", availability: "available", windows: [], observedAt };
  }
  const definition = CLAUDE_RATE_LIMIT_WINDOWS[type];
  return {
    mode: "merge",
    availability: "available",
    windows: [
      {
        ...definition,
        usedPercent: info.utilization,
        resetsAt: resetAtFromEpochSeconds(
          type === "overage" ? (info.overageResetsAt ?? info.resetsAt) : info.resetsAt,
        ),
      },
    ],
    observedAt,
  };
}

export function claudeRateLimitRefreshError(observedAt: DateTime.Utc): ProviderRateLimitUpdate {
  return { mode: "merge", availability: "error", windows: [], observedAt };
}
