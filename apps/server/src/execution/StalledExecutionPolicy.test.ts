// T3-CUSTOM(expbkt3): coverage for the revive-or-fail stall policy.
//
// The invariants worth protecting here are asymmetric. Failing to spot a stall
// leaves a session lying about being busy; spotting one that is not there
// interrupts an agent mid-thought. So the "never fires" cases below carry as
// much weight as the ones that do, and the blocked case carries the most: a
// session waiting for a human is quiet because it is correct.
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  classifyStalledExecution,
  describeMinutes,
  type StalledExecutionInput,
} from "./StalledExecutionPolicy.ts";

const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - minutes * 60_000));

const bounds = { deadRuntimeGraceMs: 60_000, silentTurnMs: 90 * 60_000 };

const input = (overrides: Partial<StalledExecutionInput> = {}): StalledExecutionInput => ({
  activity: "active",
  turnState: "running",
  stopRequestedAt: null,
  turnStartedAt: minutesAgo(10),
  lastOutputAt: minutesAgo(1),
  runtime: "alive",
  nowMs,
  bounds,
  ...overrides,
});

describe("classifyStalledExecution", () => {
  it("reports a turn that was admitted and never got a provider session", () => {
    const verdict = classifyStalledExecution(
      input({ turnState: "starting", runtime: "absent", turnStartedAt: minutesAgo(6) }),
    );
    expect(verdict.kind).toBe("revive");
    if (verdict.kind !== "revive") return;
    expect(verdict.failureType).toBe("provider-never-started");
    expect(verdict.detail).toBe(
      "The agent never started: no provider session exists 6 minutes after the turn was admitted.",
    );
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
    const verdict = classifyStalledExecution(
      input({ turnState: "starting", runtime: "absent", turnStartedAt: minutesAgo(0.5) }),
    );
    expect(verdict).toEqual({ kind: "ignore", reason: "dead-runtime-grace" });
  });

  it("reports a live session that has appended nothing for longer than the backstop", () => {
    const verdict = classifyStalledExecution(
      input({ runtime: "alive", turnStartedAt: minutesAgo(120), lastOutputAt: minutesAgo(94) }),
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
    expect(
      classifyStalledExecution(
        input({
          activity: "blocked",
          turnState: "waiting-for-approval",
          turnStartedAt: minutesAgo(300),
          lastOutputAt: minutesAgo(300),
        }),
      ),
    ).toEqual({ kind: "ignore", reason: "activity:blocked" });

    expect(
      classifyStalledExecution(
        input({
          activity: "blocked",
          turnState: "waiting-for-input",
          turnStartedAt: minutesAgo(300),
          lastOutputAt: minutesAgo(300),
        }),
      ),
    ).toEqual({ kind: "ignore", reason: "activity:blocked" });

    // Liveness is checked after activity, never before: a blocked session whose
    // runtime has vanished is still not this module's business.
    expect(
      classifyStalledExecution(
        input({
          activity: "blocked",
          turnState: "waiting-for-approval",
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

  it("leaves a long turn alone while it is still producing output", () => {
    // The shape that proved the projection's own `provider_last_observed_at` is
    // useless here: a Codex turn three hours in, streaming as it goes.
    expect(
      classifyStalledExecution(
        input({ turnStartedAt: minutesAgo(180), lastOutputAt: minutesAgo(0.5) }),
      ),
    ).toEqual({ kind: "ignore", reason: "output-recent" });
  });

  it("measures a thread with no events at all from the turn start", () => {
    expect(
      classifyStalledExecution(input({ lastOutputAt: null, turnStartedAt: minutesAgo(5) })),
    ).toEqual({ kind: "ignore", reason: "output-recent" });

    const stalled = classifyStalledExecution(
      input({ lastOutputAt: null, turnStartedAt: minutesAgo(95) }),
    );
    expect(stalled.kind).toBe("revive");
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

describe("describeMinutes", () => {
  it("reads as a sentence rather than a duration literal", () => {
    expect(describeMinutes(60_000)).toBe("1 minute");
    expect(describeMinutes(300_000)).toBe("5 minutes");
    expect(describeMinutes(1_000)).toBe("1 minute");
  });
});
