import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderRateLimitAvailability = Schema.Literals([
  "unknown",
  "available",
  "not-applicable",
  "error",
]);
export type ProviderRateLimitAvailability = typeof ProviderRateLimitAvailability.Type;

export const ProviderRateLimitWindowCategory = Schema.Literals([
  "rolling",
  "weekly",
  "model",
  "overage",
  "other",
]);
export type ProviderRateLimitWindowCategory = typeof ProviderRateLimitWindowCategory.Type;

export const ProviderRateLimitWindow = Schema.Struct({
  windowId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.NullOr(Schema.DateTimeUtc),
  windowDurationMinutes: Schema.optionalKey(NonNegativeInt),
  category: ProviderRateLimitWindowCategory,
});
export type ProviderRateLimitWindow = typeof ProviderRateLimitWindow.Type;

export const ProviderRateLimitUpdate = Schema.Struct({
  mode: Schema.Literals(["replace", "merge"]),
  availability: Schema.Literals(["available", "not-applicable", "error"]),
  windows: Schema.Array(ProviderRateLimitWindow),
  observedAt: Schema.DateTimeUtc,
});
export type ProviderRateLimitUpdate = typeof ProviderRateLimitUpdate.Type;

export const ProviderRateLimitSnapshot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  availability: ProviderRateLimitAvailability,
  windows: Schema.Array(ProviderRateLimitWindow),
  observedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastRefreshFailed: Schema.Boolean,
});
export type ProviderRateLimitSnapshot = typeof ProviderRateLimitSnapshot.Type;

export const ProviderRateLimitsStreamSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  entries: Schema.Array(ProviderRateLimitSnapshot),
});
export type ProviderRateLimitsStreamSnapshot = typeof ProviderRateLimitsStreamSnapshot.Type;
