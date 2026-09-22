// T3-CUSTOM(expbkt3): unattended setup cannot depend on a terminal renderer.
import { expect, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

it.effect("disables color probes while preserving setup input and completion callbacks", () => {
  const script = {
    id: "setup",
    name: "Setup",
    command: "vp i",
    icon: "configure" as const,
    runOnWorktreeCreate: true,
  };
  const project: OrchestrationProjectShell = {
    id: ProjectId.make("project"),
    title: "Project",
    workspaceRoot: "/project",
    defaultModelSelection: null,
    threadCreationDefaults: {
      environmentMode: null,
      worktreeBaseRef: null,
      runtimeMode: null,
      interactionMode: null,
    },
    scripts: [script],
    ownerUserId: null,
    memberUserIds: [],
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
  let started = false;
  let completed = false;
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread",
      projectId: project.id,
      worktreePath: "/worktree",
      preferredTerminalId: "setup-work-item",
      onStarted: () =>
        Effect.sync(() => {
          started = true;
        }),
    });
    expect(result.status).toBe("completed");
    expect(completed).toBe(true);
  }).pipe(
    Effect.provide(
      ProjectSetupScriptRunner.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
            getProjectShellById: () => Effect.succeed(Option.some(project)),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({})),
        Layer.provide(
          Layer.mock(TerminalManager.TerminalManager)({
            runCommand: (input) =>
              Effect.gen(function* () {
                expect(input.command).toBe("vp i");
                expect(input.terminalId).toBe("setup-work-item");
                expect(input.env).toEqual({
                  T3CODE_PROJECT_ROOT: "/project",
                  T3CODE_WORKTREE_PATH: "/worktree",
                  NO_COLOR: "1",
                });
                // Do not set CI: setup may legitimately request user input.
                expect(input.env).not.toHaveProperty("CI");
                yield* input.onStarted?.() ?? Effect.void;
                expect(started).toBe(true);
                completed = true;
                return {
                  threadId: input.threadId,
                  terminalId: input.terminalId,
                  exitCode: 0,
                  exitSignal: null,
                  error: null,
                };
              }),
          }),
        ),
      ),
    ),
  );
});
