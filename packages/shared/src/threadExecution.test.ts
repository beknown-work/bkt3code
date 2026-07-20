import { ProviderInstanceId, ThreadId, type ThreadExecutionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeThreadExecution } from "./threadExecution.js";

const snapshot = (overrides: Partial<ThreadExecutionSnapshot> = {}): ThreadExecutionSnapshot => ({
  threadId: ThreadId.make("thread-status"),
  authorityEpoch: "epoch-test",
  revision: 1,
  observedAt: "2026-07-20T00:00:00.000Z",
  activity: "active",
  canStop: true,
  providerSession: {
    state: "starting",
    generation: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    startedAt: "2026-07-20T00:00:00.000Z",
    lastObservedAt: "2026-07-20T00:00:00.000Z",
    lastError: null,
  },
  turn: {
    executionId: "execution-test",
    providerTurnId: null,
    state: "starting",
    startedAt: "2026-07-20T00:00:00.000Z",
    stopRequestedAt: null,
    completedAt: null,
    lastError: null,
  },
  ...overrides,
});

describe("describeThreadExecution", () => {
  it("describes provider startup and active work", () => {
    expect(describeThreadExecution(snapshot(), "Codex")).toBe("Starting Codex session");
    expect(
      describeThreadExecution(
        snapshot({
          providerSession: { ...snapshot().providerSession, state: "ready" },
          turn: { ...snapshot().turn!, state: "running" },
        }),
      ),
    ).toBe("Agent is working");
  });

  it("surfaces the backend error message", () => {
    expect(
      describeThreadExecution(
        snapshot({
          activity: "failed",
          turn: { ...snapshot().turn!, state: "failed", lastError: "Codex failed to start." },
        }),
      ),
    ).toBe("Codex failed to start.");
  });
});
