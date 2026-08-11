import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity } from "./environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
  UserId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { SourceControlProfileId } from "./sourceControlProfiles.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  stopExecution: "orchestration.stopExecution",
  // T3-CUSTOM(expbkt3)
  replayEvents: "orchestration.replayEvents",
  getWorkflowScript: "orchestration.getWorkflowScript",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

// T3-CUSTOM(expbkt3): portable new-thread defaults shared by web, HTTP, and MCP.
// This lives in orchestration rather than settings so project events and server
// settings can both depend on the shape without creating a package cycle.
export const ThreadCreationEnvironmentMode = Schema.Literals(["local", "worktree"]);
export type ThreadCreationEnvironmentMode = typeof ThreadCreationEnvironmentMode.Type;

export const WorktreeBaseRefSource = Schema.Literals(["local", "origin"]);
export type WorktreeBaseRefSource = typeof WorktreeBaseRefSource.Type;

export const WorktreeBaseRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("repository-default"),
    source: WorktreeBaseRefSource,
  }),
  Schema.Struct({
    kind: Schema.Literal("branch"),
    source: WorktreeBaseRefSource,
    branch: TrimmedNonEmptyString,
  }),
]);
export type WorktreeBaseRef = typeof WorktreeBaseRef.Type;

const EMPTY_PROJECT_THREAD_CREATION_DEFAULTS = {
  environmentMode: null,
  worktreeBaseRef: null,
  runtimeMode: null,
  interactionMode: null,
} as const;

export const ProjectThreadCreationDefaults = Schema.Struct({
  environmentMode: Schema.NullOr(ThreadCreationEnvironmentMode),
  worktreeBaseRef: Schema.NullOr(WorktreeBaseRef),
  runtimeMode: Schema.NullOr(RuntimeMode),
  interactionMode: Schema.NullOr(ProviderInteractionMode),
}).pipe(Schema.withDecodingDefault(Effect.succeed(EMPTY_PROJECT_THREAD_CREATION_DEFAULTS)));
export type ProjectThreadCreationDefaults = typeof ProjectThreadCreationDefaults.Type;
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

/**
 * Ownership + membership fields shared by threads/projects (and their shells).
 *
 * Both carry `withDecodingDefault` so pre-ownership rows and cached client
 * snapshots decode cleanly (same compat pattern as `archivedAt`). `ownerUserId`
 * null ⇒ legacy/unowned (single-user mode, or awaiting backfill).
 */
const OwnerUserIdField = Schema.NullOr(UserId).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
const MemberUserIdsField = Schema.Array(UserId).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // T3-CUSTOM(expbkt3): null fields inherit the owning environment's settings.
  threadCreationDefaults: Schema.optional(ProjectThreadCreationDefaults).pipe(
    Schema.withDecodingDefault(Effect.succeed(EMPTY_PROJECT_THREAD_CREATION_DEFAULTS)),
  ),
  scripts: Schema.Array(ProjectScript),
  ownerUserId: OwnerUserIdField,
  memberUserIds: MemberUserIdsField,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  // Clerk user who sent this message (team mode, user messages only). Null for
  // assistant/system messages or single-user mode. Compat-defaulted so old rows
  // decode.
  sentByUserId: Schema.NullOr(UserId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

// T3-CUSTOM(expbkt3): durable client outboxes validate this exact reference.
export const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /**
   * The provider-native conversation/session identifier used to resume this
   * thread. It is absent until the provider reports its durable thread id.
   */
  providerThreadId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

/**
 * Backend-authoritative provider-session and turn lifecycle. Provider routing
 * metadata and browser caches are deliberately not part of this state model.
 */
export const ProviderSessionState = Schema.Literals([
  "absent",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
]);
export type ProviderSessionState = typeof ProviderSessionState.Type;

export const TurnExecutionState = Schema.Literals([
  "idle",
  "starting",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
  "stopping",
  "completed",
  "interrupted",
  "failed",
]);
export type TurnExecutionState = typeof TurnExecutionState.Type;

export const ThreadExecutionActivity = Schema.Literals([
  "idle",
  "active",
  "blocked",
  "stopping",
  "failed",
]);
export type ThreadExecutionActivity = typeof ThreadExecutionActivity.Type;

// T3-CUSTOM(expbkt3): durable desired-state is optional so older execution
// snapshots remain decodable during rolling upgrades.
export const ThreadExecutionIntentPhase = Schema.Literals([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
  "recovering",
  "retry-wait",
  "stopping",
  "recovery-exhausted",
]);
export type ThreadExecutionIntentPhase = typeof ThreadExecutionIntentPhase.Type;

export const ThreadExecutionIntent = Schema.Struct({
  workItemId: TrimmedNonEmptyString,
  messageId: MessageId,
  desiredState: Schema.Literals(["running", "stopped"]),
  phase: ThreadExecutionIntentPhase,
  acceptedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  recovery: Schema.Struct({
    attempt: NonNegativeInt,
    maximumAttempts: NonNegativeInt,
    nextAttemptAt: Schema.NullOr(IsoDateTime),
    reason: Schema.NullOr(Schema.String),
    userActionRequired: Schema.Boolean,
  }),
});
export type ThreadExecutionIntent = typeof ThreadExecutionIntent.Type;

export const ThreadExecutionSnapshot = Schema.Struct({
  threadId: ThreadId,
  authorityEpoch: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  observedAt: IsoDateTime,
  activity: ThreadExecutionActivity,
  canStop: Schema.Boolean,
  providerSession: Schema.Struct({
    state: ProviderSessionState,
    generation: NonNegativeInt,
    providerInstanceId: Schema.NullOr(ProviderInstanceId),
    startedAt: Schema.NullOr(IsoDateTime),
    lastObservedAt: Schema.NullOr(IsoDateTime),
    lastError: Schema.NullOr(Schema.String),
  }),
  turn: Schema.NullOr(
    Schema.Struct({
      executionId: TrimmedNonEmptyString,
      providerTurnId: Schema.NullOr(TurnId),
      state: TurnExecutionState,
      startedAt: IsoDateTime,
      stopRequestedAt: Schema.NullOr(IsoDateTime),
      completedAt: Schema.NullOr(IsoDateTime),
      lastError: Schema.NullOr(Schema.String),
    }),
  ),
  // T3-CUSTOM(expbkt3): absent on servers without durable execution recovery.
  intent: Schema.optionalKey(ThreadExecutionIntent),
});
export type ThreadExecutionSnapshot = typeof ThreadExecutionSnapshot.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

/**
 * Short catch-up summary shown below the final assistant message of a turn
 * that ran longer than the configured cutoff. Rendered as a helper cue when
 * returning to a session after a long run.
 */
/**
 * "pending" while the summarizer is running, "ready" once text exists, and
 * "error" when the request completed without a usable summary.
 */
export const OrchestrationTurnCatchupSummaryStatus = Schema.Literals(["pending", "ready", "error"]);
export type OrchestrationTurnCatchupSummaryStatus =
  typeof OrchestrationTurnCatchupSummaryStatus.Type;

export const OrchestrationTurnCatchupSummary = Schema.Struct({
  turnId: TurnId,
  assistantMessageId: Schema.NullOr(MessageId),
  // Null while pending. For "error", this carries the user-facing failure detail.
  summary: Schema.NullOr(TrimmedNonEmptyString),
  status: OrchestrationTurnCatchupSummaryStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed("ready" as const)),
  ),
  createdAt: IsoDateTime,
});
export type OrchestrationTurnCatchupSummary = typeof OrchestrationTurnCatchupSummary.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

// T3-CUSTOM(expbkt3): public, output-free progress for durable thread bootstrap.
export const ThreadBootstrapStepStatus = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "bypassed",
]);
export type ThreadBootstrapStepStatus = typeof ThreadBootstrapStepStatus.Type;

export const ThreadBootstrapStep = Schema.Struct({
  status: ThreadBootstrapStepStatus,
  attempt: NonNegativeInt,
  terminalId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  exitCode: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  error: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ThreadBootstrapStep = typeof ThreadBootstrapStep.Type;

export const ThreadBootstrapStatus = Schema.Literals(["queued", "running", "failed", "ready"]);
export type ThreadBootstrapStatus = typeof ThreadBootstrapStatus.Type;

export const ThreadBootstrapProgress = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: ThreadBootstrapStatus,
  worktree: ThreadBootstrapStep,
  setup: ThreadBootstrapStep,
  agent: ThreadBootstrapStep,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadBootstrapProgress = typeof ThreadBootstrapProgress.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  /**
   * Server-computed wall-clock duration of a settled turn (completedAt minus
   * startedAt). The UI renders this instead of deriving elapsed time from a
   * browser clock. Null while the turn is still running, or when either
   * endpoint is missing. Compat-defaulted so pre-existing cached rows decode.
   */
  durationMs: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});

/**
 * Wall-clock duration of a settled turn, from server-side timestamps.
 *
 * Shared by every place that builds a latest-turn record — the server projector,
 * the server's snapshot hydration, and the client-side reducer that mirrors the
 * projector — so all three agree on the stored value.
 */
export function computeTurnDurationMs(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (startedAt === null || completedAt === null) {
    return null;
  }
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    return null;
  }
  return Math.max(0, completedMs - startedMs);
}
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

// T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary.
//
// A per-thread, AI-written answer to "what did this session do and how far is
// it?", generated on demand for the bulk session manager table. It is a
// separate pipeline from the catch-up summary: its own settings block, its own
// model, its own prompt, and its own durable column, so turning either off
// leaves the other intact.
/**
 * Coarse lifecycle stage the model judges the session to be in. Deliberately
 * five buckets: enough to sort a table by, few enough that the model picks the
 * same one twice.
 */
export const ThreadWorkSummaryStage = Schema.Literals([
  "planning",
  "implementing",
  "blocked",
  "awaiting-review",
  "done",
]);
export type ThreadWorkSummaryStage = typeof ThreadWorkSummaryStage.Type;

/**
 * "pending" while the reactor is generating, "ready" once the model answered,
 * and "error" when generation failed or the feature is disabled. The error
 * state is durable so a reconnecting table shows the reason instead of an
 * eternal spinner.
 */
export const ThreadWorkSummaryStatus = Schema.Literals(["pending", "ready", "error"]);
export type ThreadWorkSummaryStatus = typeof ThreadWorkSummaryStatus.Type;

export const ThreadWorkSummary = Schema.Struct({
  status: ThreadWorkSummaryStatus,
  /** Prose work summary. Null while pending and on error. */
  summary: Schema.NullOr(Schema.String),
  stage: Schema.NullOr(ThreadWorkSummaryStage),
  /** One line describing what is left. Empty string when the session is done. */
  remaining: Schema.NullOr(Schema.String),
  /** Rough completion of the session's stated goal, 0..100. */
  percent: Schema.NullOr(NonNegativeInt),
  /** User-facing failure detail; only set for `status: "error"`. */
  error: Schema.NullOr(Schema.String),
  /** Command id of the request this record answers; drives the supersede rule. */
  requestId: Schema.NullOr(CommandId),
  updatedAt: IsoDateTime,
});
export type ThreadWorkSummary = typeof ThreadWorkSummary.Type;
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): session priority. Linear-style P0..P4 stored as an
// integer so ordering is arithmetic; 0 is the highest priority and an absent
// value means "unprioritised" (sorts after P4). The "P0" spelling is purely
// presentational and lives in the renderer, never in the event log.
export const ThreadPriority = Schema.Literals([0, 1, 2, 3, 4]);
export type ThreadPriority = typeof ThreadPriority.Type;

// T3-CUSTOM(expbkt3): session lineage. A thread spawned by another session
// (today: the `t3_create_session` MCP tool) records the thread that spawned
// it, so the experimental sidebar can file it under its parent instead of
// stranding it as an unrelated top-level row. A null value means "root
// session", which is what a human-started session always is.
//
// The link is deliberately a bare ThreadId with no environment qualifier:
// a session can only be created by a caller on the same server, so parent
// and child always share an environment. Consumers resolve it within the
// environment they already hold.
// The cycle guard that enforces this lives server-side in
// apps/server/src/orchestration/threadLineage.ts — contracts stay schema-only.

// T3-CUSTOM(expbkt3): attach-to-external-session. Binds a brand-new thread to
// a provider session that was started outside T3 (e.g. `claude`/`codex` in a
// terminal). Carries the provider *instance* rather than the driver kind
// because the persisted-cursor fallback in ProviderService.startSession is
// instance-gated.
export const ThreadExternalSessionAttachment = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
});
export type ThreadExternalSessionAttachment = typeof ThreadExternalSessionAttachment.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  ownerUserId: OwnerUserIdField,
  memberUserIds: MemberUserIdsField,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // A pin overrides the settled/snoozed lifecycle: while pinnedAt is set the
  // thread renders in the pinned block and never classifies into a shelf.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  // T3-CUSTOM(expbkt3): absent on historical and pre-capability servers.
  bootstrap: Schema.optional(Schema.NullOr(ThreadBootstrapProgress)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // T3-CUSTOM(expbkt3): optional so payloads from pre-priority servers decode.
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  // T3-CUSTOM(expbkt3): optional so payloads from pre-manual-tag servers decode.
  linearIssueUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // T3-CUSTOM(expbkt3): session lineage. Optional so payloads from
  // pre-lineage servers decode; null means this is a root session.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary. Optional so payloads
  // from pre-work-summary servers decode; absent/null means never generated.
  workSummary: Schema.optional(Schema.NullOr(ThreadWorkSummary)),
  // T3-CUSTOM(expbkt3): END
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  // Rolling per-thread summary maintained incrementally on every turn
  // completion. Server-side input for the short catch-up summaries; keeps
  // summarization token cost flat regardless of session length.
  rollingSummary: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  turnSummaries: Schema.Array(OrchestrationTurnCatchupSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  session: Schema.NullOr(OrchestrationSession),
  execution: Schema.optionalKey(Schema.NullOr(ThreadExecutionSnapshot)),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  threadCreationDefaults: Schema.optional(ProjectThreadCreationDefaults).pipe(
    Schema.withDecodingDefault(Effect.succeed(EMPTY_PROJECT_THREAD_CREATION_DEFAULTS)),
  ),
  scripts: Schema.Array(ProjectScript),
  ownerUserId: OwnerUserIdField,
  memberUserIds: MemberUserIdsField,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  ownerUserId: OwnerUserIdField,
  memberUserIds: MemberUserIdsField,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  // T3-CUSTOM(expbkt3): session priority (see ThreadPriority).
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  // T3-CUSTOM(expbkt3): durable manual Linear issue URL.
  linearIssueUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // T3-CUSTOM(expbkt3): session lineage (see the ThreadPriority block above).
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary (see ThreadWorkSummary).
  workSummary: Schema.optional(Schema.NullOr(ThreadWorkSummary)),
  // T3-CUSTOM(expbkt3): END
  session: Schema.NullOr(OrchestrationSession),
  execution: Schema.optionalKey(Schema.NullOr(ThreadExecutionSnapshot)),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        step: TrimmedNonEmptyString,
        completedSteps: NonNegativeInt,
        totalSteps: NonNegativeInt,
      }),
    ),
  ),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("execution"),
    execution: ThreadExecutionSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the fallback snapshot frame (sent when `afterSequence` is
   * missing or the catch-up gap is too large) is windowed to the last
   * `turnLimit` user-anchored turns and carries `page` metadata. Absent means
   * the fallback snapshot is the full thread, preserving pre-pagination client
   * behavior. Live events are unaffected either way.
   */
  turnLimit: Schema.optionalKey(PositiveInt),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

/**
 * Bounds a thread detail read to a window of recent turns. `turnLimit` counts
 * turns with a user pending message (subagent/fan-out turns between them ride
 * along), so the window always contains the last N user prompts. `beforeCursor`
 * requests the disjoint page of older turns strictly before a previously
 * returned cursor. Requests without a window get the full thread; pagination is
 * strictly opt-in so older clients keep today's behavior on both HTTP and the
 * WebSocket fallback snapshot.
 */
export const OrchestrationThreadDetailWindow = Schema.Struct({
  turnLimit: Schema.optionalKey(PositiveInt),
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrchestrationThreadDetailWindow = typeof OrchestrationThreadDetailWindow.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `snapshotSequence` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(OrchestrationThreadDetailPage),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  // T3-CUSTOM(expbkt3): per-field project overrides; omitted means inherit all.
  threadCreationDefaults: Schema.optional(ProjectThreadCreationDefaults),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  threadCreationDefaults: Schema.optional(ProjectThreadCreationDefaults),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // T3-CUSTOM(expbkt3): trusted external creators may nominate the durable owner.
  ownerUserId: Schema.optional(UserId),
  // T3-CUSTOM(expbkt3): BEGIN — tags a session is born with. A session created
  // from another session inherits its parent's audience, so delegated work
  // stays visible to the humans watching the parent.
  memberUserIds: Schema.optional(Schema.Array(UserId)),
  // T3-CUSTOM(expbkt3): END
  createdAt: IsoDateTime,
  // T3-CUSTOM(expbkt3): session priority. Absent means "unprioritised".
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  // T3-CUSTOM(expbkt3): session lineage. Absent/null creates a root session.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  // T3-CUSTOM(expbkt3): attach-to-external-session. Handled as a dispatcher
  // side-effect (seeds the provider session binding); deliberately not carried
  // into the thread.created event, so the event log stays upstream-shaped.
  externalSession: Schema.optional(ThreadExternalSessionAttachment),
});

// T3-CUSTOM(expbkt3): high-level, server-resolved creation entrypoint. Unlike
// thread.create, omitted values deliberately flow through project/app defaults.
const ThreadBootstrapWorkspaceOverride = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("local"),
  }),
  Schema.Struct({
    mode: Schema.Literal("existing-worktree"),
    path: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    mode: Schema.Literal("new-worktree"),
    baseRef: Schema.optional(WorktreeBaseRef),
    newBranch: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ThreadBootstrapWorkspaceOverride = typeof ThreadBootstrapWorkspaceOverride.Type;

const ThreadBootstrapOverrides = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  workspace: Schema.optional(ThreadBootstrapWorkspaceOverride),
});
export type ThreadBootstrapOverrides = typeof ThreadBootstrapOverrides.Type;

export const ThreadBootstrapRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap.request"),
  commandId: CommandId,
  bootstrapId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  initialTurn: Schema.optional(
    Schema.Struct({
      messageId: MessageId,
      text: Schema.String,
      attachments: Schema.Array(ChatAttachment),
      titleSeed: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  overrides: Schema.optional(ThreadBootstrapOverrides),
  sourceControlProfileId: Schema.optional(Schema.NullOr(SourceControlProfileId)),
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  // T3-CUSTOM(expbkt3): session lineage. Absent/null creates a root session.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  ownerUserId: Schema.optional(UserId),
  // T3-CUSTOM(expbkt3): inherited session tags (see ThreadCreateCommand).
  memberUserIds: Schema.optional(Schema.Array(UserId)),
  createdAt: IsoDateTime,
});
export type ThreadBootstrapRequestCommand = typeof ThreadBootstrapRequestCommand.Type;

const ClientThreadBootstrapRequestCommand = ThreadBootstrapRequestCommand.mapFields(
  Struct.assign({
    initialTurn: Schema.optional(
      Schema.Struct({
        messageId: MessageId,
        text: Schema.String,
        attachments: Schema.Array(UploadChatAttachment),
        titleSeed: Schema.optional(TrimmedNonEmptyString),
      }),
    ),
  }),
);

export const ThreadBootstrapRetryCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap.retry"),
  commandId: CommandId,
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  step: Schema.Literals(["worktree", "setup"]),
  baseRef: Schema.optional(WorktreeBaseRef),
  createdAt: IsoDateTime,
});
export type ThreadBootstrapRetryCommand = typeof ThreadBootstrapRetryCommand.Type;

export const ThreadBootstrapStopCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type ThreadBootstrapStopCommand = typeof ThreadBootstrapStopCommand.Type;

export const ThreadBootstrapContinueCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap.continue"),
  commandId: CommandId,
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type ThreadBootstrapContinueCommand = typeof ThreadBootstrapContinueCommand.Type;

export const ResolvedThreadBootstrapWorkspace = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("local"),
    path: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    mode: Schema.Literal("existing-worktree"),
    path: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    mode: Schema.Literal("new-worktree"),
    projectCwd: TrimmedNonEmptyString,
    baseRef: WorktreeBaseRef,
    newBranch: Schema.optional(TrimmedNonEmptyString),
    // T3-CUSTOM(expbkt3): deterministic crash-recovery identity. Older
    // persisted requests may omit it and are recovered as a visible failure.
    intendedPath: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ResolvedThreadBootstrapWorkspace = typeof ResolvedThreadBootstrapWorkspace.Type;

export const ResolvedThreadBootstrapRequest = Schema.Struct({
  bootstrapId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: ResolvedThreadBootstrapWorkspace,
  initialTurn: Schema.optional(
    Schema.Struct({
      messageId: MessageId,
      text: Schema.String,
      attachments: Schema.Array(ChatAttachment),
      titleSeed: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId),
  priority: Schema.NullOr(ThreadPriority),
  // T3-CUSTOM(expbkt3): session lineage, resolved at accept time. Optional so
  // resolved requests persisted before lineage shipped still decode.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  ownerUserId: Schema.optional(UserId),
  // T3-CUSTOM(expbkt3): inherited session tags (see ThreadCreateCommand).
  memberUserIds: Schema.optional(Schema.Array(UserId)),
  createdAt: IsoDateTime,
});
export type ResolvedThreadBootstrapRequest = typeof ResolvedThreadBootstrapRequest.Type;

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // T3-CUSTOM(expbkt3): session priority. undefined = unchanged, null = clear.
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  // T3-CUSTOM(expbkt3): manual Linear tag. undefined = unchanged, null = clear.
  linearIssueUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // T3-CUSTOM(expbkt3): session lineage. undefined = unchanged, null = detach
  // to a root session. The decider rejects a value that would form a cycle.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

const ThreadMemberAddCommand = Schema.Struct({
  type: Schema.Literal("thread.member.add"),
  commandId: CommandId,
  threadId: ThreadId,
  userId: UserId,
});

const ThreadMemberRemoveCommand = Schema.Struct({
  type: Schema.Literal("thread.member.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  userId: UserId,
});

const ThreadOwnerTransferCommand = Schema.Struct({
  type: Schema.Literal("thread.owner.transfer"),
  commandId: CommandId,
  threadId: ThreadId,
  userId: UserId,
});

const ProjectMemberAddCommand = Schema.Struct({
  type: Schema.Literal("project.member.add"),
  commandId: CommandId,
  projectId: ProjectId,
  userId: UserId,
});

const ProjectMemberRemoveCommand = Schema.Struct({
  type: Schema.Literal("project.member.remove"),
  commandId: CommandId,
  projectId: ProjectId,
  userId: UserId,
});

const ProjectOwnerTransferCommand = Schema.Struct({
  type: Schema.Literal("project.owner.transfer"),
  commandId: CommandId,
  projectId: ProjectId,
  userId: UserId,
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadSourceControlProfileSetCommand = Schema.Struct({
  type: Schema.Literal("thread.source-control-profile.set"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceControlProfileId: SourceControlProfileId,
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // T3-CUSTOM(expbkt3): trusted external creators may nominate the durable owner.
  ownerUserId: Schema.optional(UserId),
  // T3-CUSTOM(expbkt3): inherited session tags (see ThreadCreateCommand).
  memberUserIds: Schema.optional(Schema.Array(UserId)),
  createdAt: IsoDateTime,
  // T3-CUSTOM(expbkt3): lets single-shot creators (MCP, the Linear bridge)
  // set a priority at creation time.
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  // T3-CUSTOM(expbkt3): session lineage set at creation time by the same
  // single-shot creators. Absent/null creates a root session.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

// T3-CUSTOM(expbkt3): durable client outboxes validate bootstrap before replay.
export const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
  // T3-CUSTOM(expbkt3): a client can persist the unresolved bootstrap request
  // in the same outbox item as its message. The server resolves defaults before
  // atomically accepting the turn, then stores resolvedRequest for recovery.
  request: Schema.optional(
    Schema.Struct({
      createThread: Schema.Boolean,
      bootstrapId: TrimmedNonEmptyString,
      projectId: ProjectId,
      title: TrimmedNonEmptyString,
      overrides: Schema.optional(ThreadBootstrapOverrides),
      sourceControlProfileId: Schema.optional(Schema.NullOr(SourceControlProfileId)),
      priority: Schema.optional(Schema.NullOr(ThreadPriority)),
      // T3-CUSTOM(expbkt3): session lineage carried through the client outbox.
      parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
      ownerUserId: Schema.optional(UserId),
      // T3-CUSTOM(expbkt3): inherited session tags (see ThreadCreateCommand).
      memberUserIds: Schema.optional(Schema.Array(UserId)),
      createdAt: IsoDateTime,
    }),
  ),
  resolvedRequest: Schema.optional(ResolvedThreadBootstrapRequest),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartPrecondition = Schema.Struct({
  requireIdle: Schema.Literal(true),
  expectedExecutionRevision: NonNegativeInt,
});
export type ThreadTurnStartPrecondition = typeof ThreadTurnStartPrecondition.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  precondition: Schema.optional(ThreadTurnStartPrecondition),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  precondition: Schema.optional(ThreadTurnStartPrecondition),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

/** Operator asked for a catch-up summary, ignoring the duration cutoff. */
const ThreadCatchupSummaryRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.catchup-summary.request"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  createdAt: IsoDateTime,
});

// T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary request. Public
// and user-triggered, dispatched one command per selected session.
const ThreadWorkSummaryRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.work-summary.request"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
// T3-CUSTOM(expbkt3): END

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadSessionRestartCommand = Schema.Struct({
  type: Schema.Literal("thread.session.restart"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ProjectMemberAddCommand,
  ProjectMemberRemoveCommand,
  ProjectOwnerTransferCommand,
  ThreadCreateCommand,
  ThreadBootstrapRequestCommand,
  ThreadBootstrapRetryCommand,
  ThreadBootstrapStopCommand,
  ThreadBootstrapContinueCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadMetaUpdateCommand,
  ThreadMemberAddCommand,
  ThreadMemberRemoveCommand,
  ThreadOwnerTransferCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadCatchupSummaryRequestCommand,
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary.
  ThreadWorkSummaryRequestCommand,
  // T3-CUSTOM(expbkt3): END
  ThreadSessionStopCommand,
  ThreadSessionRestartCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ProjectMemberAddCommand,
  ProjectMemberRemoveCommand,
  ProjectOwnerTransferCommand,
  ThreadCreateCommand,
  ClientThreadBootstrapRequestCommand,
  ThreadBootstrapRetryCommand,
  ThreadBootstrapStopCommand,
  ThreadBootstrapContinueCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadMetaUpdateCommand,
  ThreadMemberAddCommand,
  ThreadMemberRemoveCommand,
  ThreadOwnerTransferCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadCatchupSummaryRequestCommand,
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary.
  ThreadWorkSummaryRequestCommand,
  // T3-CUSTOM(expbkt3): END
  ThreadSessionStopCommand,
  ThreadSessionRestartCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

/**
 * Progress of one turn's catch-up summarization.
 *
 * - `pending`  — summarization started; show a spinner on the card.
 * - `ready`    — text produced.
 * - `error`    — generation failed; keep an actionable inline error card.
 * - `cleared`  — no card for this turn because it was below the cutoff.
 */
export const ThreadCatchupSummaryProgress = Schema.Literals([
  "pending",
  "ready",
  "error",
  "cleared",
]);
export type ThreadCatchupSummaryProgress = typeof ThreadCatchupSummaryProgress.Type;

const ThreadCatchupSummaryUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.catchup-summary.update"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  assistantMessageId: Schema.NullOr(MessageId),
  // Null leaves the thread's rolling summary untouched (e.g. the pending marker,
  // which is dispatched before the summarizer runs).
  rollingSummary: Schema.NullOr(Schema.String),
  displaySummary: Schema.NullOr(TrimmedNonEmptyString),
  progress: ThreadCatchupSummaryProgress,
  createdAt: IsoDateTime,
});

// T3-CUSTOM(expbkt3): BEGIN — internal work summary result. Dispatched by the
// WorkSummaryReactor only; the public entry point is
// `thread.work-summary.request` above.
const ThreadWorkSummaryUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.work-summary.update"),
  commandId: CommandId,
  threadId: ThreadId,
  /** The `thread.work-summary.request` command id this result answers. */
  requestId: CommandId,
  workSummary: ThreadWorkSummary,
  createdAt: IsoDateTime,
});
// T3-CUSTOM(expbkt3): END

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

// T3-CUSTOM(expbkt3): internal durable-bootstrap event commands. Public
// callers use the request/retry/stop/continue commands above.
const ThreadBootstrapRequestRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap.request.record"),
  commandId: CommandId,
  threadId: ThreadId,
  request: ResolvedThreadBootstrapRequest,
  progress: ThreadBootstrapProgress,
  createdAt: IsoDateTime,
});

const ThreadBootstrapStepUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap.step.update"),
  commandId: CommandId,
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  step: Schema.Literals(["worktree", "setup", "agent"]),
  status: ThreadBootstrapStepStatus,
  attempt: NonNegativeInt,
  terminalId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

const ThreadBootstrapControlRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap.control.record"),
  commandId: CommandId,
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  action: Schema.Literals(["stop", "retry", "continue"]),
  step: Schema.optional(Schema.Literals(["worktree", "setup"])),
  baseRef: Schema.optional(WorktreeBaseRef),
  createdAt: IsoDateTime,
});

const ThreadBootstrapCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.bootstrap.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  completedAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSourceControlProfileSetCommand,
  ThreadSessionSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadCatchupSummaryUpdateCommand,
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary result.
  ThreadWorkSummaryUpdateCommand,
  // T3-CUSTOM(expbkt3): END
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadTitleRegenerationCompleteCommand,
  ThreadBootstrapRequestRecordCommand,
  ThreadBootstrapStepUpdateCommand,
  ThreadBootstrapControlRecordCommand,
  ThreadBootstrapCompleteCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "project.member-added",
  "project.member-removed",
  "project.owner-transferred",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.meta-updated",
  "thread.member-added",
  "thread.member-removed",
  "thread.owner-transferred",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.source-control-profile-set",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-restart-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.catchup-summary-requested",
  "thread.catchup-summary-updated",
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary lifecycle.
  "thread.work-summary-requested",
  "thread.work-summary-updated",
  // T3-CUSTOM(expbkt3): END
  "thread.activity-appended",
  // T3-CUSTOM(expbkt3): durable workspace preparation lifecycle.
  "thread.bootstrap-requested",
  "thread.bootstrap-step-updated",
  "thread.bootstrap-stop-requested",
  "thread.bootstrap-retry-requested",
  "thread.bootstrap-continue-requested",
  "thread.bootstrap-completed",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  threadCreationDefaults: Schema.optional(ProjectThreadCreationDefaults).pipe(
    Schema.withDecodingDefault(Effect.succeed(EMPTY_PROJECT_THREAD_CREATION_DEFAULTS)),
  ),
  scripts: Schema.Array(ProjectScript),
  createdByUserId: Schema.optional(Schema.NullOr(UserId)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  threadCreationDefaults: Schema.optional(ProjectThreadCreationDefaults),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdByUserId: Schema.optional(Schema.NullOr(UserId)),
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  // T3-CUSTOM(expbkt3): session priority at creation time.
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  // T3-CUSTOM(expbkt3): session lineage at creation time. Immutable on this
  // event; later re-parenting travels on thread.meta.updated.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  // T3-CUSTOM(expbkt3): BEGIN — tags the session is born with, beyond its
  // creator. Later tag changes travel on thread.member-added/removed.
  memberUserIds: Schema.optional(Schema.Array(UserId)),
  // T3-CUSTOM(expbkt3): END
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(TrimmedNonEmptyString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // T3-CUSTOM(expbkt3): session priority. undefined = unchanged, null = clear.
  priority: Schema.optional(Schema.NullOr(ThreadPriority)),
  // T3-CUSTOM(expbkt3): manual Linear tag. undefined = unchanged, null = clear.
  linearIssueUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // T3-CUSTOM(expbkt3): session lineage. undefined = unchanged, null = detach.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadSourceControlProfileSetPayload = Schema.Struct({
  threadId: ThreadId,
  previousSourceControlProfileId: Schema.NullOr(SourceControlProfileId),
  sourceControlProfileId: SourceControlProfileId,
  changedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  sentByUserId: Schema.optional(Schema.NullOr(UserId)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  // T3-CUSTOM(expbkt3): persist new-thread preparation with accepted work.
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionRestartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadCatchupSummaryRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  createdAt: IsoDateTime,
});

export const ThreadCatchupSummaryUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  assistantMessageId: Schema.NullOr(MessageId),
  rollingSummary: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  displaySummary: Schema.NullOr(TrimmedNonEmptyString),
  progress: ThreadCatchupSummaryProgress.pipe(
    Schema.withDecodingDefault(Effect.succeed("ready" as const)),
  ),
  createdAt: IsoDateTime,
});

// T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary events.
export const ThreadWorkSummaryRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  /** Command id of the request; the projector stores it on the pending record. */
  requestId: CommandId,
  requestedAt: IsoDateTime,
});

export const ThreadWorkSummaryUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: CommandId,
  workSummary: ThreadWorkSummary,
});
// T3-CUSTOM(expbkt3): END

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const ThreadBootstrapRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  request: ResolvedThreadBootstrapRequest,
  progress: ThreadBootstrapProgress,
  createdAt: IsoDateTime,
});

export const ThreadBootstrapStepUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  step: Schema.Literals(["worktree", "setup", "agent"]),
  status: ThreadBootstrapStepStatus,
  attempt: NonNegativeInt,
  terminalId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadBootstrapControlRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  step: Schema.optional(Schema.Literals(["worktree", "setup"])),
  baseRef: Schema.optional(WorktreeBaseRef),
  requestedAt: IsoDateTime,
});

export const ThreadBootstrapCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  bootstrapId: TrimmedNonEmptyString,
  completedAt: IsoDateTime,
});

export const ThreadMemberAddedPayload = Schema.Struct({
  threadId: ThreadId,
  userId: UserId,
  addedByUserId: Schema.NullOr(UserId),
  addedAt: IsoDateTime,
});

export const ThreadMemberRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  userId: UserId,
  removedByUserId: Schema.NullOr(UserId),
  removedAt: IsoDateTime,
});

export const ThreadOwnerTransferredPayload = Schema.Struct({
  threadId: ThreadId,
  previousOwnerUserId: Schema.NullOr(UserId),
  ownerUserId: UserId,
  transferredByUserId: Schema.NullOr(UserId),
  transferredAt: IsoDateTime,
});

export const ProjectMemberAddedPayload = Schema.Struct({
  projectId: ProjectId,
  userId: UserId,
  addedByUserId: Schema.NullOr(UserId),
  addedAt: IsoDateTime,
});

export const ProjectMemberRemovedPayload = Schema.Struct({
  projectId: ProjectId,
  userId: UserId,
  removedByUserId: Schema.NullOr(UserId),
  removedAt: IsoDateTime,
});

export const ProjectOwnerTransferredPayload = Schema.Struct({
  projectId: ProjectId,
  previousOwnerUserId: Schema.NullOr(UserId),
  ownerUserId: UserId,
  transferredByUserId: Schema.NullOr(UserId),
  transferredAt: IsoDateTime,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
  /** Clerk user id of the operator who caused this event (audit trail). */
  actorUserId: Schema.optional(UserId),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.member-added"),
    payload: ThreadMemberAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.member-removed"),
    payload: ThreadMemberRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.owner-transferred"),
    payload: ThreadOwnerTransferredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.member-added"),
    payload: ProjectMemberAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.member-removed"),
    payload: ProjectMemberRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.owner-transferred"),
    payload: ProjectOwnerTransferredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.source-control-profile-set"),
    payload: ThreadSourceControlProfileSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-restart-requested"),
    payload: ThreadSessionRestartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.catchup-summary-requested"),
    payload: ThreadCatchupSummaryRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.catchup-summary-updated"),
    payload: ThreadCatchupSummaryUpdatedPayload,
  }),
  // T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary events.
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.work-summary-requested"),
    payload: ThreadWorkSummaryRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.work-summary-updated"),
    payload: ThreadWorkSummaryUpdatedPayload,
  }),
  // T3-CUSTOM(expbkt3): END
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.bootstrap-requested"),
    payload: ThreadBootstrapRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.bootstrap-step-updated"),
    payload: ThreadBootstrapStepUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.bootstrap-stop-requested"),
    payload: ThreadBootstrapControlRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.bootstrap-retry-requested"),
    payload: ThreadBootstrapControlRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.bootstrap-continue-requested"),
    payload: ThreadBootstrapControlRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.bootstrap-completed"),
    payload: ThreadBootstrapCompletedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
  Schema.Struct({
    kind: Schema.Literal("execution"),
    execution: ThreadExecutionSnapshot,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue({
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationStopExecutionInput = Schema.Struct({
  threadId: ThreadId,
  expectedExecutionId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrchestrationStopExecutionInput = typeof OrchestrationStopExecutionInput.Type;

export const OrchestrationStopExecutionResult = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  disposition: Schema.Literals(["stopping", "already-stopped"]),
  snapshot: ThreadExecutionSnapshot,
});
export type OrchestrationStopExecutionResult = typeof OrchestrationStopExecutionResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

// T3-CUSTOM(expbkt3)
export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationGetWorkflowScriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path from the workflow's runHandles.scriptPath. The server
   * re-derives containment; the client value is a hint, never trusted. */
  scriptPath: TrimmedNonEmptyString,
});
export type OrchestrationGetWorkflowScriptInput = typeof OrchestrationGetWorkflowScriptInput.Type;

export const OrchestrationGetWorkflowScriptResult = Schema.Struct({
  scriptPath: TrimmedNonEmptyString,
  contents: Schema.String,
  truncated: Schema.Boolean,
});
export type OrchestrationGetWorkflowScriptResult = typeof OrchestrationGetWorkflowScriptResult.Type;

const WORKFLOW_SCRIPT_ERROR_MESSAGES = {
  "invalid-path": "Workflow scripts must be absolute .js paths.",
  "root-unavailable": "Script root unavailable.",
  "not-found": "Script not found.",
  "outside-root": "Script path is outside the workflow scripts root.",
  "not-js": "Resolved script is not a .js file.",
  "not-regular-file": "Script is not a regular file.",
  "changed-during-read": "Script changed between resolution and open.",
  "read-failed": "Script read failed.",
} as const;

export class OrchestrationGetWorkflowScriptError extends Schema.TaggedErrorClass<OrchestrationGetWorkflowScriptError>()(
  "OrchestrationGetWorkflowScriptError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "root-unavailable",
      "not-found",
      "outside-root",
      "not-js",
      "not-regular-file",
      "changed-during-read",
      "read-failed",
    ]),
    scriptPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return WORKFLOW_SCRIPT_ERROR_MESSAGES[this.reason];
  }
}

export const OrchestrationRpcSchemas = {
  // T3-CUSTOM(expbkt3)
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  stopExecution: {
    input: OrchestrationStopExecutionInput,
    output: OrchestrationStopExecutionResult,
  },
  getWorkflowScript: {
    input: OrchestrationGetWorkflowScriptInput,
    output: OrchestrationGetWorkflowScriptResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: OrchestrationShellStreamItem,
  },
} as const;

export const OrchestrationUser = Schema.Struct({
  id: UserId,
  name: Schema.NullOr(TrimmedNonEmptyString),
  email: Schema.NullOr(TrimmedNonEmptyString),
  imageUrl: Schema.NullOr(TrimmedNonEmptyString),
  // Clerk organization admin. Admins manage project access; compat-defaulted so
  // older payloads/callers decode.
  isAdmin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type OrchestrationUser = typeof OrchestrationUser.Type;

export const OrchestrationUsersResult = Schema.Struct({
  users: Schema.Array(OrchestrationUser),
});
export type OrchestrationUsersResult = typeof OrchestrationUsersResult.Type;

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ThreadTurnAdmissionConflictReason = Schema.Literals([
  "execution_revision_mismatch",
  "thread_not_idle",
]);
export type ThreadTurnAdmissionConflictReason = typeof ThreadTurnAdmissionConflictReason.Type;

export class ThreadTurnAdmissionConflictError extends Schema.TaggedErrorClass<ThreadTurnAdmissionConflictError>()(
  "ThreadTurnAdmissionConflictError",
  {
    threadId: ThreadId,
    executionId: TrimmedNonEmptyString,
    reason: ThreadTurnAdmissionConflictReason,
    expectedExecutionRevision: NonNegativeInt,
    actualExecutionRevision: NonNegativeInt,
    activity: ThreadExecutionActivity,
  },
) {}

// T3-CUSTOM(expbkt3)
export class OrchestrationReplayEventsError extends Schema.TaggedErrorClass<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationStopExecutionError extends Schema.TaggedErrorClass<OrchestrationStopExecutionError>()(
  "OrchestrationStopExecutionError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationSearchThreadsError extends Schema.TaggedErrorClass<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
