/**
 * T3-CUSTOM(expbkt3): Fork orchestration command creators.
 *
 * Membership/ownership, source-control identity, catch-up summaries, session
 * restart and execution stop. Extracted from upstream-owned `commands.ts`,
 * which re-exports the internals these creators need through a single marked
 * seam. Nothing here exists upstream.
 */
import { ORCHESTRATION_WS_METHODS, type OrchestrationStopExecutionInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";
import {
  type ForkCommandEffect,
  type ForkCommandInput,
  commandIdInternal,
  dispatchCommandInternal,
  timestampedCommandMetadataInternal,
} from "./commands.ts";

export type RequestThreadCatchupSummaryInput = ForkCommandInput<"thread.catchup-summary.request">;
export type RestartThreadSessionInput = ForkCommandInput<"thread.session.restart">;
export type StopThreadExecutionInput = OrchestrationStopExecutionInput;
export type AddThreadMemberInput = ForkCommandInput<"thread.member.add">;
export type RemoveThreadMemberInput = ForkCommandInput<"thread.member.remove">;
export type TransferThreadOwnershipInput = ForkCommandInput<"thread.owner.transfer">;
export type AddProjectMemberInput = ForkCommandInput<"project.member.add">;
export type RemoveProjectMemberInput = ForkCommandInput<"project.member.remove">;
export type TransferProjectOwnershipInput = ForkCommandInput<"project.owner.transfer">;

export const addThreadMember: (input: AddThreadMemberInput) => ForkCommandEffect = Effect.fn(
  "EnvironmentCommands.addThreadMember",
)(function* (input) {
  return yield* dispatchCommandInternal({
    ...input,
    type: "thread.member.add",
    commandId: yield* commandIdInternal(input),
  });
});

export const removeThreadMember: (input: RemoveThreadMemberInput) => ForkCommandEffect = Effect.fn(
  "EnvironmentCommands.removeThreadMember",
)(function* (input) {
  return yield* dispatchCommandInternal({
    ...input,
    type: "thread.member.remove",
    commandId: yield* commandIdInternal(input),
  });
});

export const transferThreadOwnership: (input: TransferThreadOwnershipInput) => ForkCommandEffect =
  Effect.fn("EnvironmentCommands.transferThreadOwnership")(function* (input) {
    return yield* dispatchCommandInternal({
      ...input,
      type: "thread.owner.transfer",
      commandId: yield* commandIdInternal(input),
    });
  });

export const addProjectMember: (input: AddProjectMemberInput) => ForkCommandEffect = Effect.fn(
  "EnvironmentCommands.addProjectMember",
)(function* (input) {
  return yield* dispatchCommandInternal({
    ...input,
    type: "project.member.add",
    commandId: yield* commandIdInternal(input),
  });
});

export const removeProjectMember: (input: RemoveProjectMemberInput) => ForkCommandEffect =
  Effect.fn("EnvironmentCommands.removeProjectMember")(function* (input) {
    return yield* dispatchCommandInternal({
      ...input,
      type: "project.member.remove",
      commandId: yield* commandIdInternal(input),
    });
  });

export const transferProjectOwnership: (input: TransferProjectOwnershipInput) => ForkCommandEffect =
  Effect.fn("EnvironmentCommands.transferProjectOwnership")(function* (input) {
    return yield* dispatchCommandInternal({
      ...input,
      type: "project.owner.transfer",
      commandId: yield* commandIdInternal(input),
    });
  });

export const requestThreadCatchupSummary: (
  input: RequestThreadCatchupSummaryInput,
) => ForkCommandEffect = Effect.fn("EnvironmentCommands.requestThreadCatchupSummary")(
  function* (input) {
    const metadata = yield* timestampedCommandMetadataInternal(input);
    return yield* dispatchCommandInternal({
      ...input,
      type: "thread.catchup-summary.request",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  },
);

export const restartThreadSession: (input: RestartThreadSessionInput) => ForkCommandEffect =
  Effect.fn("EnvironmentCommands.restartThreadSession")(function* (input) {
    const metadata = yield* timestampedCommandMetadataInternal(input);
    return yield* dispatchCommandInternal({
      ...input,
      type: "thread.session.restart",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

type StopExecutionTag = typeof ORCHESTRATION_WS_METHODS.stopExecution;
export const stopThreadExecution: (
  input: StopThreadExecutionInput,
) => Effect.Effect<
  EnvironmentRpcSuccess<StopExecutionTag>,
  EnvironmentRpcFailure<StopExecutionTag> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
> = Effect.fn("EnvironmentCommands.stopThreadExecution")(function* (input) {
  return yield* request(ORCHESTRATION_WS_METHODS.stopExecution, input);
});
