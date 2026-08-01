import type {
  ProviderRateLimitSnapshot,
  ProviderRateLimitsStreamSnapshot,
  ProviderRateLimitUpdate,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  increment,
  providerRateLimitRefreshFailuresTotal,
  providerRateLimitUpdatesTotal,
} from "../observability/Metrics.ts";
import * as ProviderService from "./Services/ProviderService.ts";

interface ProviderRateLimitEntryState {
  readonly snapshot: ProviderRateLimitSnapshot;
  readonly lastUpdateAt: DateTime.Utc;
}

interface ProviderRateLimitState {
  readonly revision: number;
  readonly entries: ReadonlyMap<string, ProviderRateLimitEntryState>;
}

interface ProviderRateLimitsShape {
  readonly snapshot: Effect.Effect<ProviderRateLimitsStreamSnapshot>;
  readonly stream: Stream.Stream<ProviderRateLimitsStreamSnapshot>;
}

const EMPTY_SNAPSHOT: ProviderRateLimitsStreamSnapshot = { revision: 0, entries: [] };

export class ProviderRateLimits extends Context.Reference<ProviderRateLimitsShape>(
  "t3/provider/ProviderRateLimits",
  {
    defaultValue: () => ({
      snapshot: Effect.succeed(EMPTY_SNAPSHOT),
      stream: Stream.make(EMPTY_SNAPSHOT),
    }),
  },
) {}

function mergeWindows(
  current: ProviderRateLimitSnapshot["windows"],
  incoming: ProviderRateLimitUpdate["windows"],
): ProviderRateLimitSnapshot["windows"] {
  const updates = new Map(incoming.map((window) => [window.windowId, window]));
  const merged = current.map((window) => updates.get(window.windowId) ?? window);
  const existingIds = new Set(current.map((window) => window.windowId));
  return [...merged, ...incoming.filter((window) => !existingIds.has(window.windowId))];
}

export function applyProviderRateLimitUpdate(
  current: ProviderRateLimitSnapshot,
  update: ProviderRateLimitUpdate,
): ProviderRateLimitSnapshot {
  if (
    current.observedAt !== null &&
    DateTime.toEpochMillis(update.observedAt) < DateTime.toEpochMillis(current.observedAt)
  ) {
    return current;
  }

  if (update.availability === "error") {
    if (current.availability === "available" || current.availability === "not-applicable") {
      return current.lastRefreshFailed ? current : { ...current, lastRefreshFailed: true };
    }
    return {
      ...current,
      availability: "error",
      observedAt: update.observedAt,
      lastRefreshFailed: true,
    };
  }

  if (update.availability === "not-applicable") {
    return {
      ...current,
      availability: "not-applicable",
      windows: [],
      observedAt: update.observedAt,
      lastRefreshFailed: false,
    };
  }

  return {
    ...current,
    availability: "available",
    windows:
      update.mode === "replace" ? update.windows : mergeWindows(current.windows, update.windows),
    observedAt: update.observedAt,
    lastRefreshFailed: false,
  };
}

function snapshotSignature(snapshot: ProviderRateLimitSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    observedAt: snapshot.observedAt === null ? null : DateTime.toEpochMillis(snapshot.observedAt),
    windows: snapshot.windows.map((window) => ({
      ...window,
      resetsAt: window.resetsAt === null ? null : DateTime.toEpochMillis(window.resetsAt),
    })),
  });
}

function toStreamSnapshot(state: ProviderRateLimitState): ProviderRateLimitsStreamSnapshot {
  return {
    revision: state.revision,
    entries: Array.from(state.entries.values(), (entry) => entry.snapshot),
  };
}

export const makeProviderRateLimits = Effect.fn("ProviderRateLimits.make")(function* (
  events: Stream.Stream<ProviderRuntimeEvent>,
) {
  const changes = yield* PubSub.unbounded<ProviderRateLimitsStreamSnapshot>();
  const state = yield* Ref.make<ProviderRateLimitState>({ revision: 0, entries: new Map() });

  const ingest = Effect.fn("ProviderRateLimits.ingest")(function* (event: ProviderRuntimeEvent) {
    if (event.type !== "account.rate-limits.updated" || event.providerInstanceId === undefined) {
      return;
    }
    const instanceKey = String(event.providerInstanceId);
    const update = event.payload.rateLimits;
    const changed = yield* Ref.modify(state, (current) => {
      const existing = current.entries.get(instanceKey);
      if (
        existing !== undefined &&
        DateTime.toEpochMillis(update.observedAt) < DateTime.toEpochMillis(existing.lastUpdateAt)
      ) {
        return [null, current] as const;
      }
      const currentSnapshot: ProviderRateLimitSnapshot = existing?.snapshot ?? {
        providerInstanceId: event.providerInstanceId!,
        driverKind: event.provider,
        availability: "unknown",
        windows: [],
        observedAt: null,
        lastRefreshFailed: false,
      };
      const nextSnapshot = applyProviderRateLimitUpdate(currentSnapshot, update);
      if (snapshotSignature(nextSnapshot) === snapshotSignature(currentSnapshot)) {
        const nextEntries = new Map(current.entries);
        nextEntries.set(instanceKey, {
          snapshot: currentSnapshot,
          lastUpdateAt: update.observedAt,
        });
        return [null, { ...current, entries: nextEntries }] as const;
      }
      const nextEntries = new Map(current.entries);
      nextEntries.set(instanceKey, { snapshot: nextSnapshot, lastUpdateAt: update.observedAt });
      const next = { revision: current.revision + 1, entries: nextEntries };
      return [toStreamSnapshot(next), next] as const;
    });

    yield* increment(providerRateLimitUpdatesTotal, {
      provider: event.provider,
      availability: update.availability,
      mode: update.mode,
    });
    if (update.availability === "error") {
      yield* increment(providerRateLimitRefreshFailuresTotal, { provider: event.provider });
    }
    if (changed !== null) {
      yield* PubSub.publish(changes, changed);
    }
  });

  yield* events.pipe(Stream.runForEach(ingest), Effect.forkScoped);

  return {
    snapshot: Ref.get(state).pipe(Effect.map(toStreamSnapshot)),
    get stream() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = toStreamSnapshot(yield* Ref.get(state));
          return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription)).pipe(
            Stream.changesWith((left, right) => left.revision === right.revision),
          );
        }),
      );
    },
  } satisfies ProviderRateLimitsShape;
});

const makeLive = Effect.gen(function* () {
  const providers = yield* ProviderService.ProviderService;
  return yield* makeProviderRateLimits(providers.streamEvents);
});

export const layer = Layer.effect(ProviderRateLimits, makeLive);
