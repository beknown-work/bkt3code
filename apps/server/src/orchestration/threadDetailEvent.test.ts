import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./threadDetailEvent.ts";

describe("isThreadDetailEvent", () => {
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
