import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ProviderAdapterShape } from "./Services/ProviderAdapter.ts";

type LifecycleSource<TError> = Pick<
  ProviderAdapterShape<TError>,
  "hasSession" | "interruptTurn" | "listSessions" | "stopSession" | "streamEvents"
>;

type ObservableLifecycle<TError> = Required<
  Pick<
    ProviderAdapterShape<TError>,
    "inspectSession" | "requestTurnInterrupt" | "terminateSession" | "watchSession"
  >
>;

/**
 * Adds the observable lifecycle contract to a built-in adapter. Adapter map
 * ownership remains intact until `stopSession` has verified its runtime close;
 * this wrapper then verifies that ownership is no longer reported.
 */
export function makeObservableLifecycle<TError>(
  source: LifecycleSource<TError>,
): ObservableLifecycle<TError> {
  return {
    inspectSession: (threadId) =>
      Effect.gen(function* () {
        if (!(yield* source.hasSession(threadId))) return null;
        const session = (yield* source.listSessions()).find((entry) => entry.threadId === threadId);
        if (!session) return null;
        return {
          threadId,
          // ProviderService owns the externally visible generation and replaces
          // this local placeholder before returning the inspection.
          generation: 0,
          state:
            session.status === "connecting"
              ? "starting"
              : session.status === "running"
                ? "running"
                : session.status === "error"
                  ? "failed"
                  : session.status === "closed"
                    ? "stopped"
                    : "ready",
          activeProviderTurnId: session.activeTurnId ?? null,
          runtimeAlive: session.status !== "closed",
        } as const;
      }),
    requestTurnInterrupt: (threadId, turnId) =>
      source.interruptTurn(threadId, turnId).pipe(
        Effect.andThen(DateTime.now),
        Effect.map((now) => ({
          acknowledged: true,
          acknowledgedAt: DateTime.formatIso(now),
        })),
      ),
    terminateSession: (threadId) =>
      source.stopSession(threadId).pipe(
        Effect.andThen(Effect.suspend(() => source.hasSession(threadId))),
        Effect.map((runtimeAlive) => ({
          verified: !runtimeAlive,
          graceful: !runtimeAlive,
          processTreeExited: !runtimeAlive,
        })),
      ),
    watchSession: (threadId, generation) =>
      source.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.map((event) => ({ ...event, sessionGeneration: generation })),
      ),
  };
}
