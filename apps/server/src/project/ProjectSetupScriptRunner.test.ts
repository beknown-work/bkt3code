import { describe, expect, it, vi } from "@effect/vitest";
import { type OrchestrationProject, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);
// T3-CUSTOM(expbkt3): completion-aware setup runner coverage.
const isProjectSetupScriptCommandError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptCommandError,
);

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  threadCreationDefaults: {
    environmentMode: null,
    worktreeBaseRef: null,
    runtimeMode: null,
    interactionMode: null,
  },
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ownerUserId: null,
  memberUserIds: [],
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    // T3-CUSTOM(expbkt3): required bounded projection-query test doubles.
    getSessionListDetails: () => Effect.succeed([]),
    listLatestProposedPlansForActiveThreads: () => Effect.succeed([]),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadAccessById: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.die("unused"),
    listThreadShellsByProjectId: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

const makeTerminalManagerLayer = (
  runCommand: TerminalManager.TerminalManager["Service"]["runCommand"],
) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    runCommand,
    stopCommand: () => Effect.void,
    open: () => Effect.die(new Error("unused")),
    write: () => Effect.die(new Error("unused")),
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    hasRunningCommand: () => Effect.succeed(false),
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const testLayer = (
  project: OrchestrationProject,
  runCommand: TerminalManager.TerminalManager["Service"]["runCommand"],
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(runCommand)),
  );

describe("ProjectSetupScriptRunner", () => {
  it.effect("returns no-script when no setup script exists", () => {
    const runCommand = vi.fn(() => Effect.die("unexpected runCommand"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(runCommand).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, runCommand)));
  });

  it.effect("runs the setup command to completion in the deterministic terminal", () => {
    const onStarted = vi.fn(() => Effect.void);
    const runCommand = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["runCommand"]>[0]) =>
        (input.onStarted?.() ?? Effect.void).pipe(
          Effect.as({
            threadId: "thread-1",
            terminalId: "setup-setup",
            exitCode: 0,
            exitSignal: null,
            error: null,
          }),
        ),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        onStarted,
      });

      expect(result).toEqual({
        status: "completed",
        scriptId: "setup",
        scriptName: "Setup",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        exitCode: 0,
      });
      expect(runCommand).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
        },
        command: "bun install",
        onStarted: expect.any(Function),
      });
      expect(onStarted).toHaveBeenCalledWith({
        scriptId: "setup",
        scriptName: "Setup",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
      });
    }).pipe(Effect.provide(testLayer(project, runCommand)));
  });

  it.effect("returns a typed failure and terminal identity for a non-zero exit", () => {
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "./tools/setup.sh",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
          preferredTerminalId: "setup-bootstrap-1-2",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptCommandError(error)).toBe(true);
      if (isProjectSetupScriptCommandError(error)) {
        expect(error.terminalId).toBe("setup-bootstrap-1-2");
        expect(error.exitCode).toBe(17);
        expect(error.exitSignal).toBeNull();
      }
    }).pipe(
      Effect.provide(
        testLayer(project, () =>
          Effect.succeed({
            threadId: "thread-1",
            terminalId: "setup-bootstrap-1-2",
            exitCode: 17,
            exitSignal: null,
            error: null,
          }),
        ),
      ),
    );
  });

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("runCommand");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(Effect.provide(testLayer(project, () => Effect.fail(terminalError))));
  });
});
