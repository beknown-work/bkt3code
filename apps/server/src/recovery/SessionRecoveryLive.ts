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
 * why intent needs its own table). It reconnects the provider *session* only,
 * via the existing thread.session.restart command, and deliberately never
 * re-sends the interrupted turn: replaying half-finished agent work with no
 * human watching is the dangerous half of "auto-recovery", so a recovered
 * thread lands at ready and waits.
 *
 * @module SessionRecoveryLive
 */
import { CommandId, EventId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

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

const makeSessionRecovery = (options?: SessionRecoveryLiveOptions) =>
  Effect.gen(function* () {
    const recoveryState = yield* SessionRecoveryStateRepository;
    const supervisor = yield* ThreadExecutionSupervisor;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const healthyUptimeMs = Math.max(0, options?.healthyUptimeMs ?? DEFAULT_HEALTHY_UPTIME_MS);
    const enabled = options?.enabled ?? true;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const serverId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => `server:${tag}:${uuid}`));

    /** Reconnect one thread. Attempts are counted before the dispatch so a
        crash mid-attempt still consumes budget instead of looping. */
    const attemptRecovery = Effect.fn("SessionRecovery.attempt")(function* (input: {
      readonly threadId: ThreadId;
      readonly attempts: number;
      readonly now: string;
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

      if (input.attempts === 0) {
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(yield* serverId("session-recovery-activity")),
            threadId: input.threadId,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4),
              tone: "info",
              kind: "session.auto-reconnect",
              summary: "Reconnecting the session after an unexpected stop",
              payload: {},
              turnId: null,
              createdAt: input.now,
            },
            createdAt: input.now,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }

      yield* engine.dispatch({
        type: "thread.session.restart",
        commandId: CommandId.make(yield* serverId("session-recovery")),
        threadId: input.threadId,
        createdAt: input.now,
      });

      yield* Effect.logInfo("session.recovery.attempt", {
        threadId: input.threadId,
        attempt: input.attempts + 1,
        maxAttempts,
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

      const sessionState = snapshot.providerSession.state;
      if (sessionState === "ready" || sessionState === "starting") {
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

      // The session is down (absent | stopped | failed) and nobody asked for
      // that. Reconnect it, or give up if the budget is spent.
      if (row.attempts + 1 >= maxAttempts) {
        yield* attemptRecovery({ threadId: row.threadId, attempts: row.attempts, now });
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

      yield* attemptRecovery({ threadId: row.threadId, attempts: row.attempts, now });
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
