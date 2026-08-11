import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import { type OrchestrationProject, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);
// T3-CUSTOM(expbkt3): completion-aware setup runner coverage.
const isProjectSetupScriptCommandError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptCommandError,
);

const makeProject = (
  scripts: OrchestrationProject["scripts"],
  workspaceRoot = "/repo/project",
): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot,
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
    // T3-CUSTOM(expbkt3): the t3.json setup fallback reads the real workspace root.
    Layer.provideMerge(T3ProjectFileLoader.layer),
    Layer.provideMerge(NodeServices.layer),
  );

// T3-CUSTOM(expbkt3): BEGIN — checked-in t3.json setup script coverage.
const makeWorkspaceRoot = Effect.fn("makeWorkspaceRoot")(function* (t3ProjectFile?: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaceRoot = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "t3code-setup-script-" })
    .pipe(Effect.orDie);
  if (t3ProjectFile !== undefined) {
    yield* fileSystem
      .writeFileString(path.join(workspaceRoot, "t3.json"), t3ProjectFile)
      .pipe(Effect.orDie);
  }
  return workspaceRoot;
});

const succeedingRunCommand = (terminalId: string) =>
  vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["runCommand"]>[0]) =>
    (input.onStarted?.() ?? Effect.void).pipe(
      Effect.as({
        threadId: "thread-1",
        terminalId,
        exitCode: 0,
        exitSignal: null,
        error: null,
      }),
    ),
  );
// T3-CUSTOM(expbkt3): END

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

  // T3-CUSTOM(expbkt3): BEGIN — a repository can ship its setup action in t3.json.
  it.effect("prefers a persisted setup script over the one declared in t3.json", () => {
    const runCommand = succeedingRunCommand("setup-setup");

    return Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspaceRoot(
        `{ "scripts": [
           { "name": "From t3.json", "command": "./tools/from-t3-json.sh", "runOnWorktreeCreate": true }
         ] }`,
      );
      const project = makeProject(
        [
          {
            id: "setup",
            name: "Setup",
            command: "bun install",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
        workspaceRoot,
      );

      const result = yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        return yield* runner.runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        });
      }).pipe(Effect.provide(testLayer(project, runCommand)));

      expect(result).toMatchObject({
        status: "completed",
        scriptId: "setup",
        scriptName: "Setup",
      });
      expect(runCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command: "bun install", terminalId: "setup-setup" }),
      );
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("runs the t3.json setup script when the project has no persisted script", () => {
    const runCommand = succeedingRunCommand("setup-t3-json-setup");
    const onStarted = vi.fn(() => Effect.void);

    return Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspaceRoot(
        `{ "scripts": [
           { "name": "Install", "command": "bun install" },
           { "name": "Bootstrap", "command": "./tools/setup.sh", "runOnWorktreeCreate": true }
         ] }`,
      );
      const project = makeProject([], workspaceRoot);

      const result = yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        return yield* runner.runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
          onStarted,
        });
      }).pipe(Effect.provide(testLayer(project, runCommand)));

      expect(result).toEqual({
        status: "completed",
        scriptId: "t3-json-setup",
        scriptName: "Bootstrap",
        terminalId: "setup-t3-json-setup",
        cwd: "/repo/worktrees/a",
        exitCode: 0,
      });
      expect(runCommand).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-t3-json-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: workspaceRoot,
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
        },
        command: "./tools/setup.sh",
        onStarted: expect.any(Function),
      });
      expect(onStarted).toHaveBeenCalledWith({
        scriptId: "t3-json-setup",
        scriptName: "Bootstrap",
        terminalId: "setup-t3-json-setup",
        cwd: "/repo/worktrees/a",
      });
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("returns no-script when the workspace has no t3.json", () => {
    const runCommand = vi.fn(() => Effect.die("unexpected runCommand"));

    return Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspaceRoot();
      const project = makeProject([], workspaceRoot);

      const result = yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        return yield* runner.runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        });
      }).pipe(Effect.provide(testLayer(project, runCommand)));

      expect(result).toEqual({ status: "no-script" });
      expect(runCommand).not.toHaveBeenCalled();
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("returns no-script when no t3.json script opts into worktree creation", () => {
    const runCommand = vi.fn(() => Effect.die("unexpected runCommand"));

    return Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspaceRoot(
        `{ "scripts": [
           { "name": "Dev", "command": "bun dev" },
           { "name": "Test", "command": "bun test", "runOnWorktreeCreate": false }
         ] }`,
      );
      const project = makeProject([], workspaceRoot);

      const result = yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        return yield* runner.runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        });
      }).pipe(Effect.provide(testLayer(project, runCommand)));

      expect(result).toEqual({ status: "no-script" });
      expect(runCommand).not.toHaveBeenCalled();
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("returns no-script for a malformed t3.json instead of failing", () => {
    const runCommand = vi.fn(() => Effect.die("unexpected runCommand"));

    return Effect.gen(function* () {
      const workspaceRoot = yield* makeWorkspaceRoot("{ not json");
      const project = makeProject([], workspaceRoot);

      const result = yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        return yield* runner.runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        });
      }).pipe(Effect.provide(testLayer(project, runCommand)));

      expect(result).toEqual({ status: "no-script" });
      expect(runCommand).not.toHaveBeenCalled();
    }).pipe(Effect.provide(NodeServices.layer));
  });
  // T3-CUSTOM(expbkt3): END
});
