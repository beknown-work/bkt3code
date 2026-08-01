import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRateLimitSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROVIDER_RATE_LIMIT_CACHE,
  ProviderRateLimitCacheDocumentSchema,
  providerRateLimitCacheEntries,
  updateProviderRateLimitCache,
} from "./SidebarProviderRateLimits.cache.ts";

const environmentId = EnvironmentId.make("environment-1");
const at = (value: string) => DateTime.makeUnsafe(value);
const snapshot = (
  overrides: Partial<ProviderRateLimitSnapshot> = {},
): ProviderRateLimitSnapshot => ({
  providerInstanceId: ProviderInstanceId.make("codex"),
  driverKind: ProviderDriverKind.make("codex"),
  availability: "available",
  windows: [
    {
      windowId: "codex:primary",
      label: "Primary",
      usedPercent: 25,
      resetsAt: at("2026-08-02T00:00:00.000Z"),
      category: "rolling",
    },
  ],
  observedAt: at("2026-08-01T10:00:00.000Z"),
  lastRefreshFailed: false,
  ...overrides,
});

describe("provider rate-limit cache", () => {
  it("keeps the newest successful reading per environment and provider", () => {
    const cached = updateProviderRateLimitCache(EMPTY_PROVIDER_RATE_LIMIT_CACHE, environmentId, [
      snapshot(),
    ]);
    const unchanged = updateProviderRateLimitCache(cached, environmentId, [
      snapshot({ observedAt: at("2026-08-01T09:59:00.000Z") }),
    ]);

    expect(unchanged).toBe(cached);
    expect(providerRateLimitCacheEntries(cached, environmentId)).toEqual([snapshot()]);
    expect(
      providerRateLimitCacheEntries(cached, EnvironmentId.make("another-environment")),
    ).toEqual([]);
  });

  it("retains cached data through unknown and failed readings", () => {
    const cached = updateProviderRateLimitCache(EMPTY_PROVIDER_RATE_LIMIT_CACHE, environmentId, [
      snapshot(),
    ]);
    const afterFailure = updateProviderRateLimitCache(cached, environmentId, [
      snapshot({ availability: "error", windows: [], lastRefreshFailed: true }),
    ]);

    expect(afterFailure).toBe(cached);
    expect(providerRateLimitCacheEntries(afterFailure, environmentId)).toHaveLength(1);
  });

  it("clears old subscription data when the provider reports not applicable", () => {
    const cached = updateProviderRateLimitCache(EMPTY_PROVIDER_RATE_LIMIT_CACHE, environmentId, [
      snapshot(),
    ]);
    const cleared = updateProviderRateLimitCache(cached, environmentId, [
      snapshot({ availability: "not-applicable", windows: [] }),
    ]);

    expect(providerRateLimitCacheEntries(cleared, environmentId)).toEqual([]);
  });

  it("round-trips normalized observations through the persisted schema", () => {
    const cached = updateProviderRateLimitCache(EMPTY_PROVIDER_RATE_LIMIT_CACHE, environmentId, [
      snapshot(),
    ]);
    const persistedSchema = Schema.fromJsonString(ProviderRateLimitCacheDocumentSchema);
    const encoded = Schema.encodeSync(persistedSchema)(cached);
    const decoded = Schema.decodeSync(persistedSchema)(encoded);

    expect(providerRateLimitCacheEntries(decoded, environmentId)).toEqual([snapshot()]);
  });
});
