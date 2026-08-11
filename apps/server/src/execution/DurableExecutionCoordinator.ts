// T3-CUSTOM(expbkt3): durable work-item claims, retry timing, and fenced dispatch.
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Metric from "effect/Metric";
import type * as Scope from "effect/Scope";

import {
  DurableExecutionIntentRepository,
  type DurableExecutionIntent,
} from "./DurableExecutionIntentRepository.ts";
import { describeMinutes } from "./StalledExecutionPolicy.ts";
import {
  durableExecutionAckToActiveDuration,
  durableExecutionFencingRejectionsTotal,
  durableExecutionLeaseRecoveriesTotal,
  durableExecutionRecoveryAttemptsTotal,
  increment,
  metricAttributes,
} from "../observability/Metrics.ts";

const RETRY_DELAYS_MS = [
  0, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000,
] as const;
const LEASE_MS = 60_000;
const LEASE_RENEW_MS = 15_000;
const MAX_GLOBAL_CONCURRENCY = 2;

export function shouldPublishRecoveryActivity(
  kind: "started" | "recovered" | "paused" | "exhausted",
  attempt: number,
): boolean {
  return kind !== "started" || attempt === 1;
}

export function durableExecutionRetryDelayMs(workItemId: string, attempt: number): number | null {
  const base = RETRY_DELAYS_MS[attempt - 1];
  if (base === undefined) return null;
  if (base === 0) return 0;
  let hash = 2_166_136_261;
  for (const character of `${workItemId}:${attempt}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  const unit = (hash >>> 0) / 0xffff_ffff;
  return Math.max(1, Math.round(base * (0.9 + unit * 0.2)));
}

function addMillis(iso: string, millis: number): string {
  return DateTime.formatIso(
    DateTime.addDuration(DateTime.makeUnsafe(iso), Duration.millis(millis)),
  );
}

function millisUntil(now: string, target: string): number {
  return Math.max(
    1,
    DateTime.toEpochMillis(DateTime.makeUnsafe(target)) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(now)),
  );
}

export class DurableExecutionDispatchError extends Schema.TaggedErrorClass<DurableExecutionDispatchError>()(
  "DurableExecutionDispatchError",
  {
    failureType: Schema.String,
    detail: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface DurableExecutionDispatchResult {
  readonly providerTurnId: string | null;
  readonly providerInstanceId: string | null;
  readonly adoptedExecutionId?: string;
  readonly deferred?: boolean;
  readonly completed?: boolean;
}

type TurnStartEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

export interface DurableExecutionCoordinatorOptions {
  readonly ownerId: string;
  readonly now?: () => Effect.Effect<string>;
  readonly loadEvent: (
    intent: DurableExecutionIntent,
  ) => Effect.Effect<TurnStartEvent, DurableExecutionDispatchError>;
  readonly prepare?: (input: {
    readonly intent: DurableExecutionIntent;
    readonly event: TurnStartEvent;
    readonly owner: string;
    readonly generation: number;
  }) => Effect.Effect<void, DurableExecutionDispatchError>;
  readonly dispatchOriginal: (input: {
    readonly intent: DurableExecutionIntent;
    readonly event: TurnStartEvent;
  }) => Effect.Effect<DurableExecutionDispatchResult, DurableExecutionDispatchError, Scope.Scope>;
  readonly recover: (input: {
    readonly intent: DurableExecutionIntent;
    readonly event: TurnStartEvent;
    readonly mode: "exact-undelivered" | "inspect-or-continue";
  }) => Effect.Effect<DurableExecutionDispatchResult, DurableExecutionDispatchError, Scope.Scope>;
  /** T3-CUSTOM(expbkt3): publish desired-state transitions to connected clients. */
  readonly onTransition?: (input: {
    readonly workItemId: string;
    readonly threadId: DurableExecutionIntent["threadId"];
  }) => Effect.Effect<void>;
  readonly onRecoveryActivity?: (input: {
    readonly intent: DurableExecutionIntent;
    readonly kind: "started" | "recovered" | "paused" | "exhausted";
    readonly attempt: number;
    readonly detail?: string;
  }) => Effect.Effect<void>;
  readonly terminateObserved?: (intent: DurableExecutionIntent) => Effect.Effect<void>;
  /**
   * How long delivery may take before it counts as a stalled start. Read as a
   * thunk so a settings change lands without a server restart, and measured
   * from *after* `prepare`: worktree bootstrap legitimately takes minutes and
   * must not consume the budget. `null` disables the deadline.
   */
  readonly dispatchDeadlineMs?: () => Effect.Effect<number | null>;
  /**
   * Called once, when retries are exhausted, before the provider is terminated.
   * The intent phase alone does not move execution activity off "active", so
   * without this a session keeps rendering as running next to a banner that
   * says it failed.
   */
  readonly onExhausted?: (input: {
    readonly intent: DurableExecutionIntent;
    readonly detail: string;
  }) => Effect.Effect<void>;
  /**
   * Called when a recovery attempt concludes, from the provider's own history,
   * that the turn already completed. The durable item is finished at that
   * point, but the execution is not: if the events that would have settled it
   * never arrived, it is still sitting at "starting" and the session still
   * renders as running. Whoever implements this owns reconciling that.
   */
  readonly onCompletedFromHistory?: (input: {
    readonly intent: DurableExecutionIntent;
    readonly providerTurnId: string;
  }) => Effect.Effect<void>;
}

export interface DurableExecutionCoordinatorShape {
  readonly run: (workItemId: string) => Effect.Effect<void>;
  readonly wake: (workItemId: string) => Effect.Effect<void>;
  readonly runDue: Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Report a stall an outside observer noticed — a turn that was admitted, or
   * acknowledged, and then produced nothing. It is recorded as one failed
   * attempt against this work item, so the ordinary retry budget, backoff, and
   * exhaustion rule decide what happens next. There is deliberately no second
   * retry loop: the recovery itself is the coordinator's own follow-up claim.
   */
  readonly failObserved: (input: {
    readonly workItemId: string;
    readonly failureType: string;
    readonly detail: string;
  }) => Effect.Effect<void>;
}

export const makeDurableExecutionCoordinator = Effect.fn("makeDurableExecutionCoordinator")(
  function* (options: DurableExecutionCoordinatorOptions) {
    const repository = yield* DurableExecutionIntentRepository;
    const globalConcurrency = yield* Semaphore.make(MAX_GLOBAL_CONCURRENCY);
    const wakeQueue = yield* Queue.unbounded<string>();
    const now = options.now ?? (() => Effect.map(DateTime.now, DateTime.formatIso));
    const notifyTransition = (intent: DurableExecutionIntent) =>
      options.onTransition?.({ workItemId: intent.workItemId, threadId: intent.threadId }) ??
      Effect.void;
    const notifyExhausted = (intent: DurableExecutionIntent, detail: string) =>
      options.onExhausted?.({ intent, detail }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to fail execution while exhausting recovery", {
            threadId: intent.threadId,
            workItemId: intent.workItemId,
            cause: Cause.pretty(cause),
          }),
        ),
      ) ?? Effect.void;

    /**
     * The one place a failed attempt is turned into a decision: pause for
     * attention, re-arm the original dispatch, or spend a retry from the budget
     * and exhaust when it runs out. Shared by the dispatch path and by
     * `failObserved` so a stall observed from outside cannot grow a second
     * retry loop with its own backoff and its own idea of "enough".
     */
    const recordDispatchFailure = Effect.fn("DurableExecutionCoordinator.recordDispatchFailure")(
      function* (input: {
        readonly intent: DurableExecutionIntent;
        readonly recovery: boolean;
        readonly error: DurableExecutionDispatchError;
      }) {
        const { intent, recovery, error: dispatchError } = input;
        const failedAt = yield* now();
        if (!dispatchError.retryable) {
          const paused = yield* repository.markFailedAttention({
            workItemId: intent.workItemId,
            owner: options.ownerId,
            generation: intent.claimGeneration,
            failureType: dispatchError.failureType,
            detail: dispatchError.detail,
            at: failedAt,
          });
          if (paused) yield* notifyExhausted(intent, dispatchError.detail);
          if (paused && options.onRecoveryActivity) {
            yield* options.onRecoveryActivity({
              intent,
              kind: "paused",
              attempt: intent.recoveryAttempts,
              detail: dispatchError.detail,
            });
          }
          if (paused && recovery) {
            yield* increment(durableExecutionRecoveryAttemptsTotal, {
              providerInstanceId: intent.providerInstanceId ?? "unknown",
              reason: dispatchError.failureType,
              outcome: "paused",
              attempt: intent.recoveryAttempts,
            });
          }
          return;
        }
        if (!recovery) {
          const recorded = yield* repository.markOriginalDispatchFailed({
            workItemId: intent.workItemId,
            owner: options.ownerId,
            generation: intent.claimGeneration,
            failureType: dispatchError.failureType,
            detail: dispatchError.detail,
            deliveryUncertain: !dispatchError.failureType.startsWith("bootstrap-"),
            at: failedAt,
          });
          if (recorded) yield* Queue.offer(wakeQueue, intent.workItemId);
          return;
        }
        const nextDelay = durableExecutionRetryDelayMs(
          intent.workItemId,
          intent.recoveryAttempts + 1,
        );
        if (nextDelay === null) {
          // Fail the execution before terminating the provider. Termination
          // emits `session.exited`, which on a still-live turn would overwrite
          // this sentence with the generic "Provider session exited."
          yield* notifyExhausted(
            intent,
            `${dispatchError.detail} Automatic recovery gave up after ${intent.recoveryAttempts} attempts.`,
          );
        }
        if (nextDelay === null && options.terminateObserved) {
          yield* options.terminateObserved(intent).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to terminate provider while exhausting recovery", {
                threadId: intent.threadId,
                workItemId: intent.workItemId,
                generation: intent.claimGeneration,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }
        const recorded = yield* repository.markRecoveryAttemptFailed({
          workItemId: intent.workItemId,
          owner: options.ownerId,
          generation: intent.claimGeneration,
          failureType: dispatchError.failureType,
          detail: dispatchError.detail,
          nextAttemptAt: nextDelay === null ? null : addMillis(failedAt, nextDelay),
          at: failedAt,
        });
        if (recorded && nextDelay === null && options.onRecoveryActivity) {
          yield* options.onRecoveryActivity({
            intent,
            kind: "exhausted",
            attempt: intent.recoveryAttempts,
            detail: dispatchError.detail,
          });
        }
        if (recorded) {
          yield* increment(durableExecutionRecoveryAttemptsTotal, {
            providerInstanceId: intent.providerInstanceId ?? "unknown",
            reason: dispatchError.failureType,
            outcome: nextDelay === null ? "exhausted" : "failed",
            attempt: intent.recoveryAttempts,
          });
        }
      },
    );

    const runClaimed = Effect.fn("DurableExecutionCoordinator.runClaimed")(function* (
      claimed: DurableExecutionIntent,
    ) {
      return yield* Effect.gen(function* () {
        const recovery = claimed.phase === "recovering";
        const activeIntent = recovery
          ? yield* repository.beginRecoveryAttempt({
              workItemId: claimed.workItemId,
              owner: options.ownerId,
              generation: claimed.claimGeneration,
              at: yield* now(),
            })
          : Option.some(claimed);
        if (Option.isNone(activeIntent)) return;
        const intent = activeIntent.value;
        if (
          recovery &&
          options.onRecoveryActivity &&
          shouldPublishRecoveryActivity("started", intent.recoveryAttempts)
        ) {
          yield* options.onRecoveryActivity({
            intent,
            kind: "started",
            attempt: intent.recoveryAttempts,
          });
        }
        if (recovery) {
          yield* increment(durableExecutionRecoveryAttemptsTotal, {
            providerInstanceId: intent.providerInstanceId ?? "unknown",
            reason: intent.lastFailureType ?? "unknown",
            outcome: "started",
            attempt: intent.recoveryAttempts,
          });
        }

        const claimStillCurrent = yield* repository.isClaimCurrent({
          workItemId: intent.workItemId,
          owner: options.ownerId,
          generation: intent.claimGeneration,
          now: yield* now(),
        });
        if (!claimStillCurrent) {
          yield* increment(durableExecutionFencingRejectionsTotal, {
            threadId: intent.threadId,
            workItemId: intent.workItemId,
            generation: intent.claimGeneration,
            boundary: "before-load",
          });
          return;
        }

        const renewLease = Effect.gen(function* () {
          const at = yield* now();
          const renewed = yield* repository.renewClaim({
            workItemId: intent.workItemId,
            owner: options.ownerId,
            generation: intent.claimGeneration,
            expiresAt: addMillis(at, LEASE_MS),
            at,
          });
          if (!renewed) return yield* Effect.interrupt;
        }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(LEASE_RENEW_MS))));

        /**
         * Delivery: the segment that must produce turn evidence. Timed by
         * `dispatchDeadlineMs`, unlike everything above it — `prepare` runs a
         * worktree bootstrap whose honest duration is minutes, so counting it
         * would trade one stuck state for a false one.
         */
        const deliver = (event: TurnStartEvent) =>
          Effect.gen(function* () {
            const afterPreparation = yield* now();
            if (
              !(yield* repository.isClaimCurrent({
                workItemId: intent.workItemId,
                owner: options.ownerId,
                generation: intent.claimGeneration,
                now: afterPreparation,
              }))
            ) {
              yield* increment(durableExecutionFencingRejectionsTotal, {
                threadId: intent.threadId,
                workItemId: intent.workItemId,
                generation: intent.claimGeneration,
                boundary: "after-preparation",
              });
              return;
            }
            // Persist the provider side-effect boundary. If this authority dies
            // after delivery but before acknowledgement, startup recovery must
            // inspect/adopt instead of replaying the original prompt. This is
            // also what makes the deadline below safe: a turn that starts late
            // is adopted on the retry rather than sent twice.
            if (
              !(yield* repository.markProviderStarting({
                workItemId: intent.workItemId,
                owner: options.ownerId,
                generation: intent.claimGeneration,
                at: afterPreparation,
              }))
            ) {
              yield* increment(durableExecutionFencingRejectionsTotal, {
                threadId: intent.threadId,
                workItemId: intent.workItemId,
                generation: intent.claimGeneration,
                boundary: "provider-starting",
              });
              return;
            }
            const result = recovery
              ? yield* options.recover({
                  intent,
                  event,
                  mode:
                    intent.deliveryCertainty === "never-delivered"
                      ? "exact-undelivered"
                      : "inspect-or-continue",
                })
              : yield* options.dispatchOriginal({ intent, event });
            if (result.deferred === true) {
              yield* repository.deferClaim({
                workItemId: intent.workItemId,
                owner: options.ownerId,
                generation: intent.claimGeneration,
                at: yield* now(),
              });
              return;
            }
            if (result.completed === true && result.providerTurnId !== null) {
              const reconciled = yield* repository.markCompletedFromHistory({
                workItemId: intent.workItemId,
                owner: options.ownerId,
                generation: intent.claimGeneration,
                providerTurnId: result.providerTurnId,
                providerInstanceId: result.providerInstanceId,
                at: yield* now(),
              });
              if (reconciled && options.onCompletedFromHistory) {
                yield* options
                  .onCompletedFromHistory({ intent, providerTurnId: result.providerTurnId })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to settle execution completed from history", {
                        threadId: intent.threadId,
                        workItemId: intent.workItemId,
                        cause: Cause.pretty(cause),
                      }),
                    ),
                  );
              }
              if (reconciled && recovery && options.onRecoveryActivity) {
                yield* options.onRecoveryActivity({
                  intent,
                  kind: "recovered",
                  attempt: intent.recoveryAttempts,
                });
              }
              if (reconciled && recovery) {
                yield* increment(durableExecutionRecoveryAttemptsTotal, {
                  providerInstanceId: result.providerInstanceId ?? "unknown",
                  reason: intent.lastFailureType ?? "unknown",
                  outcome: "history-completed",
                  attempt: intent.recoveryAttempts,
                });
              }
              return;
            }
            if (result.providerTurnId === null) {
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-turn-not-acknowledged",
                detail: "Provider dispatch returned no matching turn evidence.",
                retryable: true,
              });
            }
            const acknowledged = yield* repository.markAcknowledged({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              providerTurnId: result.providerTurnId,
              providerInstanceId: result.providerInstanceId,
              adoptedExecutionId: result.adoptedExecutionId ?? intent.workItemId,
              at: yield* now(),
            });
            if (acknowledged && recovery && options.onRecoveryActivity) {
              yield* options.onRecoveryActivity({
                intent,
                kind: "recovered",
                attempt: intent.recoveryAttempts,
              });
            }
            if (acknowledged) {
              yield* Metric.update(
                Metric.withAttributes(
                  durableExecutionAckToActiveDuration,
                  metricAttributes({
                    providerInstanceId: result.providerInstanceId ?? "unknown",
                    recovery,
                  }),
                ),
                Duration.millis(
                  Math.max(
                    0,
                    DateTime.toEpochMillis(DateTime.makeUnsafe(yield* now())) -
                      DateTime.toEpochMillis(DateTime.makeUnsafe(intent.acceptedAt)),
                  ),
                ),
              );
              if (recovery) {
                yield* increment(durableExecutionRecoveryAttemptsTotal, {
                  providerInstanceId: result.providerInstanceId ?? "unknown",
                  reason: intent.lastFailureType ?? "unknown",
                  outcome: "recovered",
                  attempt: intent.recoveryAttempts,
                });
              }
            }
          });

        const dispatch = Effect.gen(function* () {
          yield* Effect.forkScoped(renewLease);
          const event = yield* options.loadEvent(intent);
          const beforeSideEffect = yield* now();
          if (
            !(yield* repository.isClaimCurrent({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              now: beforeSideEffect,
            }))
          ) {
            yield* increment(durableExecutionFencingRejectionsTotal, {
              threadId: intent.threadId,
              workItemId: intent.workItemId,
              generation: intent.claimGeneration,
              boundary: "before-provider-side-effect",
            });
            return;
          }
          if (options.prepare) {
            yield* options.prepare({
              intent,
              event,
              owner: options.ownerId,
              generation: intent.claimGeneration,
            });
          }
          const deadlineMs = options.dispatchDeadlineMs
            ? yield* options.dispatchDeadlineMs()
            : null;
          if (deadlineMs === null) return yield* deliver(event);
          const delivered = yield* deliver(event).pipe(
            Effect.timeoutOption(Duration.millis(deadlineMs)),
          );
          if (Option.isNone(delivered)) {
            // The lease renewal fiber lives inside this scope, so a delivery
            // that never returns would renew its claim forever and the work
            // item would never come due again. This is the only bound on that.
            return yield* new DurableExecutionDispatchError({
              failureType: "provider-dispatch-timeout",
              detail: `The agent never started: the provider acknowledged no turn within ${describeMinutes(deadlineMs)}.`,
              retryable: true,
            });
          }
        });

        yield* notifyTransition(intent);
        const exit = yield* Effect.exit(Effect.scoped(dispatch));
        if (Exit.isSuccess(exit)) return;
        const error = Cause.squash(exit.cause);
        yield* recordDispatchFailure({
          intent,
          recovery,
          error: Schema.is(DurableExecutionDispatchError)(error)
            ? error
            : new DurableExecutionDispatchError({
                failureType: "unexpected-dispatch-failure",
                detail: Cause.pretty(exit.cause),
                retryable: true,
                cause: error,
              }),
        });
      }).pipe(
        Effect.ensuring(
          notifyTransition(claimed).pipe(Effect.andThen(Queue.offer(wakeQueue, "")), Effect.asVoid),
        ),
      );
    });

    const run: DurableExecutionCoordinatorShape["run"] = (workItemId) =>
      globalConcurrency
        .withPermits(1)(
          Effect.gen(function* () {
            const at = yield* now();
            const claimed = yield* repository.claim({
              workItemId,
              owner: options.ownerId,
              now: at,
              expiresAt: addMillis(at, LEASE_MS),
            });
            if (Option.isSome(claimed)) {
              yield* notifyTransition(claimed.value);
              yield* runClaimed(claimed.value);
            }
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("durable execution coordinator run failed", {
              workItemId,
              owner: options.ownerId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

    const failObserved: DurableExecutionCoordinatorShape["failObserved"] = ({
      workItemId,
      failureType,
      detail,
    }) =>
      globalConcurrency
        .withPermits(1)(
          Effect.gen(function* () {
            const at = yield* now();
            // Claiming is the fence. A work item the coordinator is actively
            // dispatching holds a live claim, so an observed stall can never
            // interrupt a dispatch that is still making progress; and a claim
            // moves the row to "recovering", which is where the retry budget
            // lives.
            const claimed = yield* repository.claim({
              workItemId,
              owner: options.ownerId,
              now: at,
              expiresAt: addMillis(at, LEASE_MS),
            });
            if (Option.isNone(claimed)) {
              // A claim is refused once the budget is spent, so a work item
              // whose every revive was acknowledged and then stalled again can
              // never fail an attempt and would sit at "running" for good.
              // Close it out here instead: same terminal state, same banner,
              // reached by the only route still open.
              const current = yield* repository.getByWorkItemId({ workItemId });
              const spent =
                Option.isSome(current) &&
                current.value.desiredState === "running" &&
                current.value.recoveryAttempts >= current.value.maximumRecoveryAttempts;
              if (!spent) {
                yield* Effect.logDebug("durable execution stall not claimable", {
                  workItemId,
                  failureType,
                });
                return;
              }
              const exhaustedDetail = `${detail} Automatic recovery gave up after ${current.value.recoveryAttempts} attempts.`;
              const parked = yield* repository.exhaustSpentBudget({
                workItemId,
                failureType,
                detail: exhaustedDetail,
                at: yield* now(),
              });
              if (!parked) return;
              yield* notifyExhausted(current.value, exhaustedDetail);
              yield* (
                options.terminateObserved?.(current.value).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to terminate provider while exhausting recovery", {
                      threadId: current.value.threadId,
                      workItemId,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ) ?? Effect.void
              );
              if (options.onRecoveryActivity) {
                yield* options.onRecoveryActivity({
                  intent: current.value,
                  kind: "exhausted",
                  attempt: current.value.recoveryAttempts,
                  detail,
                });
              }
              yield* increment(durableExecutionRecoveryAttemptsTotal, {
                providerInstanceId: current.value.providerInstanceId ?? "unknown",
                reason: failureType,
                outcome: "exhausted",
                attempt: current.value.recoveryAttempts,
              });
              yield* notifyTransition(current.value);
              return;
            }
            const intent = claimed.value;
            if (intent.phase !== "recovering") {
              // The row turned queued between the observation and the claim, so
              // there is no delivered turn to charge a retry for. Hand it back
              // runnable and due now rather than deferring it: deferring clears
              // `runnable`, and re-arming that depends on a *previous* work item
              // completing — which would park the very thing being rescued.
              // Delivery certainty is left alone; nothing was sent.
              yield* repository.markOriginalDispatchFailed({
                workItemId,
                owner: options.ownerId,
                generation: intent.claimGeneration,
                failureType,
                detail,
                deliveryUncertain: false,
                at: yield* now(),
              });
              yield* Queue.offer(wakeQueue, workItemId);
              return;
            }
            const attempted = yield* repository.beginRecoveryAttempt({
              workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              at: yield* now(),
            });
            if (Option.isNone(attempted)) return;
            yield* recordDispatchFailure({
              intent: attempted.value,
              recovery: true,
              error: new DurableExecutionDispatchError({ failureType, detail, retryable: true }),
            });
            yield* notifyTransition(attempted.value);
            yield* Queue.offer(wakeQueue, "");
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("durable execution observed-stall handling failed", {
              workItemId,
              failureType,
              owner: options.ownerId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

    const runDue: DurableExecutionCoordinatorShape["runDue"] = Effect.gen(function* () {
      const due = yield* repository.listRunnable({ now: yield* now(), limit: 100 });
      yield* Effect.forEach(due, (intent) => run(intent.workItemId), {
        concurrency: MAX_GLOBAL_CONCURRENCY,
        discard: true,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable execution coordinator due scan failed", {
          owner: options.ownerId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const waitForWakeOrDue = Effect.gen(function* () {
      const at = yield* now();
      const next = yield* repository.nextRunnableAt({ now: at });
      if (Option.isNone(next)) return yield* Queue.take(wakeQueue);
      if (next.value <= at) return "";
      return yield* Effect.race(
        Queue.take(wakeQueue),
        Effect.sleep(Duration.millis(millisUntil(at, next.value))).pipe(Effect.as("")),
      );
    });

    const loop = Effect.forever(
      runDue.pipe(
        Effect.andThen(waitForWakeOrDue),
        Effect.flatMap((workItemId) => (workItemId.length === 0 ? Effect.void : run(workItemId))),
      ),
    );

    const start: DurableExecutionCoordinatorShape["start"] = Effect.fn(
      "DurableExecutionCoordinator.start",
    )(function* () {
      const recoveredLeases = yield* repository.reconcileStartup({ at: yield* now() }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("durable execution startup reconciliation failed", {
            owner: options.ownerId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(0)),
        ),
      );
      if (recoveredLeases > 0) {
        yield* increment(
          durableExecutionLeaseRecoveriesTotal,
          { authorityEpoch: options.ownerId },
          recoveredLeases,
        );
      }
      yield* Effect.forkScoped(loop);
      yield* Queue.offer(wakeQueue, "");
    });

    return {
      run,
      wake: (workItemId) => Queue.offer(wakeQueue, workItemId).pipe(Effect.asVoid),
      runDue,
      start,
      failObserved,
    } satisfies DurableExecutionCoordinatorShape;
  },
);
