import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type ThreadBootstrapRequestCommand,
  type VcsRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeThreadCreationDefaults, resolveExactBranch } from "./DefaultsResolver.ts";

const NOW = "2026-08-03T00:00:00.000Z";

function project(overrides: Partial<OrchestrationProjectShell> = {}): OrchestrationProjectShell {
  return {
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
    scripts: [],
    ownerUserId: null,
    memberUserIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function command(
  overrides: Partial<ThreadBootstrapRequestCommand> = {},
): ThreadBootstrapRequestCommand {
  return {
    type: "thread.bootstrap.request",
    commandId: CommandId.make("command-1"),
    bootstrapId: "bootstrap-1",
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    sourceControlProfileId: null,
    priority: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe("mergeThreadCreationDefaults", () => {
  it("merges each field using explicit then project then app precedence", () => {
    const resolved = mergeThreadCreationDefaults({
      command: command({
        initialTurn: {
          messageId: MessageId.make("message-1"),
          text: "Build it",
          attachments: [],
        },
        overrides: {
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-explicit"),
            model: "explicit-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          interactionMode: "default",
          workspace: {
            mode: "new-worktree",
            baseRef: { kind: "branch", source: "origin", branch: "release" },
          },
        },
      }),
      project: project({
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex-project"),
          model: "project-model",
        },
        threadCreationDefaults: {
          environmentMode: "local",
          worktreeBaseRef: { kind: "branch", source: "local", branch: "develop" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      }),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultThreadEnvMode: "worktree",
        newWorktreesStartFromOrigin: false,
        defaultThreadModelSelection: {
          instanceId: ProviderInstanceId.make("codex-app"),
          model: "app-model",
        },
        defaultThreadRuntimeMode: "full-access",
        defaultThreadInteractionMode: "plan",
      },
    });

    expect(resolved.modelSelection.model).toBe("explicit-model");
    expect(resolved.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(resolved.runtimeMode).toBe("approval-required");
    expect(resolved.interactionMode).toBe("default");
    expect(resolved.workspace).toEqual({
      mode: "new-worktree",
      projectCwd: "/repo/project",
      baseRef: { kind: "branch", source: "origin", branch: "release" },
    });
  });

  it("uses app defaults when the project inherits every field", () => {
    const resolved = mergeThreadCreationDefaults({
      command: command(),
      project: project(),
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultThreadEnvMode: "worktree",
        newWorktreesStartFromOrigin: true,
        defaultThreadRuntimeMode: "auto-accept-edits",
        defaultThreadInteractionMode: "plan",
      },
    });

    expect(resolved.workspace).toEqual({
      mode: "new-worktree",
      projectCwd: "/repo/project",
      baseRef: { kind: "repository-default", source: "origin" },
    });
    expect(resolved.runtimeMode).toBe("auto-accept-edits");
    expect(resolved.interactionMode).toBe("plan");
    expect(resolved.modelSelection).toEqual(DEFAULT_SERVER_SETTINGS.defaultThreadModelSelection);
  });

  it("treats supplied worktrees as existing and never as newly created worktrees", () => {
    const resolved = mergeThreadCreationDefaults({
      command: command({
        overrides: {
          workspace: {
            mode: "existing-worktree",
            path: "/repo/worktrees/existing",
            branch: "feature/existing",
          },
        },
      }),
      project: project(),
      settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
    });

    expect(resolved.workspace).toEqual({
      mode: "existing-worktree",
      path: "/repo/worktrees/existing",
      branch: "feature/existing",
    });
  });
});

describe("resolveExactBranch", () => {
  const refs: VcsRef[] = [
    { name: "main", current: true, isDefault: true, worktreePath: "/repo/project" },
    {
      name: "origin/main",
      isRemote: true,
      remoteName: "origin",
      current: false,
      isDefault: true,
      worktreePath: null,
    },
    {
      name: "origin/release",
      isRemote: true,
      remoteName: "origin",
      current: false,
      isDefault: false,
      worktreePath: null,
    },
  ];

  it("keeps local and origin repository defaults distinct", () => {
    expect(resolveExactBranch(refs, { kind: "repository-default", source: "local" })).toEqual({
      kind: "branch",
      source: "local",
      branch: "main",
    });
    expect(resolveExactBranch(refs, { kind: "repository-default", source: "origin" })).toEqual({
      kind: "branch",
      source: "origin",
      branch: "main",
    });
  });

  it("fails instead of substituting a missing configured branch", () => {
    expect(
      resolveExactBranch(refs, { kind: "branch", source: "origin", branch: "deleted" }),
    ).toBeNull();
  });
});
