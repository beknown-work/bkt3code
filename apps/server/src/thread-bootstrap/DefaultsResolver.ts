// T3-CUSTOM(expbkt3): one defaults hierarchy for web, HTTP, WebSocket, and MCP creation.
import type {
  OrchestrationProjectShell,
  ResolvedThreadBootstrapRequest,
  ServerSettings as ServerSettingsContract,
  ThreadBootstrapRequestCommand,
  VcsRef,
  WorktreeBaseRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";

export class ThreadCreationDefaultsResolutionError extends Data.TaggedError(
  "ThreadCreationDefaultsResolutionError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function resolveExactBranch(
  refs: ReadonlyArray<VcsRef>,
  baseRef: WorktreeBaseRef,
): WorktreeBaseRef | null {
  if (baseRef.kind === "repository-default") {
    const match = refs.find(
      (ref) =>
        // T3-CUSTOM(expbkt3): Git only reports a default branch from
        // origin/HEAD. A repository with no remotes still has a safe local
        // base: its checked-out branch.
        (ref.isDefault || (baseRef.source === "local" && ref.current)) &&
        (baseRef.source === "origin"
          ? ref.isRemote === true && ref.remoteName === "origin"
          : ref.isRemote !== true),
    );
    if (!match) return null;
    return {
      kind: "branch",
      source: baseRef.source,
      branch:
        baseRef.source === "origin" && match.name.startsWith("origin/")
          ? match.name.slice("origin/".length)
          : match.name,
    };
  }

  const expectedName = baseRef.source === "origin" ? `origin/${baseRef.branch}` : baseRef.branch;
  const match = refs.find(
    (ref) =>
      ref.name === expectedName &&
      (baseRef.source === "origin"
        ? ref.isRemote === true && ref.remoteName === "origin"
        : ref.isRemote !== true),
  );
  return match ? baseRef : null;
}

export function mergeThreadCreationDefaults(input: {
  readonly command: ThreadBootstrapRequestCommand;
  readonly project: OrchestrationProjectShell;
  readonly settings: ServerSettingsContract;
}): Omit<ResolvedThreadBootstrapRequest, "workspace"> & {
  readonly workspace:
    | { readonly mode: "local"; readonly path: string }
    | {
        readonly mode: "existing-worktree";
        readonly path: string;
        readonly branch?: string;
      }
    | {
        readonly mode: "new-worktree";
        readonly projectCwd: string;
        readonly baseRef: WorktreeBaseRef;
        readonly newBranch?: string;
      };
} {
  const { command, project, settings } = input;
  const projectDefaults = project.threadCreationDefaults ?? {
    environmentMode: null,
    worktreeBaseRef: null,
    runtimeMode: null,
    interactionMode: null,
  };
  const explicitWorkspace = command.overrides?.workspace;
  const environmentMode =
    explicitWorkspace?.mode === "new-worktree"
      ? "worktree"
      : explicitWorkspace?.mode === "local" || explicitWorkspace?.mode === "existing-worktree"
        ? "local"
        : (projectDefaults.environmentMode ?? settings.defaultThreadEnvMode);

  const workspace = explicitWorkspace
    ? explicitWorkspace.mode === "local"
      ? ({ mode: "local", path: project.workspaceRoot } as const)
      : explicitWorkspace.mode === "existing-worktree"
        ? ({
            mode: "existing-worktree",
            path: explicitWorkspace.path,
            ...(explicitWorkspace.branch ? { branch: explicitWorkspace.branch } : {}),
          } as const)
        : ({
            mode: "new-worktree",
            projectCwd: project.workspaceRoot,
            baseRef: explicitWorkspace.baseRef ??
              projectDefaults.worktreeBaseRef ?? {
                kind: "repository-default",
                source: settings.newWorktreesStartFromOrigin ? "origin" : "local",
              },
            ...(explicitWorkspace.newBranch ? { newBranch: explicitWorkspace.newBranch } : {}),
          } as const)
    : environmentMode === "local"
      ? ({ mode: "local", path: project.workspaceRoot } as const)
      : ({
          mode: "new-worktree",
          projectCwd: project.workspaceRoot,
          baseRef: projectDefaults.worktreeBaseRef ?? {
            kind: "repository-default",
            source: settings.newWorktreesStartFromOrigin ? "origin" : "local",
          },
        } as const);

  return {
    bootstrapId: command.bootstrapId,
    threadId: command.threadId,
    projectId: command.projectId,
    title: command.title,
    modelSelection:
      command.overrides?.modelSelection ??
      project.defaultModelSelection ??
      settings.defaultThreadModelSelection,
    runtimeMode:
      command.overrides?.runtimeMode ??
      projectDefaults.runtimeMode ??
      settings.defaultThreadRuntimeMode,
    interactionMode:
      command.overrides?.interactionMode ??
      projectDefaults.interactionMode ??
      settings.defaultThreadInteractionMode,
    workspace,
    ...(command.initialTurn ? { initialTurn: command.initialTurn } : {}),
    sourceControlProfileId: command.sourceControlProfileId ?? null,
    priority: command.priority ?? null,
    // T3-CUSTOM(expbkt3): session lineage survives bootstrap resolution.
    parentThreadId: command.parentThreadId ?? null,
    ...(command.ownerUserId ? { ownerUserId: command.ownerUserId } : {}),
    // T3-CUSTOM(expbkt3): inherited session tags survive bootstrap resolution.
    // An empty list is meaningful ("tag nobody"), so only an absent one is dropped.
    ...(command.memberUserIds !== undefined ? { memberUserIds: command.memberUserIds } : {}),
    createdAt: command.createdAt,
  };
}

export class ThreadCreationDefaultsResolver extends Context.Service<
  ThreadCreationDefaultsResolver,
  {
    readonly resolve: (
      command: ThreadBootstrapRequestCommand,
    ) => Effect.Effect<ResolvedThreadBootstrapRequest, ThreadCreationDefaultsResolutionError>;
  }
>()("t3/thread-bootstrap/DefaultsResolver/ThreadCreationDefaultsResolver") {}

const make = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  return ThreadCreationDefaultsResolver.of({
    resolve: (command) =>
      Effect.gen(function* () {
        const project = yield* snapshotQuery.getProjectShellById(command.projectId).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadCreationDefaultsResolutionError({
                message: "Failed to load the target project.",
                cause,
              }),
          ),
        );
        if (Option.isNone(project)) {
          return yield* new ThreadCreationDefaultsResolutionError({
            message: `Project ${command.projectId} was not found.`,
          });
        }

        const settings = yield* settingsService.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new ThreadCreationDefaultsResolutionError({
                message: "Failed to load app thread defaults.",
                cause,
              }),
          ),
        );
        const merged = mergeThreadCreationDefaults({
          command,
          project: project.value,
          settings,
        });
        // Repository I/O happens only after the request is durably queued, so
        // a slow fetch or stale ref becomes visible worktree-step progress.
        return merged;
      }),
  });
});

export const layer = Layer.effect(ThreadCreationDefaultsResolver, make);
