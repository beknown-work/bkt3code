/**
 * T3-CUSTOM(expbkt3): Codex provider rate-limit normalisation.
 *
 * Pure helpers translating Codex account rate-limit payloads into the fork's
 * ProviderRateLimitUpdate shape. Extracted from CodexAdapter.ts so the
 * upstream-owned adapter keeps a single marked import seam.
 */
import type { ProviderRateLimitUpdate } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type * as EffectCodexSchema from "effect-codex-app-server/schema";

/**
 * Local twin of CodexAdapter's `trimText`. Duplicated deliberately: importing it
 * from the adapter would make this module and the adapter mutually dependent.
 */
function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

type CodexRateLimitWindow = {
  readonly usedPercent: number;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
};

type CodexRateLimitBucket = {
  readonly limitId?: string | null;
  readonly limitName?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
};

function normalizeCodexRateLimitWindows(
  buckets: ReadonlyArray<readonly [string, CodexRateLimitBucket]>,
) {
  return buckets.flatMap(([fallbackId, bucket]) => {
    const bucketId = trimText(bucket.limitId) ?? fallbackId;
    const bucketName = trimText(bucket.limitName);
    return (["primary", "secondary"] as const).flatMap((position) => {
      const window = bucket[position];
      if (
        window === null ||
        window === undefined ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100
      ) {
        return [];
      }
      const duration = window.windowDurationMins ?? undefined;
      const resetsAt = window.resetsAt ?? undefined;
      return [
        {
          windowId: `codex:${bucketId}:${position}`,
          label: bucketName
            ? `${bucketName} ${position}`
            : position === "primary"
              ? "Primary"
              : "Secondary",
          usedPercent: window.usedPercent,
          resetsAt:
            resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt > 0
              ? DateTime.makeUnsafe(resetsAt * 1_000)
              : null,
          ...(duration !== undefined && Number.isInteger(duration) && duration >= 0
            ? { windowDurationMinutes: duration }
            : {}),
          category: duration !== undefined && duration >= 10_080 ? "weekly" : "rolling",
        } as const,
      ];
    });
  });
}

export function normalizeCodexRateLimitRead(
  response: EffectCodexSchema.V2GetAccountRateLimitsResponse,
  observedAt: DateTime.Utc,
): ProviderRateLimitUpdate {
  const multiBucketEntries = Object.entries(response.rateLimitsByLimitId ?? {});
  const buckets: ReadonlyArray<readonly [string, CodexRateLimitBucket]> =
    multiBucketEntries.length > 0 ? multiBucketEntries : [["default", response.rateLimits]];
  const windows = normalizeCodexRateLimitWindows(buckets);
  return {
    mode: "replace",
    availability: windows.length > 0 ? "available" : "not-applicable",
    windows,
    observedAt,
  };
}

export function normalizeCodexRateLimitNotification(
  notification: EffectCodexSchema.V2AccountRateLimitsUpdatedNotification,
  observedAt: DateTime.Utc,
): ProviderRateLimitUpdate {
  const bucket = notification.rateLimits;
  const windows = normalizeCodexRateLimitWindows([[trimText(bucket.limitId) ?? "default", bucket]]);
  return {
    mode: "merge",
    // This notification is explicitly sparse. An empty window set means
    // "no fields changed", not that subscription quotas stopped applying.
    availability: "available",
    windows,
    observedAt,
  };
}

export function codexRateLimitRefreshError(observedAt: DateTime.Utc): ProviderRateLimitUpdate {
  return {
    mode: "merge",
    availability: "error",
    windows: [],
    observedAt,
  };
}
