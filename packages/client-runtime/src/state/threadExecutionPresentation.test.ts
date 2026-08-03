import { describe, expect, it } from "@effect/vitest";

import { deriveThreadExecutionPresentation } from "./threadExecutionPresentation.ts";

describe("durable thread execution presentation", () => {
  it("shows local durable outbox work as active immediately", () => {
    expect(
      deriveThreadExecutionPresentation({
        hasPendingOutboxItem: true,
        intent: null,
        providerActivity: "idle",
      }),
    ).toEqual({ active: true, label: "Sending", needsAttention: false });
  });

  it.each([
    ["queued", "Queued"],
    ["preparing", "Preparing"],
    ["starting", "Starting"],
    ["running", "Running"],
    ["waiting-for-approval", "Waiting for approval"],
    ["waiting-for-input", "Waiting for input"],
    ["recovering", "Recovering"],
    ["retry-wait", "Retrying"],
    ["stopping", "Stopping"],
  ] as const)("maps %s to an honest active phase", (phase, label) => {
    expect(
      deriveThreadExecutionPresentation({
        hasPendingOutboxItem: false,
        intent: {
          desiredState: phase === "stopping" ? "stopped" : "running",
          phase,
          recovery: { userActionRequired: false },
        },
        providerActivity: "idle",
      }),
    ).toEqual({ active: true, label, needsAttention: false });
  });

  it("keeps exhausted work visible without claiming it is running", () => {
    expect(
      deriveThreadExecutionPresentation({
        hasPendingOutboxItem: false,
        intent: {
          desiredState: "stopped",
          phase: "recovery-exhausted",
          recovery: { userActionRequired: true },
        },
        providerActivity: "failed",
      }),
    ).toEqual({ active: false, label: "Recovery failed", needsAttention: true });
  });

  it("falls back to provider observation on older servers", () => {
    expect(
      deriveThreadExecutionPresentation({
        hasPendingOutboxItem: false,
        intent: null,
        providerActivity: "active",
      }),
    ).toEqual({ active: true, label: "Running", needsAttention: false });
  });
});
