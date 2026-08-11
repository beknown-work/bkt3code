import type * as Duration from "effect/Duration";
import * as Option from "effect/Option";

export const THREAD_SUBSCRIPTION_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;

export function threadSubscriptionRetryDelay(attempt: number): Option.Option<Duration.Input> {
  const delay = THREAD_SUBSCRIPTION_RETRY_DELAYS_MS[attempt];
  return delay === undefined ? Option.none() : Option.some(delay);
}
