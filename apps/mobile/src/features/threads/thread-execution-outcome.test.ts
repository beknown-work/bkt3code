import type { ThreadExecutionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getThreadExecutionOutcome } from "./thread-execution-outcome";

function execution(turn: Record<string, unknown>): ThreadExecutionSnapshot {
  return { turn } as ThreadExecutionSnapshot;
}

describe("getThreadExecutionOutcome", () => {
  it("shows a stopped outcome for an interrupted turn or a completed turn that honored a stop", () => {
    expect(
      getThreadExecutionOutcome(
        execution({ completedAt: "2026-09-05T12:00:00.000Z", state: "interrupted" }),
      ),
    ).toEqual({
      kind: "stopped",
      providerTurnId: undefined,
      detail: "This response was stopped before it completed.",
      title: "Agent stopped",
    });
    expect(getThreadExecutionOutcome(execution({ state: "interrupted" }))).toBeNull();
    expect(
      getThreadExecutionOutcome(
        execution({
          completedAt: "2026-09-05T12:00:00.000Z",
          state: "completed",
          stopRequestedAt: "2026-09-05T11:59:59.000Z",
        }),
      ),
    ).toEqual({
      kind: "stopped",
      providerTurnId: undefined,
      detail: "This response was stopped before it completed.",
      title: "Agent stopped",
    });
  });

  it("uses the supervisor failure detail and never labels a completed turn as failed", () => {
    expect(
      getThreadExecutionOutcome(
        execution({
          completedAt: "2026-09-05T12:00:00.000Z",
          lastError: "Provider connection closed.",
          state: "failed",
        }),
      ),
    ).toEqual({
      kind: "failed",
      providerTurnId: undefined,
      detail: "Provider connection closed.",
      title: "Agent failed",
    });
    expect(
      getThreadExecutionOutcome(
        execution({ completedAt: "2026-09-05T12:00:00.000Z", state: "completed" }),
      ),
    ).toBeNull();
  });
});
