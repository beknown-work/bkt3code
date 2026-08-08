/**
 * T3-CUSTOM(expbkt3): Implementation of external-operator and provider-scoped
 * T3 control tools. Capability checks remain local to this dedicated toolkit.
 */
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  OrchestrationProposedPlanId,
  OrchestrationCommand as OrchestrationCommandSchema,
  ProjectId,
  ThreadId,
  UserId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import { withPlannotatorPlanMarker } from "@t3tools/shared/plannotator";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ClerkDirectory } from "../../../auth/ClerkDirectory.ts";
import { ServerConfig } from "../../../config.ts";
import { ThreadExecutionSupervisor } from "../../../execution/ThreadExecutionSupervisor.ts";
import { OrchestrationCommandDispatcher } from "../../../orchestration/dispatchCommand.ts";
import { OrchestrationAccessControl } from "../../../orchestration/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
// T3-CUSTOM(expbkt3): bounded catch-up detail for t3_list_sessions.
import type { ProjectionSessionListDetail } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PlannotatorManager } from "../../../plannotator/PlannotatorManager.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolkit, T3ControlToolError } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommandSchema);

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.max(0, Math.min(value, maximum));
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return "T3 Code could not complete the requested operation.";
}

const mapControlError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, T3ControlToolError, R> =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new T3ControlToolError({
            operation,
            message: errorMessage(cause),
          }),
      ),
    );

const requireCapability = Effect.fn("T3ControlToolkit.requireCapability")(function* (
  operation: string,
  capability: McpInvocationContext.McpCapability,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has(capability)) {
    return yield* new T3ControlToolError({
      operation,
      message: `This MCP credential does not grant ${capability}.`,
    });
  }
  return scope;
});

const requireExternalOperator = Effect.fn("T3ControlToolkit.requireExternalOperator")(function* (
  operation: string,
) {
  const scope = yield* requireCapability(operation, "t3.control");
  if (!McpInvocationContext.isExternalMcpOperator(scope)) {
    return yield* new T3ControlToolError({
      operation,
      message: "This operation requires the Settings-issued external operator credential.",
    });
  }
  return scope;
});

const requireSessionCreator = Effect.fn("T3ControlToolkit.requireSessionCreator")(function* (
  operation: string,
) {
  const scope = yield* requireCapability(operation, "t3.control");
  if (!McpInvocationContext.canCreateMcpSessions(scope)) {
    return yield* new T3ControlToolError({
      operation,
      message:
        "Creating sessions requires an authenticated user-bound provider session, personal external token, or external operator credential.",
    });
  }
  return scope;
});

const hasUserWideScope = (scope: McpInvocationContext.McpInvocationScope): boolean =>
  McpInvocationContext.isExternalMcpOperator(scope) ||
  scope.principal === "external-user" ||
  scope.capabilities.has("t3.session.create");

/**
 * T3-CUSTOM(expbkt3): decide which session a newly created session is filed
 * under.
 *
 * Nesting is the agent's call. A session fanning out cross-repo work wants its
 * children visible as a subtree; a session that incidentally files unrelated
 * work does not, and burying that session inside an unrelated tree is worse
 * than leaving it flat.
 *
 *   createAsChild === false        → root session
 *   parentSessionId given          → that session, after existence + access
 *   caller is a provider session   → the calling session
 *   otherwise                      → root session
 *
 * The principal check is load-bearing independently of the flag: an
 * external-user token's threadId is that user's *conductor* thread, not a
 * session they are working in, so defaulting to it would file every session the
 * user creates under one synthetic root.
 */
const resolveCreatedSessionParent = Effect.fn("T3ControlToolkit.resolveCreatedSessionParent")(
  function* (input: {
    readonly operation: string;
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly projectId: ProjectId }>;
    readonly createAsChild: boolean | undefined;
    readonly parentSessionId: string | undefined;
  }) {
    const { operation, scope } = input;
    // Two ways to say different things about the same field: refuse rather
    // than letting one silently win.
    if (input.parentSessionId !== undefined && input.createAsChild === false) {
      return yield* new T3ControlToolError({
        operation,
        message:
          "createAsChild: false cannot be combined with parentSessionId. Omit parentSessionId to create a top-level session.",
      });
    }
    if (input.createAsChild === false) return null;

    if (input.parentSessionId !== undefined) {
      const requestedParentId = ThreadId.make(input.parentSessionId);
      const parent = input.threads.find((candidate) => candidate.id === requestedParentId);
      // A parent the caller cannot see is reported as absent rather than
      // forbidden, matching how this handler already treats projects.
      const visible =
        parent !== undefined &&
        (McpInvocationContext.isExternalMcpOperator(scope) ||
          scope.actorUserId === null ||
          (yield* (yield* OrchestrationAccessControl)
            .canAccessProject(scope.actorUserId, parent.projectId)
            .pipe(mapControlError(operation))));
      if (!visible) {
        return yield* new T3ControlToolError({
          operation,
          message: `T3 session ${requestedParentId} was not found.`,
        });
      }
      return requestedParentId;
    }

    return scope.principal === "provider-session" ? scope.threadId : null;
  },
);

const resolveConfiguredOwnerUserId = Effect.fn("T3ControlToolkit.resolveConfiguredOwnerUserId")(
  function* (operation: string) {
    const config = yield* ServerConfig;
    const clerkAuth = config.clerkAuth;
    if (clerkAuth === undefined) return null;

    const explicitUserId = clerkAuth.defaultOwnerUserId?.trim();
    if (explicitUserId) return UserId.make(explicitUserId);

    const defaultOwnerEmail = clerkAuth.defaultOwnerEmail?.trim();
    if (defaultOwnerEmail) {
      const clerkDirectory = yield* ClerkDirectory;
      const resolved = yield* clerkDirectory
        .findUserIdByEmail(defaultOwnerEmail)
        .pipe(mapControlError(operation));
      if (resolved !== null) return resolved;
    }

    return yield* new T3ControlToolError({
      operation,
      message:
        "Team mode requires a resolvable T3CODE_DEFAULT_OWNER_USER_ID or T3CODE_DEFAULT_OWNER_EMAIL before external MCP can create projects or ownerless sessions.",
    });
  },
);

const resolveSessionId = Effect.fn("T3ControlToolkit.resolveSessionId")(function* (
  operation: string,
  requested: ThreadId | undefined,
  capability: "t3.read" | "t3.control" | "t3.plan" = "t3.read",
) {
  const scope = yield* requireCapability(operation, capability);
  if (hasUserWideScope(scope)) {
    if (requested === undefined) {
      return yield* new T3ControlToolError({
        operation,
        message: "sessionId is required for a user-wide MCP call.",
      });
    }
    if (!McpInvocationContext.isExternalMcpOperator(scope) && scope.actorUserId !== null) {
      const accessControl = yield* OrchestrationAccessControl;
      const allowed = yield* accessControl
        .canAccessThread(scope.actorUserId, requested)
        .pipe(mapControlError(operation));
      if (!allowed) {
        return yield* new T3ControlToolError({
          operation,
          message: `T3 session ${requested} was not found.`,
        });
      }
    }
    return requested;
  }
  if (requested !== undefined && requested !== scope.threadId) {
    return yield* new T3ControlToolError({
      operation,
      message: "An in-session agent may only control its own T3 session.",
    });
  }
  return scope.threadId;
});

function attentionReasons(
  thread: OrchestrationThreadShell | OrchestrationThread,
  execution: ThreadExecutionSnapshot,
): ReadonlyArray<string> {
  const reasons: Array<string> = [];
  if (
    ("hasPendingApprovals" in thread && thread.hasPendingApprovals) ||
    execution.turn?.state === "waiting-for-approval"
  ) {
    reasons.push("approval");
  }
  if (
    ("hasPendingUserInput" in thread && thread.hasPendingUserInput) ||
    execution.turn?.state === "waiting-for-input"
  ) {
    reasons.push("user-input");
  }
  if (
    ("hasActionableProposedPlan" in thread && thread.hasActionableProposedPlan) ||
    ("proposedPlans" in thread && thread.proposedPlans.some((plan) => plan.implementedAt === null))
  ) {
    reasons.push("proposed-plan");
  }
  if (execution.activity === "failed" || thread.session?.status === "error")
    reasons.push("failure");
  return reasons;
}

// T3-CUSTOM(expbkt3): list summaries consume narrow catch-up detail, not full threads.
function sessionSummary(
  thread: OrchestrationThreadShell,
  execution: ThreadExecutionSnapshot,
  project:
    | {
        readonly id: string;
        readonly title: string;
        readonly workspaceRoot: string;
      }
    | undefined,
  detail: ProjectionSessionListDetail | undefined,
) {
  const reasons = attentionReasons(thread, execution);
  return {
    sessionId: thread.id,
    title: thread.title,
    project: project ?? null,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    archivedAt: thread.archivedAt,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil ?? null,
    // T3-CUSTOM(expbkt3): session priority (0 = P0 highest, null = unset).
    priority: thread.priority ?? null,
    // T3-CUSTOM(expbkt3): session lineage. Lets an agent inspect its own
    // subtree instead of re-spawning work it already delegated.
    parentSessionId: thread.parentThreadId ?? null,
    session: thread.session,
    execution,
    needsHumanAttention: reasons.length > 0,
    humanAttentionReasons: reasons,
    catchup: {
      rollingSummary: detail?.rollingSummary ?? null,
      latestTurnSummary: detail?.latestTurnSummary ?? null,
    },
    latestTurn: thread.latestTurn,
    updatedAt: thread.updatedAt,
  };
}

function htmlPlanSummary(content: string): string {
  const heading =
    content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
    "HTML plan";
  const title = heading
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `# ${title || "HTML plan"}\n\nThis plan was submitted as HTML. Open the Plannotator review to inspect and annotate the full document.`;
}

function redactMcpConfiguration(settings: Parameters<typeof redactServerSettingsForClient>[0]) {
  const redacted = redactServerSettingsForClient(settings);
  return {
    ...redacted,
    experimental: {
      ...redacted.experimental,
      externalMcp: {
        ...redacted.experimental.externalMcp,
        apiKey: "",
        apiKeyConfigured: redacted.experimental.externalMcp.apiKey.length >= 24,
      },
    },
  };
}

const makeCommandId = (crypto: Crypto.Crypto, operation: string) =>
  crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => CommandId.make(`mcp:${operation}:${uuid}`)),
    mapControlError(operation),
  );

const makeMessageId = (crypto: Crypto.Crypto, operation: string) =>
  crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => MessageId.make(`mcp:${uuid}`)),
    mapControlError(operation),
  );

const handlers = {
  t3_list_sessions: Effect.fn("T3ControlToolkit.listSessions")(function* (input) {
    const operation = "list-sessions";
    const scope = yield* requireCapability(operation, "t3.read");
    const query = yield* ProjectionSnapshotQuery;
    const executionSupervisor = yield* ThreadExecutionSupervisor;
    // T3-CUSTOM(expbkt3): never materialize full message/activity history for session lists.
    const shell = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const archived =
      input.includeArchived === true && hasUserWideScope(scope)
        ? yield* query.getArchivedShellSnapshot().pipe(mapControlError(operation))
        : null;
    const threads = [...shell.threads, ...(archived?.threads ?? [])].filter(
      (thread) =>
        McpInvocationContext.isExternalMcpOperator(scope) ||
        (scope.actorUserId !== null
          ? thread.ownerUserId === scope.actorUserId ||
            thread.memberUserIds.includes(scope.actorUserId)
          : thread.id === scope.threadId),
    );
    const executions = yield* executionSupervisor.getSnapshots(threads.map((thread) => thread.id));
    const projects = new Map(
      [...shell.projects, ...(archived?.projects ?? [])].map((project) => [
        project.id,
        {
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        },
      ]),
    );
    // T3-CUSTOM(expbkt3): cap first, then bulk-read only catch-up fields for returned sessions.
    const selected = threads
      .map((thread) => ({
        thread,
        execution:
          executions.get(thread.id) ??
          ({
            threadId: thread.id,
            authorityEpoch: "unavailable",
            revision: 0,
            observedAt: thread.updatedAt,
            activity: "idle",
            canStop: false,
            providerSession: {
              state: "absent",
              generation: 0,
              providerInstanceId: null,
              startedAt: null,
              lastObservedAt: null,
              lastError: null,
            },
            turn: null,
          } satisfies ThreadExecutionSnapshot),
      }))
      .filter(
        ({ thread, execution }) =>
          input.attentionOnly !== true || attentionReasons(thread, execution).length > 0,
      )
      .sort((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt))
      .slice(0, boundedLimit(input.limit, 100, 500));
    const details = new Map(
      (yield* query
        .getSessionListDetails(selected.map(({ thread }) => thread.id))
        .pipe(mapControlError(operation))).map((detail) => [detail.threadId, detail]),
    );
    const summaries = selected.map(({ thread, execution }) =>
      sessionSummary(thread, execution, projects.get(thread.projectId), details.get(thread.id)),
    );
    return {
      totals: {
        returned: summaries.length,
        attention: summaries.filter((session) => session.needsHumanAttention).length,
        running: summaries.filter(
          (session) =>
            session.execution.activity === "active" ||
            session.execution.activity === "blocked" ||
            session.execution.activity === "stopping",
        ).length,
      },
      sessions: summaries,
    };
  }),

  t3_get_session: Effect.fn("T3ControlToolkit.getSession")(function* (input) {
    const operation = "get-session";
    const sessionId = yield* resolveSessionId(operation, input.sessionId);
    const query = yield* ProjectionSnapshotQuery;
    const executionSupervisor = yield* ThreadExecutionSupervisor;
    const loaded = yield* query.getThreadDetailSnapshot(sessionId).pipe(mapControlError(operation));
    if (Option.isNone(loaded)) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 session ${sessionId} was not found.`,
      });
    }
    const thread = loaded.value.thread;
    const execution = yield* executionSupervisor.getSnapshot(sessionId);
    const messageLimit = boundedLimit(input.messageLimit, 30, 200);
    const activityLimit = boundedLimit(input.activityLimit, 50, 300);
    return {
      snapshotSequence: loaded.value.snapshotSequence,
      thread: {
        ...thread,
        messages: thread.messages.slice(-messageLimit),
        activities: thread.activities.slice(-activityLimit),
      },
      execution,
      humanAttentionReasons: attentionReasons(thread, execution),
      // T3-CUSTOM(expbkt3): bulk session manager work summary, hoisted to the
      // top level so an agent reading a session does not have to know it lives
      // on the thread object. Null when one was never requested.
      workSummary: thread.workSummary ?? null,
    };
  }),

  t3_list_projects: Effect.fn("T3ControlToolkit.listProjects")(function* (input) {
    const operation = "list-projects";
    const scope = yield* requireCapability(operation, "t3.read");
    const query = yield* ProjectionSnapshotQuery;
    const snapshot = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const archived =
      input.includeArchived === true && hasUserWideScope(scope)
        ? yield* query.getArchivedShellSnapshot().pipe(mapControlError(operation))
        : null;
    const actorUserId = scope.actorUserId;
    const activeCounts = new Map<string, number>();
    for (const thread of snapshot.threads) {
      activeCounts.set(thread.projectId, (activeCounts.get(thread.projectId) ?? 0) + 1);
    }
    const projects = new Map(
      [...snapshot.projects, ...(archived?.projects ?? [])]
        .filter(
          (project) =>
            McpInvocationContext.isExternalMcpOperator(scope) ||
            (actorUserId !== null
              ? project.ownerUserId === actorUserId ||
                project.memberUserIds.includes(actorUserId) ||
                snapshot.threads.some(
                  (thread) =>
                    thread.projectId === project.id &&
                    (thread.ownerUserId === actorUserId ||
                      thread.memberUserIds.includes(actorUserId)),
                )
              : snapshot.threads.some(
                  (thread) => thread.id === scope.threadId && thread.projectId === project.id,
                )),
        )
        .map((project) => [project.id, project]),
    );
    return {
      projects: [...projects.values()].map((project) => ({
        ...project,
        activeSessionCount: activeCounts.get(project.id) ?? 0,
      })),
    };
  }),

  t3_get_configuration: Effect.fn("T3ControlToolkit.getConfiguration")(function* (input) {
    const operation = "get-configuration";
    yield* requireCapability(operation, "t3.read");
    const settingsService = yield* ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry;
    const [settings, providers] = yield* Effect.all([
      settingsService.getSettings,
      input.refreshProviders === true ? providerRegistry.refresh() : providerRegistry.getProviders,
    ]).pipe(mapControlError(operation));
    return {
      settings: redactMcpConfiguration(settings),
      providers,
      guidance: {
        modelSelection:
          "Use a provider instanceId and one of that provider's model slugs. Include only supported option selections.",
        runtimeMode: "Use t3_update_session or t3_send_prompt to select a runtime/sandbox mode.",
        interactionMode: "Use plan for planning-only turns and default for implementation turns.",
      },
    };
  }),

  t3_send_prompt: Effect.fn("T3ControlToolkit.sendPrompt")(function* (input) {
    const operation = "send-prompt";
    const scope = yield* requireCapability(operation, "t3.control");
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const loaded = yield* query.getThreadDetailById(sessionId).pipe(mapControlError(operation));
    if (Option.isNone(loaded)) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 session ${sessionId} was not found.`,
      });
    }
    const thread = loaded.value;
    const [commandId, messageId, createdAt] = yield* Effect.all([
      makeCommandId(crypto, operation),
      makeMessageId(crypto, operation),
      nowIso,
    ]);
    const result = yield* dispatcher
      .dispatch(
        {
          type: "thread.turn.start",
          commandId,
          threadId: sessionId,
          message: {
            messageId,
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: input.modelSelection ?? thread.modelSelection,
          runtimeMode: input.runtimeMode ?? thread.runtimeMode,
          interactionMode: input.interactionMode ?? thread.interactionMode,
          createdAt,
        },
        { actorUserId: scope.actorUserId },
      )
      .pipe(mapControlError(operation));
    return { accepted: true, sequence: result.sequence, sessionId, messageId, createdAt };
  }),

  t3_update_session: Effect.fn("T3ControlToolkit.updateSession")(function* (input) {
    const operation = "update-session";
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const createdAt = yield* nowIso;
    const results: Array<{ readonly type: string; readonly sequence: number }> = [];

    if (
      input.title !== undefined ||
      input.modelSelection !== undefined ||
      input.branch !== undefined ||
      // T3-CUSTOM(expbkt3): session priority.
      input.priority !== undefined
    ) {
      const commandId = yield* makeCommandId(crypto, operation);
      const result = yield* dispatcher
        .dispatch({
          type: "thread.meta.update",
          commandId,
          threadId: sessionId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          // T3-CUSTOM(expbkt3): undefined leaves priority unchanged; null clears it.
          ...(input.priority === undefined ? {} : { priority: input.priority }),
        })
        .pipe(mapControlError(operation));
      results.push({ type: "thread.meta.update", sequence: result.sequence });
    }
    if (input.runtimeMode !== undefined) {
      const commandId = yield* makeCommandId(crypto, operation);
      const result = yield* dispatcher
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId,
          threadId: sessionId,
          runtimeMode: input.runtimeMode,
          createdAt,
        })
        .pipe(mapControlError(operation));
      results.push({ type: "thread.runtime-mode.set", sequence: result.sequence });
    }
    if (input.interactionMode !== undefined) {
      const commandId = yield* makeCommandId(crypto, operation);
      const result = yield* dispatcher
        .dispatch({
          type: "thread.interaction-mode.set",
          commandId,
          threadId: sessionId,
          interactionMode: input.interactionMode,
          createdAt,
        })
        .pipe(mapControlError(operation));
      results.push({ type: "thread.interaction-mode.set", sequence: result.sequence });
    }
    if (results.length === 0) {
      return yield* new T3ControlToolError({
        operation,
        message: "Provide at least one session field to update.",
      });
    }
    return { updated: true, sessionId, commands: results };
  }),

  t3_update_server_settings: Effect.fn("T3ControlToolkit.updateServerSettings")(function* (input) {
    const operation = "update-server-settings";
    yield* requireExternalOperator(operation);
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService
      .updateSettings(input.patch)
      .pipe(mapControlError(operation));
    return {
      updated: true,
      settings: redactMcpConfiguration(settings),
      warning:
        "If this patch rotated or disabled external MCP access, use the newly configured credential for future calls.",
    };
  }),

  t3_session_action: Effect.fn("T3ControlToolkit.sessionAction")(function* (input) {
    const operation = `session-${input.action}`;
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const [commandId, createdAt] = yield* Effect.all([makeCommandId(crypto, operation), nowIso]);
    let command: OrchestrationCommand;
    switch (input.action) {
      case "interrupt":
        command = {
          type: "thread.turn.interrupt",
          commandId,
          threadId: sessionId,
          createdAt,
        };
        break;
      case "stop":
        command = {
          type: "thread.session.stop",
          commandId,
          threadId: sessionId,
          createdAt,
        };
        break;
      case "restart":
        command = {
          type: "thread.session.restart",
          commandId,
          threadId: sessionId,
          createdAt,
        };
        break;
      case "archive":
        command = { type: "thread.archive", commandId, threadId: sessionId };
        break;
      case "unarchive":
        command = { type: "thread.unarchive", commandId, threadId: sessionId };
        break;
      case "settle":
        command = { type: "thread.settle", commandId, threadId: sessionId };
        break;
      case "activate":
        command = {
          type: "thread.unsettle",
          commandId,
          threadId: sessionId,
          reason: "user",
        };
        break;
      case "snooze":
        if (input.snoozedUntil === undefined) {
          return yield* new T3ControlToolError({
            operation,
            message: "snoozedUntil is required for the snooze action.",
          });
        }
        command = {
          type: "thread.snooze",
          commandId,
          threadId: sessionId,
          snoozedUntil: input.snoozedUntil,
        };
        break;
      case "unsnooze":
        command = {
          type: "thread.unsnooze",
          commandId,
          threadId: sessionId,
          reason: "user",
        };
        break;
      case "delete":
        command = { type: "thread.delete", commandId, threadId: sessionId };
        break;
      case "request-catchup": {
        const thread = yield* query.getThreadDetailById(sessionId).pipe(mapControlError(operation));
        const turnId = Option.getOrNull(thread)?.latestTurn?.turnId;
        if (turnId === null || turnId === undefined) {
          return yield* new T3ControlToolError({
            operation,
            message: "This session has no turn to summarize.",
          });
        }
        command = {
          type: "thread.catchup-summary.request",
          commandId,
          threadId: sessionId,
          turnId,
          createdAt,
        };
        break;
      }
      // T3-CUSTOM(expbkt3): bulk session manager work summary. Unlike catch-up,
      // this summarizes the whole session, so it needs no turn to anchor to and
      // works on a session that has never completed a turn.
      case "request-work-summary":
        command = {
          type: "thread.work-summary.request",
          commandId,
          threadId: sessionId,
          createdAt,
        };
        break;
    }
    const result = yield* dispatcher.dispatch(command).pipe(mapControlError(operation));
    return { accepted: true, action: input.action, sessionId, sequence: result.sequence };
  }),

  t3_respond_approval: Effect.fn("T3ControlToolkit.respondApproval")(function* (input) {
    const operation = "respond-approval";
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const [commandId, createdAt] = yield* Effect.all([makeCommandId(crypto, operation), nowIso]);
    const result = yield* dispatcher
      .dispatch({
        type: "thread.approval.respond",
        commandId,
        threadId: sessionId,
        requestId: ApprovalRequestId.make(input.requestId),
        decision: input.decision,
        createdAt,
      })
      .pipe(mapControlError(operation));
    return { accepted: true, sessionId, requestId: input.requestId, sequence: result.sequence };
  }),

  t3_respond_user_input: Effect.fn("T3ControlToolkit.respondUserInput")(function* (input) {
    const operation = "respond-user-input";
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.control");
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const [commandId, createdAt] = yield* Effect.all([makeCommandId(crypto, operation), nowIso]);
    const result = yield* dispatcher
      .dispatch({
        type: "thread.user-input.respond",
        commandId,
        threadId: sessionId,
        requestId: ApprovalRequestId.make(input.requestId),
        answers: input.answers,
        createdAt,
      })
      .pipe(mapControlError(operation));
    return { accepted: true, sessionId, requestId: input.requestId, sequence: result.sequence };
  }),

  t3_create_project: Effect.fn("T3ControlToolkit.createProject")(function* (input) {
    const operation = "create-project";
    yield* requireExternalOperator(operation);
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const workspaceRoot = yield* workspacePaths
      .normalizeWorkspaceRoot(input.workspaceRoot, {
        createIfMissing: input.createWorkspaceRootIfMissing === true,
      })
      .pipe(mapControlError(operation));
    const shell = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const existing = shell.projects.find((project) => project.workspaceRoot === workspaceRoot);
    if (existing) {
      return {
        created: false,
        project: existing,
        guidance: "This workspace is already registered. Use its id with t3_create_session.",
      };
    }

    const uuid = yield* crypto.randomUUIDv4.pipe(mapControlError(operation));
    const projectId = ProjectId.make(`mcp-project:${uuid}`);
    const commandId = yield* makeCommandId(crypto, operation);
    const createdAt = yield* nowIso;
    const title = input.title?.trim() || path.basename(workspaceRoot) || "New MCP project";
    const ownerUserId = yield* resolveConfiguredOwnerUserId(operation);
    const result = yield* dispatcher
      .dispatch(
        {
          type: "project.create",
          commandId,
          projectId,
          title,
          workspaceRoot,
          createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing === true,
          defaultModelSelection: input.defaultModelSelection ?? null,
          ...(input.threadCreationDefaults
            ? { threadCreationDefaults: input.threadCreationDefaults }
            : {}),
          createdAt,
        },
        { actorUserId: ownerUserId },
      )
      .pipe(mapControlError(operation));
    return {
      created: true,
      project: {
        id: projectId,
        title,
        workspaceRoot,
        defaultModelSelection: input.defaultModelSelection ?? null,
        threadCreationDefaults: input.threadCreationDefaults ?? {
          environmentMode: null,
          worktreeBaseRef: null,
          runtimeMode: null,
          interactionMode: null,
        },
      },
      sequence: result.sequence,
      guidance: "Use this project id with t3_create_session.",
    };
  }),

  t3_update_project: Effect.fn("T3ControlToolkit.updateProject")(function* (input) {
    const operation = "update-project";
    yield* requireExternalOperator(operation);
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const projectId = ProjectId.make(input.projectId);
    const shell = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const project = shell.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 project ${projectId} was not found.`,
      });
    }
    if (
      input.title === undefined &&
      input.defaultModelSelection === undefined &&
      input.threadCreationDefaults === undefined &&
      input.scripts === undefined
    ) {
      return yield* new T3ControlToolError({
        operation,
        message: "Provide at least one project field to update.",
      });
    }
    const commandId = yield* makeCommandId(crypto, operation);
    const result = yield* dispatcher
      .dispatch({
        type: "project.meta.update",
        commandId,
        projectId,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.defaultModelSelection !== undefined
          ? { defaultModelSelection: input.defaultModelSelection }
          : {}),
        ...(input.threadCreationDefaults !== undefined
          ? { threadCreationDefaults: input.threadCreationDefaults }
          : {}),
        ...(input.scripts !== undefined ? { scripts: input.scripts } : {}),
      })
      .pipe(mapControlError(operation));
    return {
      updated: true,
      projectId,
      sequence: result.sequence,
      defaults: {
        defaultModelSelection:
          input.defaultModelSelection === undefined
            ? project.defaultModelSelection
            : input.defaultModelSelection,
        threadCreationDefaults: input.threadCreationDefaults ?? project.threadCreationDefaults,
      },
    };
  }),

  // T3-CUSTOM(expbkt3): BEGIN — session lineage, editable after creation so an
  // agent can reorganise a workspace it did not lay out itself.
  t3_link_session: Effect.fn("T3ControlToolkit.linkSession")(function* (input) {
    const operation = "link-session";
    const sessionId = yield* resolveSessionId(
      operation,
      ThreadId.make(input.sessionId),
      "t3.control",
    );
    // Read access is the right bar for the parent: the caller is not changing
    // it, only pointing at it. resolveSessionId reports an inaccessible session
    // as absent, so this leaks nothing.
    const parentSessionId = yield* resolveSessionId(
      operation,
      ThreadId.make(input.parentSessionId),
      "t3.read",
    );
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* makeCommandId(crypto, operation);
    // The decider owns the tree invariant, so a cycle fails here with its
    // message rather than being re-derived (and drifting) in this handler.
    const result = yield* dispatcher
      .dispatch({
        type: "thread.meta.update",
        commandId,
        threadId: sessionId,
        parentThreadId: parentSessionId,
      })
      .pipe(mapControlError(operation));
    return { linked: true, sessionId, parentSessionId, sequence: result.sequence };
  }),

  t3_unlink_session: Effect.fn("T3ControlToolkit.unlinkSession")(function* (input) {
    const operation = "unlink-session";
    const sessionId = yield* resolveSessionId(
      operation,
      ThreadId.make(input.sessionId),
      "t3.control",
    );
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* makeCommandId(crypto, operation);
    const result = yield* dispatcher
      .dispatch({
        type: "thread.meta.update",
        commandId,
        threadId: sessionId,
        parentThreadId: null,
      })
      .pipe(mapControlError(operation));
    return { unlinked: true, sessionId, parentSessionId: null, sequence: result.sequence };
  }),
  // T3-CUSTOM(expbkt3): END

  t3_create_session: Effect.fn("T3ControlToolkit.createSession")(function* (input) {
    const operation = "create-session";
    const scope = yield* requireSessionCreator(operation);
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const crypto = yield* Crypto.Crypto;
    const shell = yield* query.getShellSnapshot().pipe(mapControlError(operation));
    const projectId = ProjectId.make(input.projectId);
    const project = shell.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 project ${projectId} was not found.`,
      });
    }
    if (!McpInvocationContext.isExternalMcpOperator(scope) && scope.actorUserId !== null) {
      const accessControl = yield* OrchestrationAccessControl;
      const allowed = yield* accessControl
        .canAccessProject(scope.actorUserId, projectId)
        .pipe(mapControlError(operation));
      if (!allowed) {
        return yield* new T3ControlToolError({
          operation,
          message: `T3 project ${projectId} was not found.`,
        });
      }
    }
    // T3-CUSTOM(expbkt3): session lineage.
    const parentThreadId = yield* resolveCreatedSessionParent({
      operation,
      scope,
      threads: shell.threads,
      createAsChild: input.createAsChild,
      parentSessionId: input.parentSessionId,
    });
    const uuid = yield* crypto.randomUUIDv4.pipe(mapControlError(operation));
    const sessionId = ThreadId.make(`mcp:${uuid}`);
    const ownerUserId =
      scope.actorUserId ?? project.ownerUserId ?? (yield* resolveConfiguredOwnerUserId(operation));
    const title =
      input.title?.trim() ||
      input.prompt?.trim().split(/\s+/).slice(0, 10).join(" ").slice(0, 80) ||
      "New MCP session";
    const createdAt = yield* nowIso;
    const [commandId, bootstrapUuid] = yield* Effect.all([
      makeCommandId(crypto, operation),
      crypto.randomUUIDv4.pipe(mapControlError(operation)),
    ]);
    const prompt = input.prompt?.trim();
    const messageId = prompt ? yield* makeMessageId(crypto, operation) : null;
    const workspace =
      input.workspace ??
      (input.worktreePath
        ? {
            mode: "existing-worktree" as const,
            path: input.worktreePath,
            ...(input.branch ? { branch: input.branch } : {}),
          }
        : input.branch
          ? {
              mode: "existing-worktree" as const,
              path: project.workspaceRoot,
              branch: input.branch,
            }
          : undefined);
    const hasOverrides =
      input.modelSelection !== undefined ||
      input.runtimeMode !== undefined ||
      input.interactionMode !== undefined ||
      workspace !== undefined;
    const bootstrapRequest = {
      createThread: true,
      bootstrapId: `mcp-bootstrap:${bootstrapUuid}`,
      projectId,
      title,
      ...(hasOverrides
        ? {
            overrides: {
              ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
              ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
              ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
              ...(workspace ? { workspace } : {}),
            },
          }
        : {}),
      sourceControlProfileId: null,
      priority: input.priority ?? null,
      // T3-CUSTOM(expbkt3): session lineage.
      parentThreadId,
      ...(ownerUserId ? { ownerUserId } : {}),
      createdAt,
    } as const;
    const result = yield* dispatcher
      .dispatch(
        messageId && prompt
          ? {
              type: "thread.turn.start",
              commandId,
              threadId: sessionId,
              message: {
                messageId,
                role: "user",
                text: prompt,
                attachments: [],
              },
              runtimeMode: input.runtimeMode ?? "full-access",
              interactionMode: input.interactionMode ?? "default",
              bootstrap: { request: bootstrapRequest },
              createdAt,
            }
          : {
              type: "thread.bootstrap.request",
              commandId,
              bootstrapId: bootstrapRequest.bootstrapId,
              threadId: sessionId,
              projectId,
              title,
              ...(bootstrapRequest.overrides ? { overrides: bootstrapRequest.overrides } : {}),
              sourceControlProfileId: null,
              priority: bootstrapRequest.priority,
              // T3-CUSTOM(expbkt3): session lineage.
              parentThreadId: bootstrapRequest.parentThreadId,
              ...(ownerUserId ? { ownerUserId } : {}),
              createdAt,
            },
        { actorUserId: ownerUserId },
      )
      .pipe(mapControlError(operation));
    return {
      created: true,
      // T3-CUSTOM(expbkt3): the prompt is durable but remains gated by setup.
      started: false,
      initialTurnQueued: messageId !== null,
      sessionId,
      threadId: sessionId,
      bootstrapId: `mcp-bootstrap:${bootstrapUuid}`,
      bootstrapStatus: "queued",
      ...(messageId ? { messageId } : {}),
      sequence: result.sequence,
    };
  }),

  t3_submit_plan: Effect.fn("T3ControlToolkit.submitPlan")(function* (input) {
    const operation = "submit-plan";
    const sessionId = yield* resolveSessionId(operation, input.sessionId, "t3.plan");
    const query = yield* ProjectionSnapshotQuery;
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const manager = yield* PlannotatorManager;
    const crypto = yield* Crypto.Crypto;
    const thread = yield* query.getThreadDetailById(sessionId).pipe(mapControlError(operation));
    if (Option.isNone(thread)) {
      return yield* new T3ControlToolError({
        operation,
        message: `T3 session ${sessionId} was not found.`,
      });
    }
    const [uuid, commandId, createdAt] = yield* Effect.all([
      crypto.randomUUIDv4.pipe(mapControlError(operation)),
      makeCommandId(crypto, operation),
      nowIso,
    ]);
    const planId = OrchestrationProposedPlanId.make(`plannotator:${uuid}`);
    const review = yield* manager
      .start({
        threadId: sessionId,
        planId,
        format: input.format,
        content: input.content,
      })
      .pipe(mapControlError(operation));
    const planMarkdown = withPlannotatorPlanMarker(
      input.format === "md" ? input.content : htmlPlanSummary(input.content),
      review.proxyPath,
    );
    const result = yield* dispatcher
      .dispatch({
        type: "thread.proposed-plan.upsert",
        commandId,
        threadId: sessionId,
        proposedPlan: {
          id: planId,
          turnId: thread.value.latestTurn?.turnId ?? null,
          planMarkdown,
          implementedAt: null,
          implementationThreadId: null,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.tapError(() => manager.discard(review.id)),
        mapControlError(operation),
      );
    return {
      accepted: true,
      sessionId,
      planId,
      plannotatorSession: review,
      openInT3: review.proxyPath,
      sequence: result.sequence,
      workflow: {
        annotations: "start a new plan-mode revision turn in this T3 session",
        approval: "starts a default-mode implementation turn linked to this proposed plan",
        denial: "records a declined review without starting implementation",
      },
    };
  }),

  t3_list_plannotator_reviews: Effect.fn("T3ControlToolkit.listPlannotatorReviews")(
    function* (input) {
      const operation = "list-plannotator-reviews";
      const scope = yield* requireCapability(operation, "t3.read");
      const manager = yield* PlannotatorManager;
      let filterSessionId: ThreadId | undefined;
      if (hasUserWideScope(scope)) {
        filterSessionId = input.sessionId;
        if (
          filterSessionId !== undefined &&
          !McpInvocationContext.isExternalMcpOperator(scope) &&
          scope.actorUserId !== null
        ) {
          const accessControl = yield* OrchestrationAccessControl;
          const allowed = yield* accessControl
            .canAccessThread(scope.actorUserId, filterSessionId)
            .pipe(mapControlError(operation));
          if (!allowed) {
            return yield* new T3ControlToolError({
              operation,
              message: `T3 session ${filterSessionId} was not found.`,
            });
          }
        }
      } else {
        if (input.sessionId !== undefined && input.sessionId !== scope.threadId) {
          return yield* new T3ControlToolError({
            operation,
            message: "An in-session agent may only inspect its own Plannotator reviews.",
          });
        }
        filterSessionId = scope.threadId;
      }
      const reviews = yield* manager.list(filterSessionId);
      const filtered =
        input.plannotatorSessionId === undefined
          ? reviews
          : reviews.filter((review) => review.id === input.plannotatorSessionId);
      return {
        reviews: filtered,
        totals: {
          reviews: filtered.length,
          waiting: filtered.filter(
            (review) => review.status === "starting" || review.status === "running",
          ).length,
          decided: filtered.filter(
            (review) =>
              review.status === "approved" ||
              review.status === "feedback" ||
              review.status === "denied",
          ).length,
        },
      };
    },
  ),

  t3_dispatch_command: Effect.fn("T3ControlToolkit.dispatchCommand")(function* (input) {
    const operation = "dispatch-command";
    yield* requireExternalOperator(operation);
    const dispatcher = yield* OrchestrationCommandDispatcher;
    const command = yield* decodeOrchestrationCommand(input.command).pipe(
      mapControlError(operation),
    );
    const result = yield* dispatcher.dispatch(command).pipe(mapControlError(operation));
    return { accepted: true, commandType: command.type, sequence: result.sequence };
  }),
} satisfies Parameters<typeof T3ControlToolkit.toLayer>[0];

export const T3ControlToolkitHandlersLive = T3ControlToolkit.toLayer(handlers);

/** Exposed for focused authorization tests. */
export const __testing = {
  resolveSessionId,
  // T3-CUSTOM(expbkt3): caller-seam regression for bounded session list reads.
  listSessions: handlers.t3_list_sessions,
  // T3-CUSTOM(expbkt3): session lineage resolution for created sessions.
  resolveCreatedSessionParent,
};
