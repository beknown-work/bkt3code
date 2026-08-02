/**
 * T3-CUSTOM(expbkt3): Orchestration command acknowledgement timeout.
 *
 * Lives in its own module (rather than `commandsFork.ts`) because the fork's
 * `dispatch` rewrite inside upstream-owned `commands.ts` consumes it; importing
 * it from `commandsFork.ts` would create a cycle.
 */
import * as Schema from "effect/Schema";

export const ORCHESTRATION_COMMAND_ACK_TIMEOUT = "10 seconds";

export class OrchestrationCommandAcknowledgementTimeoutError extends Schema.TaggedErrorClass<OrchestrationCommandAcknowledgementTimeoutError>()(
  "OrchestrationCommandAcknowledgementTimeoutError",
  {
    commandType: Schema.String,
  },
) {
  override get message(): string {
    const operation =
      this.commandType === "thread.create"
        ? "Thread creation"
        : this.commandType === "thread.turn.start"
          ? "Starting the agent"
          : `The ${this.commandType} request`;
    return `${operation} was not acknowledged by the server within 10 seconds. Check the connection and retry.`;
  }
}
