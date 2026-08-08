import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ThreadTurnAdmissionConflictError,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { ProjectionThreadBootstrapRepositoryLive } from "../persistence/Layers/ProjectionThreadBootstraps.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadExecutionSupervisor } from "../execution/ThreadExecutionSupervisor.ts";
// T3-CUSTOM(expbkt3): high-level creation is resolved and queued by one durable coordinator.
import * as ThreadBootstrapCoordinator from "../thread-bootstrap/Coordinator.ts";
import * as ThreadCreationDefaultsResolver from "../thread-bootstrap/DefaultsResolver.ts";
// T3-CUSTOM(expbkt3): attach-to-external-session.
import {
  buildExternalResumeCursor,
  probeExternalSessionArtifact,
} from "../provider/externalSessionAttachment.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

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
    case "ProjectSetupScriptCommandError":
      return (
        error.detail ??
        `Setup terminal exited with code ${String(error.exitCode)} and signal ${String(error.exitSignal)}.`
      );
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
  // T3-CUSTOM(expbkt3): shared web/HTTP/WebSocket/MCP bootstrap path.
  const threadBootstrapCoordinator = yield* ThreadBootstrapCoordinator.ThreadBootstrapCoordinator;
  // T3-CUSTOM(expbkt3): attach-to-external-session seeds the provider binding
  // before the first turn, which is all the existing resume path needs.
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const homeDirectory = NodeOS.homedir();
  // Captured here so the filesystem probe does not leak its requirements into
  // `dispatch`, whose signature is context-free (same trick as the reaper).
  const platformContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

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
                setupResult.status === "completed"
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
              sourceControlProfileId: bootstrap.createThread.sourceControlProfileId,
              createdAt: bootstrap.createThread.createdAt,
              // T3-CUSTOM(expbkt3): session priority.
              priority: bootstrap.createThread.priority ?? null,
              // T3-CUSTOM(expbkt3): session lineage.
              parentThreadId: bootstrap.createThread.parentThreadId ?? null,
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
    // T3-CUSTOM(expbkt3): retained for the compatibility release, but v2 must
    // never invoke the pre-commit bootstrap path.
    void dispatchBootstrapTurnStart;

    // T3-CUSTOM(expbkt3): BEGIN — attach a new thread to an existing external
    // provider session.
    const dispatchAttachedThreadCreate = Effect.fn("dispatchAttachedThreadCreate")(function* (
      createCommand: Extract<OrchestrationCommand, { type: "thread.create" }>,
      externalSession: NonNullable<
        Extract<OrchestrationCommand, { type: "thread.create" }>["externalSession"]
      >,
    ) {
      const fail = (message: string) =>
        Effect.fail(new OrchestrationDispatchCommandError({ message }));

      // Resume is bound to the directory the session ran in, so a worktree
      // checkout would silently look somewhere else.
      if (createCommand.branch !== null || createCommand.worktreePath !== null) {
        return yield* fail(
          "An attached session must use the project checkout: it resumes in the directory the external session ran in.",
        );
      }
      // ProviderService only falls back to a persisted cursor when the binding
      // instance matches the one the turn routes to.
      if (createCommand.modelSelection.instanceId !== externalSession.providerInstanceId) {
        return yield* fail(
          "The attached session's provider instance must match the thread's selected model instance.",
        );
      }

      const instance = yield* providerService
        .getInstanceInfo(externalSession.providerInstanceId)
        .pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                message: `Provider instance '${externalSession.providerInstanceId}' was not found.`,
              }),
          ),
        );

      const built = yield* Effect.try({
        try: () => buildExternalResumeCursor(instance.driverKind, externalSession.sessionId),
        catch: (cause) =>
          new OrchestrationDispatchCommandError({
            message: cause instanceof Error ? cause.message : "Invalid external session id.",
          }),
      });

      const shell = yield* snapshotQuery
        .getShellSnapshot()
        .pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to read the project for an attached session."),
          ),
        );
      const project = shell.projects.find((entry) => entry.id === createCommand.projectId);
      if (!project) {
        return yield* fail(`T3 project ${createCommand.projectId} was not found.`);
      }

      const probe = yield* probeExternalSessionArtifact({
        driverKind: instance.driverKind,
        sessionId: built.normalizedSessionId,
        cwd: project.workspaceRoot,
        homePath: homeDirectory,
      }).pipe(
        Effect.provide(platformContext),
        Effect.orElseSucceed(() => "unknown" as const),
      );

      if (probe === "missing") {
        // Codex silently starts a fresh thread on an unknown id, so a missing
        // artifact must fail loudly here rather than look like a success.
        return yield* fail(
          `No ${instance.driverKind === "claudeAgent" ? "Claude" : "Codex"} session '${built.normalizedSessionId}' was found for ${project.workspaceRoot}. Check the session id and that you picked the project it ran in.`,
        );
      }
      if (probe === "unknown") {
        yield* Effect.logWarning("provider.external-session.probe-inconclusive", {
          threadId: createCommand.threadId,
          driverKind: instance.driverKind,
          cwd: project.workspaceRoot,
        });
      }

      const result = yield* orchestrationEngine
        .dispatch(createCommand, dispatchOptions)
        .pipe(
          Effect.mapError((cause) =>
            toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
          ),
        );

      yield* providerSessionDirectory
        .upsert({
          threadId: createCommand.threadId,
          provider: instance.driverKind,
          providerInstanceId: externalSession.providerInstanceId,
          runtimeMode: createCommand.runtimeMode,
          // Not running yet: the binding only carries the resume state that
          // the first turn will pick up.
          status: "stopped",
          resumeCursor: built.cursor,
          runtimePayload: { cwd: project.workspaceRoot },
        })
        .pipe(
          Effect.mapError(
            () =>
              new OrchestrationDispatchCommandError({
                // The thread exists and is usable; only the binding failed.
                message:
                  "The thread was created but could not be attached to the external session. Delete it and try again.",
              }),
          ),
        );

      yield* orchestrationEngine
        .dispatch(
          {
            type: "thread.activity.append",
            commandId: yield* serverCommandId("attach-external-session"),
            threadId: createCommand.threadId,
            activity: {
              id: yield* serverEventId,
              tone: "info",
              kind: "session.attached-external",
              summary: `Attached to an existing ${instance.driverKind === "claudeAgent" ? "Claude" : "Codex"} session (${built.normalizedSessionId.slice(0, 8)})`,
              payload: {
                providerInstanceId: externalSession.providerInstanceId,
                sessionId: built.normalizedSessionId,
                probe,
              },
              turnId: null,
              createdAt: createCommand.createdAt,
            },
            createdAt: createCommand.createdAt,
          },
          dispatchOptions,
        )
        .pipe(Effect.ignoreCause({ log: true }));

      return result;
    });
    // T3-CUSTOM(expbkt3): END

    const normalizeBootstrapDispatch = <A>(
      effect: Effect.Effect<A, ThreadBootstrapCoordinator.ThreadBootstrapCoordinatorError>,
    ): Effect.Effect<A, OrchestrationDispatchCommandError> =>
      effect.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch thread bootstrap command"),
        ),
      );

    // T3-CUSTOM(expbkt3): resolve creation defaults without performing provider
    // or workspace side effects, then let the coordinator dispatch one atomic
    // turn command carrying both the exact message and resolved bootstrap spec.
    const dispatchDurableBootstrapTurn = Effect.fn(
      "OrchestrationCommandDispatcher.dispatchDurableBootstrapTurn",
    )(function* (turnStart: Extract<OrchestrationCommand, { type: "thread.turn.start" }>) {
      const request = turnStart.bootstrap?.request;
      if (request === undefined) {
        return yield* orchestrationEngine
          .dispatch(turnStart, dispatchOptions)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      }
      let createThread = request.createThread;
      if (createThread) {
        // A browser retry can carry a fresh command id after the atomic first
        // turn already committed. Match the legacy bootstrap path: completed
        // creation is a no-op, while a half-created thread resumes in place.
        const existing = yield* snapshotQuery
          .getThreadShellById(turnStart.threadId)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(
                cause,
                "Failed to check thread existence for durable bootstrap.",
              ),
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
          createThread = false;
        }
      }
      return yield* normalizeBootstrapDispatch(
        threadBootstrapCoordinator.request(
          {
            type: "thread.bootstrap.request",
            commandId: turnStart.commandId,
            bootstrapId: request.bootstrapId,
            threadId: turnStart.threadId,
            projectId: request.projectId,
            title: request.title,
            initialTurn: {
              messageId: turnStart.message.messageId,
              text: turnStart.message.text,
              attachments: turnStart.message.attachments,
              ...(turnStart.titleSeed ? { titleSeed: turnStart.titleSeed } : {}),
            },
            ...(request.overrides ? { overrides: request.overrides } : {}),
            ...(request.sourceControlProfileId !== undefined
              ? { sourceControlProfileId: request.sourceControlProfileId }
              : {}),
            ...(request.priority !== undefined ? { priority: request.priority } : {}),
            // T3-CUSTOM(expbkt3): session lineage. This rebuild is the only
            // carrier for a prompt-bearing t3_create_session, so dropping the
            // field here silently orphans every agent-spawned session.
            ...(request.parentThreadId !== undefined
              ? { parentThreadId: request.parentThreadId }
              : {}),
            ...(request.ownerUserId ? { ownerUserId: request.ownerUserId } : {}),
            createdAt: request.createdAt,
          },
          {
            actorUserId: options?.actorUserId ?? null,
            createThread,
            turnStart,
          },
        ),
      );
    });

    const baseDispatchEffect =
      // T3-CUSTOM(expbkt3): public bootstrap controls never reach the strict decider.
      command.type === "thread.turn.start" && command.bootstrap?.request !== undefined
        ? dispatchDurableBootstrapTurn(command)
        : command.type === "thread.bootstrap.request"
          ? normalizeBootstrapDispatch(
              threadBootstrapCoordinator.request(command, {
                actorUserId: options?.actorUserId ?? null,
              }),
            )
          : command.type === "thread.bootstrap.retry"
            ? normalizeBootstrapDispatch(threadBootstrapCoordinator.retry(command))
            : command.type === "thread.bootstrap.stop"
              ? normalizeBootstrapDispatch(threadBootstrapCoordinator.stop(command))
              : command.type === "thread.bootstrap.continue"
                ? normalizeBootstrapDispatch(threadBootstrapCoordinator.continue(command))
                : // T3-CUSTOM(expbkt3): bootstrap-bearing turn starts reach the
                  // engine unchanged so thread, message, intent, and receipt share
                  // one transaction. The durable execution coordinator owns every
                  // post-commit worktree, setup, and provider side effect.
                  command.type === "thread.create" && command.externalSession
                  ? dispatchAttachedThreadCreate(command, command.externalSession)
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

// T3-CUSTOM(expbkt3): test and alternate runtimes may provide their own durable
// bootstrap repository while production composes the SQLite implementation.
export const layerWithBootstrapRepository = Layer.effect(OrchestrationCommandDispatcher, make).pipe(
  // T3-CUSTOM(expbkt3): additive bootstrap modules keep the upstream dispatcher seam small.
  Layer.provideMerge(
    ThreadBootstrapCoordinator.layer.pipe(Layer.provide(ThreadCreationDefaultsResolver.layer)),
  ),
);

export const layer = layerWithBootstrapRepository.pipe(
  Layer.provide(
    ProjectionThreadBootstrapRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive)),
  ),
);

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
