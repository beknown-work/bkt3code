/**
 * T3-CUSTOM(expbkt3): one upstream read per issue, however many people are looking.
 *
 * The sidebar re-requests every visible issue once a minute, per open client.
 * The resolver underneath it had no cache and no coalescing, so the cost was
 * multiplied by every viewer and every browser tab: two people with the sidebar
 * open on thirty tagged threads were fifty upstream reads a minute, for data
 * that is identical for all of them and changes a few times a day.
 *
 * Issue status is workspace-global — it does not vary by viewer — so it caches
 * cleanly. This holds a short-lived entry per identifier and a Deferred per
 * in-flight identifier, so concurrent callers asking for the same issue wait on
 * one read instead of starting their own.
 */
import type { LinearIssueStatusSummary } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * Slightly under the sidebar's own 55s stale time, so a client that refreshes on
 * the minute boundary still gets a fresh read rather than being served an entry
 * that is about to expire anyway.
 */
export const DEFAULT_STATUS_TTL_MS = 50_000;

/**
 * Failures expire fast. A misconfigured credential or a bridge that is briefly
 * down should not pin "unavailable" on a row for a full minute after it starts
 * working again — but retrying every single request would hammer whatever is
 * already failing.
 */
export const DEFAULT_ERROR_TTL_MS = 5_000;

interface CacheEntry {
  readonly summary: LinearIssueStatusSummary;
  readonly expiresAt: number;
}

interface CacheState {
  readonly entries: Map<string, CacheEntry>;
  readonly inflight: Map<string, Deferred.Deferred<LinearIssueStatusSummary>>;
}

export interface LinearIssueStatusCacheOptions {
  readonly ttlMs?: number;
  readonly errorTtlMs?: number;
  /** Guards against a pathological identifier set pinning memory indefinitely. */
  readonly maxEntries?: number;
}

export interface LinearIssueStatusCache {
  /**
   * Resolves every identifier, calling `fetchMissing` at most once for the ones
   * this call is responsible for. Identifiers already being fetched by another
   * caller are awaited, not re-fetched.
   */
  readonly resolve: (
    identifiers: ReadonlyArray<string>,
    fetchMissing: (
      missing: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LinearIssueStatusSummary>>,
  ) => Effect.Effect<ReadonlyArray<LinearIssueStatusSummary>>;
}

const MAX_ENTRIES = 500;

export const makeLinearIssueStatusCache = (
  options: LinearIssueStatusCacheOptions = {},
): Effect.Effect<LinearIssueStatusCache> =>
  Effect.gen(function* () {
    const ttlMs = options.ttlMs ?? DEFAULT_STATUS_TTL_MS;
    const errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
    const maxEntries = options.maxEntries ?? MAX_ENTRIES;
    const state = yield* SynchronizedRef.make<CacheState>({
      entries: new Map(),
      inflight: new Map(),
    });

    const prune = (entries: Map<string, CacheEntry>, now: number) => {
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(key);
      }
      // Oldest-expiry first, so a burst of one-off identifiers cannot evict the
      // rows the sidebar actually keeps asking for.
      if (entries.size > maxEntries) {
        const ordered = [...entries].sort((left, right) => left[1].expiresAt - right[1].expiresAt);
        for (const [key] of ordered.slice(0, entries.size - maxEntries)) entries.delete(key);
      }
    };

    const resolve: LinearIssueStatusCache["resolve"] = (identifiers, fetchMissing) =>
      Effect.gen(function* () {
        const wanted = [...new Set(identifiers)];
        if (wanted.length === 0) return [];
        const now = yield* Clock.currentTimeMillis;

        const fresh = new Map<string, LinearIssueStatusSummary>();
        const awaited = new Map<string, Deferred.Deferred<LinearIssueStatusSummary>>();
        const claimed = new Map<string, Deferred.Deferred<LinearIssueStatusSummary>>();

        yield* SynchronizedRef.updateEffect(state, (current) =>
          Effect.gen(function* () {
            const entries = new Map(current.entries);
            const inflight = new Map(current.inflight);
            prune(entries, now);
            for (const identifier of wanted) {
              const entry = entries.get(identifier);
              if (entry && entry.expiresAt > now) {
                fresh.set(identifier, entry.summary);
                continue;
              }
              const pending = inflight.get(identifier);
              if (pending) {
                awaited.set(identifier, pending);
                continue;
              }
              const deferred = yield* Deferred.make<LinearIssueStatusSummary>();
              inflight.set(identifier, deferred);
              claimed.set(identifier, deferred);
            }
            return { entries, inflight };
          }),
        );

        if (claimed.size > 0) {
          const missing = [...claimed.keys()];
          // A defect in the fetch must still release every Deferred, or the
          // callers waiting on this batch would hang until their own timeout.
          const fetched = yield* fetchMissing(missing).pipe(
            Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<LinearIssueStatusSummary>)),
          );
          const bySummary = new Map(fetched.map((summary) => [summary.identifier, summary]));
          const completedAt = yield* Clock.currentTimeMillis;
          const settled: Array<readonly [string, CacheEntry]> = [];
          for (const identifier of missing) {
            const summary = bySummary.get(identifier) ?? {
              identifier,
              url: null,
              status: null,
              statusType: null,
              updatedAt: null,
              error: "Linear status is temporarily unavailable.",
            };
            const lifetime = summary.error === null ? ttlMs : errorTtlMs;
            settled.push([identifier, { summary, expiresAt: completedAt + lifetime }]);
            fresh.set(identifier, summary);
            yield* Deferred.succeed(claimed.get(identifier)!, summary);
          }
          yield* SynchronizedRef.update(state, (current) => {
            const entries = new Map(current.entries);
            const inflight = new Map(current.inflight);
            for (const [identifier, entry] of settled) {
              entries.set(identifier, entry);
              inflight.delete(identifier);
            }
            prune(entries, completedAt);
            return { entries, inflight };
          });
        }

        for (const [identifier, deferred] of awaited) {
          fresh.set(identifier, yield* Deferred.await(deferred));
        }

        return wanted.map((identifier) => fresh.get(identifier)!);
      });

    return { resolve };
  });

/**
 * The process-wide instance. The fork's RPC handler map is rebuilt per
 * connection, so a cache constructed there would collapse a single client's
 * tabs and nothing else — and the multiplication this exists to remove is
 * across viewers. Memoised here rather than threaded through the runtime so
 * the change costs no edit to an upstream-owned file.
 */
let shared: LinearIssueStatusCache | undefined;

export const sharedLinearIssueStatusCache = (): Effect.Effect<LinearIssueStatusCache> =>
  Effect.suspend(() =>
    shared === undefined
      ? makeLinearIssueStatusCache().pipe(
          Effect.tap((cache) =>
            Effect.sync(() => {
              shared = cache;
            }),
          ),
        )
      : Effect.succeed(shared),
  );

/** Test-only: drops the process-wide instance so suites cannot leak into each other. */
export const resetSharedLinearIssueStatusCache = (): void => {
  shared = undefined;
};
