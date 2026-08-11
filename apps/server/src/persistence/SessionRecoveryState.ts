// T3-CUSTOM(expbkt3): desired-state store backing automatic session recovery.
//
// This table answers one question the projections cannot: *did anyone ask for
// this session to stop?* A thread parked at turn_state='interrupted' with no
// stop_requested_at looks identical whether the provider aborted cleanly, the
// process died, or the server restarted mid-turn — but only the last two
// deserve a reconnect. Intent is therefore recorded where it is known (the
// execution supervisor and the stop-intent domain events) rather than inferred
// afterwards from terminal state.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type SessionRecoveryStateRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** What the system currently believes the user wants for this session. */
export const SessionDesiredState = Schema.Literals(["running", "stopped"]);
export type SessionDesiredState = typeof SessionDesiredState.Type;

export const SessionRecoveryState = Schema.Struct({
  threadId: ThreadId,
  desiredState: SessionDesiredState,
  /** Free-text cause of the last transition; diagnostics only. */
  reason: Schema.NullOr(Schema.String),
  /** Execution id of the turn that last set desiredState=running. A change
      here means a fresh user turn, which resets the attempt budget. */
  lastExecutionId: Schema.NullOr(Schema.String),
  attempts: NonNegativeInt,
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  recoveredAt: Schema.NullOr(IsoDateTime),
  gaveUpAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type SessionRecoveryState = typeof SessionRecoveryState.Type;

export class SessionRecoveryStateRepository extends Context.Service<
  SessionRecoveryStateRepository,
  {
    /** Record that a turn was admitted: the session is meant to be running.
        Resets the attempt budget when the execution id changes. */
    readonly markRunning: (input: {
      readonly threadId: ThreadId;
      readonly executionId: string | null;
      readonly reason: string;
      readonly at: string;
    }) => Effect.Effect<void, SessionRecoveryStateRepositoryError>;

    /** Record an intentional stop. Recovery never touches these rows. */
    readonly markStopped: (input: {
      readonly threadId: ThreadId;
      readonly reason: string;
      readonly at: string;
    }) => Effect.Effect<void, SessionRecoveryStateRepositoryError>;

    /** The session went down without anyone asking. Leaves desiredState
        alone (running) so the sweep picks it up; only annotates the cause. */
    readonly noteUnexpectedDown: (input: {
      readonly threadId: ThreadId;
      readonly reason: string;
      readonly at: string;
    }) => Effect.Effect<void, SessionRecoveryStateRepositoryError>;

    /** Rows eligible for a reconnect attempt right now. */
    readonly listRecoverable: (input: {
      readonly now: string;
      readonly maxAttempts: number;
    }) => Effect.Effect<ReadonlyArray<SessionRecoveryState>, SessionRecoveryStateRepositoryError>;

    readonly getByThreadId: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<Option.Option<SessionRecoveryState>, SessionRecoveryStateRepositoryError>;

    /** Count an attempt before dispatching it, so a crash mid-attempt still
        consumes budget rather than looping forever. */
    readonly recordAttempt: (input: {
      readonly threadId: ThreadId;
      readonly at: string;
      readonly nextAttemptAt: string;
    }) => Effect.Effect<void, SessionRecoveryStateRepositoryError>;

    /** A reconnect has been observed healthy: clear the attempt budget. */
    readonly recordRecovered: (input: {
      readonly threadId: ThreadId;
      readonly at: string;
    }) => Effect.Effect<void, SessionRecoveryStateRepositoryError>;

    readonly recordGaveUp: (input: {
      readonly threadId: ThreadId;
      readonly at: string;
    }) => Effect.Effect<void, SessionRecoveryStateRepositoryError>;

    readonly deleteByThreadId: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, SessionRecoveryStateRepositoryError>;
  }
>()("t3/persistence/SessionRecoveryState/SessionRecoveryStateRepository") {}

const decodeRow = Schema.decodeUnknownEffect(SessionRecoveryState);

function sqlError(operation: string, threadId?: ThreadId) {
  return (cause: unknown): SessionRecoveryStateRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(
          operation,
          cause,
          threadId === undefined ? undefined : { threadId },
        )
      : new PersistenceSqlError({
          operation,
          ...(threadId === undefined ? {} : { correlation: { threadId } }),
          cause,
        });
}

const SELECT_COLUMNS = `
  thread_id AS "threadId",
  desired_state AS "desiredState",
  reason,
  last_execution_id AS "lastExecutionId",
  attempts,
  last_attempt_at AS "lastAttemptAt",
  next_attempt_at AS "nextAttemptAt",
  recovered_at AS "recoveredAt",
  gave_up_at AS "gaveUpAt",
  updated_at AS "updatedAt"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRecoverableRows = SqlSchema.findAll({
    Request: Schema.Struct({ now: Schema.String, maxAttempts: Schema.Number }),
    Result: SessionRecoveryState,
    execute: ({ now, maxAttempts }) =>
      sql`
        SELECT ${sql.literal(SELECT_COLUMNS)}
        FROM session_recovery_state
        WHERE desired_state = 'running'
          AND gave_up_at IS NULL
          AND attempts < ${maxAttempts}
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        ORDER BY updated_at ASC
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: SessionRecoveryState,
    execute: ({ threadId }) =>
      sql`
        SELECT ${sql.literal(SELECT_COLUMNS)}
        FROM session_recovery_state
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  return {
    markRunning: ({ threadId, executionId, reason, at }) =>
      sql`
        INSERT INTO session_recovery_state (
          thread_id, desired_state, reason, last_execution_id,
          attempts, last_attempt_at, next_attempt_at, recovered_at, gave_up_at, updated_at
        ) VALUES (
          ${threadId}, 'running', ${reason}, ${executionId},
          0, NULL, NULL, NULL, NULL, ${at}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          desired_state = 'running',
          reason = excluded.reason,
          last_execution_id = excluded.last_execution_id,
          -- A new execution id means a fresh user turn, which is explicit
          -- intent and therefore restores the full attempt budget. Re-running
          -- the same execution must not, or a flapping session would retry
          -- forever.
          attempts = CASE
            WHEN session_recovery_state.last_execution_id IS NOT excluded.last_execution_id
            THEN 0 ELSE session_recovery_state.attempts
          END,
          next_attempt_at = CASE
            WHEN session_recovery_state.last_execution_id IS NOT excluded.last_execution_id
            THEN NULL ELSE session_recovery_state.next_attempt_at
          END,
          gave_up_at = CASE
            WHEN session_recovery_state.last_execution_id IS NOT excluded.last_execution_id
            THEN NULL ELSE session_recovery_state.gave_up_at
          END,
          recovered_at = NULL,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("SessionRecoveryState.markRunning", threadId)),
      ),

    markStopped: ({ threadId, reason, at }) =>
      sql`
        INSERT INTO session_recovery_state (
          thread_id, desired_state, reason, last_execution_id,
          attempts, last_attempt_at, next_attempt_at, recovered_at, gave_up_at, updated_at
        ) VALUES (
          ${threadId}, 'stopped', ${reason}, NULL, 0, NULL, NULL, NULL, NULL, ${at}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          desired_state = 'stopped',
          reason = excluded.reason,
          attempts = 0,
          next_attempt_at = NULL,
          gave_up_at = NULL,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("SessionRecoveryState.markStopped", threadId)),
      ),

    noteUnexpectedDown: ({ threadId, reason, at }) =>
      sql`
        UPDATE session_recovery_state
        SET reason = ${reason}, updated_at = ${at}
        WHERE thread_id = ${threadId} AND desired_state = 'running'
      `.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("SessionRecoveryState.noteUnexpectedDown", threadId)),
      ),

    listRecoverable: (input) =>
      listRecoverableRows(input).pipe(
        Effect.mapError(sqlError("SessionRecoveryState.listRecoverable")),
      ),

    getByThreadId: (input) =>
      getRow(input).pipe(Effect.mapError(sqlError("SessionRecoveryState.getByThreadId"))),

    recordAttempt: ({ threadId, at, nextAttemptAt }) =>
      sql`
        UPDATE session_recovery_state
        SET attempts = attempts + 1,
            last_attempt_at = ${at},
            next_attempt_at = ${nextAttemptAt},
            updated_at = ${at}
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("SessionRecoveryState.recordAttempt", threadId)),
      ),

    recordRecovered: ({ threadId, at }) =>
      sql`
        UPDATE session_recovery_state
        SET attempts = 0,
            next_attempt_at = NULL,
            recovered_at = ${at},
            gave_up_at = NULL,
            updated_at = ${at}
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("SessionRecoveryState.recordRecovered", threadId)),
      ),

    recordGaveUp: ({ threadId, at }) =>
      sql`
        UPDATE session_recovery_state
        SET gave_up_at = ${at}, next_attempt_at = NULL, updated_at = ${at}
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("SessionRecoveryState.recordGaveUp", threadId)),
      ),

    deleteByThreadId: ({ threadId }) =>
      sql`DELETE FROM session_recovery_state WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(sqlError("SessionRecoveryState.deleteByThreadId", threadId)),
      ),
  } satisfies SessionRecoveryStateRepository["Service"];
});

export const layer = Layer.effect(SessionRecoveryStateRepository, make);

/** Exported for tests that need to assert decode behaviour directly. */
export const decodeSessionRecoveryStateRow = decodeRow;
