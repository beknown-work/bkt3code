import {
  type EnvironmentId,
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRateLimitAvailability,
  ProviderRateLimitWindowCategory,
  TrimmedNonEmptyString,
  type ProviderRateLimitSnapshot as ProviderRateLimitSnapshotType,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const PROVIDER_RATE_LIMIT_CACHE_STORAGE_KEY = "t3code:provider-rate-limits:v1";

const CachedProviderRateLimitWindowSchema = Schema.Struct({
  windowId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  windowDurationMinutes: Schema.optionalKey(NonNegativeInt),
  category: ProviderRateLimitWindowCategory,
});

const CachedProviderRateLimitSnapshotSchema = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  availability: ProviderRateLimitAvailability,
  windows: Schema.Array(CachedProviderRateLimitWindowSchema),
  observedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastRefreshFailed: Schema.Boolean,
});

const ProviderRateLimitEnvironmentCacheSchema = Schema.Struct({
  entries: Schema.Array(CachedProviderRateLimitSnapshotSchema),
});

export const ProviderRateLimitCacheDocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  environments: Schema.Record(Schema.String, ProviderRateLimitEnvironmentCacheSchema),
});

export type ProviderRateLimitCacheDocument = typeof ProviderRateLimitCacheDocumentSchema.Type;

export const EMPTY_PROVIDER_RATE_LIMIT_CACHE: ProviderRateLimitCacheDocument = {
  version: 1,
  environments: {},
};

function snapshotSignature(snapshot: ProviderRateLimitSnapshotType): string {
  return JSON.stringify({
    ...snapshot,
    observedAt: snapshot.observedAt === null ? null : DateTime.toEpochMillis(snapshot.observedAt),
    windows: snapshot.windows.map((window) => ({
      ...window,
      resetsAt: window.resetsAt === null ? null : DateTime.toEpochMillis(window.resetsAt),
    })),
  });
}

function isCacheable(snapshot: ProviderRateLimitSnapshotType): boolean {
  return (
    snapshot.availability === "available" &&
    snapshot.observedAt !== null &&
    snapshot.windows.length > 0 &&
    !snapshot.lastRefreshFailed
  );
}

export function providerRateLimitCacheEntries(
  document: ProviderRateLimitCacheDocument,
  environmentId: EnvironmentId | null,
): ReadonlyArray<ProviderRateLimitSnapshotType> {
  if (environmentId === null) return [];
  return document.environments[String(environmentId)]?.entries ?? [];
}

export function updateProviderRateLimitCache(
  document: ProviderRateLimitCacheDocument,
  environmentId: EnvironmentId,
  liveEntries: ReadonlyArray<ProviderRateLimitSnapshotType>,
): ProviderRateLimitCacheDocument {
  const environmentKey = String(environmentId);
  const currentEntries = document.environments[environmentKey]?.entries ?? [];
  const nextById = new Map(
    currentEntries.map((entry) => [String(entry.providerInstanceId), entry]),
  );
  let changed = false;

  for (const entry of liveEntries) {
    const instanceKey = String(entry.providerInstanceId);
    if (entry.availability === "not-applicable") {
      changed = nextById.delete(instanceKey) || changed;
      continue;
    }
    if (!isCacheable(entry)) continue;

    const current = nextById.get(instanceKey);
    if (
      current?.observedAt != null &&
      entry.observedAt != null &&
      DateTime.toEpochMillis(current.observedAt) > DateTime.toEpochMillis(entry.observedAt)
    ) {
      continue;
    }
    if (current !== undefined && snapshotSignature(current) === snapshotSignature(entry)) {
      continue;
    }
    nextById.set(instanceKey, entry);
    changed = true;
  }

  if (!changed) return document;
  return {
    ...document,
    environments: {
      ...document.environments,
      [environmentKey]: {
        entries: Array.from(nextById.values()).toSorted((left, right) =>
          String(left.providerInstanceId).localeCompare(String(right.providerInstanceId)),
        ),
      },
    },
  };
}
