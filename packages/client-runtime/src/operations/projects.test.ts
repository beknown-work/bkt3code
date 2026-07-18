import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  CommandId,
  SourceControlDiscoveryResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  buildAddProjectRemoteSourceReadiness,
  buildProjectCreateCommand,
  findExistingAddProject,
  getAddProjectInitialQuery,
  normalizeProjectNickname,
  resolveAddProjectPath,
  sortAddProjectProviderSources,
  suggestProjectNickname,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  it("resolves initial browse paths from settings", () => {
    expect(getAddProjectInitialQuery("")).toBe("~/");
    expect(getAddProjectInitialQuery("/work")).toBe("/work/");
    expect(getAddProjectInitialQuery("C:\\work")).toBe("C:\\work\\");
  });

  it("rejects unsupported windows paths on non-windows environments", () => {
    expect(
      resolveAddProjectPath({
        rawPath: "C:\\repo",
        platform: "MacIntel",
        currentProjectCwd: null,
      }),
    ).toEqual({
      ok: false,
      error: "Windows-style paths are only supported on Windows environments.",
    });
  });

  it("resolves relative paths from the active project cwd", () => {
    expect(
      resolveAddProjectPath({
        rawPath: "../next",
        platform: "Linux",
        currentProjectCwd: "/work/current",
      }),
    ).toEqual({ ok: true, path: "/work/next" });
  });

  it("marks authenticated source control providers as ready", () => {
    const discovery: SourceControlDiscoveryResult = {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          status: "available",
          installHint: "Install gh",
          version: Option.some("1.0.0"),
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("octo"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "gitlab",
          label: "GitLab",
          status: "available",
          installHint: "Install glab",
          version: Option.some("1.0.0"),
          detail: Option.none(),
          auth: {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.some("Run glab auth login"),
          },
        },
      ],
    };

    const readiness = buildAddProjectRemoteSourceReadiness(discovery);
    expect(readiness.url.ready).toBe(true);
    expect(readiness.github.ready).toBe(true);
    expect(readiness.gitlab).toEqual({ ready: false, hint: "Run glab auth login" });
    expect(sortAddProjectProviderSources(readiness)[0]).toBe("github");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        ownerUserId: null,
        memberUserIds: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        ownerUserId: null,
        memberUserIds: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });

  it("normalizes and validates project nicknames", () => {
    expect(normalizeProjectNickname("  My repo  ")).toBe("My repo");
    expect(normalizeProjectNickname("   ")).toBeNull();
  });

  it("suggests project nicknames from local paths", () => {
    expect(suggestProjectNickname({ workspaceRoot: "/work/t3-code/" })).toBe("t3-code");
    expect(suggestProjectNickname({ workspaceRoot: "C:\\work\\desktop-app\\" })).toBe(
      "desktop-app",
    );
    expect(
      suggestProjectNickname({ workspaceRoot: "\\\\server\\share\\repositories\\client" }),
    ).toBe("client");
  });

  it("suggests project nicknames from repository names and clone URLs", () => {
    expect(suggestProjectNickname({ repositoryName: "openai/codex" })).toBe("codex");
    expect(suggestProjectNickname({ remoteUrl: "https://github.com/openai/codex.git" })).toBe(
      "codex",
    );
    expect(suggestProjectNickname({ remoteUrl: "git@github.com:openai/codex.git" })).toBe("codex");
    expect(suggestProjectNickname({ remoteUrl: "   " })).toBe("Repository");
  });

  it("builds the existing project.create command shape", () => {
    expect(
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        title: "  My repository  ",
        workspaceRoot: "/work/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({
      type: "project.create",
      commandId: "command",
      projectId: "project",
      title: "My repository",
      workspaceRoot: "/work/repo",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
    });
  });

  it("rejects an empty explicit project nickname", () => {
    expect(() =>
      buildProjectCreateCommand({
        commandId: CommandId.make("command"),
        projectId: ProjectId.make("project"),
        title: "   ",
        workspaceRoot: "/work/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("Project nickname must not be empty");
  });
});
