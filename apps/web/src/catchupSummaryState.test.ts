/**
 * T3-CUSTOM(expbkt3): Focused coverage for immediate catch-up request feedback.
 */
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CatchupSummary } from "./types";
import {
  makeCatchupRequestError,
  makePendingCatchupSummary,
  mergeCatchupSummaryMaps,
} from "./catchupSummaryState";

const turnId = TurnId.make("turn-catchup");
const requestedAt = "2026-07-27T01:00:00.000Z";

describe("catch-up request UI state", () => {
  it("creates the pending card immediately", () => {
    expect(makePendingCatchupSummary(turnId, requestedAt)).toEqual({
      turnId,
      assistantMessageId: null,
      summary: null,
      status: "pending",
      createdAt: requestedAt,
    });
  });

  it("keeps a command failure in the same card", () => {
    expect(
      makeCatchupRequestError(turnId, "2026-07-27T01:00:01.000Z", new Error("Server unavailable.")),
    ).toMatchObject({
      turnId,
      summary: "Server unavailable.",
      status: "error",
    });
  });

  it("uses transient state until a newer server update arrives", () => {
    const oldReady: CatchupSummary = {
      turnId,
      assistantMessageId: null,
      summary: "Old summary.",
      status: "ready",
      createdAt: "2026-07-27T00:59:00.000Z",
    };
    const pending = makePendingCatchupSummary(turnId, requestedAt);
    const newReady: CatchupSummary = {
      ...oldReady,
      summary: "New summary.",
      createdAt: "2026-07-27T01:00:02.000Z",
    };

    expect(
      mergeCatchupSummaryMaps(new Map([[turnId, oldReady]]), new Map([[turnId, pending]])).get(
        turnId,
      )?.status,
    ).toBe("pending");
    expect(
      mergeCatchupSummaryMaps(new Map([[turnId, newReady]]), new Map([[turnId, pending]])).get(
        turnId,
      )?.summary,
    ).toBe("New summary.");
  });
});
