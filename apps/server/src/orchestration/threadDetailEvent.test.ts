import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./threadDetailEvent.ts";

describe("isThreadDetailEvent", () => {
  // T3-CUSTOM(expbkt3): live workspace preparation must advance beyond the HTTP snapshot.
  it.each([
    "thread.bootstrap-requested",
    "thread.bootstrap-step-updated",
    "thread.bootstrap-completed",
  ] as const)("routes %s to already-open thread subscriptions", (type) => {
    const event = { type } as OrchestrationEvent;

    expect(isThreadDetailEvent(event)).toBe(true);
  });

  it("routes catch-up progress to already-open thread subscriptions", () => {
    const event = {
      type: "thread.catchup-summary-updated",
    } as OrchestrationEvent;

    expect(isThreadDetailEvent(event)).toBe(true);
  });

  it("does not route shell-only project events to a thread detail", () => {
    const event = {
      type: "project.meta-updated",
    } as OrchestrationEvent;

    expect(isThreadDetailEvent(event)).toBe(false);
  });
});
