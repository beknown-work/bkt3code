import { ProjectId } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): BEGIN — checked-in t3.json setup scripts run automatically.
import {
  projectScriptFromFileScript,
  projectScriptRuntimeEnv,
  setupProjectScript,
  setupT3ProjectFileScript,
} from "@t3tools/shared/projectScripts";
// T3-CUSTOM(expbkt3): END
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
// T3-CUSTOM(expbkt3): BEGIN — checked-in t3.json setup scripts run automatically.
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

/**
 * Synthetic id for the setup script a repository declares in `t3.json`. It has
 * no persisted record, so the id only has to be stable: it names the default
 * setup terminal and appears in bootstrap receipts.
 */
const T3_PROJECT_FILE_SETUP_SCRIPT_ID = "t3-json-setup";
// T3-CUSTOM(expbkt3): END

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

// T3-CUSTOM(expbkt3): BEGIN — durable bootstrap observes setup launch and completion.
export interface ProjectSetupScriptRunnerResultCompleted {
  readonly status: "completed";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly exitCode: 0;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultCompleted;

export interface ProjectSetupScriptRunnerStarted {
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  readonly onStarted?: (started: ProjectSetupScriptRunnerStarted) => Effect.Effect<void>;
}
// T3-CUSTOM(expbkt3): END

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    // T3-CUSTOM(expbkt3): BEGIN — launch failures identify the retained setup terminal.
    operation: Schema.Literals(["resolveProject", "runCommand"]),
    // whose retained history the caller may expose.
    terminalId: Schema.optional(Schema.String),
    // T3-CUSTOM(expbkt3): END
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

// T3-CUSTOM(expbkt3): BEGIN — setup completion failures remain typed and inspectable.
export class ProjectSetupScriptCommandError extends Schema.TaggedErrorClass<ProjectSetupScriptCommandError>()(
  "ProjectSetupScriptCommandError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    terminalId: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
    exitSignal: Schema.NullOr(Schema.Int),
    detail: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Project setup script failed in terminal '${this.terminalId}' for thread '${this.threadId}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}
// T3-CUSTOM(expbkt3): END

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
  // T3-CUSTOM(expbkt3): BEGIN — completion-aware setup failure.
  ProjectSetupScriptCommandError,
  // T3-CUSTOM(expbkt3): END
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

// T3-CUSTOM(expbkt3): BEGIN — setup is completion-aware and preserves an interactive
// terminal identity so durable bootstrap can gate, retry, stop, and inspect it.
export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projectFileLoader = yield* T3ProjectFileLoader.T3ProjectFileLoader;

  /**
   * The setup script a repository declares in its checked-in `t3.json`, if any.
   * Loading is infallible: a missing, unreadable, or invalid file resolves to
   * `Option.none`, and so to no script.
   */
  const t3ProjectFileSetupScript = Effect.fn("ProjectSetupScriptRunner.t3ProjectFileSetupScript")(
    function* (workspaceRoot: string) {
      const projectFile = yield* projectFileLoader.load(workspaceRoot);
      const fileScript = setupT3ProjectFileScript(Option.getOrUndefined(projectFile)?.scripts);
      return fileScript === null
        ? null
        : projectScriptFromFileScript(T3_PROJECT_FILE_SETUP_SCRIPT_ID, fileScript);
    },
  );

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    // A project script the user configured always wins; the repository's
    // checked-in t3.json is the fallback, so a repo that ships its setup action
    // works in a fresh worktree without a per-environment manual import.
    const script =
      setupProjectScript(project.scripts) ??
      (yield* t3ProjectFileSetupScript(project.workspaceRoot));
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });

    const completion = yield* terminalManager
      .runCommand({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
        command: script.command,
        ...(input.onStarted
          ? {
              onStarted: () =>
                input.onStarted!({
                  scriptId: script.id,
                  scriptName: script.name,
                  terminalId,
                  cwd,
                }),
            }
          : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "runCommand",
              terminalId,
              cause,
            }),
        ),
      );
    if (completion.exitCode !== 0 || completion.exitSignal !== null || completion.error !== null) {
      return yield* new ProjectSetupScriptCommandError({
        ...errorContext,
        terminalId,
        exitCode: completion.exitCode,
        exitSignal: completion.exitSignal,
        detail: completion.error,
      });
    }

    return {
      status: "completed",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
      exitCode: 0,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});
// T3-CUSTOM(expbkt3): END

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
