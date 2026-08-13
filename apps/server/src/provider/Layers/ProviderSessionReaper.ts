import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  listRunningSessionRows,
  settleRunningSession,
} from "../../orchestration/reconcileRunningTurns.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
export const PROVIDER_SESSION_INACTIVITY_ENV = "T3CODE_PROVIDER_SESSION_INACTIVITY_MS";
export const providerSessionInactivityThresholdConfig = Config.int(
  PROVIDER_SESSION_INACTIVITY_ENV,
).pipe(
  Config.withDefault(DEFAULT_INACTIVITY_THRESHOLD_MS),
  Config.mapOrFail((value) =>
    value > 0
      ? Effect.succeed(value)
      : Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `${PROVIDER_SESSION_INACTIVITY_ENV} must be a positive integer.`,
            }),
          ),
        ),
  ),
);
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Last-resort backstop for a turn that is still "running" with a live provider
 * session but has clearly gone nowhere. Deliberately generous: silence is not
 * evidence of death (see reconcileRunningTurns), so this must never be the
 * mechanism that ends a normal turn.
 */
const DEFAULT_TURN_ABSOLUTE_CAP_MS = 2 * 60 * 60 * 1000;
/**
 * A turn must have been running at least this long before "no in-memory
 * session" counts as proof of death, so a session that is mid-registration is
 * never mistaken for an orphan.
 */
const ORPHAN_EVIDENCE_GRACE_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly turnAbsoluteCapMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    // Captured here (rather than inside the sweep) so the orphan pass does not
    // leak these requirements into `start()`, whose context is Scope-only.
    const reconcileContext = yield* Effect.context<
      Crypto.Crypto | OrchestrationEngine.OrchestrationEngineService | SqlClient.SqlClient
    >();

    const inactivityThresholdMs =
      options?.inactivityThresholdMs ?? (yield* providerSessionInactivityThresholdConfig);
    if (inactivityThresholdMs <= 0) {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: "Provider session inactivity threshold must be positive.",
          }),
        ),
      );
    }
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const turnAbsoluteCapMs = Math.max(
      1,
      options?.turnAbsoluteCapMs ?? DEFAULT_TURN_ABSOLUTE_CAP_MS,
    );

    /**
     * Settle threads still marked running whose agent is provably gone.
     *
     * The plain session reaper below can never do this: it skips any thread
     * with an active turn, which is exactly the stuck case. Evidence here is
     * "the adapters hold no in-memory session for this thread" — never silence,
     * because a healthy agent can emit nothing for the whole of a long tool
     * call.
     */
    const sweepOrphanedTurns = Effect.gen(function* () {
      const rows = yield* listRunningSessionRows;

      if (rows.length === 0) {
        return;
      }

      const liveThreadIds = new Set(
        (yield* providerService.listSessions()).map((session) => String(session.threadId)),
      );
      const now = yield* Clock.currentTimeMillis;

      for (const row of rows) {
        const startedMs = Date.parse(row.turnStartedAt ?? row.updatedAt);
        const runningForMs = Number.isNaN(startedMs) ? 0 : now - startedMs;

        const reason = !liveThreadIds.has(row.threadId)
          ? runningForMs >= ORPHAN_EVIDENCE_GRACE_MS
            ? "Interrupted: the agent session is no longer running."
            : null
          : runningForMs >= turnAbsoluteCapMs
            ? "Interrupted: the turn exceeded the maximum run time."
            : null;

        if (reason === null) {
          continue;
        }

        yield* settleRunningSession({ row, reason }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaper.settled-orphaned-turn", {
              threadId: row.threadId,
              runningForMs,
              reason,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.settle-orphaned-turn-failed", {
              threadId: row.threadId,
              cause,
            }),
          ),
        );
      }
    }).pipe(Effect.provide(reconcileContext));

    const sweep = Effect.gen(function* () {
      yield* sweepOrphanedTurns;

      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        // T3-CUSTOM(expbkt3): terminate (not stop) idle sessions so the process tree exits.
        const reaped = yield* providerService.terminateSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.termination-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
