import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  THREAD_SUBSCRIPTION_RETRY_DELAYS_MS,
  threadSubscriptionRetryDelay,
} from "./threadSubscriptionRetry.ts";

describe("thread subscription retry", () => {
  it("backs off transient failures and then becomes dormant", () => {
    expect(
      THREAD_SUBSCRIPTION_RETRY_DELAYS_MS.map((_, attempt) =>
        Option.getOrThrow(threadSubscriptionRetryDelay(attempt)),
      ),
    ).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000]);
    expect(Option.isNone(threadSubscriptionRetryDelay(6))).toBe(true);
  });
});
