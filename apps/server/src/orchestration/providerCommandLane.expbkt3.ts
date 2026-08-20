/**
 * T3-CUSTOM(expbkt3): Non-invasive deadline for the upstream provider-command lane.
 *
 * ProviderCommandReactor deliberately uses one ordered DrainableWorker. Keep
 * that upstream model, but never join one provider operation forever: its
 * finalizer may be uninterruptible while an SDK callback is pending. The
 * command runs detached so timing out the join releases the lane immediately;
 * cleanup is then requested without awaiting the same stuck finalizer.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

export const DEFAULT_PROVIDER_COMMAND_LANE_DEADLINE: Duration.Input = "30 seconds";

export interface ProviderCommandLaneDeadlineInput {
  readonly eventType: string;
  readonly threadId: string;
  readonly commandId: string | null;
  readonly timeout?: Duration.Input;
}

export const runProviderCommandWithinLaneDeadline = <E, R>(
  command: Effect.Effect<void, E, R>,
  input: ProviderCommandLaneDeadlineInput,
) =>
  Effect.gen(function* () {
    // Start in the current scheduler turn so healthy commands retain the
    // upstream worker's observable ordering; only their lifetime is detached.
    const commandFiber = yield* command.pipe(Effect.forkDetach({ startImmediately: true }));
    const timeout = input.timeout ?? DEFAULT_PROVIDER_COMMAND_LANE_DEADLINE;
    const completed = yield* Fiber.join(commandFiber).pipe(Effect.timeoutOption(timeout));
    if (Option.isSome(completed)) return;

    yield* Fiber.interrupt(commandFiber).pipe(Effect.forkDetach, Effect.asVoid);
    yield* Effect.logWarning("provider command timed out and released the reactor lane", {
      eventType: input.eventType,
      threadId: input.threadId,
      commandId: input.commandId,
      timeout: String(timeout),
    });
  });
