import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThread,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
  type UserId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { decideWorktreeRecovery, describeWorktreeRecreation } from "../threadWorktreeRecovery.ts";
import {
  durableExecutionGuardedContinuationsTotal,
  durableExecutions,
  increment,
  orchestrationEventsProcessedTotal,
  setMetric,
} from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type {
  ProviderSessionExecutionOptions,
  ProviderThreadSnapshot,
} from "../../provider/Services/ProviderAdapter.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { makeProviderSessionRestartSweep } from "./ProviderSessionRestartSweep.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ThreadExecutionSupervisor } from "../../execution/ThreadExecutionSupervisor.ts";
import { SourceControlProfileService } from "../../sourceControl/SourceControlProfileService.ts";
// T3-CUSTOM(expbkt3): session-identity markers injected into provider sessions.
import {
  SessionIdentityEnvironmentService,
  sessionIdentityFingerprint,
  unresolvedSessionIdentityEnvironment,
} from "../../identity/SessionIdentityEnvironment.ts";
import { ServerConfig } from "../../config.ts";
// T3-CUSTOM(expbkt3): schema guards preserve setup launch certainty across the durable boundary.
import {
  ProjectSetupScriptCommandError,
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
  ProjectSetupScriptRunner,
} from "../../project/ProjectSetupScriptRunner.ts";
// T3-CUSTOM(expbkt3): exact durable-bootstrap bases bypass ref-list pagination.
import { resolveAvailableWorktreeBase } from "../../thread-bootstrap/WorktreeBaseResolver.ts";
// T3-CUSTOM(expbkt3): periodic title refresh cadence.
import { shouldRefreshThreadTitle } from "../../thread-title/titleRefreshCadence.ts";
// T3-CUSTOM(expbkt3): who owns a session title, and when generation may replace it.
import {
  canGeneratedTitleReplace,
  shouldNameThreadFromFirstPrompt,
} from "../../thread-title/titleAuthorship.ts";
// T3-CUSTOM(expbkt3): durable dispatch control plane; provider mechanics stay here.
import {
  DurableExecutionDispatchError,
  makeDurableExecutionCoordinator,
} from "../../execution/DurableExecutionCoordinator.ts";
import { DurableExecutionIntentRepository } from "../../execution/DurableExecutionIntentRepository.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isProjectSetupScriptCommandError = Schema.is(ProjectSetupScriptCommandError);
const isProjectSetupScriptOperationError = Schema.is(ProjectSetupScriptOperationError);
const isProjectSetupScriptProjectNotFoundError = Schema.is(ProjectSetupScriptProjectNotFoundError);

// T3-CUSTOM(expbkt3): mere provider-history presence is not terminal evidence.
export function providerHistoryProvesCompletion(
  history: ProviderThreadSnapshot,
  providerTurnId: TurnId,
): boolean {
  return history.turns.some((turn) => turn.id === providerTurnId && turn.state === "completed");
}

// T3-CUSTOM(expbkt3): Codex only materializes a thread after its first user message.
export function providerHistoryReadProvesUndelivered(cause: unknown): boolean {
  if (!isProviderAdapterRequestError(cause)) return false;
  const detail = cause.detail.toLowerCase();
  return (
    cause.provider === "codex" &&
    cause.method === "thread/read" &&
    detail.includes("not materialized yet") &&
    detail.includes("before first user message")
  );
}

// T3-CUSTOM(expbkt3): ten retries cannot repair missing resume state or removed configuration.
export function durableRecoveryFailure(
  cause: unknown,
  fallbackFailureType: string,
): DurableExecutionDispatchError {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause ? String(cause._tag) : "";
  const detail = String(cause);
  // Adapter errors bury the decisive message (an ENOENT from a spawn, a
  // permission failure) in nested `cause`s that String() never surfaces, so
  // classify against the whole chain.
  let normalized = detail.toLowerCase();
  const seen = new Set<unknown>();
  let nested: unknown = cause;
  while (typeof nested === "object" && nested !== null && "cause" in nested && !seen.has(nested)) {
    seen.add(nested);
    nested = (nested as { readonly cause?: unknown }).cause;
    if (nested !== undefined && nested !== null) {
      normalized += ` ${String(nested).toLowerCase()}`;
    }
  }
  const permanentTag =
    tag === "ProviderAdapterValidationError" ||
    tag === "ProviderValidationError" ||
    tag === "ProviderUnsupportedError" ||
    tag === "ProviderInstanceNotFoundError" ||
    tag === "ProviderSessionNotFoundError";
  const permanentDetail =
    /resume (?:cursor|state).*(?:missing|unavailable|not found)/.test(normalized) ||
    /(?:session|thread).*(?:does not exist|not found|unknown)/.test(normalized) ||
    /worktree.*(?:does not exist|not found|missing)/.test(normalized) ||
    normalized.includes("enoent") ||
    normalized.includes("permission denied") ||
    normalized.includes("access revoked");
  const retryable = !(permanentTag || permanentDetail);
  return new DurableExecutionDispatchError({
    failureType: retryable ? fallbackFailureType : "durable-resume-unavailable",
    detail,
    retryable,
    cause,
  });
}

const normalizeDurableDispatchError = (cause: unknown, fallbackFailureType: string) =>
  Schema.is(DurableExecutionDispatchError)(cause)
    ? cause
    : durableRecoveryFailure(cause, fallbackFailureType);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.session-restart-requested"
      | "thread.archived"
      | "thread.session-set";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = message.text.trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

// T3-CUSTOM(expbkt3): title ownership moved to apps/server/src/thread-title.
// Upstream compared the current title to the raw seed, but clients title a new
// thread with `truncate(prompt)` while seeding the full prompt, so no prompt
// over the truncation budget was ever auto-named. `titleManuallySet` is the
// durable "a human chose this" flag the periodic refresh also honors.
function canReplaceThreadTitle(
  currentTitle: string,
  titleSeed?: string,
  titleManuallySet?: boolean,
): boolean {
  return canGeneratedTitleReplace({
    title: currentTitle,
    ...(titleSeed !== undefined ? { titleSeed } : {}),
    ...(titleManuallySet !== undefined ? { titleManuallySet } : {}),
  });
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

/**
 * An interrupt that could not be delivered because nothing was running.
 *
 * After a server restart the provider process is gone, so the orchestration
 * turn is the only thing left to settle — respawning an agent just to stop it
 * would be absurd. Both shapes reach here as adapter request errors: the
 * service refuses to route to a dead session, and codex reports a session
 * with no active turn.
 */
function isDeadSessionInterruptError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  const detail = (error ? error.detail : Cause.pretty(cause)).toLowerCase();
  return (
    detail.includes("no live provider session") ||
    detail.includes("no active turn to interrupt") ||
    detail.includes("no persisted provider binding exists")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const executionSupervisor = yield* ThreadExecutionSupervisor;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectSetupScriptRunner = yield* Effect.serviceOption(ProjectSetupScriptRunner);
  // T3-CUSTOM(expbkt3): optional keeps isolated upstream reactor tests lightweight.
  const durableIntentRepository = yield* Effect.serviceOption(DurableExecutionIntentRepository);
  const sourceControlProfiles = yield* Effect.serviceOption(SourceControlProfileService);
  // T3-CUSTOM(expbkt3): optional for the same reason as the profile service —
  // isolated upstream reactor tests do not build the user directory.
  const sessionIdentity = yield* Effect.serviceOption(SessionIdentityEnvironmentService);
  const providerSessionRestartSweep = yield* makeProviderSessionRestartSweep;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  // T3-CUSTOM(expbkt3): Tracks the identity whose personal MCP credentials
  // were bound when this reactor started each ACP session. An absent entry
  // means a pre-existing session has not yet been rebound in this process.
  const threadCredentialActors = new Map<ThreadId, UserId | null>();
  // T3-CUSTOM(expbkt3): identity environment the live provider process for each
  // thread was spawned with. A process reads its environment once, so this is
  // what makes an owner transfer or a new sender observable as staleness.
  const threadSessionIdentities = new Map<ThreadId, NodeJS.ProcessEnv>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const setThreadSessionInterrupted = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "interrupted",
        activeTurnId: null,
        lastError: null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveSourceControlExecutionOptions = Effect.fnUntraced(function* (
    thread: OrchestrationThread,
    method: string,
  ): Effect.fn.Return<ProviderSessionExecutionOptions | undefined, ProviderAdapterRequestError> {
    const context = yield* Option.match(sourceControlProfiles, {
      onNone: () => Effect.succeed(null),
      // T3-CUSTOM(expbkt3): attribution follows durable thread ownership.
      onSome: (profiles) =>
        profiles.resolveThreadExecutionContext(thread.id, thread.ownerUserId, {}).pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterRequestError({
                provider: providerErrorLabelFromInstanceHint({
                  instanceId: String(thread.modelSelection.instanceId),
                }),
                method,
                detail: error.detail,
              }),
          ),
        ),
    });
    return context ? { environment: context.environment } : undefined;
  });

  // T3-CUSTOM(expbkt3): resolves who owns this thread and who sent the message
  // being answered, from the durable environment-user directory. `undefined`
  // means "this operation has no sender of its own" — an interrupt or an
  // approval reply — and reuses whatever the live session was started with, so
  // a session recovered by one of those paths does not drift from the identity
  // this reactor is tracking for the thread.
  const resolveSessionIdentityEnvironment = Effect.fnUntraced(function* (
    thread: OrchestrationThread,
    senderUserId: UserId | null | undefined,
  ) {
    if (senderUserId === undefined) {
      const bound = threadSessionIdentities.get(thread.id);
      if (bound !== undefined) {
        return bound;
      }
    }
    return yield* Option.match(sessionIdentity, {
      onNone: () => Effect.succeed(unresolvedSessionIdentityEnvironment()),
      onSome: (service) =>
        service.resolve({
          ownerUserId: thread.ownerUserId,
          senderUserId: senderUserId ?? null,
        }),
    });
  });

  // T3-CUSTOM(expbkt3): the source-control profile environment and the identity
  // markers compose — a thread-profile session carries both, a machine-identity
  // session carries the markers alone.
  const resolveSessionExecutionOptions = Effect.fnUntraced(function* (
    thread: OrchestrationThread,
    method: string,
    senderUserId: UserId | null | undefined,
  ): Effect.fn.Return<ProviderSessionExecutionOptions, ProviderAdapterRequestError> {
    const sourceControlExecutionOptions = yield* resolveSourceControlExecutionOptions(
      thread,
      method,
    );
    const identityEnvironment = yield* resolveSessionIdentityEnvironment(thread, senderUserId);
    return { ...sourceControlExecutionOptions, identityEnvironment };
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  // T3-CUSTOM(expbkt3): a worktree deleted out from under a live thread —
  // external cleanup, a disk incident, a manual `git worktree remove` — would
  // otherwise fail every session start with the same ENOENT until a human
  // rebuilds the directory by hand.
  const ensureThreadWorktree = Effect.fn("ensureThreadWorktree")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly workspaceRoot: string | null;
    readonly createdAt: string;
  }) {
    const worktreePath = input.thread.worktreePath;
    if (worktreePath === null) {
      return;
    }
    if (yield* fileSystem.exists(worktreePath)) {
      return;
    }
    const branch = input.thread.branch;
    const branchExists =
      input.workspaceRoot !== null && branch !== null
        ? (yield* gitWorkflow.listLocalBranchNames(input.workspaceRoot)).includes(branch)
        : false;
    const decision = decideWorktreeRecovery({
      worktreePath,
      branch,
      branchExists,
      workspaceRoot: input.workspaceRoot,
    });
    if (decision.kind === "unrecoverable") {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabelFromInstanceHint({
          instanceId: String(input.thread.modelSelection.instanceId),
        }),
        method: "thread.turn.start",
        detail: decision.detail,
      });
    }
    // An `rm -rf` deletion leaves a stale `.git/worktrees/` registration that
    // keeps the branch "checked out" and blocks re-adding it at this path.
    yield* gitWorkflow.pruneWorktrees(decision.workspaceRoot);
    yield* gitWorkflow.createWorktree({
      cwd: decision.workspaceRoot,
      refName: decision.branch,
      path: decision.worktreePath,
    });
    yield* Effect.all({
      commandId: serverCommandId("worktree-recreated-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.thread.id,
          activity: {
            id: eventId,
            tone: "info",
            kind: "worktree.recreated",
            summary: `Recreated missing worktree from branch '${decision.branch}'`,
            payload: {
              detail: describeWorktreeRecreation({
                worktreePath: decision.worktreePath,
                branch: decision.branch,
              }),
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      readonly actorUserId?: UserId | null;
      /**
       * T3-CUSTOM(expbkt3): the user who actually sent this message, with no
       * owner fallback — an inferred sender is the misattribution this exists
       * to prevent.
       */
      readonly messageSenderUserId?: UserId | null;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredCredentialActor = options?.actorUserId ?? thread.ownerUserId;
    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    yield* ensureThreadWorktree({
      thread,
      workspaceRoot: project?.workspaceRoot ?? null,
      createdAt,
    });
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    // T3-CUSTOM(expbkt3): source-control profile environment plus the session
    // identity markers the agent reads to name the person it works for.
    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.turn.start",
      options?.messageSenderUserId ?? null,
    );
    const desiredSessionIdentity =
      sessionExecutionOptions.identityEnvironment ?? unresolvedSessionIdentityEnvironment();

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(
        threadId,
        {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
        },
        {
          ...sessionExecutionOptions,
          actorUserId: desiredCredentialActor,
        },
      );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        threadCredentialActors.set(threadId, desiredCredentialActor);
        threadSessionIdentities.set(threadId, desiredSessionIdentity);
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            providerThreadId: thread.session?.providerThreadId ?? null,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);
      // T3-CUSTOM(expbkt3): Managed MCP credentials are bound to the user who
      // starts this turn. Resume the ACP under a fresh generation when a
      // different authorized user takes over a shared thread.
      const credentialActorChanged =
        !threadCredentialActors.has(threadId) ||
        threadCredentialActors.get(threadId) !== desiredCredentialActor;
      // T3-CUSTOM(expbkt3): the running process already read its environment,
      // so an owner transfer or a different sender only reaches the agent
      // through a fresh session.
      const boundSessionIdentity = threadSessionIdentities.get(threadId);
      const sessionIdentityChanged =
        boundSessionIdentity === undefined ||
        sessionIdentityFingerprint(boundSessionIdentity) !==
          sessionIdentityFingerprint(desiredSessionIdentity);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange &&
        !credentialActorChanged &&
        !sessionIdentityChanged
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        credentialActorChanged,
        sessionIdentityChanged,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly actorUserId?: UserId | null;
    /** T3-CUSTOM(expbkt3): sender of this message, never the owner by fallback. */
    readonly messageSenderUserId?: UserId | null;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
      actorUserId: input.actorUserId ?? thread.ownerUserId,
      messageSenderUserId: input.messageSenderUserId ?? null,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        // T3-CUSTOM(expbkt3): a rename that landed while the model was thinking
        // wins — including one the user typed.
        if (!canReplaceThreadTitle(thread.title, input.titleSeed, thread.titleManuallySet)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
          // T3-CUSTOM(expbkt3): generated, so a later refresh may replace it.
          titleOrigin: "generated",
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    recovery?: {
      readonly messageText: string;
      readonly useOriginalAttachments: boolean;
    },
    claimGuard?: Effect.Effect<void, DurableExecutionDispatchError>,
  ) {
    if (claimGuard !== undefined) yield* claimGuard;
    const key = turnStartKeyForEvent(event);
    if (
      recovery === undefined &&
      Option.isNone(durableIntentRepository) &&
      (yield* hasHandledTurnStartRecently(key))
    ) {
      return;
    }
    const executionId = String(event.commandId ?? event.eventId);
    const preparedExecution = yield* recovery === undefined
      ? executionSupervisor.prepareExecution(event)
      : executionSupervisor.recoverExecution(event);
    if (preparedExecution.turn?.executionId !== executionId) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const userMessageCount = thread.messages.filter((entry) => entry.role === "user").length;
    const isFirstUserMessageTurn = userMessageCount === 1;
    // T3-CUSTOM(expbkt3): BEGIN — re-derive the title as a long session drifts
    // from its opening prompt. Reuses the durable regeneration flow (request
    // ids, supersede checks, interrupted-run recovery) rather than renaming
    // directly, so a refresh behaves exactly like the manual action.
    if (!isFirstUserMessageTurn) {
      const { experimental } = yield* serverSettingsService.getSettings;
      if (
        shouldRefreshThreadTitle({
          userMessageCount,
          titleManuallySet: thread.titleManuallySet,
          settings: experimental.threadTitleMaintenance,
        })
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("thread-title-refresh"),
            threadId: event.payload.threadId,
            regenerateTitle: true,
          })
          .pipe(
            // A title is cosmetic; never let it interfere with starting the turn.
            Effect.catchCause((cause) =>
              Effect.logWarning("scheduled thread title refresh failed to dispatch", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
    }
    // T3-CUSTOM(expbkt3): END
    if (isFirstUserMessageTurn) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: recovery?.messageText ?? message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      // T3-CUSTOM(expbkt3): BEGIN — name the session through the durable
      // regeneration flow instead of upstream's forked fiber, which this fork's
      // durable turn dispatch interrupts before the model answers. See
      // shouldNameThreadFromFirstPrompt for the full reasoning.
      if (
        shouldNameThreadFromFirstPrompt({
          userMessageCount,
          title: thread.title,
          titleManuallySet: thread.titleManuallySet,
          ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
        })
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("thread-title-first-prompt"),
            threadId: event.payload.threadId,
            regenerateTitle: true,
          })
          .pipe(
            // A title is cosmetic; never let it interfere with starting the turn.
            Effect.catchCause((cause) =>
              Effect.logWarning("first-prompt thread title naming failed to dispatch", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      } else if (
        canReplaceThreadTitle(thread.title, event.payload.titleSeed, thread.titleManuallySet)
      ) {
        // Retained for upstream parity: reachable only when the durable route
        // declines but the title is still replaceable.
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
      // T3-CUSTOM(expbkt3): END
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return executionSupervisor.failExecution(event.payload.threadId, executionId, detail).pipe(
        Effect.andThen(
          setThreadSessionErrorOnTurnStartFailure({
            threadId: event.payload.threadId,
            detail,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    if (claimGuard !== undefined) yield* claimGuard;
    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: recovery?.messageText ?? message.text,
      ...((recovery === undefined || recovery.useOriginalAttachments) &&
      message.attachments !== undefined
        ? { attachments: message.attachments }
        : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      actorUserId: message.sentByUserId ?? thread.ownerUserId,
      messageSenderUserId: message.sentByUserId ?? null,
      createdAt: event.payload.createdAt,
    }).pipe(
      // T3-CUSTOM(expbkt3): record the failure for the user, then re-fail with
      // the original cause so the durable dispatcher can classify it. Swallowing
      // it here reported every session-start failure as a retryable missing
      // acknowledgement, which burned all recovery attempts on permanent errors
      // like a deleted worktree.
      Effect.catchCause((cause) =>
        recoverTurnStartFailure(cause).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );

    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.turn.start",
      message.sentByUserId ?? null,
    );

    if (!(yield* executionSupervisor.canContinueExecution(event.payload.threadId, executionId))) {
      // A stop may arrive while the provider process is starting. Ensure a
      // process spawned during that window cannot survive or receive a turn.
      yield* providerService
        .terminateSession({ threadId: event.payload.threadId })
        .pipe(Effect.catchCause(Effect.logWarning));
      return undefined;
    }

    if (claimGuard !== undefined) yield* claimGuard;

    return yield* executionSupervisor
      .canContinueExecution(event.payload.threadId, executionId)
      .pipe(
        Effect.flatMap((canContinue) =>
          canContinue
            ? providerService.sendTurn(
                { ...sendTurnRequest, clientExecutionId: executionId },
                sessionExecutionOptions,
              )
            : Effect.succeed(undefined),
        ),
        Effect.catchCause((cause) =>
          recoverTurnStartFailure(cause).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.turn.interrupt",
      undefined,
    );
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId }, sessionExecutionOptions)
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          // Stop must always be able to unstick a thread. When the provider
          // session is already gone there is nothing to interrupt, so settle
          // the orchestration turn directly instead of leaving it pinned.
          if (isDeadSessionInterruptError(cause)) {
            return setThreadSessionInterrupted({
              threadId: event.payload.threadId,
              createdAt: event.payload.createdAt,
            }).pipe(
              Effect.andThen(
                appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.turn.interrupt.failed",
                  summary: "Turn stopped",
                  detail: "The provider session was no longer running, so the turn was closed.",
                  turnId: event.payload.turnId ?? null,
                  createdAt: event.payload.createdAt,
                }),
              ),
            );
          }
          return appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.interrupt.failed",
            summary: "Provider turn interrupt failed",
            detail: formatFailureDetail(cause),
            turnId: event.payload.turnId ?? null,
            createdAt: event.payload.createdAt,
          });
        }),
      );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
      thread,
      "thread.approval.respond",
      undefined,
    );
    yield* providerService
      .respondToRequest(
        {
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          decision: event.payload.decision,
        },
        sessionExecutionOptions,
      )
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      const sessionExecutionOptions = yield* resolveSessionExecutionOptions(
        thread,
        "thread.user-input.respond",
        undefined,
      );
      yield* providerService
        .respondToUserInput(
          {
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
            answers: event.payload.answers,
          },
          sessionExecutionOptions,
        )
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  // T3-CUSTOM(expbkt3): upper bound on a provider stop holding the reactor lane.
  const SESSION_STOP_TIMEOUT = "15 seconds";

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    // T3-CUSTOM(expbkt3): The projection can say stopped while a provider
    // process remains alive. Treat session.stop as idempotent against the
    // provider registry so the sidebar's force-stop escape hatch is real.
    if (thread.session) {
      // T3-CUSTOM(expbkt3): this runs on the reactor's single sequential lane.
      // A provider stop that never returned blocked every later turn wake,
      // approval, and interrupt for every thread (2026-08-20 outage). Bound it;
      // the projection below still converges to stopped either way.
      const stopped = yield* providerService
        .stopSession({ threadId: thread.id })
        .pipe(Effect.timeoutOption(SESSION_STOP_TIMEOUT));
      if (Option.isNone(stopped)) {
        yield* Effect.logWarning("provider session stop timed out on the reactor lane", {
          threadId: thread.id,
          timeout: SESSION_STOP_TIMEOUT,
        });
      }
    }
    threadCredentialActors.delete(thread.id);

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        providerThreadId: thread.session?.providerThreadId ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processSessionRestartRequested = Effect.fn("processSessionRestartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-restart-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread?.session) {
      return yield* new ProviderAdapterRequestError({
        provider: "unknown",
        method: "thread.session.restart",
        detail: `Thread '${event.payload.threadId}' does not have a provider session to reconnect.`,
      });
    }

    const modelSelection =
      thread.session.providerInstanceId !== undefined
        ? {
            ...thread.modelSelection,
            instanceId: thread.session.providerInstanceId,
          }
        : thread.modelSelection;
    yield* ensureSessionForThread(thread.id, event.payload.createdAt, { modelSelection });
  });

  // T3-CUSTOM(expbkt3): New-thread preparation runs only after the accepted
  // turn and its exact bootstrap specification are durable. Each external
  // step has a persisted uncertainty boundary so a restart never launches a
  // worktree or setup script twice merely because the acknowledgement was lost.
  const prepareDurableBootstrap = Effect.fn("prepareDurableBootstrap")(function* (input: {
    readonly intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent;
    readonly event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
    readonly owner: string;
    readonly generation: number;
  }) {
    const bootstrap = input.event.payload.bootstrap;
    if (bootstrap === undefined || Option.isNone(durableIntentRepository)) return;
    const resolvedBootstrapRequest = bootstrap.resolvedRequest;
    const resolvedBootstrapWorkspace = resolvedBootstrapRequest?.workspace;
    const resolvedBootstrapCwd =
      resolvedBootstrapWorkspace?.mode === "new-worktree"
        ? resolvedBootstrapWorkspace.projectCwd
        : resolvedBootstrapWorkspace?.path;
    const repository = durableIntentRepository.value;
    const operation = yield* repository.getBootstrapOperation({
      workItemId: input.intent.workItemId,
    });
    if (Option.isNone(operation)) {
      return yield* new DurableExecutionDispatchError({
        failureType: "bootstrap-state-missing",
        detail: "The accepted bootstrap specification has no durable operation record.",
        retryable: false,
      });
    }
    const fail = (failureType: string, detail: string, retryable: boolean, cause?: unknown) =>
      new DurableExecutionDispatchError({
        failureType,
        detail,
        retryable,
        ...(cause === undefined ? {} : { cause }),
      });
    const currentTime = () => Effect.map(DateTime.now, DateTime.formatIso);
    let thread = yield* resolveThread(input.intent.threadId);
    if (!thread) {
      return yield* fail(
        "bootstrap-thread-missing",
        "The thread committed with this durable work item is no longer available.",
        false,
      );
    }
    let worktreePath = thread.worktreePath ?? operation.value.worktreePath;

    const worktreeStep = yield* repository.beginBootstrapStep({
      workItemId: input.intent.workItemId,
      owner: input.owner,
      generation: input.generation,
      step: "worktree",
      at: yield* currentTime(),
    });
    if (Option.isNone(worktreeStep)) {
      return yield* fail(
        "bootstrap-claim-fenced",
        "Bootstrap preparation lost its execution claim before worktree reconciliation.",
        false,
      );
    }

    if (worktreeStep.value !== "acknowledged" && worktreeStep.value !== "not-required") {
      const prepare = bootstrap.prepareWorktree;
      const resolvedPrepare =
        resolvedBootstrapWorkspace?.mode === "new-worktree"
          ? resolvedBootstrapWorkspace
          : undefined;
      if (prepare === undefined && resolvedPrepare === undefined) {
        return yield* fail(
          "bootstrap-worktree-spec-missing",
          "Durable worktree state requires preparation but the accepted specification is absent.",
          false,
        );
      }
      const projectCwd = prepare?.projectCwd ?? resolvedPrepare!.projectCwd;
      const targetBranch = prepare?.branch ?? prepare?.baseBranch ?? resolvedPrepare?.newBranch;
      if (targetBranch === undefined) {
        return yield* fail(
          "bootstrap-worktree-branch-missing",
          "The durable bootstrap has no deterministic worktree branch identity.",
          false,
        );
      }
      const deterministicPath =
        resolvedPrepare?.intendedPath ??
        path.join(
          serverConfig.worktreesDir,
          path.basename(projectCwd),
          targetBranch.replace(/\//g, "-"),
        );
      const candidatePath = worktreePath ?? deterministicPath;
      const candidateExists = yield* fileSystem
        .exists(candidatePath)
        .pipe(
          Effect.mapError((cause) =>
            fail(
              "bootstrap-worktree-inspection-failed",
              `Could not inspect deterministic worktree path '${candidatePath}'.`,
              true,
              cause,
            ),
          ),
        );
      if (candidateExists) {
        const status = yield* gitWorkflow
          .localStatus({ cwd: candidatePath })
          .pipe(
            Effect.mapError((cause) =>
              fail(
                "bootstrap-worktree-inspection-failed",
                `Could not reconcile the existing worktree '${candidatePath}'.`,
                true,
                cause,
              ),
            ),
          );
        if (!status.isRepo || status.refName !== targetBranch) {
          return yield* fail(
            "bootstrap-worktree-conflict",
            `The deterministic path '${candidatePath}' exists but is not worktree branch '${targetBranch}'.`,
            false,
          );
        }
        worktreePath = candidatePath;
      } else {
        if (worktreeStep.value === "running") {
          yield* repository.markBootstrapStepFailed({
            workItemId: input.intent.workItemId,
            owner: input.owner,
            generation: input.generation,
            step: "worktree",
            phase: "uncertain",
            detail:
              "The server restarted during worktree creation and no matching deterministic worktree can be proven.",
            at: yield* currentTime(),
          });
          return yield* fail(
            "bootstrap-worktree-uncertain",
            "The server restarted during worktree creation and no matching deterministic worktree can be proven.",
            false,
          );
        }
        if (
          !(yield* repository.isClaimCurrent({
            workItemId: input.intent.workItemId,
            owner: input.owner,
            generation: input.generation,
            now: yield* currentTime(),
          }))
        ) {
          return yield* fail(
            "bootstrap-claim-fenced",
            "Bootstrap preparation was stopped before worktree creation.",
            false,
          );
        }
        let baseBranch = prepare?.baseBranch ?? null;
        // "Start from origin" is a stored default; repos without an origin
        // remote fall back to the local base branch instead of failing the
        // whole bootstrap on `git fetch origin`. Upstream applies this in
        // ws.ts; the fork relocated this block here, so it carries the guard.
        let startFromOrigin =
          prepare?.startFromOrigin === true &&
          (yield* gitWorkflow
            .remoteExists({ cwd: projectCwd, remoteName: "origin" })
            .pipe(Effect.orElseSucceed(() => false)));
        if (resolvedPrepare !== undefined) {
          startFromOrigin = resolvedPrepare.baseRef.source === "origin";
          if (startFromOrigin) {
            yield* gitWorkflow
              .fetchRemote({ cwd: projectCwd, remoteName: "origin" })
              .pipe(
                Effect.mapError((cause) =>
                  fail(
                    "bootstrap-worktree-fetch-failed",
                    `Could not fetch the configured base for '${targetBranch}'.`,
                    true,
                    cause,
                  ),
                ),
              );
          }
          const exactBaseRef = yield* resolveAvailableWorktreeBase({
            cwd: projectCwd,
            baseRef: resolvedPrepare.baseRef,
            listRefs: gitWorkflow.listRefs,
            resolveRemoteTrackingCommit: gitWorkflow.resolveRemoteTrackingCommit,
          }).pipe(
            Effect.mapError((cause) =>
              fail(
                "bootstrap-worktree-base-unavailable",
                "Could not inspect the configured worktree base.",
                true,
                cause,
              ),
            ),
          );
          if (exactBaseRef === null || exactBaseRef.kind !== "branch") {
            return yield* fail(
              "bootstrap-worktree-base-unavailable",
              "The configured worktree base is no longer available.",
              false,
            );
          }
          baseBranch = exactBaseRef.branch;
        }
        if (baseBranch === null) {
          return yield* fail(
            "bootstrap-worktree-base-unavailable",
            "The accepted worktree specification has no base branch.",
            false,
          );
        }
        let worktreeBaseRef = baseBranch;
        if (startFromOrigin) {
          if (resolvedPrepare === undefined) {
            yield* gitWorkflow
              .fetchRemote({ cwd: projectCwd, remoteName: "origin" })
              .pipe(
                Effect.mapError((cause) =>
                  fail(
                    "bootstrap-worktree-fetch-failed",
                    `Could not fetch the base for '${targetBranch}'.`,
                    true,
                    cause,
                  ),
                ),
              );
          }
          const resolved = yield* gitWorkflow
            .resolveRemoteTrackingCommit({
              cwd: projectCwd,
              refName: baseBranch,
              fallbackRemoteName: "origin",
            })
            .pipe(
              Effect.mapError((cause) =>
                fail(
                  "bootstrap-worktree-base-unavailable",
                  `Could not resolve base branch '${baseBranch}'.`,
                  false,
                  cause,
                ),
              ),
            );
          worktreeBaseRef = resolved.commitSha;
        }
        const created = yield* gitWorkflow
          .createWorktree({
            cwd: projectCwd,
            refName: worktreeBaseRef,
            ...(resolvedPrepare !== undefined || prepare?.branch !== undefined
              ? { newRefName: targetBranch }
              : {}),
            baseRefName: baseBranch,
            path: deterministicPath,
          })
          .pipe(
            Effect.mapError((cause) =>
              fail(
                "bootstrap-worktree-create-failed",
                `Could not create worktree branch '${targetBranch}'.`,
                true,
                cause,
              ),
            ),
          );
        worktreePath = created.worktree.path;
      }

      yield* orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`durable-bootstrap:worktree:${input.intent.workItemId}`),
          threadId: input.intent.threadId,
          branch: targetBranch,
          worktreePath,
        })
        .pipe(
          Effect.mapError((cause) =>
            fail(
              "bootstrap-worktree-record-failed",
              "The worktree exists but its durable thread metadata could not be recorded.",
              true,
              cause,
            ),
          ),
        );
      if (
        !(yield* repository.acknowledgeBootstrapStep({
          workItemId: input.intent.workItemId,
          owner: input.owner,
          generation: input.generation,
          step: "worktree",
          worktreePath,
          at: yield* currentTime(),
        }))
      ) {
        return yield* fail(
          "bootstrap-claim-fenced",
          "Worktree preparation completed after the execution claim was fenced.",
          false,
        );
      }
      yield* vcsStatusBroadcaster
        .refreshStatus(worktreePath)
        .pipe(Effect.ignoreCause({ log: true }));
      thread = (yield* resolveThread(input.intent.threadId)) ?? thread;
    }

    const setupStep = yield* repository.beginBootstrapStep({
      workItemId: input.intent.workItemId,
      owner: input.owner,
      generation: input.generation,
      step: "setup",
      at: yield* currentTime(),
    });
    if (Option.isNone(setupStep)) {
      return yield* fail(
        "bootstrap-claim-fenced",
        "Bootstrap preparation lost its execution claim before setup reconciliation.",
        false,
      );
    }
    if (setupStep.value === "acknowledged" || setupStep.value === "not-required") return;
    const terminalId = operation.value.setupTerminalId;
    if (setupStep.value === "running") {
      const adopted = thread.activities.some(
        (activity) =>
          activity.kind === "setup-script.started" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          "terminalId" in activity.payload &&
          activity.payload.terminalId === terminalId,
      );
      const detail = adopted
        ? "Setup launch was recorded before restart, but its completion cannot be proven. Automatic relaunch is disabled."
        : "Setup launch may have started before restart; automatic relaunch is disabled.";
      yield* repository.markBootstrapStepFailed({
        workItemId: input.intent.workItemId,
        owner: input.owner,
        generation: input.generation,
        step: "setup",
        phase: "uncertain",
        detail,
        at: yield* currentTime(),
      });
      return yield* fail("bootstrap-setup-uncertain", detail, false);
    } else if (setupStep.value === "uncertain") {
      return yield* fail(
        "bootstrap-setup-uncertain",
        operation.value.lastFailureDetail ??
          "Setup delivery is uncertain and cannot be launched again automatically.",
        false,
      );
    } else if (setupStep.value === "failed") {
      return yield* fail(
        "bootstrap-setup-failed",
        operation.value.lastFailureDetail ?? "Setup failed and requires an explicit retry.",
        false,
      );
    } else {
      if (Option.isNone(projectSetupScriptRunner)) {
        return yield* fail(
          "bootstrap-setup-runner-unavailable",
          "The durable setup runner is unavailable in this server environment.",
          false,
        );
      }
      const setupPath =
        worktreePath ??
        thread.worktreePath ??
        bootstrap.prepareWorktree?.projectCwd ??
        resolvedBootstrapCwd;
      if (setupPath === undefined || setupPath === null) {
        return yield* fail(
          "bootstrap-setup-path-missing",
          "The setup script has no durable workspace path.",
          false,
        );
      }
      if (
        !(yield* repository.isClaimCurrent({
          workItemId: input.intent.workItemId,
          owner: input.owner,
          generation: input.generation,
          now: yield* currentTime(),
        }))
      ) {
        return yield* fail(
          "bootstrap-claim-fenced",
          "Bootstrap preparation was stopped before setup launch.",
          false,
        );
      }
      const projectId = bootstrap.createThread?.projectId ?? resolvedBootstrapRequest?.projectId;
      const projectCwd = bootstrap.prepareWorktree?.projectCwd ?? resolvedBootstrapCwd;
      const resultExit = yield* Effect.exit(
        projectSetupScriptRunner.value.runForThread({
          threadId: input.intent.threadId,
          ...(projectId === undefined ? {} : { projectId }),
          ...(projectCwd === undefined ? {} : { projectCwd }),
          worktreePath: setupPath,
          preferredTerminalId: terminalId,
        }),
      );
      if (Exit.isFailure(resultExit)) {
        const setupFailure = Cause.squash(resultExit.cause);
        const failedBeforeLaunch =
          isProjectSetupScriptProjectNotFoundError(setupFailure) ||
          (isProjectSetupScriptOperationError(setupFailure) &&
            setupFailure.operation === "resolveProject");
        const knownCompletedFailure = isProjectSetupScriptCommandError(setupFailure);
        const safeToRetry = failedBeforeLaunch || knownCompletedFailure;
        const detail = knownCompletedFailure
          ? "The setup script completed with a failure."
          : failedBeforeLaunch
            ? "Setup could not start because its project configuration is unavailable."
            : "Setup launch or completion could not be proven.";
        yield* repository.markBootstrapStepFailed({
          workItemId: input.intent.workItemId,
          owner: input.owner,
          generation: input.generation,
          step: "setup",
          phase: safeToRetry ? "failed" : "uncertain",
          detail,
          at: yield* currentTime(),
        });
        return yield* fail(
          safeToRetry ? "bootstrap-setup-failed" : "bootstrap-setup-uncertain",
          detail,
          false,
          setupFailure,
        );
      }
    }
    if (
      !(yield* repository.acknowledgeBootstrapStep({
        workItemId: input.intent.workItemId,
        owner: input.owner,
        generation: input.generation,
        step: "setup",
        at: yield* currentTime(),
      }))
    ) {
      return yield* fail(
        "bootstrap-claim-fenced",
        "Setup preparation completed after the execution claim was fenced.",
        false,
      );
    }
  });

  const assertDurableClaimCurrent = (
    intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent,
    boundary: string,
  ): Effect.Effect<void, DurableExecutionDispatchError> => {
    const owner = intent.claimOwner;
    const repository = Option.getOrNull(durableIntentRepository);
    if (repository === null || owner === null) {
      return Effect.fail(
        new DurableExecutionDispatchError({
          failureType: "execution-claim-missing",
          detail: `Durable execution claim is unavailable at '${boundary}'.`,
          retryable: false,
        }),
      );
    }
    return Effect.gen(function* () {
      const current = yield* repository
        .isClaimCurrent({
          workItemId: intent.workItemId,
          owner,
          generation: intent.claimGeneration,
          now: yield* Effect.map(DateTime.now, DateTime.formatIso),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DurableExecutionDispatchError({
                failureType: "execution-claim-check-failed",
                detail: `Durable execution claim could not be checked at '${boundary}'.`,
                retryable: true,
                cause,
              }),
          ),
        );
      if (!current) {
        return yield* new DurableExecutionDispatchError({
          failureType: "execution-claim-fenced",
          detail: `Durable execution was fenced before '${boundary}'.`,
          retryable: false,
        });
      }
    });
  };

  const dispatchDurableOriginal = Effect.fn("dispatchDurableOriginal")(function* (input: {
    readonly intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent;
    readonly event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
  }) {
    const thread = yield* resolveThread(input.intent.threadId);
    if (!thread) {
      return yield* new DurableExecutionDispatchError({
        failureType: "thread-missing",
        detail: `Thread '${input.intent.threadId}' no longer exists.`,
        retryable: false,
      });
    }
    const snapshot = yield* executionSupervisor.getSnapshot(input.intent.threadId);
    const activeProviderTurnId =
      (snapshot.activity === "active" || snapshot.activity === "blocked") &&
      snapshot.turn?.providerTurnId
        ? snapshot.turn.providerTurnId
        : null;
    if (activeProviderTurnId !== null) {
      const providerInstanceId =
        thread.session?.providerInstanceId ?? input.intent.modelSelection?.instanceId;
      if (providerInstanceId === undefined) {
        return yield* new DurableExecutionDispatchError({
          failureType: "provider-instance-missing",
          detail: "The active turn has no provider instance for busy-message delivery.",
          retryable: false,
        });
      }
      const capabilities = yield* providerService.getCapabilities(providerInstanceId).pipe(
        Effect.mapError(
          (cause) =>
            new DurableExecutionDispatchError({
              failureType: "provider-instance-unavailable",
              detail: String(cause),
              retryable: false,
              cause,
            }),
        ),
      );
      if (capabilities.activeTurnInput === "queue") {
        return {
          providerTurnId: null,
          providerInstanceId,
          deferred: true,
        } as const;
      }
      const message = thread.messages.find((candidate) => candidate.id === input.intent.messageId);
      if (!message || message.role !== "user") {
        return yield* new DurableExecutionDispatchError({
          failureType: "accepted-message-missing",
          detail: `Accepted message '${input.intent.messageId}' is unavailable for steering.`,
          retryable: false,
        });
      }
      const request = yield* buildSendTurnRequestForThread({
        threadId: input.intent.threadId,
        messageText: input.intent.messageText ?? message.text,
        ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
        ...(input.intent.modelSelection === null
          ? {}
          : { modelSelection: input.intent.modelSelection }),
        interactionMode: input.event.payload.interactionMode,
        actorUserId: input.intent.actingUserId ?? thread.ownerUserId,
        messageSenderUserId: input.intent.actingUserId ?? null,
        createdAt: input.event.payload.createdAt,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DurableExecutionDispatchError({
              failureType: "provider-steer-prepare-failed",
              detail: String(cause),
              retryable: true,
              cause,
            }),
        ),
      );
      const executionOptions = yield* resolveSessionExecutionOptions(
        thread,
        "thread.turn.start",
        input.intent.actingUserId ?? null,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DurableExecutionDispatchError({
              failureType: "provider-steer-options-failed",
              detail: String(cause),
              retryable: true,
              cause,
            }),
        ),
      );
      yield* assertDurableClaimCurrent(input.intent, "provider-steer");
      const steered = yield* providerService
        .sendTurn({ ...request, clientExecutionId: input.intent.workItemId }, executionOptions)
        .pipe(
          Effect.mapError(
            (cause) =>
              new DurableExecutionDispatchError({
                failureType: "provider-steer-failed",
                detail: String(cause),
                retryable: true,
                cause,
              }),
          ),
        );
      return {
        providerTurnId: steered.turnId ?? activeProviderTurnId,
        providerInstanceId,
        adoptedExecutionId: snapshot.turn?.executionId ?? input.intent.workItemId,
      };
    }

    const result = yield* processTurnStartRequested(
      input.event,
      undefined,
      assertDurableClaimCurrent(input.intent, "provider-turn-start"),
    ).pipe(
      Effect.mapError((cause) => durableRecoveryFailure(cause, "provider-turn-dispatch-failed")),
    );
    if (result === undefined) {
      return yield* new DurableExecutionDispatchError({
        failureType: "provider-turn-not-acknowledged",
        detail: "Provider turn dispatch completed without a turn acknowledgement.",
        retryable: true,
      });
    }
    return {
      providerTurnId: result.turnId,
      providerInstanceId: input.intent.modelSelection?.instanceId ?? null,
      adoptedExecutionId: input.intent.workItemId,
    };
  });

  const appendDurableRecoveryActivity = Effect.fn("appendDurableRecoveryActivity")(
    function* (input: {
      readonly intent: import("../../execution/DurableExecutionIntentRepository.ts").DurableExecutionIntent;
      readonly kind: "started" | "recovered" | "paused" | "exhausted";
      readonly attempt: number;
      readonly detail?: string;
    }) {
      const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const presentation =
        input.kind === "started"
          ? { tone: "info" as const, summary: "Recovering interrupted agent work" }
          : input.kind === "recovered"
            ? { tone: "info" as const, summary: "Agent work recovered" }
            : input.kind === "paused"
              ? { tone: "approval" as const, summary: "Recovery paused for attention" }
              : { tone: "error" as const, summary: "Automatic recovery exhausted" };
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(
            `durable-recovery:${input.kind}:${input.intent.workItemId}:${input.attempt}`,
          ),
          threadId: input.intent.threadId,
          activity: {
            id: yield* serverEventId(),
            tone: presentation.tone,
            kind: `recovery.${input.kind}`,
            summary: presentation.summary,
            payload: {
              workItemId: input.intent.workItemId,
              attempt: input.attempt,
              maximumAttempts: input.intent.maximumRecoveryAttempts,
              ...(input.detail === undefined ? {} : { detail: input.detail }),
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to append durable recovery activity", {
              threadId: input.intent.threadId,
              workItemId: input.intent.workItemId,
              kind: input.kind,
              attempt: input.attempt,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    },
  );

  // T3-CUSTOM(expbkt3): BEGIN — the coordinator owns every normal/recovery
  // provider turn in production, while this reactor remains the adapter seam.
  const refreshDurablePhaseMetrics = Option.isSome(durableIntentRepository)
    ? Effect.gen(function* () {
        const counts = yield* durableIntentRepository.value.countVisibleByPhase;
        for (const phase of [
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
        ]) {
          yield* setMetric(durableExecutions, { phase }, counts[phase] ?? 0);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to refresh durable execution phase metrics", {
            cause: Cause.pretty(cause),
          }),
        ),
      )
    : Effect.void;
  const durableCoordinator = Option.isSome(durableIntentRepository)
    ? yield* makeDurableExecutionCoordinator({
        ownerId: executionSupervisor.authorityEpoch,
        // T3-CUSTOM(expbkt3): intent phases are part of the execution snapshot stream.
        onTransition: ({ threadId }) =>
          Effect.gen(function* () {
            yield* executionSupervisor.refreshIntent(threadId);
            yield* refreshDurablePhaseMetrics;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to publish durable execution transition", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        onRecoveryActivity: (input) =>
          appendDurableRecoveryActivity(input).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to publish durable recovery activity", {
                threadId: input.intent.threadId,
                workItemId: input.intent.workItemId,
                kind: input.kind,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        terminateObserved: (intent) =>
          providerService.terminateSession({ threadId: intent.threadId }).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to terminate durable execution provider session", {
                threadId: intent.threadId,
                workItemId: intent.workItemId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        loadEvent: (intent) =>
          Stream.runHead(
            orchestrationEngine.readEvents((intent.requestEventSequence ?? 1) - 1, 1),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new DurableExecutionDispatchError({
                  failureType: "persisted-event-unavailable",
                  detail: String(cause),
                  retryable: false,
                  cause,
                }),
            ),
            Effect.flatMap((loaded) => {
              const event = Option.getOrNull(loaded);
              return event?.type === "thread.turn-start-requested"
                ? Effect.succeed(event)
                : Effect.fail(
                    new DurableExecutionDispatchError({
                      failureType: "persisted-event-unavailable",
                      detail: `Turn request event sequence '${intent.requestEventSequence}' is unavailable.`,
                      retryable: false,
                    }),
                  );
            }),
          ),
        prepare: (input) =>
          prepareDurableBootstrap(input).pipe(
            Effect.mapError((cause) =>
              normalizeDurableDispatchError(cause, "bootstrap-preparation-failed"),
            ),
          ),
        dispatchOriginal: (input) =>
          dispatchDurableOriginal(input).pipe(
            Effect.mapError((cause) =>
              normalizeDurableDispatchError(cause, "provider-turn-dispatch-failed"),
            ),
          ),
        recover: ({ intent, event, mode }) =>
          Effect.gen(function* () {
            let effectiveMode = mode;
            const inspection = yield* providerService.inspectSession(intent.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new DurableExecutionDispatchError({
                    failureType: "provider-inspection-failed",
                    detail: String(cause),
                    retryable: true,
                    cause,
                  }),
              ),
            );
            const execution = yield* executionSupervisor.getSnapshot(intent.threadId);
            const activeProviderTurnId = inspection?.activeProviderTurnId ?? null;
            const activeTurnMatches =
              activeProviderTurnId !== null &&
              (activeProviderTurnId === intent.providerTurnId ||
                execution.turn?.executionId === intent.workItemId);
            if (activeTurnMatches) {
              return {
                providerTurnId: activeProviderTurnId,
                providerInstanceId:
                  execution.providerSession.providerInstanceId ??
                  intent.modelSelection?.instanceId ??
                  null,
                adoptedExecutionId: execution.turn?.executionId ?? intent.workItemId,
              };
            }
            if (activeProviderTurnId !== null) {
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-active-turn-mismatch",
                detail: `Provider turn '${activeProviderTurnId}' is active, but it cannot be correlated with work item '${intent.workItemId}'.`,
                retryable: true,
              });
            }
            const thread = yield* resolveThread(intent.threadId);
            if (!thread) {
              return yield* new DurableExecutionDispatchError({
                failureType: "thread-missing",
                detail: `Thread '${intent.threadId}' no longer exists.`,
                retryable: false,
              });
            }
            const providerInstanceId =
              thread.session?.providerInstanceId ?? intent.modelSelection?.instanceId;
            if (providerInstanceId === undefined) {
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-instance-missing",
                detail: "The durable work item no longer resolves to a provider instance.",
                retryable: false,
              });
            }
            const capabilities = yield* providerService.getCapabilities(providerInstanceId).pipe(
              Effect.mapError(
                (cause) =>
                  new DurableExecutionDispatchError({
                    failureType: "provider-instance-unavailable",
                    detail: String(cause),
                    retryable: false,
                    cause,
                  }),
              ),
            );
            const readProviderThread = providerService.readThread;
            if (mode === "inspect-or-continue" && readProviderThread === undefined) {
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-history-unavailable",
                detail: `Provider instance '${providerInstanceId}' cannot inspect persisted history before guarded continuation.`,
                retryable: false,
              });
            }
            if (
              readProviderThread !== undefined &&
              (mode === "inspect-or-continue" || intent.providerTurnId !== null)
            ) {
              const executionOptions = yield* resolveSessionExecutionOptions(
                thread,
                "thread.turn.start",
                undefined,
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new DurableExecutionDispatchError({
                      failureType: "provider-history-options-failed",
                      detail: String(cause),
                      retryable: true,
                      cause,
                    }),
                ),
              );
              yield* assertDurableClaimCurrent(intent, "provider-history-resume");
              const providerHistoryExit = yield* Effect.exit(
                readProviderThread(intent.threadId, executionOptions),
              );
              if (Exit.isFailure(providerHistoryExit)) {
                const cause = Cause.squash(providerHistoryExit.cause);
                if (intent.providerTurnId === null && providerHistoryReadProvesUndelivered(cause)) {
                  effectiveMode = "exact-undelivered";
                } else {
                  return yield* durableRecoveryFailure(cause, "provider-history-read-failed");
                }
              } else if (
                intent.providerTurnId !== null &&
                providerHistoryProvesCompletion(
                  providerHistoryExit.value,
                  TurnId.make(intent.providerTurnId),
                )
              ) {
                return {
                  providerTurnId: intent.providerTurnId,
                  providerInstanceId,
                  completed: true,
                };
              }
            }
            if (
              effectiveMode === "inspect-or-continue" &&
              capabilities.durableResume === "unsupported"
            ) {
              return yield* new DurableExecutionDispatchError({
                failureType: "durable-resume-unsupported",
                detail: `Provider instance '${providerInstanceId}' cannot safely resume uncertain delivery.`,
                retryable: false,
              });
            }
            const messageText =
              effectiveMode === "exact-undelivered"
                ? (intent.messageText ?? "")
                : "Continue the unfinished task from the persisted conversation and current workspace state. Inspect what already completed before acting, and do not repeat completed external actions.";
            if (effectiveMode === "inspect-or-continue") {
              yield* increment(durableExecutionGuardedContinuationsTotal, {
                threadId: intent.threadId,
                workItemId: intent.workItemId,
                providerInstanceId,
              });
            }
            const result = yield* processTurnStartRequested(
              event,
              {
                messageText,
                useOriginalAttachments: effectiveMode === "exact-undelivered",
              },
              assertDurableClaimCurrent(intent, "provider-recovery-turn-start"),
            ).pipe(
              Effect.mapError((cause) =>
                durableRecoveryFailure(cause, "provider-recovery-dispatch-failed"),
              ),
            );
            if (result === undefined) {
              return yield* new DurableExecutionDispatchError({
                failureType: "provider-recovery-not-acknowledged",
                detail: "Guarded recovery completed without provider-turn evidence.",
                retryable: true,
              });
            }
            return {
              providerTurnId: result.turnId,
              providerInstanceId,
              adoptedExecutionId: intent.workItemId,
            };
          }).pipe(
            Effect.mapError((cause) =>
              normalizeDurableDispatchError(cause, "provider-recovery-failed"),
            ),
          ),
      }).pipe(
        Effect.provideService(DurableExecutionIntentRepository, durableIntentRepository.value),
      )
    : null;
  // T3-CUSTOM(expbkt3): END

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        if (durableCoordinator !== null && event.commandId !== null) {
          yield* durableCoordinator.wake(event.commandId);
        } else {
          yield* processTurnStartRequested(event);
        }
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.session-restart-requested":
        if (durableCoordinator !== null && Option.isSome(durableIntentRepository)) {
          // T3-CUSTOM(expbkt3): Retry resets an exhausted work item; it is not
          // a blind provider reconnect and works even when no session remains.
          const items = yield* durableIntentRepository.value.listByThreadId({
            threadId: event.payload.threadId,
          });
          const retried = items.findLast(
            (item) =>
              item.desiredState === "running" &&
              item.phase === "recovering" &&
              item.recoveryAttempts === 0,
          );
          if (retried !== undefined) {
            yield* durableCoordinator.wake(retried.workItemId);
            return;
          }
        }
        yield* processSessionRestartRequested(event);
        if (durableCoordinator !== null) yield* durableCoordinator.runDue;
        return;
      case "thread.archived":
        // T3-CUSTOM(expbkt3): archive fences the durable item transactionally
        // and also terminates any provider process observed after that fence.
        yield* providerService
          .terminateSession({ threadId: event.payload.threadId })
          .pipe(Effect.catchCause(Effect.logWarning), Effect.asVoid);
        return;
      case "thread.session-set":
        if (durableCoordinator !== null) yield* durableCoordinator.runDue;
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const staleProviderSessions = yield* providerSessionRestartSweep.findStaleProviderSessions();
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.session-restart-requested" ||
        event.type === "thread.archived" ||
        event.type === "thread.session-set"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent));

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    // Provider processes die with the server, so any session the projection
    // still calls live is restart debris. Sweeping it here (after the event
    // stream is attached, so the sweep's own dispatches are processed) is
    // what makes a deploy recoverable without user intervention.
    const sweepStaleSessions =
      providerSessionRestartSweep.sweepStaleProviderSessions(staleProviderSessions);
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* clearInterrupted;
      yield* sweepStaleSessions;
    } else {
      yield* forkParked(clearInterrupted);
      yield* forkParked(sweepStaleSessions);
    }
  });

  return {
    start,
    // T3-CUSTOM(expbkt3): startup invokes this after stale-session reconciliation.
    startDurableRecovery: () =>
      durableCoordinator === null
        ? Effect.void
        : refreshDurablePhaseMetrics.pipe(Effect.andThen(durableCoordinator.start())),
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
