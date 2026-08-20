/**
 * reconcileRunningTurns - Settle turns whose agent is provably gone, while the
 * server is running.
 *
 * Restart-orphaned sessions are handled at startup by
 * {@link ./staleSessionReconciliation.ts}. This module covers the other case: a
 * live server whose agent has died without reporting it, so the thread stays
 * "running" and the UI counts up from a turn that already ended.
 *
 * Settling is driven by *hard evidence* only, never by silence: providers can
 * legitimately emit nothing for the whole of a long tool call (ACP suppresses
 * in-progress tool updates entirely, and Claude's Bash cap is exactly 600s), so
 * an inactivity rule would kill healthy agents. The accepted proof is that the
 * adapters hold no in-memory session for the thread; a long absolute cap acts as
 * a last-resort backstop for anything else.
 *
 * The settle timestamp is the thread's last recorded event, not "now", so the
 * resulting turn duration reflects the work that actually happened instead of
 * baking in the wall-clock gap since the agent died.
 *
 * @module reconcileRunningTurns
 */
import {
  CommandId,
  EventId,
  IsoDateTime,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";

/** A thread whose session projection still claims to be running/starting. */
export interface RunningSessionRow {
  readonly threadId: string;
  readonly providerName: string | null;
  readonly providerInstanceId: string | null;
  readonly runtimeMode: string | null;
  readonly updatedAt: string;
  readonly lastActivityAt: string | null;
  readonly turnStartedAt: string | null;
  /** T3-CUSTOM(expbkt3): the orchestration turn id the session projection is pinned to. */
  readonly activeTurnId: string | null;
}

/**
 * Every thread still marked running/starting, with the newest event on its
 * stream (the closest thing to "when did this turn last make progress") and the
 * active turn's start time.
 */
export const listRunningSessionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<RunningSessionRow>`
    SELECT
      s.thread_id AS "threadId",
      s.provider_name AS "providerName",
      s.provider_instance_id AS "providerInstanceId",
      s.runtime_mode AS "runtimeMode",
      s.updated_at AS "updatedAt",
      s.active_turn_id AS "activeTurnId",
      (
        SELECT MAX(e.occurred_at)
        FROM orchestration_events e
        WHERE e.stream_id = s.thread_id
      ) AS "lastActivityAt",
      tr.started_at AS "turnStartedAt"
    FROM projection_thread_sessions s
    JOIN projection_threads t ON t.thread_id = s.thread_id
    LEFT JOIN projection_turns tr
      ON tr.thread_id = s.thread_id AND tr.turn_id = s.active_turn_id
    WHERE s.status IN ('running', 'starting')
      AND t.deleted_at IS NULL
  `;
});

/**
 * Settle one orphaned session. "interrupted" settles a still-running turn in
 * the projector and is honest about what happened — the session really is gone.
 */
export const settleRunningSession = (input: {
  readonly row: RunningSessionRow;
  readonly reason: string;
}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    const threadId = ThreadId.make(input.row.threadId);
    // Prefer the last real activity; fall back to the session's own timestamp.
    const settleAt = IsoDateTime.make(input.row.lastActivityAt ?? input.row.updatedAt);
    const uuid = yield* crypto.randomUUIDv4;

    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`server:reconcile-running-turn:${uuid}`),
      threadId,
      session: {
        threadId,
        status: "interrupted",
        providerName: input.row.providerName,
        ...(input.row.providerInstanceId !== null
          ? { providerInstanceId: ProviderInstanceId.make(input.row.providerInstanceId) }
          : {}),
        runtimeMode: (input.row.runtimeMode ?? "full-access") as RuntimeMode,
        activeTurnId: null,
        lastError: input.reason,
        // Drives the settled turn's completedAt in the projector.
        updatedAt: settleAt,
      },
      createdAt: settleAt,
    });
  });

// T3-CUSTOM(expbkt3): BEGIN - interrupt a live turn for real before settling it.
/**
 * Ask the provider to end a turn that is still alive in memory but has gone
 * silent, through the same `thread.turn.interrupt` path the Stop button uses.
 *
 * `settleRunningSession` alone only rewrites the projection: the provider turn
 * keeps running, durable recovery then sees that live turn, re-adopts it, and
 * the reaper settles it again on its next sweep — ten "successful" recoveries
 * later the work item is an unclaimable zombie that blocks every later prompt
 * (2026-08-20, `mcp:1e019f68`). Dispatching the interrupt first makes the
 * durable work item terminal (`stopThread`) and tells the provider to stop, so
 * provider, projection and intent agree and there is nothing left to recover.
 */
export const interruptRunningSession = (input: {
  readonly row: RunningSessionRow;
  readonly reason: string;
}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    const threadId = ThreadId.make(input.row.threadId);
    const uuid = yield* crypto.randomUUIDv4;
    const createdAt = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(`server:reconcile-running-turn-interrupt:${uuid}`),
      threadId,
      ...(input.row.activeTurnId !== null ? { turnId: TurnId.make(input.row.activeTurnId) } : {}),
      createdAt,
    });
    // Leave the reason in the thread feed; the interrupt itself carries none.
    const activityUuid = yield* crypto.randomUUIDv4;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:reconcile-running-turn-activity:${activityUuid}`),
      threadId,
      activity: {
        id: EventId.make(activityUuid),
        tone: "info",
        kind: "provider.turn.interrupted",
        summary: input.reason,
        payload: {
          detail: input.reason,
          activeTurnId: input.row.activeTurnId,
          lastActivityAt: input.row.lastActivityAt,
        },
        turnId: input.row.activeTurnId !== null ? TurnId.make(input.row.activeTurnId) : null,
        createdAt,
      },
      createdAt,
    });
    yield* Effect.logInfo("provider.session.reaper.interrupted-silent-turn", {
      threadId: input.row.threadId,
      activeTurnId: input.row.activeTurnId,
      reason: input.reason,
    });
  });
// T3-CUSTOM(expbkt3): END
