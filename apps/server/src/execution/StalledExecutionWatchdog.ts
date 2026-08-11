/**
 * StalledExecutionWatchdog - notice the sessions that stopped saying anything.
 *
 * The durable coordinator bounds everything it is holding: an in-flight dispatch
 * has a deadline, a claim has a lease, a failed attempt has a backoff. What it
 * cannot see is a work item it already finished with — one whose turn was
 * acknowledged and then went quiet. Nothing polls those, so the row stays
 * "running" forever.
 *
 * This sweep is the observer for that state, and only the observer. It decides
 * nothing about retries: when it judges a turn stalled it reports the stall to
 * the coordinator, which spends one unit of the existing attempt budget, applies
 * the existing backoff, and exhausts under the existing rule. The revival itself
 * is the coordinator's own next claim, which inspects the provider and re-adopts
 * a turn that turns out to be progressing after all.
 *
 * Silence is measured from the thread's event log, never from
 * `provider_last_observed_at`. That column only moves on provider *lifecycle*
 * events — a healthy Codex turn streaming output for two hours leaves it
 * untouched — so a watchdog keyed on it would kill working sessions. See
 * `StalledExecutionPolicy` for the rest of the reasoning.
 *
 * @module StalledExecutionWatchdog
 */
import { ThreadId, type StalledExecutionWatchdogSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { increment, stalledExecutionRevivalsTotal } from "../observability/Metrics.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  classifyStalledExecution,
  type StalledExecutionRuntime,
} from "./StalledExecutionPolicy.ts";
import { ThreadExecutionSupervisor } from "./ThreadExecutionSupervisor.ts";

export interface StalledExecutionWatchdogOptions {
  /** Read once per sweep, so retuning the bounds does not need a restart. */
  readonly settings: () => Effect.Effect<StalledExecutionWatchdogSettings>;
  /** Where a judged stall goes: `DurableExecutionCoordinator.failObserved`. */
  readonly failObserved: (input: {
    readonly workItemId: string;
    readonly failureType: string;
    readonly detail: string;
  }) => Effect.Effect<void>;
  readonly now?: () => Effect.Effect<number>;
}

export interface StalledExecutionWatchdogShape {
  /** One pass. Exposed for tests, which must never wait on a real interval. */
  readonly sweep: Effect.Effect<void>;
  /** Starts the periodic sweep inside the caller's scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

interface CandidateRow {
  readonly threadId: string;
  readonly workItemId: string;
  readonly phase: string;
}

export const makeStalledExecutionWatchdog = Effect.fn("makeStalledExecutionWatchdog")(function* (
  options: StalledExecutionWatchdogOptions,
) {
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* ProviderService;
  const supervisor = yield* ThreadExecutionSupervisor;
  const now = options.now ?? (() => Effect.map(DateTime.now, DateTime.toEpochMillis));

  /**
   * Candidates come from the projection rather than supervisor memory because
   * the durable work item id lives here too, and a stall is only actionable
   * when both halves agree there is something in flight. `activity = 'active'`
   * is doing real work in this filter: it excludes "blocked", which is a
   * session waiting on a human.
   */
  const listCandidates = sql<CandidateRow>`
    SELECT execution.thread_id AS "threadId",
           intent.work_item_id AS "workItemId",
           intent.phase AS phase
    FROM projection_thread_executions AS execution
    JOIN projection_thread_execution_intents AS intent
      ON intent.thread_id = execution.thread_id
    WHERE execution.activity = 'active'
      AND execution.turn_state IN ('starting', 'running')
      AND execution.stop_requested_at IS NULL
      AND intent.desired_state = 'running'
      AND intent.dismissed_at IS NULL
      AND intent.phase IN ('preparing', 'starting', 'running', 'recovering')
      AND intent.work_item_id = (
        SELECT newest.work_item_id
        FROM projection_thread_execution_intents AS newest
        WHERE newest.thread_id = execution.thread_id
          AND newest.desired_state = 'running'
        ORDER BY newest.request_event_sequence DESC, newest.accepted_at DESC
        LIMIT 1
      )
  `;

  /**
   * Newest event on the thread's own stream. Ordered by sequence and limited to
   * one row so the existing `(aggregate_kind, stream_id, sequence)` index serves
   * it; `MAX(occurred_at)` cannot use that index and would scan the stream.
   */
  const lastOutputAt = (threadId: ThreadId) =>
    sql<{ readonly occurredAt: string }>`
      SELECT occurred_at AS "occurredAt"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      ORDER BY sequence DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.occurredAt ?? null));

  const runtimeFor = (threadId: ThreadId) =>
    provider.inspectSession(threadId).pipe(
      Effect.map((inspection): StalledExecutionRuntime | null =>
        inspection === null ? "absent" : inspection.runtimeAlive ? "alive" : "dead",
      ),
      Effect.catchCause((cause) =>
        // An adapter that cannot answer is not evidence of anything. Skipping
        // costs one sweep; guessing could cost a working turn.
        Effect.logWarning("stalled execution liveness check failed", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );

  const sweepCandidate = Effect.fn("StalledExecutionWatchdog.sweepCandidate")(function* (
    candidate: CandidateRow,
    settings: StalledExecutionWatchdogSettings,
  ) {
    const threadId = ThreadId.make(candidate.threadId);
    // Supervisor memory is the authority; the projection can lag it by
    // milliseconds, which is exactly long enough to fail a settled turn.
    const snapshot = yield* supervisor.getSnapshot(threadId);
    const runtime = yield* runtimeFor(threadId);
    if (runtime === null) return;
    const verdict = classifyStalledExecution({
      activity: snapshot.activity,
      turnState: snapshot.turn?.state ?? null,
      stopRequestedAt: snapshot.turn?.stopRequestedAt ?? null,
      turnStartedAt: snapshot.turn?.startedAt ?? null,
      lastOutputAt: yield* lastOutputAt(threadId),
      runtime,
      nowMs: yield* now(),
      bounds: {
        deadRuntimeGraceMs: settings.deadRuntimeGraceMs,
        silentTurnMs: settings.silentTurnMs,
      },
    });
    if (verdict.kind === "ignore") {
      yield* Effect.logDebug("stalled execution watchdog pass", {
        threadId,
        workItemId: candidate.workItemId,
        reason: verdict.reason,
      });
      return;
    }
    yield* Effect.logWarning("stalled execution reported to durable recovery", {
      threadId,
      workItemId: candidate.workItemId,
      phase: candidate.phase,
      failureType: verdict.failureType,
      quietForMs: verdict.quietForMs,
    });
    yield* increment(stalledExecutionRevivalsTotal, { reason: verdict.failureType });
    yield* options.failObserved({
      workItemId: candidate.workItemId,
      failureType: verdict.failureType,
      detail: verdict.detail,
    });
  });

  const sweep: StalledExecutionWatchdogShape["sweep"] = Effect.gen(function* () {
    const settings = yield* options.settings();
    if (!settings.enabled) return;
    const candidates = yield* listCandidates;
    if (candidates.length === 0) return;
    // Sequential: each report can start a provider process, and a burst of
    // them landing together on a shared box is its own outage.
    for (const candidate of candidates) {
      yield* sweepCandidate(candidate, settings).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("stalled execution watchdog candidate failed", {
            threadId: candidate.threadId,
            workItemId: candidate.workItemId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("stalled execution watchdog sweep failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const start: StalledExecutionWatchdogShape["start"] = () =>
    Effect.gen(function* () {
      const settings = yield* options.settings();
      if (!settings.enabled) {
        yield* Effect.logInfo("stalled execution watchdog disabled");
        return;
      }
      // The interval is fixed at start, but `enabled` and every bound are
      // re-read per sweep, so the only change needing a restart is the cadence.
      yield* Effect.forkScoped(
        sweep.pipe(Effect.repeat(Schedule.spaced(Duration.millis(settings.pollIntervalMs)))),
      );
      yield* Effect.logInfo("stalled execution watchdog started", {
        pollIntervalMs: settings.pollIntervalMs,
        deadRuntimeGraceMs: settings.deadRuntimeGraceMs,
        silentTurnMs: settings.silentTurnMs,
      });
    });

  return { sweep, start } satisfies StalledExecutionWatchdogShape;
});
