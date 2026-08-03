// T3-CUSTOM(expbkt3): durable client outbox shared by web, desktop, and mobile.
import { isTransportConnectionErrorMessage } from "../errors/transport.ts";
import type { EnvironmentShellStatus } from "../state/shell.ts";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  SourceControlProfileId,
  SourceProposedPlanReference,
  ThreadId,
  ThreadTurnStartBootstrap,
  type EnvironmentId as EnvironmentIdType,
  type ClientOrchestrationCommand,
  type MessageId as MessageIdType,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
  type SourceControlProfileId as SourceControlProfileIdType,
  type ThreadId as ThreadIdType,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const THREAD_OUTBOX_SCHEMA_VERSION = 6;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;
export const ANONYMOUS_OUTBOX_IDENTITY = "anonymous";

export class ThreadOutboxPersistenceError extends Schema.TaggedErrorClass<ThreadOutboxPersistenceError>()(
  "ThreadOutboxPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Message could not be saved locally, so it was not sent.";
  }
}

type ClientTurnStartCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: "thread.turn.start" }
>;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
  sourceControlProfileId: Schema.optional(SourceControlProfileId),
});

export const QueuedThreadImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, 4, 5, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  identityKey: Schema.optional(Schema.String),
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(QueuedThreadImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  titleSeed: Schema.optional(Schema.String),
  creation: Schema.optional(QueuedThreadCreationSchema),
  deliveryState: Schema.optional(Schema.Literals(["pending", "failed"])),
  failureDetail: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string | undefined;
  readonly projectCwd?: string | undefined;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean | undefined;
  readonly sourceControlProfileId?: SourceControlProfileIdType | undefined;
}

export interface QueuedThreadImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentIdType;
  /** Authenticated account id. Legacy/local-only entries omit it and use an isolated fallback. */
  readonly identityKey?: string | undefined;
  readonly threadId: ThreadIdType;
  readonly messageId: MessageIdType;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<QueuedThreadImageAttachment>;
  readonly modelSelection?: ModelSelectionType | undefined;
  readonly runtimeMode?: RuntimeModeType | undefined;
  readonly interactionMode?: ProviderInteractionModeType | undefined;
  readonly bootstrap?: ClientTurnStartCommand["bootstrap"] | undefined;
  readonly sourceProposedPlan?: ClientTurnStartCommand["sourceProposedPlan"] | undefined;
  readonly titleSeed?: string | undefined;
  readonly creation?: QueuedThreadCreation | undefined;
  readonly deliveryState?: "pending" | "failed" | undefined;
  readonly failureDetail?: string | undefined;
  readonly createdAt: string;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
): ThreadSettingsSnapshot {
  return {
    modelSelection: message.modelSelection ?? thread.modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: message.interactionMode ?? thread.interactionMode,
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function outboxIdentityNamespace(
  message: Pick<QueuedThreadMessage, "environmentId" | "identityKey">,
): string {
  return `${message.environmentId}:${encodeURIComponent(message.identityKey ?? ANONYMOUS_OUTBOX_IDENTITY)}`;
}

/** A user-requested retry is distinct from transport replay of the same command. */
export function retryQueuedThreadMessage(
  message: QueuedThreadMessage,
  commandId: CommandId,
): QueuedThreadMessage {
  const { failureDetail: _failureDetail, ...pending } = message;
  return { ...pending, commandId, deliveryState: "pending" };
}

export function scopedOutboxThreadKey(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): string {
  return `${environmentId}:${threadId}`;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageIdType, QueuedThreadMessage>();
  for (const message of messages) deduplicated.set(message.messageId, message);

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedOutboxThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
  readonly durableExecutionRecovery?: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.isCreation) {
    if (input.threadExists) return "remove";
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) return input.shellStatus === "live" ? "remove" : "wait";
  return input.environmentConnected &&
    (!input.threadBusy || input.durableExecutionRecovery === true)
    ? "send"
    : "wait";
}

export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) return false;
  if (message.text.trim().length === 0 || message.modelSelection === undefined) return false;
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "fail";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  return input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
    ? "retry"
    : "fail";
}
