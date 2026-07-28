import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ThreadTurnAdmissionConflictError,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadExecutionSupervisor } from "../execution/ThreadExecutionSupervisor.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isThreadTurnAdmissionConflictError = Schema.is(ThreadTurnAdmissionConflictError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function setupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function setupFailureDetail(error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return setupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

function toDispatchCommandError(cause: unknown, fallbackMessage: string) {
  return isOrchestrationDispatchCommandError(cause)
    ? cause
    : new OrchestrationDispatchCommandError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        cause,
      });
}

function toDispatchError(cause: unknown, fallbackMessage: string) {
  return isThreadTurnAdmissionConflictError(cause)
    ? cause
    : toDispatchCommandError(cause, fallbackMessage);
}

/**
 * Dispatch an orchestration command through the server command gate.
 *
 * Bootstrap turn starts are expanded here so HTTP and WebSocket callers share
 * the same thread creation, worktree preparation, setup-script, and cleanup
 * semantics.
 */
export class OrchestrationCommandDispatcher extends Context.Service<
  OrchestrationCommandDispatcher,
  {
    readonly dispatch: (
      command: OrchestrationCommand,
      options?: { readonly actorUserId?: UserId | null },
    ) => Effect.Effect<
      { readonly sequence: number },
      OrchestrationDispatchCommandError | ThreadTurnAdmissionConflictError
    >;
  }
>()("t3/orchestration/dispatchCommand/OrchestrationCommandDispatcher") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const executionSupervisor = yield* ThreadExecutionSupervisor;

  const dispatch = Effect.fn("OrchestrationCommandDispatcher.dispatch")(function* (
    command: OrchestrationCommand,
    options?: { readonly actorUserId?: UserId | null },
  ) {
    // The operating Clerk user (team mode), threaded into every produced event's
    // metadata and into the owner of any thread this command creates — including
    // the internal thread.create issued during bootstrap turn-starts.
    const actorUserId = options?.actorUserId ?? null;
    const dispatchOptions = { actorUserId };
    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
      ),
    );
    const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
    const serverCommandId = (tag: string) =>
      randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

    const appendSetupScriptActivity = Effect.fn("appendSetupScriptActivity")(function* (input: {
      readonly threadId: ThreadId;
      readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
      readonly summary: string;
      readonly createdAt: string;
      readonly payload: Record<string, unknown>;
      readonly tone: "info" | "error";
    }) {
      const [commandId, activityId] = yield* Effect.all([
        serverCommandId("setup-script-activity"),
        serverEventId,
      ]);
      return yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: activityId,
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    });

    const dispatchBootstrapTurnStart = Effect.fn("dispatchBootstrapTurnStart")(function* (
      turnStart: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    ) {
      const bootstrap = turnStart.bootstrap;

      // Durable-retry idempotency: a bootstrap turn-start that creates a thread
      // may be re-dispatched by the client when it never received the first ack
      // (e.g. the page was refreshed while the bootstrap — worktree creation plus
      // setup script — was still running). An active thread whose first turn
      // already started means the prior attempt succeeded end to end; treat that
      // retry as a no-op instead of re-running thread.create (which fails the
      // "already exists" invariant) and re-emitting the user message. An active
      // thread WITHOUT a turn is a half-finished bootstrap (a prior attempt died
      // between thread.create and the turn start, e.g. on a dropped socket) —
      // resume it: skip thread.create, reuse an already-prepared worktree, and
      // carry on to the turn start so the thread does not stay wedged forever.
      let resumeExistingThread = false;
      let existingWorktreePath: string | null = null;
      if (bootstrap?.createThread) {
        const existing = yield* snapshotQuery
          .getThreadShellById(turnStart.threadId)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to check thread existence for bootstrap."),
            ),
          );
        if (Option.isSome(existing)) {
          if (existing.value.latestTurn !== null) {
            const { snapshotSequence } = yield* snapshotQuery
              .getSnapshotSequence()
              .pipe(
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to read projection sequence."),
                ),
              );
            return { sequence: snapshotSequence };
          }
          resumeExistingThread = true;
          existingWorktreePath = existing.value.worktreePath;
          yield* Effect.logInfo("resuming half-finished bootstrap turn start", {
            threadId: turnStart.threadId,
            worktreePath: existingWorktreePath,
          });
        }
      }

      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = turnStart;
      let createdThread = false;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath =
        existingWorktreePath ?? bootstrap?.createThread?.worktreePath ?? null;

      const cleanupCreatedThread = () =>
        createdThread
          ? serverCommandId("bootstrap-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                orchestrationEngine.dispatch({
                  type: "thread.delete",
                  commandId,
                  threadId: turnStart.threadId,
                }),
              ),
              Effect.ignoreCause({ log: true }),
            )
          : Effect.void;

      const recordSetupScriptLaunchFailure = Effect.fn("recordSetupScriptLaunchFailure")(
        function* (input: {
          readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
          readonly requestedAt: string;
          readonly worktreePath: string;
        }) {
          const detail = setupFailureDetail(input.error);
          yield* appendSetupScriptActivity({
            threadId: turnStart.threadId,
            kind: "setup-script.failed",
            summary: "Setup script failed to start",
            createdAt: input.requestedAt,
            payload: { detail, worktreePath: input.worktreePath },
            tone: "error",
          }).pipe(Effect.ignoreCause({ log: false }));
          yield* Effect.logWarning("bootstrap turn start failed to launch setup script", {
            threadId: turnStart.threadId,
            worktreePath: input.worktreePath,
            detail,
          });
        },
      );

      const recordSetupScriptStarted = Effect.fn("recordSetupScriptStarted")(function* (input: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) {
        const startedAt = yield* nowIso;
        const payload = {
          scriptId: input.scriptId,
          scriptName: input.scriptName,
          terminalId: input.terminalId,
          worktreePath: input.worktreePath,
        };
        yield* Effect.all([
          appendSetupScriptActivity({
            threadId: turnStart.threadId,
            kind: "setup-script.requested",
            summary: "Starting setup script",
            createdAt: input.requestedAt,
            payload,
            tone: "info",
          }),
          appendSetupScriptActivity({
            threadId: turnStart.threadId,
            kind: "setup-script.started",
            summary: "Setup script started",
            createdAt: startedAt,
            payload,
            tone: "info",
          }),
        ]).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning(
              "bootstrap turn start launched setup script but failed to record setup activity",
              {
                threadId: turnStart.threadId,
                worktreePath: input.worktreePath,
                scriptId: input.scriptId,
                terminalId: input.terminalId,
                detail: error.message,
              },
            ),
          ),
        );
      });

      const runSetupProgram = Effect.fn("runSetupProgram")(function* () {
        if (!bootstrap?.runSetupScript || !targetWorktreePath) {
          return;
        }
        const worktreePath = targetWorktreePath;
        const requestedAt = yield* nowIso;
        yield* projectSetupScriptRunner
          .runForThread({
            threadId: turnStart.threadId,
            ...(targetProjectId ? { projectId: targetProjectId } : {}),
            ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
            worktreePath,
          })
          .pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                recordSetupScriptLaunchFailure({ error, requestedAt, worktreePath }),
              onSuccess: (setupResult) =>
                setupResult.status === "started"
                  ? recordSetupScriptStarted({
                      requestedAt,
                      worktreePath,
                      scriptId: setupResult.scriptId,
                      scriptName: setupResult.scriptName,
                      terminalId: setupResult.terminalId,
                    })
                  : Effect.void,
            }),
          );
      });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread && !resumeExistingThread) {
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.create",
              commandId: yield* serverCommandId("bootstrap-thread-create"),
              threadId: turnStart.threadId,
              projectId: bootstrap.createThread.projectId,
              title: bootstrap.createThread.title,
              modelSelection: bootstrap.createThread.modelSelection,
              runtimeMode: bootstrap.createThread.runtimeMode,
              interactionMode: bootstrap.createThread.interactionMode,
              branch: bootstrap.createThread.branch,
              worktreePath: bootstrap.createThread.worktreePath,
              createdAt: bootstrap.createThread.createdAt,
            },
            dispatchOptions,
          );
          createdThread = true;
        }

        // Skip re-preparing when resuming a bootstrap whose worktree already
        // exists — createWorktree is not idempotent for the same branch name.
        if (bootstrap?.prepareWorktree && targetWorktreePath === null) {
          let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
          if (bootstrap.prepareWorktree.startFromOrigin) {
            yield* gitWorkflow.fetchRemote({
              cwd: bootstrap.prepareWorktree.projectCwd,
              remoteName: "origin",
            });
            const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              fallbackRemoteName: "origin",
            });
            worktreeBaseRef = resolvedRemoteBase.commitSha;
          }
          const worktree = yield* gitWorkflow.createWorktree({
            cwd: bootstrap.prepareWorktree.projectCwd,
            refName: worktreeBaseRef,
            newRefName: bootstrap.prepareWorktree.branch,
            baseRefName: bootstrap.prepareWorktree.baseBranch,
            path: null,
          });
          targetWorktreePath = worktree.worktree.path;
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
            threadId: turnStart.threadId,
            branch: worktree.worktree.refName,
            worktreePath: targetWorktreePath,
          });
          yield* vcsStatusBroadcaster
            .refreshStatus(targetWorktreePath)
            .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);
        }

        yield* runSetupProgram();
        return yield* orchestrationEngine.dispatch(finalTurnStartCommand, dispatchOptions);
      });

      // Uninterruptible: a dropped websocket must not kill the bootstrap between
      // thread.create and the turn start — that used to strand an active thread
      // with no turn (and no compensating delete on the interrupt-only path),
      // which every retry then mis-read as an already-completed bootstrap. Each
      // inner step is bounded (git commands time out; the setup script only
      // launches), so this cannot pin the fiber indefinitely.
      return yield* Effect.uninterruptible(bootstrapProgram).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          const dispatchError = toDispatchCommandError(
            error,
            "Failed to bootstrap thread turn start.",
          );
          return Cause.hasInterruptsOnly(cause)
            ? Effect.fail(dispatchError)
            : cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
        }),
      );
    });

    const baseDispatchEffect =
      command.type === "thread.turn.start" && command.bootstrap
        ? dispatchBootstrapTurnStart(command)
        : orchestrationEngine
            .dispatch(command, dispatchOptions)
            .pipe(
              Effect.mapError((cause) =>
                toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
              ),
            );

    const dispatchEffect =
      command.type === "thread.turn.start" && command.precondition
        ? executionSupervisor
            .admitIdleTurn({
              threadId: command.threadId,
              executionId: String(command.commandId),
              expectedExecutionRevision: command.precondition.expectedExecutionRevision,
              ...(command.modelSelection?.instanceId
                ? { providerInstanceId: command.modelSelection.instanceId }
                : {}),
              startedAt: command.createdAt,
            })
            .pipe(
              Effect.flatMap(() => baseDispatchEffect),
              Effect.onError(() =>
                executionSupervisor
                  .releaseTurnAdmission(command.threadId, String(command.commandId))
                  .pipe(Effect.ignoreCause({ log: true })),
              ),
            )
        : baseDispatchEffect;

    return yield* startup
      .enqueueCommand(dispatchEffect)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchError(cause, "Failed to dispatch orchestration command"),
        ),
      );
  });

  return OrchestrationCommandDispatcher.of({ dispatch });
});

export const layer = Layer.effect(OrchestrationCommandDispatcher, make);

export const passthroughLayer = Layer.effect(
  OrchestrationCommandDispatcher,
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
    return OrchestrationCommandDispatcher.of({
      dispatch: (command, options) =>
        orchestrationEngine
          .dispatch(command, options)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          ),
    });
  }),
);
