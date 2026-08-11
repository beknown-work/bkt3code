/**
 * StalledExecutionPolicy - when a turn that claims to be working is not.
 *
 * Execution activity only moves inside a transition, and every caller of that
 * transition is an event: an admitted turn, a provider runtime event, a stop. A
 * turn that is admitted and then produces nothing therefore stays "active"
 * forever, and the UI derives "running" from exactly that. This module is the
 * decision that closes the gap, kept pure so the rules can be read and tested
 * without a provider, a database, or a clock.
 *
 * ## The strongest signal is our own state machine, not the operating system
 *
 * `turn.state = "starting"` means the supervisor admitted the turn and has not
 * seen `turn.started`. `providerSession.state = "ready"` means the provider
 * handshake completed. Together they say something unambiguous: **the provider
 * is up and simply never took the turn.** Seconds in that combination are
 * normal. Ninety of them are not, and no amount of waiting fixes it.
 *
 * This was learned the expensive way. Three sessions launched at once into one
 * directory: one answered in seven seconds, two sat at starting+ready for over
 * fifteen minutes. Their provider processes were alive the whole time — idle in
 * `ep_poll` at 0% CPU, children parked in `futex_do_wait`. Every process-level
 * signal said "healthy".
 *
 * ## Liveness is evidence, never a gate
 *
 * That incident is why `runtime` may only ever *shorten* a bound, never suppress
 * a verdict, and why `"unknown"` is a first-class value rather than a reason to
 * skip:
 *
 *   - A missing or dead runtime is **proof of absence** — nothing exists that
 *     could produce output — so it fires on a short grace, long enough only to
 *     stay off the 15-second invariant audit's and startup's toes.
 *   - A live runtime proves only that the adapter still holds a record. It
 *     cannot tell a wedged CLI from a long quiet tool call, and as above it
 *     cannot even tell a wedged CLI from a working one. So it buys nothing and
 *     blocks nothing.
 *
 * Silence keeps its long backstop for the mid-turn shape, and it is measured
 * against real appended output rather than the execution projection.
 * `provider_last_observed_at` only moves on provider *lifecycle* events, so a
 * healthy Codex turn streaming for two hours leaves it two hours stale; keying
 * on it would kill working sessions. See `StalledExecutionWatchdog`.
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

/**
 * What the provider adapter says about the session behind this turn. Optional
 * evidence: it can shorten a bound, never lengthen one, and never suppress a
 * verdict. `"unknown"` is what an adapter that cannot answer contributes.
 */
export type StalledExecutionRuntime =
  /** A session record exists and reports itself open. */
  | "alive"
  /** A session record exists and reports itself closed. */
  | "dead"
  /** No session record at all. */
  | "absent"
  /** The adapter could not answer. Not evidence of anything, either way. */
  | "unknown";

export interface StalledExecutionBounds {
  /**
   * How long a turn may sit at "starting" while its provider session is already
   * up. This is the primary detector and the shortest bound, because the state
   * pair it keys on cannot occur in a healthy turn for long.
   */
  readonly startedButNotTakenMs: number;
  /** Grace after turn start before a missing runtime counts as a stall. */
  readonly deadRuntimeGraceMs: number;
  /** How long a running turn may append nothing before it counts as a stall. */
  readonly silentTurnMs: number;
}

export interface StalledExecutionInput {
  readonly activity: ThreadExecutionSnapshot["activity"];
  readonly turnState: NonNullable<ThreadExecutionSnapshot["turn"]>["state"] | null;
  readonly providerSessionState: ThreadExecutionSnapshot["providerSession"]["state"];
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
      readonly stalledForMs: number;
    };

/** Bounds are milliseconds, but a person reads an error message in minutes. */
export function describeMinutes(millis: number): string {
  const minutes = Math.max(1, Math.round(millis / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Sub-minute bounds read as nonsense in minutes, so say seconds below one. */
export function describeElapsed(millis: number): string {
  if (millis < 60_000) {
    const seconds = Math.max(1, Math.round(millis / 1_000));
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  return describeMinutes(millis);
}

const parsedMillis = (iso: string | null): number | null => {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
};

const runtimeIsGone = (runtime: StalledExecutionRuntime) =>
  runtime === "absent" || runtime === "dead";

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
  const runtimeGone = runtimeIsGone(input.runtime);

  if (input.turnState === "starting") {
    // Liveness may shorten: a runtime that is provably gone needs no patience.
    if (runtimeGone && sinceTurnStartMs > input.bounds.deadRuntimeGraceMs) {
      return {
        kind: "revive",
        failureType: "provider-never-started",
        detail: `The agent never started: no provider session exists ${describeElapsed(sinceTurnStartMs)} after the turn was admitted.`,
        stalledForMs: sinceTurnStartMs,
      };
    }
    // The primary detector. "ready" is the whole live set here: the supervisor
    // normalises an adapter reporting "running" to "ready"
    // (`inspectionProviderState`), so a session that is up is exactly this.
    //
    // Deliberately not extended to a provider session that is itself still
    // "starting": a slow launch is the durable dispatch deadline's job, and
    // charging the same failure twice would burn two retry budgets for one
    // fault.
    if (
      input.providerSessionState === "ready" &&
      sinceTurnStartMs > input.bounds.startedButNotTakenMs
    ) {
      return {
        kind: "revive",
        failureType: "provider-turn-never-started",
        detail: `The provider session was ready but never started the turn, ${describeElapsed(sinceTurnStartMs)} after it was admitted.`,
        stalledForMs: sinceTurnStartMs,
      };
    }
    return { kind: "ignore", reason: `starting:${input.providerSessionState}` };
  }

  // A running turn. A runtime that is gone is proof; otherwise fall back to how
  // long the thread has actually appended nothing.
  if (runtimeGone && sinceTurnStartMs > input.bounds.deadRuntimeGraceMs) {
    return {
      kind: "revive",
      failureType: "provider-runtime-gone",
      detail: `The provider session disappeared ${describeElapsed(sinceTurnStartMs)} into the turn without reporting an exit.`,
      stalledForMs: sinceTurnStartMs,
    };
  }
  // Fall back to the turn start when the thread has no events of its own, so a
  // turn that has never said anything is still measurable.
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
    detail: `No output from the agent for ${describeElapsed(quietForMs)} while its provider session was still open.`,
    stalledForMs: quietForMs,
  };
}
