/**
 * StalledExecutionPolicy - when silence becomes evidence.
 *
 * Execution activity only moves inside a transition, and every caller of that
 * transition is an event: an admitted turn, a provider runtime event, a stop. A
 * turn that is admitted and then produces nothing therefore stays "active"
 * forever, and the UI derives "running" from exactly that. This module is the
 * decision that closes the gap, kept pure so the rules can be read and tested
 * without a provider, a database, or a clock.
 *
 * ## Liveness first, silence as a long backstop
 *
 * The two signals available are not equally trustworthy, and that asymmetry is
 * the whole policy.
 *
 * `runtimeAlive` is bookkeeping, not an operating-system probe: the adapters
 * derive it from their in-memory session map (`status !== "closed"`), which is
 * also why the stop path's own error says process-tree termination "could not be
 * *verified*". So:
 *
 *   - A missing or dead runtime is **proof of absence**. Nothing exists that
 *     could produce output, whatever the projection says. It is cheap to check
 *     and cannot be a false positive, so it acts on a short grace — long enough
 *     only to stay off the 15-second invariant audit's and startup's toes.
 *   - A live runtime proves only that the adapter still holds a record. It
 *     cannot tell a wedged CLI from a long quiet tool call; a forty-minute test
 *     run appends nothing to the thread and is perfectly healthy. Pure silence
 *     therefore gets a much longer backstop, and it is measured against real
 *     appended output rather than the execution projection.
 *
 * Requiring a dead process would miss the hung-but-alive case entirely; acting
 * on silence alone would kill long quiet turns. Liveness gates the fast path,
 * silence only ever arms the slow one — and because the verdict is "revive",
 * which inspects and re-adopts a turn that is genuinely progressing, a false
 * positive costs a retry rather than the user's work.
 *
 * ## Never on a session that is waiting for a human
 *
 * `activity: "blocked"` means waiting-for-approval or waiting-for-input. That
 * session is quiet because it is correct, and killing it would be worse than the
 * bug this module exists to fix. The guard is structural: only `"active"` can
 * reach a verdict at all, and it is the first rule, so no later reordering can
 * expose the blocked case.
 *
 * @module StalledExecutionPolicy
 */
import type { ThreadExecutionSnapshot } from "@t3tools/contracts";

/** What the provider adapter says about the session behind this turn. */
export type StalledExecutionRuntime =
  /** A session record exists and reports itself open. */
  | "alive"
  /** A session record exists and reports itself closed. */
  | "dead"
  /** No session record at all. */
  | "absent";

export interface StalledExecutionBounds {
  /** Grace after turn start before a missing runtime counts as a stall. */
  readonly deadRuntimeGraceMs: number;
  /** How long a live runtime may append nothing before it counts as a stall. */
  readonly silentTurnMs: number;
}

export interface StalledExecutionInput {
  readonly activity: ThreadExecutionSnapshot["activity"];
  readonly turnState: NonNullable<ThreadExecutionSnapshot["turn"]>["state"] | null;
  readonly stopRequestedAt: string | null;
  /** When the turn was admitted. */
  readonly turnStartedAt: string | null;
  /** Newest event appended to the thread, from the event log. Null if none. */
  readonly lastOutputAt: string | null;
  readonly runtime: StalledExecutionRuntime;
  readonly nowMs: number;
  readonly bounds: StalledExecutionBounds;
}

export type StalledExecutionVerdict =
  | { readonly kind: "ignore"; readonly reason: string }
  | {
      readonly kind: "revive";
      readonly failureType: string;
      readonly detail: string;
      readonly quietForMs: number;
    };

/** Bounds are milliseconds, but a person reads an error message in minutes. */
export function describeMinutes(millis: number): string {
  const minutes = Math.max(1, Math.round(millis / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const parsedMillis = (iso: string | null): number | null => {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
};

export function classifyStalledExecution(input: StalledExecutionInput): StalledExecutionVerdict {
  // Rule one, and it stays rule one: only a session that claims to be working
  // can be judged. "blocked" is waiting for a human and "stopping" belongs to
  // the stop path, which carries its own timeout.
  if (input.activity !== "active") {
    return { kind: "ignore", reason: `activity:${input.activity}` };
  }
  if (
    input.turnState === null ||
    input.turnState === "waiting-for-approval" ||
    input.turnState === "waiting-for-input" ||
    input.turnState === "stopping" ||
    input.turnState === "completed" ||
    input.turnState === "interrupted" ||
    input.turnState === "failed"
  ) {
    return { kind: "ignore", reason: `turn:${input.turnState ?? "none"}` };
  }
  if (input.stopRequestedAt !== null) {
    return { kind: "ignore", reason: "stop-in-flight" };
  }

  const turnStartedMs = parsedMillis(input.turnStartedAt);
  if (turnStartedMs === null) {
    // Without a turn start there is no interval to measure, and guessing one
    // would mean guessing in the direction of killing work.
    return { kind: "ignore", reason: "turn-start-unknown" };
  }
  const sinceTurnStartMs = Math.max(0, input.nowMs - turnStartedMs);

  if (input.runtime !== "alive") {
    if (sinceTurnStartMs <= input.bounds.deadRuntimeGraceMs) {
      return { kind: "ignore", reason: "dead-runtime-grace" };
    }
    return input.turnState === "starting"
      ? {
          kind: "revive",
          failureType: "provider-never-started",
          detail: `The agent never started: no provider session exists ${describeMinutes(sinceTurnStartMs)} after the turn was admitted.`,
          quietForMs: sinceTurnStartMs,
        }
      : {
          kind: "revive",
          failureType: "provider-runtime-gone",
          detail: `The provider session disappeared ${describeMinutes(sinceTurnStartMs)} into the turn without reporting an exit.`,
          quietForMs: sinceTurnStartMs,
        };
  }

  // A live runtime: fall back to the turn start when the thread has no events
  // of its own, so a turn that has never said anything is still measurable.
  const lastOutputMs = parsedMillis(input.lastOutputAt);
  const quietSinceMs =
    lastOutputMs === null ? turnStartedMs : Math.max(lastOutputMs, turnStartedMs);
  const quietForMs = Math.max(0, input.nowMs - quietSinceMs);
  if (quietForMs <= input.bounds.silentTurnMs) {
    return { kind: "ignore", reason: "output-recent" };
  }
  return {
    kind: "revive",
    failureType: "provider-output-silent",
    detail: `No output from the agent for ${describeMinutes(quietForMs)} while its provider session was still open.`,
    quietForMs,
  };
}
