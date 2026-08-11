// T3-CUSTOM(expbkt3): coverage for the revive-or-fail stall policy.
//
// The invariants worth protecting here are asymmetric. Failing to spot a stall
// leaves a session lying about being busy; spotting one that is not there
// interrupts an agent mid-thought. So the "never fires" cases below carry as
// much weight as the ones that do, and the blocked case carries the most: a
// session waiting for a human is quiet because it is correct.
//
// Two cases are named after the production rows that produced them. Neither is
// hypothetical, and both encode a decision a future reader would otherwise be
// tempted to simplify away.
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  classifyStalledExecution,
  describeElapsed,
  describeMinutes,
  type StalledExecutionInput,
} from "./StalledExecutionPolicy.ts";

const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - minutes * 60_000));
const secondsAgo = (seconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - seconds * 1_000));

const bounds = {
  startedButNotTakenMs: 90_000,
  deadRuntimeGraceMs: 60_000,
  silentTurnMs: 90 * 60_000,
};

const input = (overrides: Partial<StalledExecutionInput> = {}): StalledExecutionInput => ({
  activity: "active",
  turnState: "running",
  providerSessionState: "ready",
  stopRequestedAt: null,
  turnStartedAt: minutesAgo(10),
  lastOutputAt: minutesAgo(1),
  runtime: "alive",
  nowMs,
  bounds,
  ...overrides,
});

describe("classifyStalledExecution", () => {
  describe("the provider was ready and never took the turn", () => {
    // expbkt3, three sessions launched at once into one directory: one answered
    // in seven seconds, two sat here for fifteen minutes. Their processes were
    // alive and idle the whole time, which is why liveness cannot gate this.
    const stalledStart = (overrides: Partial<StalledExecutionInput> = {}) =>
      input({
        turnState: "starting",
        providerSessionState: "ready",
        turnStartedAt: minutesAgo(15),
        lastOutputAt: minutesAgo(15),
        ...overrides,
      });

    it("reports it once the short bound passes", () => {
      const verdict = classifyStalledExecution(stalledStart());
      expect(verdict.kind).toBe("revive");
      if (verdict.kind !== "revive") return;
      expect(verdict.failureType).toBe("provider-turn-never-started");
      expect(verdict.detail).toBe(
        "The provider session was ready but never started the turn, 15 minutes after it was admitted.",
      );
    });

    it("reports it whatever the provider process is doing", () => {
      // Alive and idle, dead, or unanswerable: none of these may change the
      // verdict. Liveness is evidence, never a gate.
      for (const runtime of ["alive", "dead", "absent", "unknown"] as const) {
        expect(classifyStalledExecution(stalledStart({ runtime })).kind).toBe("revive");
      }
    });

    it("leaves a turn that has only just been admitted alone", () => {
      expect(classifyStalledExecution(stalledStart({ turnStartedAt: secondsAgo(30) }))).toEqual({
        kind: "ignore",
        reason: "starting:ready",
      });
    });

    it("leaves a provider that is still starting to the dispatch deadline", () => {
      // Charging this here would spend a second retry budget on one fault.
      expect(
        classifyStalledExecution(
          stalledStart({ providerSessionState: "starting", runtime: "alive" }),
        ),
      ).toEqual({ kind: "ignore", reason: "starting:starting" });
    });
  });

  it("reports a turn admitted against a provider session that never existed", () => {
    const verdict = classifyStalledExecution(
      input({
        turnState: "starting",
        providerSessionState: "starting",
        runtime: "absent",
        turnStartedAt: minutesAgo(6),
      }),
    );
    expect(verdict.kind).toBe("revive");
    if (verdict.kind !== "revive") return;
    expect(verdict.failureType).toBe("provider-never-started");
  });

  it("reports a runtime that disappeared mid-turn without reporting an exit", () => {
    const verdict = classifyStalledExecution(
      input({ turnState: "running", runtime: "dead", turnStartedAt: minutesAgo(20) }),
    );
    expect(verdict.kind).toBe("revive");
    if (verdict.kind !== "revive") return;
    expect(verdict.failureType).toBe("provider-runtime-gone");
  });

  it("gives a missing runtime a grace period so it does not race the audit or startup", () => {
    expect(
      classifyStalledExecution(
        input({
          turnState: "starting",
          providerSessionState: "starting",
          runtime: "absent",
          turnStartedAt: secondsAgo(30),
        }),
      ),
    ).toEqual({ kind: "ignore", reason: "starting:starting" });
  });

  it("reports a live session that has appended nothing for longer than the backstop", () => {
    const verdict = classifyStalledExecution(
      input({ turnStartedAt: minutesAgo(120), lastOutputAt: minutesAgo(94) }),
    );
    expect(verdict.kind).toBe("revive");
    if (verdict.kind !== "revive") return;
    expect(verdict.failureType).toBe("provider-output-silent");
    expect(verdict.detail).toBe(
      "No output from the agent for 94 minutes while its provider session was still open.",
    );
  });

  it("never fires on a session waiting for a human, however long it has been quiet", () => {
    // Waiting for approval, silent for five hours: the correct behaviour is to
    // keep waiting. This is the case that must not regress.
    for (const turnState of ["waiting-for-approval", "waiting-for-input"] as const) {
      expect(
        classifyStalledExecution(
          input({
            activity: "blocked",
            turnState,
            turnStartedAt: minutesAgo(300),
            lastOutputAt: minutesAgo(300),
          }),
        ),
      ).toEqual({ kind: "ignore", reason: "activity:blocked" });
    }

    // Activity is checked before anything else, so no combination of liveness,
    // provider state or elapsed time can reach a verdict behind it.
    expect(
      classifyStalledExecution(
        input({
          activity: "blocked",
          turnState: "starting",
          providerSessionState: "ready",
          runtime: "absent",
          turnStartedAt: minutesAgo(300),
        }),
      ),
    ).toEqual({ kind: "ignore", reason: "activity:blocked" });
  });

  it("never fires while a stop is in flight", () => {
    expect(
      classifyStalledExecution(
        input({ activity: "stopping", turnState: "stopping", lastOutputAt: minutesAgo(300) }),
      ),
    ).toEqual({ kind: "ignore", reason: "activity:stopping" });

    expect(
      classifyStalledExecution(
        input({ stopRequestedAt: minutesAgo(30), lastOutputAt: minutesAgo(300) }),
      ),
    ).toEqual({ kind: "ignore", reason: "stop-in-flight" });
  });

  it("leaves a long turn alone while it is still producing output (thread 89654a8e)", () => {
    // The production row that decided where silence is measured from. Its
    // `provider_last_observed_at` was 112 minutes stale while the event log had
    // provider output six seconds old, because that column only moves on
    // provider *lifecycle* events. Anyone tempted to simplify the watchdog back
    // to the projection column fails here.
    expect(
      classifyStalledExecution(
        input({ turnStartedAt: minutesAgo(180), lastOutputAt: secondsAgo(6) }),
      ),
    ).toEqual({ kind: "ignore", reason: "output-recent" });
  });

  it("measures a thread with no events at all from the turn start", () => {
    expect(
      classifyStalledExecution(input({ lastOutputAt: null, turnStartedAt: minutesAgo(5) })),
    ).toEqual({ kind: "ignore", reason: "output-recent" });

    expect(
      classifyStalledExecution(input({ lastOutputAt: null, turnStartedAt: minutesAgo(95) })).kind,
    ).toBe("revive");
  });

  it("ignores output timestamps older than the turn that is running now", () => {
    // A resumed thread carries events from previous turns. Measuring from those
    // would fail a turn that has only just been admitted.
    expect(
      classifyStalledExecution(
        input({ turnStartedAt: minutesAgo(2), lastOutputAt: minutesAgo(400) }),
      ),
    ).toEqual({ kind: "ignore", reason: "output-recent" });
  });

  it("ignores states with nothing to measure or nothing to fix", () => {
    expect(classifyStalledExecution(input({ activity: "idle" }))).toEqual({
      kind: "ignore",
      reason: "activity:idle",
    });
    expect(classifyStalledExecution(input({ activity: "failed" }))).toEqual({
      kind: "ignore",
      reason: "activity:failed",
    });
    expect(classifyStalledExecution(input({ turnState: null }))).toEqual({
      kind: "ignore",
      reason: "turn:none",
    });
    expect(classifyStalledExecution(input({ turnState: "completed" }))).toEqual({
      kind: "ignore",
      reason: "turn:completed",
    });
    expect(classifyStalledExecution(input({ turnStartedAt: null }))).toEqual({
      kind: "ignore",
      reason: "turn-start-unknown",
    });
    expect(classifyStalledExecution(input({ turnStartedAt: "not-a-date" }))).toEqual({
      kind: "ignore",
      reason: "turn-start-unknown",
    });
  });
});

describe("describeElapsed", () => {
  it("reads as a sentence at both scales", () => {
    expect(describeElapsed(90_000)).toBe("2 minutes");
    expect(describeElapsed(30_000)).toBe("30 seconds");
    expect(describeElapsed(1_000)).toBe("1 second");
    expect(describeMinutes(60_000)).toBe("1 minute");
    expect(describeMinutes(300_000)).toBe("5 minutes");
  });
});
