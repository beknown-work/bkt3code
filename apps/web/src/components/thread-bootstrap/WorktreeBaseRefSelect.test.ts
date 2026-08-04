import type { VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorktreeBaseRefOptions,
  parseWorktreeBaseRefValue,
  worktreeBaseRefQueryTarget,
  worktreeBaseRefValue,
} from "./WorktreeBaseRefSelect";

const ref = (input: Partial<VcsRef> & Pick<VcsRef, "name">): VcsRef => ({
  current: false,
  isDefault: false,
  worktreePath: null,
  ...input,
});

describe("WorktreeBaseRefSelect", () => {
  it("requests matching origin refs so named remote branches are selectable", () => {
    expect(worktreeBaseRefQueryTarget(null, "/repo")).toEqual({
      environmentId: null,
      cwd: "/repo",
      includeMatchingRemoteRefs: true,
    });
  });

  it("keeps matching local and origin refs as distinct exact choices", () => {
    const options = buildWorktreeBaseRefOptions([
      ref({ name: "main", isDefault: true }),
      ref({
        name: "origin/main",
        isDefault: true,
        isRemote: true,
        remoteName: "origin",
      }),
    ]);

    expect(options).toEqual([
      {
        value: "local:main",
        label: "Local · main",
        baseRef: { kind: "branch", source: "local", branch: "main" },
      },
      {
        value: "origin:main",
        label: "Origin · main",
        baseRef: { kind: "branch", source: "origin", branch: "main" },
      },
    ]);
  });

  it("round-trips inherited, repository-default, and exact refs", () => {
    expect(parseWorktreeBaseRefValue("inherit")).toBeNull();
    expect(parseWorktreeBaseRefValue("default:origin")).toEqual({
      kind: "repository-default",
      source: "origin",
    });
    expect(parseWorktreeBaseRefValue("local:release/next")).toEqual({
      kind: "branch",
      source: "local",
      branch: "release/next",
    });
    expect(worktreeBaseRefValue({ kind: "branch", source: "origin", branch: "release/next" })).toBe(
      "origin:release/next",
    );
  });
});
