import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ResolvedThreadBootstrapRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

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
import { ThreadBootstrapCoordinator, layer } from "./Coordinator.ts";
import { ThreadCreationDefaultsResolver } from "./DefaultsResolver.ts";

const NOW = "2026-08-03T00:00:00.000Z";

function resolvedRequest(): ResolvedThreadBootstrapRequest {
  return {
    bootstrapId: "bootstrap-1",
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspace: {
      mode: "new-worktree",
      projectCwd: "/repo/project",
      baseRef: { kind: "branch", source: "local", branch: "main" },
      newBranch: "t3code/bootstrap-1",
      intendedPath: "/tmp/worktrees/project/t3code-bootstrap-1",
    },
    initialTurn: {
      messageId: MessageId.make("message-1"),
      text: "Build it",
      attachments: [],
    },
    sourceControlProfileId: null,
    priority: null,
    createdAt: NOW,
  };
}

function requestCommand() {
  return {
    type: "thread.bootstrap.request" as const,
    commandId: CommandId.make("request-1"),
    bootstrapId: "bootstrap-1",
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    createdAt: NOW,
  };
}

function failedSetupBootstrap(): ProjectionThreadBootstrap {
  const request = resolvedRequest();
  return {
    threadId: request.threadId,
    bootstrapId: request.bootstrapId,
    status: "failed",
    progress: {
      id: request.bootstrapId,
      status: "failed",
      worktree: {
        status: "succeeded",
        attempt: 1,
        terminalId: null,
        exitCode: null,
        error: null,
        worktreePath: "/tmp/worktrees/project/t3code-bootstrap-1",
      },
      setup: {
        status: "failed",
        attempt: 1,
        terminalId: "setup-bootstrap-1-1",
        exitCode: 1,
        error: "Setup failed.",
        worktreePath: "/tmp/worktrees/project/t3code-bootstrap-1",
      },
      agent: {
        status: "pending",
        attempt: 0,
        terminalId: null,
        exitCode: null,
        error: null,
        worktreePath: null,
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    request,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function testLayer(input: {
  readonly commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly turnStarted: Deferred.Deferred<void>;
  readonly bootstrapCompleted: Deferred.Deferred<void>;
  readonly setup: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly request?: ResolvedThreadBootstrapRequest;
  readonly bootstrap?: ProjectionThreadBootstrap;
  readonly onCommand?: (command: OrchestrationCommand) => Effect.Effect<void>;
  readonly stopCommand?: TerminalManager.TerminalManager["Service"]["stopCommand"];
}) {
  return layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.mock(ThreadCreationDefaultsResolver)({
        resolve: () => Effect.succeed(input.request ?? resolvedRequest()),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
        dispatch: (command) =>
          Ref.update(input.commands, (commands) => [...commands, command]).pipe(
            Effect.andThen(
              command.type === "thread.turn.start"
                ? Deferred.succeed(input.turnStarted, undefined).pipe(Effect.asVoid)
                : command.type === "thread.bootstrap.complete"
                  ? Deferred.succeed(input.bootstrapCompleted, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            ),
            Effect.andThen(input.onCommand?.(command) ?? Effect.void),
            Effect.as({ sequence: 1 }),
          ),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        fetchRemote: () => Effect.void,
        listRefs: () =>
          Effect.succeed({
            refs: [
              {
                name: "main",
                current: true,
                isDefault: true,
                worktreePath: "/repo/project",
              },
            ],
            isRepo: true,
            hasPrimaryRemote: true,
            nextCursor: null,
            totalCount: 1,
          }),
        resolveRemoteTrackingCommit: () =>
          Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/main" }),
        createWorktree: () =>
          Effect.succeed({
            worktree: {
              path: "/tmp/worktrees/project/t3code-bootstrap-1",
              refName: "t3code/bootstrap-1",
            },
          }),
      } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
    ),
    Layer.provide(
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread: input.setup,
      }),
    ),
    Layer.provide(
      Layer.mock(TerminalManager.TerminalManager)({
        stopCommand: input.stopCommand ?? (() => Effect.void),
      } satisfies Partial<TerminalManager.TerminalManager["Service"]>),
    ),
    Layer.provide(
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshStatus: () =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: "t3code/bootstrap-1",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          }),
      } satisfies Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>),
    ),
    Layer.provide(
      Layer.mock(ProjectionThreadBootstrapRepository)({
        getByThreadId: () => Effect.succeed(Option.fromNullishOr(input.bootstrap)),
        listIncomplete: () => Effect.succeed([]),
      } satisfies Partial<ProjectionThreadBootstrapRepository["Service"]>),
    ),
    Layer.provide(
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        awaitCommandReady: Effect.void,
        markHttpListening: Effect.void,
        enqueueCommand: (effect) => effect,
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "thread-bootstrap-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
}

describe("ThreadBootstrapCoordinator", () => {
  it.effect("atomically accepts a durable turn without launching bootstrap side effects", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const turnStarted = yield* Deferred.make<void>();
      const bootstrapCompleted = yield* Deferred.make<void>();
      const dependencies = testLayer({
        commands,
        turnStarted,
        bootstrapCompleted,
        setup: () => Effect.die("setup must be owned by the durable execution coordinator"),
      });

      yield* Effect.gen(function* () {
        const coordinator = yield* ThreadBootstrapCoordinator;
        const originalTurn: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
          type: "thread.turn.start",
          commandId: CommandId.make("original-turn-command"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Build it",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        };
        yield* coordinator.request(requestCommand(), {
          createThread: true,
          turnStart: originalTurn,
        });
        yield* Deferred.await(turnStarted);

        const emitted = yield* Ref.get(commands);
        expect(emitted).toHaveLength(1);
        expect(emitted[0]?.type).toBe("thread.turn.start");
        if (emitted[0]?.type !== "thread.turn.start") return;
        expect(emitted[0].commandId).toBe(originalTurn.commandId);
        expect(emitted[0].bootstrap?.resolvedRequest?.bootstrapId).toBe("bootstrap-1");
        expect(emitted[0].bootstrap?.createThread?.projectId).toBe(ProjectId.make("project-1"));
      }).pipe(Effect.provide(dependencies));
    }),
  );

  it.effect("returns after queueing and gates the first turn on setup success", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const turnStarted = yield* Deferred.make<void>();
      const setupStarted = yield* Deferred.make<void>();
      const finishSetup = yield* Deferred.make<void>();
      const bootstrapCompleted = yield* Deferred.make<void>();
      const dependencies = testLayer({
        commands,
        turnStarted,
        bootstrapCompleted,
        setup: () =>
          Deferred.succeed(setupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishSetup)),
            Effect.as({
              status: "completed" as const,
              scriptId: "setup",
              scriptName: "Setup",
              terminalId: "setup-bootstrap-1-1",
              cwd: "/tmp/worktrees/project/t3code-bootstrap-1",
              exitCode: 0 as const,
            }),
          ),
      });

      yield* Effect.gen(function* () {
        const coordinator = yield* ThreadBootstrapCoordinator;
        const result = yield* coordinator.request(requestCommand());
        expect(result).toEqual({ sequence: 1 });
        yield* Deferred.await(setupStarted);
        expect(
          (yield* Ref.get(commands)).some((command) => command.type === "thread.turn.start"),
        ).toBe(false);

        yield* Deferred.succeed(finishSetup, undefined);
        yield* Deferred.await(turnStarted);
        yield* Deferred.await(bootstrapCompleted);
        const types = (yield* Ref.get(commands)).map((command) => command.type);
        expect(types.indexOf("thread.bootstrap.step.update")).toBeLessThan(
          types.indexOf("thread.turn.start"),
        );
        expect(types).toContain("thread.bootstrap.complete");
      }).pipe(Effect.provide(dependencies));
    }),
  );

  it.effect("adopts an existing empty thread without dispatching thread.create", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const turnStarted = yield* Deferred.make<void>();
      const bootstrapCompleted = yield* Deferred.make<void>();
      const dependencies = testLayer({
        commands,
        turnStarted,
        bootstrapCompleted,
        setup: () => Effect.succeed({ status: "no-script" as const }),
      });

      yield* Effect.gen(function* () {
        const coordinator = yield* ThreadBootstrapCoordinator;
        yield* coordinator.request(requestCommand(), { createThread: false });
        yield* Deferred.await(turnStarted);
        yield* Deferred.await(bootstrapCompleted);

        const dispatched = yield* Ref.get(commands);
        expect(dispatched.some((command) => command.type === "thread.create")).toBe(false);
        expect(
          dispatched.some((command) => command.type === "thread.bootstrap.request.record"),
        ).toBe(true);
        expect(dispatched.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          1,
        );
      }).pipe(Effect.provide(dependencies));
    }),
  );

  it.effect("keeps the first turn pending after a non-zero setup result", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const turnStarted = yield* Deferred.make<void>();
      const setupFailed = yield* Deferred.make<void>();
      const bootstrapCompleted = yield* Deferred.make<void>();
      const dependencies = testLayer({
        commands,
        turnStarted,
        bootstrapCompleted,
        setup: (input) =>
          Effect.fail(
            new ProjectSetupScriptRunner.ProjectSetupScriptCommandError({
              threadId: input.threadId,
              projectId: input.projectId,
              worktreePath: input.worktreePath,
              terminalId: input.preferredTerminalId ?? "setup-bootstrap-1-1",
              exitCode: 2,
              exitSignal: null,
              detail: "exit 2",
            }),
          ),
        onCommand: (command) =>
          command.type === "thread.bootstrap.step.update" &&
          command.step === "setup" &&
          command.status === "failed"
            ? Deferred.succeed(setupFailed, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });

      yield* Effect.gen(function* () {
        const coordinator = yield* ThreadBootstrapCoordinator;
        yield* coordinator.request(requestCommand());
        yield* Deferred.await(setupFailed);
        const emitted = yield* Ref.get(commands);
        expect(emitted.some((command) => command.type === "thread.turn.start")).toBe(false);
        expect(
          emitted.some(
            (command) =>
              command.type === "thread.bootstrap.step.update" &&
              command.step === "setup" &&
              command.status === "failed" &&
              command.exitCode === 2,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(dependencies));
    }),
  );

  it.effect("retries setup in a new terminal and starts exactly one pending turn", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const turnStarted = yield* Deferred.make<void>();
      const bootstrapCompleted = yield* Deferred.make<void>();
      const dependencies = testLayer({
        commands,
        turnStarted,
        bootstrapCompleted,
        bootstrap: failedSetupBootstrap(),
        setup: (input) =>
          Effect.succeed({
            status: "completed" as const,
            scriptId: "setup",
            scriptName: "Setup",
            terminalId: input.preferredTerminalId ?? "missing",
            cwd: input.worktreePath,
            exitCode: 0 as const,
          }),
      });

      yield* Effect.gen(function* () {
        const coordinator = yield* ThreadBootstrapCoordinator;
        yield* coordinator.retry({
          type: "thread.bootstrap.retry",
          commandId: CommandId.make("retry-setup"),
          threadId: ThreadId.make("thread-1"),
          bootstrapId: "bootstrap-1",
          step: "setup",
          createdAt: NOW,
        });
        yield* Deferred.await(turnStarted);
        yield* Deferred.await(bootstrapCompleted);
        const emitted = yield* Ref.get(commands);
        expect(
          emitted.some(
            (command) =>
              command.type === "thread.bootstrap.step.update" &&
              command.step === "setup" &&
              command.status === "running" &&
              command.terminalId === "setup-bootstrap-1-2",
          ),
        ).toBe(true);
        expect(emitted.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
      }).pipe(Effect.provide(dependencies));
    }),
  );

  it.effect("bypasses only a failed setup and starts the pending turn once", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const turnStarted = yield* Deferred.make<void>();
      const bootstrapCompleted = yield* Deferred.make<void>();
      const dependencies = testLayer({
        commands,
        turnStarted,
        bootstrapCompleted,
        bootstrap: failedSetupBootstrap(),
        setup: () => Effect.die("setup must not rerun while bypassing"),
      });

      yield* Effect.gen(function* () {
        const coordinator = yield* ThreadBootstrapCoordinator;
        yield* coordinator.continue({
          type: "thread.bootstrap.continue",
          commandId: CommandId.make("continue-setup"),
          threadId: ThreadId.make("thread-1"),
          bootstrapId: "bootstrap-1",
          createdAt: NOW,
        });
        yield* Deferred.await(turnStarted);
        yield* Deferred.await(bootstrapCompleted);
        const emitted = yield* Ref.get(commands);
        expect(
          emitted.some(
            (command) =>
              command.type === "thread.bootstrap.step.update" &&
              command.step === "setup" &&
              command.status === "bypassed",
          ),
        ).toBe(true);
        expect(emitted.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
      }).pipe(Effect.provide(dependencies));
    }),
  );

  it.effect("skips automatic setup for an explicitly supplied worktree", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const turnStarted = yield* Deferred.make<void>();
      const bootstrapCompleted = yield* Deferred.make<void>();
      let setupCalls = 0;
      const request: ResolvedThreadBootstrapRequest = {
        ...resolvedRequest(),
        workspace: {
          mode: "existing-worktree",
          path: "/repo/worktrees/existing",
          branch: "feature/existing",
        },
      };
      const dependencies = testLayer({
        commands,
        turnStarted,
        bootstrapCompleted,
        request,
        setup: () =>
          Effect.sync(() => {
            setupCalls += 1;
            return { status: "no-script" as const };
          }),
      });

      yield* Effect.gen(function* () {
        const coordinator = yield* ThreadBootstrapCoordinator;
        yield* coordinator.request(requestCommand());
        yield* Deferred.await(turnStarted);
        yield* Deferred.await(bootstrapCompleted);
        expect(setupCalls).toBe(0);
        const emitted = yield* Ref.get(commands);
        expect(
          emitted.some(
            (command) =>
              command.type === "thread.bootstrap.step.update" && command.step === "setup",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(dependencies));
    }),
  );
});
