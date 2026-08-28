import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { CommandId, WS_METHODS } from "@t3tools/contracts";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createRuntimeCommand,
} from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CreateThreadInput,
  // T3-CUSTOM(expbkt3): durable bootstrap command atoms.
  type RequestThreadBootstrapInput,
  type RetryThreadBootstrapInput,
  type StopThreadBootstrapInput,
  type ContinueThreadBootstrapInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type PinThreadInput,
  type ReorderPinnedThreadInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  createThread,
  requestThreadBootstrap,
  retryThreadBootstrap,
  stopThreadBootstrap,
  continueThreadBootstrap,
  deleteThread,
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
// T3-CUSTOM(expbkt3): BEGIN fork command creators
import {
  type AddThreadMemberInput,
  type RemoveThreadMemberInput,
  type RequestThreadCatchupSummaryInput,
  type RequestThreadWorkSummaryInput,
  type RestartThreadSessionInput,
  type StopThreadExecutionInput,
  type TransferThreadOwnershipInput,
  addThreadMember,
  removeThreadMember,
  requestThreadCatchupSummary,
  requestThreadWorkSummary,
  restartThreadSession,
  stopThreadExecution,
  transferThreadOwnership,
} from "../operations/commandsFork.ts";
// T3-CUSTOM(expbkt3): END
import type { EnvironmentRegistry } from "../connection/registry.ts";
// T3-CUSTOM(expbkt3): every client persists the exact turn before dispatch.
import {
  ANONYMOUS_OUTBOX_IDENTITY,
  recordThreadOutboxFailure,
  shouldRetryThreadOutboxDelivery,
  ThreadOutboxPersistenceError,
  type QueuedThreadMessage,
} from "../outbox/index.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { bumpOutboxRevision } from "./outbox.ts";

export type DurableStartThreadTurnInput = StartThreadTurnInput & {
  /** T3-CUSTOM(expbkt3): local-only account namespace; never crosses the wire. */
  readonly outboxIdentityKey?: string;
};

export type DiscardDurableOutboxInput = Pick<
  QueuedThreadMessage,
  "environmentId" | "identityKey" | "messageId"
>;

// T3-CUSTOM(expbkt3): preserve one command id across timeout, reconnect, and reload.
const startThreadTurnDurably = Effect.fn("ThreadCommands.startThreadTurnDurably")(function* (
  environmentId: QueuedThreadMessage["environmentId"],
  input: DurableStartThreadTurnInput,
  registry: AtomRegistry.AtomRegistry,
) {
  const { outboxIdentityKey = ANONYMOUS_OUTBOX_IDENTITY, ...serverInput } = input;
  const cache = yield* EnvironmentCacheStore;
  const commandId =
    serverInput.commandId ??
    (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make)));
  const createdAt =
    serverInput.createdAt ?? (yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)));
  const queuedMessage: QueuedThreadMessage = {
    environmentId,
    identityKey: outboxIdentityKey,
    threadId: serverInput.threadId,
    messageId: serverInput.message.messageId,
    commandId,
    text: serverInput.message.text,
    // T3-CUSTOM(expbkt3): an uploaded attachment already has its asset id and no
    // inline data url; a locally-held one supplies the data url and its preview.
    attachments: serverInput.message.attachments.map((attachment, index) => {
      const dataUrl = "dataUrl" in attachment ? attachment.dataUrl : undefined;
      return {
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        id: "id" in attachment ? attachment.id : `${serverInput.message.messageId}-${index}`,
        ...(dataUrl === undefined ? {} : { dataUrl, previewUri: dataUrl }),
      };
    }),
    ...(serverInput.modelSelection === undefined
      ? {}
      : { modelSelection: serverInput.modelSelection }),
    ...(serverInput.runtimeMode === undefined ? {} : { runtimeMode: serverInput.runtimeMode }),
    ...(serverInput.interactionMode === undefined
      ? {}
      : { interactionMode: serverInput.interactionMode }),
    ...(serverInput.bootstrap === undefined ? {} : { bootstrap: serverInput.bootstrap }),
    ...(serverInput.sourceProposedPlan === undefined
      ? {}
      : { sourceProposedPlan: serverInput.sourceProposedPlan }),
    ...(serverInput.titleSeed === undefined ? {} : { titleSeed: serverInput.titleSeed }),
    deliveryState: "pending",
    createdAt,
  };
  const dispatch = startThreadTurn({ ...serverInput, commandId, createdAt });

  if (cache.saveOutbox === undefined || cache.removeOutbox === undefined) {
    return yield* dispatch;
  }
  yield* cache.saveOutbox(queuedMessage).pipe(
    Effect.mapError(
      (cause) => new ThreadOutboxPersistenceError({ operation: "save-before-send", cause }),
    ),
    Effect.tap(() =>
      Effect.sync(() => bumpOutboxRevision(registry, environmentId, outboxIdentityKey)),
    ),
    Effect.tapError(() =>
      recordThreadOutboxFailure({
        kind: "persistence",
        operation: "save-before-send",
        outcome: "failed",
      }),
    ),
  );
  const dispatched = yield* Effect.exit(dispatch);
  if (Exit.isFailure(dispatched)) {
    const error = Cause.squash(dispatched.cause);
    const retrying = shouldRetryThreadOutboxDelivery(error);
    yield* recordThreadOutboxFailure({
      kind: "delivery",
      operation: "start-turn",
      outcome: retrying ? "retrying" : "failed",
    });
    if (!retrying) {
      yield* cache
        .saveOutbox({
          ...queuedMessage,
          deliveryState: "failed",
          failureDetail: error instanceof Error ? error.message : Cause.pretty(dispatched.cause),
        })
        .pipe(
          Effect.tapError(() =>
            recordThreadOutboxFailure({
              kind: "persistence",
              operation: "save-failure-state",
              outcome: "failed",
            }),
          ),
        );
      bumpOutboxRevision(registry, environmentId, outboxIdentityKey);
    }
    return yield* Effect.failCause(dispatched.cause);
  }
  yield* cache.removeOutbox(queuedMessage).pipe(
    Effect.tap(() =>
      Effect.sync(() => bumpOutboxRevision(registry, environmentId, outboxIdentityKey)),
    ),
    Effect.catch(() =>
      recordThreadOutboxFailure({
        kind: "persistence",
        operation: "remove-after-ack",
        outcome: "failed",
      }),
    ),
  );
  return dispatched.value;
});

// T3-CUSTOM(expbkt3): acknowledgement timeout error
export { OrchestrationCommandAcknowledgementTimeoutError } from "../operations/commandAck.ts";

export type {
  ArchiveThreadInput,
  CreateThreadInput,
  RequestThreadBootstrapInput,
  RetryThreadBootstrapInput,
  StopThreadBootstrapInput,
  ContinueThreadBootstrapInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  PinThreadInput,
  ReorderPinnedThreadInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";
// T3-CUSTOM(expbkt3): BEGIN fork command input types
export type {
  AddThreadMemberInput,
  RemoveThreadMemberInput,
  RequestThreadCatchupSummaryInput,
  RequestThreadWorkSummaryInput,
  RestartThreadSessionInput,
  StopThreadExecutionInput,
  TransferThreadOwnershipInput,
} from "../operations/commandsFork.ts";
// T3-CUSTOM(expbkt3): END

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    discardOutbox: createRuntimeCommand(runtime, {
      label: "environment-data:commands:thread:discard-outbox",
      execute: (message: DiscardDurableOutboxInput, registry) =>
        Effect.gen(function* () {
          const cache = yield* EnvironmentCacheStore;
          if (cache.removeOutbox === undefined) return;
          yield* cache.removeOutbox(message);
          bumpOutboxRevision(
            registry,
            message.environmentId,
            message.identityKey ?? ANONYMOUS_OUTBOX_IDENTITY,
          );
        }),
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    // T3-CUSTOM(expbkt3): expose durable bootstrap controls to every client runtime.
    requestBootstrap: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:bootstrap-request",
      execute: (input: RequestThreadBootstrapInput) => requestThreadBootstrap(input),
      scheduler,
      concurrency,
    }),
    retryBootstrap: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:bootstrap-retry",
      execute: (input: RetryThreadBootstrapInput) => retryThreadBootstrap(input),
      scheduler,
      concurrency,
    }),
    stopBootstrap: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:bootstrap-stop",
      execute: (input: StopThreadBootstrapInput) => stopThreadBootstrap(input),
      scheduler,
      concurrency,
    }),
    continueBootstrap: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:bootstrap-continue",
      execute: (input: ContinueThreadBootstrapInput) => continueThreadBootstrap(input),
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
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
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
      // T3-CUSTOM(expbkt3): the environment id namespaces persisted pending work.
      execute: (input: DurableStartThreadTurnInput, registry, environmentId) =>
        startThreadTurnDurably(environmentId, input, registry),
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
    // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary request.
    requestWorkSummary: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:request-work-summary",
      execute: (input: RequestThreadWorkSummaryInput) => requestThreadWorkSummary(input),
      scheduler,
      concurrency,
    }),
    // T3-CUSTOM(expbkt3): END
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    // T3-CUSTOM(expbkt3): BEGIN — session restart and thread membership commands.
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
    // T3-CUSTOM(expbkt3): END
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
}
