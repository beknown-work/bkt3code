/**
 * SessionRecoveryLive - reconnect sessions that stopped without being asked to.
 *
 * A deploy restarts this service roughly once a minute after CI goes green,
 * and every restart kills the agent processes it hosts. Until now each of
 * those threads settled to "interrupted" and stayed dead until a human clicked
 * Reconnect on each one. The same is true of a provider that crashes mid-turn.
 *
 * This sweep closes that gap for exactly the threads a user meant to be
 * running, as recorded in session_recovery_state (see the repository module for
 * why intent needs its own table).
 *
 * Recovery has two moves, and picking between them is the whole design:
 *
 *   - When the agent already produced work for the latest message, only the
 *     *session* is reconnected (thread.session.restart). Replaying a
 *     half-finished turn with no human watching is the dangerous half of
 *     "auto-recovery", so that thread lands at ready and waits.
 *   - When the latest user message never got a turn at all, reconnecting alone
 *     is useless: the session comes back ready and then sits idle forever with
 *     the message undelivered. This is what a turn that dies milliseconds after
 *     admission looks like — an agent-authored message from the Linear bridge
 *     that never ran. There is no partial work to corrupt, so the turn is
 *     re-dispatched with the *same* message id (the message projection is
 *     idempotent by id, so it does not duplicate in the transcript).
 *
 * Both moves share the one attempt budget, so a thread that cannot be revived
 * still gives up rather than retrying forever.
 *
 * @module SessionRecoveryLive
 */
import { CommandId, EventId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ThreadExecutionSupervisor } from "../execution/ThreadExecutionSupervisor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SessionRecoveryStateRepository } from "../persistence/SessionRecoveryState.ts";
import { SessionRecovery, type SessionRecoveryShape } from "./SessionRecovery.ts";

/** One reconnect attempt per thread per sweep; ten attempts spans ~20 minutes. */
const DEFAULT_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 10;
/**
 * How long a reconnected session must stay up before the attempt budget is
 * refunded. Without this, a session that dies every 30s would reconnect,
 * "recover", and retry forever.
 */
const DEFAULT_HEALTHY_UPTIME_MS = 5 * 60 * 1000;

export interface SessionRecoveryLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly healthyUptimeMs?: number;
  /** Escape hatch for operators and tests; recovery is on by default. */
  readonly enabled?: boolean;
  /**
   * Reserved for a future config-gated follow-up: re-sending the interrupted
   * turn after a successful reconnect. Intentionally inert for now.
   */
  readonly autoResumeTurn?: boolean;
}

/** The newest user message on a thread, used to detect undelivered work. */
const LatestUserMessageRow = Schema.Struct({
  messageId: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
});

const makeSessionRecovery = (options?: SessionRecoveryLiveOptions) =>
  Effect.gen(function* () {
    const recoveryState = yield* SessionRecoveryStateRepository;
    const supervisor = yield* ThreadExecutionSupervisor;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const sql = yield* SqlClient.SqlClient;

    const findLatestUserMessage = SqlSchema.findOneOption({
      Request: Schema.Struct({ threadId: Schema.String }),
      Result: LatestUserMessageRow,
      execute: ({ threadId }) =>
        sql`
          SELECT message_id AS "messageId", text, created_at AS "createdAt"
          FROM projection_thread_messages
          WHERE thread_id = ${threadId} AND role = 'user'
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `,
    });

    const countTurnsSince = SqlSchema.findOne({
      Request: Schema.Struct({ threadId: Schema.String, since: Schema.String }),
      Result: Schema.Struct({ turns: Schema.Number }),
      execute: ({ threadId, since }) =>
        sql`
          SELECT COUNT(*) AS "turns"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND requested_at >= ${since}
        `,
    });

    /**
     * Work the user (or the bridge acting for them) asked for that no turn ever
     * picked up. A turn requested at or after the message means the work was
     * delivered — whatever happened to it afterwards is the other branch's
     * problem, and must not be replayed here.
     */
    const findUndeliveredWork = Effect.fn("SessionRecovery.findUndeliveredWork")(function* (
      threadId: ThreadId,
    ) {
      const message = yield* findLatestUserMessage({ threadId: String(threadId) });
      if (Option.isNone(message)) return null;
      const counted = yield* countTurnsSince({
        threadId: String(threadId),
        since: message.value.createdAt,
      });
      return counted.turns > 0 ? null : message.value;
    });

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const healthyUptimeMs = Math.max(0, options?.healthyUptimeMs ?? DEFAULT_HEALTHY_UPTIME_MS);
    const enabled = options?.enabled ?? true;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const serverId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => `server:${tag}:${uuid}`));

    /** Reconnect one thread, and re-deliver its message when no turn ever ran.
        Attempts are counted before the dispatch so a crash mid-attempt still
        consumes budget instead of looping. */
    const attemptRecovery = Effect.fn("SessionRecovery.attempt")(function* (input: {
      readonly threadId: ThreadId;
      readonly attempts: number;
      readonly now: string;
      readonly undelivered: {
        readonly messageId: string;
        readonly text: string;
      } | null;
      readonly thread: {
        readonly modelSelection: unknown;
        readonly runtimeMode: string;
        readonly interactionMode: string;
      } | null;
    }) {
      const nextAttemptAt = yield* DateTime.now.pipe(
        Effect.map((instant) =>
          DateTime.formatIso(DateTime.addDuration(instant, Duration.millis(sweepIntervalMs))),
        ),
      );
      yield* recoveryState.recordAttempt({
        threadId: input.threadId,
        at: input.now,
        nextAttemptAt,
      });

      const redelivering = input.undelivered !== null && input.thread !== null;

      if (input.attempts === 0) {
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(yield* serverId("session-recovery-activity")),
            threadId: input.threadId,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: "info",
              kind: redelivering ? "session.auto-redeliver" : "session.auto-reconnect",
              summary: redelivering
                ? "Re-running a message whose turn never started"
                : "Reconnecting the session after an unexpected stop",
              payload: {},
              turnId: null,
              createdAt: input.now,
            },
            createdAt: input.now,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }

      if (redelivering && input.undelivered && input.thread) {
        // Starting a turn also ensures the provider session, so this both
        // revives the session and delivers the work a plain restart would
        // have left sitting unread. Same message id: the projection dedupes
        // by id, so the transcript keeps one copy.
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* serverId("session-recovery-turn")),
          threadId: input.threadId,
          message: {
            messageId: MessageId.make(input.undelivered.messageId),
            role: "user",
            text: input.undelivered.text,
            attachments: [],
          },
          modelSelection: input.thread.modelSelection as never,
          runtimeMode: input.thread.runtimeMode as never,
          interactionMode: input.thread.interactionMode as never,
          createdAt: input.now,
        });
      } else {
        yield* engine.dispatch({
          type: "thread.session.restart",
          commandId: CommandId.make(yield* serverId("session-recovery")),
          threadId: input.threadId,
          createdAt: input.now,
        });
      }

      yield* Effect.logInfo("session.recovery.attempt", {
        threadId: input.threadId,
        attempt: input.attempts + 1,
        maxAttempts,
        mode: redelivering ? "redeliver-turn" : "reconnect-session",
      });
    });

    const sweepThread = Effect.fn("SessionRecovery.sweepThread")(function* (row: {
      readonly threadId: ThreadId;
      readonly attempts: number;
      readonly recoveredAt: string | null;
    }) {
      const now = yield* nowIso;
      const shell = yield* snapshotQuery.getThreadShellById(row.threadId);

      // A thread that is gone or parked is not something to reconnect.
      if (Option.isNone(shell)) {
        yield* recoveryState.deleteByThreadId({ threadId: row.threadId });
        return;
      }
      if (shell.value.archivedAt !== null) {
        yield* recoveryState.markStopped({
          threadId: row.threadId,
          reason: "thread-archived",
          at: now,
        });
        return;
      }

      const snapshot = yield* supervisor.getSnapshot(row.threadId);

      // Never race a live execution, or a reconnect a human already made.
      if (
        snapshot.canStop ||
        snapshot.activity === "active" ||
        snapshot.activity === "blocked" ||
        snapshot.activity === "stopping"
      ) {
        return;
      }

      // Work nobody ever ran. A reconnect alone would leave this sitting unread
      // forever, so it is worth an attempt even when the session looks healthy.
      const undelivered = yield* findUndeliveredWork(row.threadId);
      const threadDefaults = {
        modelSelection: shell.value.modelSelection as unknown,
        runtimeMode: String(shell.value.runtimeMode),
        interactionMode: String(shell.value.interactionMode),
      };

      const sessionState = snapshot.providerSession.state;
      if ((sessionState === "ready" || sessionState === "starting") && undelivered === null) {
        const startedAt = Date.parse(snapshot.providerSession.startedAt ?? "");
        const upFor = Number.isFinite(startedAt) ? Date.parse(now) - startedAt : 0;
        if (row.attempts > 0 && row.recoveredAt === null && upFor >= healthyUptimeMs) {
          yield* recoveryState.recordRecovered({ threadId: row.threadId, at: now });
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(yield* serverId("session-recovery-activity")),
              threadId: row.threadId,
              activity: {
                id: EventId.make(yield* crypto.randomUUIDv4),
                tone: "info",
                kind: "session.auto-reconnected",
                summary: "Session reconnected automatically",
                payload: { attempts: row.attempts },
                turnId: null,
                createdAt: now,
              },
              createdAt: now,
            })
            .pipe(Effect.ignoreCause({ log: true }));
          yield* Effect.logInfo("session.recovery.recovered", {
            threadId: row.threadId,
            attempts: row.attempts,
          });
        }
        return;
      }

      // Either the session is down (absent | stopped | failed) with nobody
      // asking for that, or it is up but holding work that never ran. Both are
      // an attempt; both give up when the budget is spent.
      if (row.attempts + 1 >= maxAttempts) {
        yield* attemptRecovery({
          threadId: row.threadId,
          attempts: row.attempts,
          now,
          undelivered,
          thread: threadDefaults,
        });
        yield* recoveryState.recordGaveUp({ threadId: row.threadId, at: now });
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(yield* serverId("session-recovery-activity")),
            threadId: row.threadId,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: "error",
              kind: "session.auto-reconnect-gave-up",
              summary: `Automatic reconnect gave up after ${maxAttempts} attempts`,
              payload: { attempts: maxAttempts },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          })
          .pipe(Effect.ignoreCause({ log: true }));
        yield* Effect.logWarning("session.recovery.gave-up", {
          threadId: row.threadId,
          attempts: maxAttempts,
        });
        return;
      }

      yield* attemptRecovery({
        threadId: row.threadId,
        attempts: row.attempts,
        now,
        undelivered,
        thread: threadDefaults,
      });
    });

    const sweep = Effect.gen(function* () {
      const now = yield* nowIso;
      const rows = yield* recoveryState.listRecoverable({ now, maxAttempts });
      if (rows.length === 0) return;

      yield* Effect.logDebug("session.recovery.sweep", { candidates: rows.length });

      // Sequential: recoveries are rare and each one starts a provider
      // process, so a burst of them should not land all at once.
      for (const row of rows) {
        yield* sweepThread(row).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("session.recovery.thread-failed", {
              threadId: row.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
    });

    /**
     * Capture stop *intent* from the command stream rather than from provider
     * acknowledgements: a provider that is already dead will never ack, and
     * the user's intent is no less real for that.
     */
    const trackStopIntent = Stream.runForEach(engine.streamDomainEvents, (event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "thread.session-stop-requested":
            return yield* recoveryState.markStopped({
              threadId: event.payload.threadId,
              reason: "session-stop-command",
              at: yield* nowIso,
            });
          case "thread.turn-interrupt-requested":
            return yield* recoveryState.markStopped({
              threadId: event.payload.threadId,
              reason: "turn-interrupt-command",
              at: yield* nowIso,
            });
          case "thread.deleted":
            return yield* recoveryState.deleteByThreadId({ threadId: event.payload.threadId });
          default:
            return;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("session.recovery.intent-tracking-failed", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );

    const start: SessionRecoveryShape["start"] = () =>
      Effect.gen(function* () {
        if (!enabled) {
          yield* Effect.logInfo("session.recovery.disabled");
          return;
        }

        yield* Effect.forkScoped(trackStopIntent);
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("session.recovery.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("session.recovery.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("session.recovery.started", {
          sweepIntervalMs,
          maxAttempts,
          healthyUptimeMs,
        });
      });

    return { start } satisfies SessionRecoveryShape;
  });

export const makeSessionRecoveryLive = (options?: SessionRecoveryLiveOptions) =>
  Layer.effect(SessionRecovery, makeSessionRecovery(options));

export const SessionRecoveryLive = makeSessionRecoveryLive();
