import * as Effect from "effect/Effect";

const SHELL_PROJECTION_POLL_INTERVAL = "10 millis";

/**
 * Wait until every durable projection has applied the event that will be
 * represented by a shell delta. Domain-event delivery and projection updates
 * run concurrently, so querying shell rows before this point can permanently
 * drop an upsert from a connected client's sidebar.
 */
export const awaitShellProjectionSequence = Effect.fn(
  "ShellProjectionBarrier.awaitShellProjectionSequence",
)(function* <E>(input: {
  readonly eventSequence: number;
  readonly eventType: string;
  readonly readSnapshotSequence: () => Effect.Effect<{ readonly snapshotSequence: number }, E>;
}) {
  let loggedReadFailure = false;
  for (;;) {
    const projectionSequence = yield* input.readSnapshotSequence().pipe(Effect.result);
    if (
      projectionSequence._tag === "Success" &&
      projectionSequence.success.snapshotSequence >= input.eventSequence
    ) {
      return;
    }
    if (projectionSequence._tag === "Failure" && !loggedReadFailure) {
      loggedReadFailure = true;
      yield* Effect.logWarning("waiting for shell projection after sequence read failed", {
        eventSequence: input.eventSequence,
        eventType: input.eventType,
        cause: projectionSequence.failure,
      });
    }
    yield* Effect.sleep(SHELL_PROJECTION_POLL_INTERVAL);
  }
});
