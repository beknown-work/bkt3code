/**
 * T3-CUSTOM(expbkt3): Regression coverage for the Plan → Build transition.
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { approvedPlanInteractionModeCommand } from "./PlannotatorManager.ts";

const threadId = ThreadId.make("thread-plan-review");
const commandId = CommandId.make("plannotator:mode:test");
const createdAt = "2026-07-26T20:00:00.000Z";

describe("Plannotator decision interaction mode", () => {
  it("switches an approved plan to Build/default mode", () => {
    expect(
      approvedPlanInteractionModeCommand({
        decision: { kind: "approved", feedback: "" },
        threadId,
        commandId,
        createdAt,
      }),
    ).toEqual({
      type: "thread.interaction-mode.set",
      commandId,
      threadId,
      interactionMode: "default",
      createdAt,
    });
  });

  it.each([
    { kind: "feedback" as const, feedback: "Revise the rollout." },
    { kind: "denied" as const, feedback: "" },
  ])("does not change mode for a $kind decision", (decision) => {
    expect(
      approvedPlanInteractionModeCommand({
        decision,
        threadId,
        commandId,
        createdAt,
      }),
    ).toBeNull();
  });
});
