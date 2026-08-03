// T3-CUSTOM(expbkt3): durable worktree/setup/agent bootstrap coordinator.
import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  type ResolvedThreadBootstrapRequest,
  type ThreadBootstrapProgress,
  type ThreadBootstrapRequestCommand,
  type ThreadBootstrapRetryCommand,
  type ThreadBootstrapStopCommand,
  type ThreadBootstrapContinueCommand,
  type ThreadId,
  type UserId,
  type WorktreeBaseRef,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import {
  type ProjectionThreadBootstrap,
  ProjectionThreadBootstrapRepository,
} from "../persistence/Services/ProjectionThreadBootstraps.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { resolveExactBranch, ThreadCreationDefaultsResolver } from "./DefaultsResolver.ts";

export class ThreadBootstrapCoordinatorError extends Data.TaggedError(
  "ThreadBootstrapCoordinatorError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const commandId = (bootstrapId: string, phase: string, attempt = 0) =>
  CommandId.make(`bootstrap:${bootstrapId}:${phase}:${attempt}`);
const setupTerminalId = (bootstrapId: string, attempt: number) =>
  `setup-${bootstrapId}-${attempt}`.slice(0, 128);

function pendingStep(status: "pending" | "skipped", worktreePath: string | null = null) {
  return {
    status,
    attempt: 0,
    terminalId: null,
    exitCode: null,
    error: null,
    worktreePath,
  } as const;
}

function initialProgress(request: ResolvedThreadBootstrapRequest): ThreadBootstrapProgress {
  const createsWorktree = request.workspace.mode === "new-worktree";
  const existingPath =
    request.workspace.mode === "new-worktree"
      ? (request.workspace.intendedPath ?? null)
      : request.workspace.path;
  return {
    id: request.bootstrapId,
    status: "queued",
    worktree: pendingStep(createsWorktree ? "pending" : "skipped", existingPath),
    setup: pendingStep(createsWorktree ? "pending" : "skipped"),
    agent: pendingStep(request.initialTurn ? "pending" : "skipped"),
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  };
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class ThreadBootstrapCoordinator extends Context.Service<
  ThreadBootstrapCoordinator,
  {
    readonly request: (
      command: ThreadBootstrapRequestCommand,
      options?: {
        readonly actorUserId?: UserId | null;
        readonly createThread?: boolean;
        readonly turnStart?: Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
      },
    ) => Effect.Effect<{ readonly sequence: number }, ThreadBootstrapCoordinatorError>;
    readonly retry: (
      command: ThreadBootstrapRetryCommand,
    ) => Effect.Effect<{ readonly sequence: number }, ThreadBootstrapCoordinatorError>;
    readonly stop: (
      command: ThreadBootstrapStopCommand,
    ) => Effect.Effect<{ readonly sequence: number }, ThreadBootstrapCoordinatorError>;
    readonly continue: (
      command: ThreadBootstrapContinueCommand,
    ) => Effect.Effect<{ readonly sequence: number }, ThreadBootstrapCoordinatorError>;
    readonly recover: Effect.Effect<void, ThreadBootstrapCoordinatorError>;
  }
>()("t3/thread-bootstrap/Coordinator/ThreadBootstrapCoordinator") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const defaultsResolver = yield* ThreadCreationDefaultsResolver;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const bootstraps = yield* ProjectionThreadBootstrapRepository;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

  const dispatch = (command: OrchestrationCommand, actorUserId: UserId | null = null) =>
    engine.dispatch(command, { actorUserId }).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadBootstrapCoordinatorError({
            message: `Failed to persist bootstrap command ${command.type}.`,
            cause,
          }),
      ),
    );

  const updateStep = (input: {
    readonly request: ResolvedThreadBootstrapRequest;
    readonly step: "worktree" | "setup" | "agent";
    readonly status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "bypassed";
    readonly attempt: number;
    readonly terminalId?: string | null;
    readonly exitCode?: number | null;
    readonly error?: string | null;
    readonly worktreePath?: string | null;
  }) =>
    nowIso.pipe(
      Effect.flatMap((updatedAt) =>
        dispatch({
          type: "thread.bootstrap.step.update",
          commandId: commandId(
            input.request.bootstrapId,
            `${input.step}-${input.status}`,
            input.attempt,
          ),
          threadId: input.request.threadId,
          bootstrapId: input.request.bootstrapId,
          step: input.step,
          status: input.status,
          attempt: input.attempt,
          ...(input.terminalId !== undefined ? { terminalId: input.terminalId } : {}),
          ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          updatedAt,
        }),
      ),
    );

  const complete = (request: ResolvedThreadBootstrapRequest) =>
    nowIso.pipe(
      Effect.flatMap((completedAt) =>
        dispatch({
          type: "thread.bootstrap.complete",
          commandId: commandId(request.bootstrapId, "complete"),
          threadId: request.threadId,
          bootstrapId: request.bootstrapId,
          completedAt,
        }),
      ),
    );

  const appendSetupActivity = (input: {
    readonly request: ResolvedThreadBootstrapRequest;
    readonly kind:
      | "setup-script.requested"
      | "setup-script.started"
      | "setup-script.failed"
      | "setup-script.completed"
      | "setup-script.bypassed";
    readonly summary: string;
    readonly attempt: number;
    readonly payload: Record<string, unknown>;
    readonly tone?: "info" | "error";
  }) =>
    nowIso.pipe(
      Effect.flatMap((createdAt) =>
        dispatch({
          type: "thread.activity.append",
          commandId: commandId(input.request.bootstrapId, `activity-${input.kind}`, input.attempt),
          threadId: input.request.threadId,
          activity: {
            id: EventId.make(
              `bootstrap:${input.request.bootstrapId}:${input.kind}:${input.attempt}`,
            ),
            tone: input.tone ?? "info",
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt,
          },
          createdAt,
        }),
      ),
      Effect.ignoreCause({ log: true }),
    );

  const startAgent = Effect.fn("ThreadBootstrapCoordinator.startAgent")(function* (
    request: ResolvedThreadBootstrapRequest,
  ) {
    if (!request.initialTurn) {
      yield* updateStep({ request, step: "agent", status: "skipped", attempt: 0 });
      return yield* complete(request);
    }
    yield* updateStep({ request, step: "agent", status: "running", attempt: 1 });
    yield* dispatch({
      type: "thread.turn.start",
      commandId: commandId(request.bootstrapId, "agent-start", 1),
      threadId: request.threadId,
      message: {
        messageId: request.initialTurn.messageId,
        role: "user",
        text: request.initialTurn.text,
        attachments: request.initialTurn.attachments,
      },
      modelSelection: request.modelSelection,
      ...(request.initialTurn.titleSeed ? { titleSeed: request.initialTurn.titleSeed } : {}),
      runtimeMode: request.runtimeMode,
      interactionMode: request.interactionMode,
      createdAt: request.createdAt,
    });
    yield* updateStep({ request, step: "agent", status: "succeeded", attempt: 1 });
    return yield* complete(request);
  });

  const runSetup = Effect.fn("ThreadBootstrapCoordinator.runSetup")(function* (input: {
    readonly request: ResolvedThreadBootstrapRequest;
    readonly worktreePath: string;
    readonly attempt: number;
  }) {
    const terminalId = setupTerminalId(input.request.bootstrapId, input.attempt);
    yield* updateStep({
      request: input.request,
      step: "setup",
      status: "running",
      attempt: input.attempt,
      terminalId,
      worktreePath: input.worktreePath,
    });
    const outcome = yield* Effect.exit(
      setupRunner.runForThread({
        threadId: input.request.threadId,
        projectId: input.request.projectId,
        worktreePath: input.worktreePath,
        preferredTerminalId: terminalId,
        onStarted: (started) => {
          const payload = {
            scriptId: started.scriptId,
            scriptName: started.scriptName,
            terminalId: started.terminalId,
            worktreePath: input.worktreePath,
          };
          return appendSetupActivity({
            request: input.request,
            kind: "setup-script.requested",
            summary: "Starting setup script",
            attempt: input.attempt,
            payload,
          }).pipe(
            Effect.andThen(
              appendSetupActivity({
                request: input.request,
                kind: "setup-script.started",
                summary: "Setup script started",
                attempt: input.attempt,
                payload,
              }),
            ),
          );
        },
      }),
    );
    if (Exit.isFailure(outcome)) {
      const failure = Cause.squash(outcome.cause);
      const exitCode =
        typeof failure === "object" &&
        failure !== null &&
        "_tag" in failure &&
        failure._tag === "ProjectSetupScriptCommandError" &&
        "exitCode" in failure &&
        (typeof failure.exitCode === "number" || failure.exitCode === null)
          ? failure.exitCode
          : null;
      yield* updateStep({
        request: input.request,
        step: "setup",
        status: "failed",
        attempt: input.attempt,
        terminalId,
        exitCode,
        error: errorDetail(failure),
        worktreePath: input.worktreePath,
      });
      yield* appendSetupActivity({
        request: input.request,
        kind: "setup-script.failed",
        summary: "Setup script failed",
        attempt: input.attempt,
        payload: {
          terminalId,
          exitCode,
          detail: errorDetail(failure),
          worktreePath: input.worktreePath,
        },
        tone: "error",
      });
      return;
    }
    if (outcome.value.status === "no-script") {
      yield* updateStep({
        request: input.request,
        step: "setup",
        status: "skipped",
        attempt: input.attempt,
        terminalId: null,
        worktreePath: input.worktreePath,
      });
    } else {
      yield* updateStep({
        request: input.request,
        step: "setup",
        status: "succeeded",
        attempt: input.attempt,
        terminalId: outcome.value.terminalId,
        exitCode: 0,
        worktreePath: input.worktreePath,
      });
      const payload = {
        scriptId: outcome.value.scriptId,
        scriptName: outcome.value.scriptName,
        terminalId: outcome.value.terminalId,
        exitCode: 0,
        worktreePath: input.worktreePath,
      };
      yield* appendSetupActivity({
        request: input.request,
        kind: "setup-script.completed",
        summary: "Setup script completed",
        attempt: input.attempt,
        payload,
      });
    }
    yield* startAgent(input.request);
  });

  const findAdoptableWorktree = Effect.fn("ThreadBootstrapCoordinator.findAdoptableWorktree")(
    function* (request: ResolvedThreadBootstrapRequest) {
      const workspace = request.workspace;
      if (workspace.mode !== "new-worktree" || !workspace.newBranch || !workspace.intendedPath) {
        return null;
      }
      const refs = yield* gitWorkflow.listRefs({
        cwd: workspace.projectCwd,
        query: workspace.newBranch,
        refresh: true,
      });
      return (
        refs.refs.find(
          (ref) =>
            ref.isRemote !== true &&
            ref.name === workspace.newBranch &&
            ref.worktreePath === workspace.intendedPath,
        ) ?? null
      );
    },
  );

  const finishWorktree = Effect.fn("ThreadBootstrapCoordinator.finishWorktree")(function* (input: {
    readonly request: ResolvedThreadBootstrapRequest;
    readonly worktreePath: string;
    readonly branch: string;
    readonly attempt: number;
    readonly setupAttempt: number;
  }) {
    yield* dispatch({
      type: "thread.meta.update",
      commandId: commandId(input.request.bootstrapId, "worktree-meta", input.attempt),
      threadId: input.request.threadId,
      branch: input.branch,
      worktreePath: input.worktreePath,
    });
    yield* updateStep({
      request: input.request,
      step: "worktree",
      status: "succeeded",
      attempt: input.attempt,
      worktreePath: input.worktreePath,
    });
    yield* vcsStatusBroadcaster
      .refreshStatus(input.worktreePath)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);
    yield* runSetup({
      request: input.request,
      worktreePath: input.worktreePath,
      attempt: input.setupAttempt,
    });
  });

  const createWorktree = Effect.fn("ThreadBootstrapCoordinator.createWorktree")(function* (input: {
    readonly request: ResolvedThreadBootstrapRequest;
    readonly baseRef: WorktreeBaseRef;
    readonly attempt: number;
  }) {
    const workspace = input.request.workspace;
    if (workspace.mode !== "new-worktree") return;
    yield* updateStep({
      request: input.request,
      step: "worktree",
      status: "running",
      attempt: input.attempt,
    });
    if (input.attempt > 1) {
      const adoptable = yield* findAdoptableWorktree(input.request).pipe(Effect.option);
      if (Option.isSome(adoptable) && adoptable.value !== null) {
        return yield* finishWorktree({
          request: input.request,
          worktreePath: adoptable.value.worktreePath!,
          branch: workspace.newBranch ?? adoptable.value.name,
          attempt: input.attempt,
          setupAttempt: 1,
        });
      }
    }
    const projectCwd = workspace.projectCwd;
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        if (input.baseRef.source === "origin") {
          yield* gitWorkflow.fetchRemote({ cwd: projectCwd, remoteName: "origin" });
        }
        const refs = yield* gitWorkflow.listRefs({
          cwd: projectCwd,
          refresh: true,
          includeMatchingRemoteRefs: true,
        });
        const exactBaseRef = resolveExactBranch(refs.refs, input.baseRef);
        if (!exactBaseRef || exactBaseRef.kind !== "branch") {
          const selected =
            input.baseRef.kind === "repository-default"
              ? `${input.baseRef.source} repository default`
              : `${input.baseRef.source}/${input.baseRef.branch}`;
          return yield* new ThreadBootstrapCoordinatorError({
            message: `Configured worktree base ref is unavailable: ${selected}.`,
          });
        }
        const branch = exactBaseRef.branch;
        let refName = branch;
        if (exactBaseRef.source === "origin") {
          const remote = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd: projectCwd,
            refName: branch,
            fallbackRemoteName: "origin",
          });
          refName = remote.commitSha;
        }
        return yield* gitWorkflow.createWorktree({
          cwd: projectCwd,
          refName,
          newRefName: workspace.newBranch,
          baseRefName: branch,
          path: workspace.intendedPath ?? null,
        });
      }),
    );
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause);
      yield* updateStep({
        request: input.request,
        step: "worktree",
        status: "failed",
        attempt: input.attempt,
        error: errorDetail(failure),
      });
      return;
    }
    yield* finishWorktree({
      request: input.request,
      worktreePath: result.value.worktree.path,
      branch: result.value.worktree.refName,
      attempt: input.attempt,
      setupAttempt: 1,
    });
  });

  const run = Effect.fn("ThreadBootstrapCoordinator.run")(function* (
    request: ResolvedThreadBootstrapRequest,
  ) {
    if (request.workspace.mode === "new-worktree") {
      return yield* createWorktree({ request, baseRef: request.workspace.baseRef, attempt: 1 });
    }
    return yield* startAgent(request);
  });

  const launch = (request: ResolvedThreadBootstrapRequest) =>
    run(request).pipe(
      Effect.catch((error) =>
        Effect.logError("durable thread bootstrap failed", {
          bootstrapId: request.bootstrapId,
          threadId: request.threadId,
          detail: errorDetail(error),
        }),
      ),
      Effect.forkDetach,
      Effect.asVoid,
    );

  const request: ThreadBootstrapCoordinator["Service"]["request"] = (command, options) =>
    Effect.gen(function* () {
      const existing = yield* bootstraps.getByThreadId(command.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadBootstrapCoordinatorError({
              message: "Failed to inspect existing bootstrap state.",
              cause,
            }),
        ),
      );
      if (Option.isSome(existing)) {
        if (existing.value.bootstrapId !== command.bootstrapId) {
          return yield* new ThreadBootstrapCoordinatorError({
            message: `Thread ${command.threadId} already has a different bootstrap request.`,
          });
        }
        // Re-dispatch the deterministic record command so the engine returns
        // its original receipt sequence instead of an unusable synthetic 0.
        return yield* dispatch({
          type: "thread.bootstrap.request.record",
          commandId: commandId(existing.value.bootstrapId, "request-record"),
          threadId: existing.value.threadId,
          request: existing.value.request,
          progress: existing.value.progress,
          createdAt: existing.value.createdAt,
        });
      }
      let resolved = yield* defaultsResolver
        .resolve(command)
        .pipe(
          Effect.mapError(
            (cause) => new ThreadBootstrapCoordinatorError({ message: cause.message, cause }),
          ),
        );
      if (resolved.workspace.mode === "new-worktree") {
        let allocatedBranch = resolved.workspace.newBranch;
        if (!allocatedBranch) {
          const uuid = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(
              (cause) =>
                new ThreadBootstrapCoordinatorError({
                  message: "Failed to allocate the worktree branch.",
                  cause,
                }),
            ),
          );
          allocatedBranch = buildTemporaryWorktreeBranchName(() => uuid);
        }
        resolved = {
          ...resolved,
          workspace: {
            ...resolved.workspace,
            newBranch: allocatedBranch,
            intendedPath: path.join(
              serverConfig.worktreesDir,
              path.basename(resolved.workspace.projectCwd),
              allocatedBranch.replace(/\//g, "-"),
            ),
          },
        };
      }
      if (!resolved.ownerUserId && options?.actorUserId) {
        resolved = { ...resolved, ownerUserId: options.actorUserId };
      }

      // T3-CUSTOM(expbkt3): initial messages use the durable turn transaction.
      // Bootstrap projection commands remain available for workspace-only
      // requests, but no accepted message is split across thread/create/record.
      if (resolved.initialTurn && options?.turnStart) {
        const originalTurn = options.turnStart;
        const createThread = options?.createThread !== false;
        const titleSeed = originalTurn.titleSeed ?? resolved.initialTurn.titleSeed;
        const initialPath =
          resolved.workspace.mode === "new-worktree" ? null : resolved.workspace.path;
        const initialBranch =
          resolved.workspace.mode === "existing-worktree"
            ? (resolved.workspace.branch ?? null)
            : null;
        return yield* dispatch(
          {
            type: "thread.turn.start",
            commandId: originalTurn.commandId,
            threadId: resolved.threadId,
            message: {
              messageId: resolved.initialTurn.messageId,
              role: "user",
              text: resolved.initialTurn.text,
              attachments: resolved.initialTurn.attachments,
            },
            modelSelection: resolved.modelSelection,
            ...(titleSeed !== undefined ? { titleSeed } : {}),
            runtimeMode: resolved.runtimeMode,
            interactionMode: resolved.interactionMode,
            bootstrap: {
              ...(createThread
                ? {
                    createThread: {
                      projectId: resolved.projectId,
                      title: resolved.title,
                      modelSelection: resolved.modelSelection,
                      runtimeMode: resolved.runtimeMode,
                      interactionMode: resolved.interactionMode,
                      branch: initialBranch,
                      worktreePath: initialPath,
                      sourceControlProfileId: resolved.sourceControlProfileId,
                      ...(resolved.ownerUserId ? { ownerUserId: resolved.ownerUserId } : {}),
                      createdAt: resolved.createdAt,
                      priority: resolved.priority,
                    },
                  }
                : {}),
              resolvedRequest: resolved,
            },
            ...(originalTurn.sourceProposedPlan
              ? { sourceProposedPlan: originalTurn.sourceProposedPlan }
              : {}),
            createdAt: originalTurn.createdAt,
          },
          options?.actorUserId ?? null,
        );
      }

      if (options?.createThread !== false) {
        const initialPath =
          resolved.workspace.mode === "new-worktree" ? null : resolved.workspace.path;
        const initialBranch =
          resolved.workspace.mode === "existing-worktree"
            ? (resolved.workspace.branch ?? null)
            : null;
        yield* dispatch({
          type: "thread.create",
          commandId: commandId(resolved.bootstrapId, "thread-create"),
          threadId: resolved.threadId,
          projectId: resolved.projectId,
          title: resolved.title,
          modelSelection: resolved.modelSelection,
          runtimeMode: resolved.runtimeMode,
          interactionMode: resolved.interactionMode,
          branch: initialBranch,
          worktreePath: resolved.workspace.mode === "existing-worktree" ? initialPath : null,
          sourceControlProfileId: resolved.sourceControlProfileId,
          ...(resolved.ownerUserId ? { ownerUserId: resolved.ownerUserId } : {}),
          createdAt: resolved.createdAt,
          priority: resolved.priority,
        });
      }
      const recorded = yield* dispatch({
        type: "thread.bootstrap.request.record",
        commandId: commandId(resolved.bootstrapId, "request-record"),
        threadId: resolved.threadId,
        request: resolved,
        progress: initialProgress(resolved),
        createdAt: resolved.createdAt,
      });
      yield* launch(resolved);
      return recorded;
    }).pipe(Effect.uninterruptible);

  const load = (threadId: ThreadId, bootstrapId: string) =>
    bootstraps.getByThreadId(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadBootstrapCoordinatorError({
            message: "Failed to load bootstrap state.",
            cause,
          }),
      ),
      Effect.flatMap((state) =>
        Option.isSome(state) && state.value.bootstrapId === bootstrapId
          ? Effect.succeed(state.value)
          : Effect.fail(
              new ThreadBootstrapCoordinatorError({ message: "Bootstrap was not found." }),
            ),
      ),
    );

  const retry: ThreadBootstrapCoordinator["Service"]["retry"] = (command) =>
    Effect.gen(function* () {
      const state = yield* load(command.threadId, command.bootstrapId);
      if (state.progress[command.step].status !== "failed") {
        return yield* new ThreadBootstrapCoordinatorError({
          message: `Only a failed ${command.step} step can be retried.`,
        });
      }
      const recorded = yield* dispatch({
        type: "thread.bootstrap.control.record",
        commandId: command.commandId,
        threadId: command.threadId,
        bootstrapId: command.bootstrapId,
        action: "retry",
        step: command.step,
        ...(command.baseRef ? { baseRef: command.baseRef } : {}),
        createdAt: command.createdAt,
      });
      if (command.step === "worktree") {
        const retryRequest: ResolvedThreadBootstrapRequest =
          command.baseRef && state.request.workspace.mode === "new-worktree"
            ? {
                ...state.request,
                workspace: { ...state.request.workspace, baseRef: command.baseRef },
              }
            : state.request;
        yield* createWorktree({
          request: retryRequest,
          baseRef:
            command.baseRef ??
            (state.request.workspace.mode === "new-worktree"
              ? state.request.workspace.baseRef
              : { kind: "repository-default", source: "origin" }),
          attempt: state.progress.worktree.attempt + 1,
        }).pipe(Effect.forkDetach);
      } else {
        const worktreePath = state.progress.worktree.worktreePath;
        if (!worktreePath) {
          return yield* new ThreadBootstrapCoordinatorError({
            message: "Cannot retry setup without a completed worktree.",
          });
        }
        yield* runSetup({
          request: state.request,
          worktreePath,
          attempt: state.progress.setup.attempt + 1,
        }).pipe(Effect.forkDetach);
      }
      return recorded;
    });

  const stop: ThreadBootstrapCoordinator["Service"]["stop"] = (command) =>
    Effect.gen(function* () {
      const state = yield* load(command.threadId, command.bootstrapId);
      if (state.progress.setup.status !== "running" || !state.progress.setup.terminalId) {
        return yield* new ThreadBootstrapCoordinatorError({
          message: "Setup is not currently running.",
        });
      }
      const recorded = yield* dispatch({
        type: "thread.bootstrap.control.record",
        commandId: command.commandId,
        threadId: command.threadId,
        bootstrapId: command.bootstrapId,
        action: "stop",
        step: "setup",
        createdAt: command.createdAt,
      });
      yield* terminalManager
        .stopCommand({
          threadId: command.threadId,
          terminalId: state.progress.setup.terminalId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadBootstrapCoordinatorError({
                message: "Failed to stop the setup terminal.",
                cause,
              }),
          ),
        );
      return recorded;
    });

  const continueBootstrap: ThreadBootstrapCoordinator["Service"]["continue"] = (command) =>
    Effect.gen(function* () {
      const state = yield* load(command.threadId, command.bootstrapId);
      if (
        state.progress.worktree.status !== "succeeded" ||
        state.progress.setup.status !== "failed"
      ) {
        return yield* new ThreadBootstrapCoordinatorError({
          message: "Only a failed setup can be bypassed after worktree creation succeeds.",
        });
      }
      const recorded = yield* dispatch({
        type: "thread.bootstrap.control.record",
        commandId: command.commandId,
        threadId: command.threadId,
        bootstrapId: command.bootstrapId,
        action: "continue",
        step: "setup",
        createdAt: command.createdAt,
      });
      yield* updateStep({
        request: state.request,
        step: "setup",
        status: "bypassed",
        attempt: state.progress.setup.attempt,
        terminalId: state.progress.setup.terminalId,
        exitCode: state.progress.setup.exitCode,
        worktreePath: state.progress.worktree.worktreePath,
      });
      yield* appendSetupActivity({
        request: state.request,
        kind: "setup-script.bypassed",
        summary: "Setup script bypassed",
        attempt: state.progress.setup.attempt,
        payload: {
          terminalId: state.progress.setup.terminalId,
          exitCode: state.progress.setup.exitCode,
          worktreePath: state.progress.worktree.worktreePath,
        },
      });
      yield* startAgent(state.request).pipe(Effect.forkDetach);
      return recorded;
    });

  const recoverState = Effect.fn("ThreadBootstrapCoordinator.recoverState")(function* (
    state: ProjectionThreadBootstrap,
  ) {
    const { progress, request } = state;
    if (progress.worktree.status === "pending") {
      return yield* run(request);
    }
    if (progress.worktree.status === "running") {
      const adoptable = yield* findAdoptableWorktree(request);
      if (adoptable?.worktreePath && request.workspace.mode === "new-worktree") {
        return yield* finishWorktree({
          request,
          worktreePath: adoptable.worktreePath,
          branch: request.workspace.newBranch ?? adoptable.name,
          attempt: progress.worktree.attempt,
          setupAttempt: Math.max(1, progress.setup.attempt + 1),
        });
      }
      return yield* updateStep({
        request,
        step: "worktree",
        status: "failed",
        attempt: progress.worktree.attempt,
        error:
          "Worktree creation was interrupted and no exact managed worktree match was found. Retry to create it safely.",
        worktreePath:
          request.workspace.mode === "new-worktree"
            ? (request.workspace.intendedPath ?? null)
            : null,
      });
    }
    if (progress.worktree.status === "failed") return;

    if (progress.setup.status === "pending") {
      if (!progress.worktree.worktreePath) {
        return yield* updateStep({
          request,
          step: "setup",
          status: "failed",
          attempt: progress.setup.attempt,
          error: "The completed worktree path is unavailable after restart.",
        });
      }
      return yield* runSetup({
        request,
        worktreePath: progress.worktree.worktreePath,
        attempt: Math.max(1, progress.setup.attempt + 1),
      });
    }
    if (progress.setup.status === "failed") return;

    if (progress.agent.status === "pending" || progress.agent.status === "running") {
      return yield* startAgent(request);
    }
    return yield* complete(request);
  });

  const recover = bootstraps.listIncomplete().pipe(
    Effect.mapError(
      (cause) =>
        new ThreadBootstrapCoordinatorError({
          message: "Failed to load incomplete bootstraps during recovery.",
          cause,
        }),
    ),
    Effect.flatMap((states) =>
      Effect.forEach(
        states,
        (state) =>
          state.progress.setup.status === "running"
            ? updateStep({
                request: state.request,
                step: "setup",
                status: "failed",
                attempt: state.progress.setup.attempt,
                terminalId: state.progress.setup.terminalId,
                exitCode: null,
                error: "Setup was interrupted by a server restart. Retry or continue anyway.",
                worktreePath: state.progress.worktree.worktreePath,
              })
            : recoverState(state).pipe(
                Effect.catch((error) =>
                  Effect.logError("failed to recover durable thread bootstrap", {
                    bootstrapId: state.bootstrapId,
                    threadId: state.threadId,
                    detail: errorDetail(error),
                  }),
                ),
                Effect.forkDetach,
                Effect.asVoid,
              ),
        { concurrency: 2 },
      ),
    ),
    Effect.asVoid,
  );

  // Recovery waits for projections/settings/reactors to be ready, but it never
  // blocks startup on an interactive setup process.
  yield* startup.enqueueCommand(recover).pipe(
    Effect.catch((error) =>
      Effect.logError("failed to schedule durable thread bootstrap recovery", {
        detail: errorDetail(error),
      }),
    ),
    Effect.forkDetach,
  );

  return ThreadBootstrapCoordinator.of({
    request,
    retry,
    stop,
    continue: continueBootstrap,
    recover,
  });
});

export const layer = Layer.effect(ThreadBootstrapCoordinator, make);
