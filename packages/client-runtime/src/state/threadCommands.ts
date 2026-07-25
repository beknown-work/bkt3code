import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type AddThreadMemberInput,
  type ArchiveThreadInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type RemoveThreadMemberInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RequestThreadCatchupSummaryInput,
  type RevertThreadCheckpointInput,
  type RestartThreadSessionInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type StopThreadExecutionInput,
  type TransferThreadOwnershipInput,
  type UnarchiveThreadInput,
  type UpdateThreadMetadataInput,
  addThreadMember,
  archiveThread,
  createThread,
  deleteThread,
  interruptThreadTurn,
  removeThreadMember,
  respondToThreadApproval,
  respondToThreadUserInput,
  requestThreadCatchupSummary,
  revertThreadCheckpoint,
  restartThreadSession,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  startThreadTurn,
  stopThreadSession,
  stopThreadExecution,
  transferThreadOwnership,
  unarchiveThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export { OrchestrationCommandAcknowledgementTimeoutError } from "../operations/commands.ts";

export type {
  AddThreadMemberInput,
  ArchiveThreadInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  RemoveThreadMemberInput,
  RespondToThreadApprovalInput,
  RequestThreadCatchupSummaryInput,
  RespondToThreadUserInputInput,
  RevertThreadCheckpointInput,
  RestartThreadSessionInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  StopThreadExecutionInput,
  TransferThreadOwnershipInput,
  UnarchiveThreadInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    stopExecution: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-execution",
      execute: (input: StopThreadExecutionInput) => stopThreadExecution(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    requestCatchupSummary: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:request-catchup-summary",
      execute: (input: RequestThreadCatchupSummaryInput) => requestThreadCatchupSummary(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    restartSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:restart-session",
      execute: (input: RestartThreadSessionInput) => restartThreadSession(input),
      scheduler,
      concurrency,
    }),
    addMember: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:add-member",
      execute: (input: AddThreadMemberInput) => addThreadMember(input),
      scheduler,
      concurrency,
    }),
    removeMember: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:remove-member",
      execute: (input: RemoveThreadMemberInput) => removeThreadMember(input),
      scheduler,
      concurrency,
    }),
    transferOwnership: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:transfer-ownership",
      execute: (input: TransferThreadOwnershipInput) => transferThreadOwnership(input),
      scheduler,
      concurrency,
    }),
  };
}
