// T3-CUSTOM(expbkt3): sidebar "Create new thread" bootstrap input coverage.
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNewThreadFromRowBootstrapInput,
  NEW_THREAD_FROM_ROW_TITLE,
  newThreadFromRowBootstrapId,
  type NewThreadParentThread,
} from "./NewThreadFromRow.logic";

const CREATED_AT = "2026-08-10T12:00:00.000Z";
const NEW_THREAD_ID = ThreadId.make("thread-new");

function parent(overrides: Partial<NewThreadParentThread> = {}): NewThreadParentThread {
  return {
    id: ThreadId.make("thread-parent"),
    projectId: ProjectId.make("project-1"),
    branch: "feature/parent",
    worktreePath: "/home/dev/worktrees/repo/feature-parent",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    ...overrides,
  };
}

describe("buildNewThreadFromRowBootstrapInput", () => {
  it("parents the new thread and inherits the parent's model", () => {
    const input = buildNewThreadFromRowBootstrapInput({
      parent: parent(),
      threadId: NEW_THREAD_ID,
      choice: "same-worktree",
      createdAt: CREATED_AT,
    });

    expect(input.threadId).toBe(NEW_THREAD_ID);
    expect(input.parentThreadId).toBe(ThreadId.make("thread-parent"));
    expect(input.projectId).toBe(ProjectId.make("project-1"));
    expect(input.title).toBe(NEW_THREAD_FROM_ROW_TITLE);
    expect(input.bootstrapId).toBe(newThreadFromRowBootstrapId(NEW_THREAD_ID));
    expect(input.createdAt).toBe(CREATED_AT);
    expect(input.overrides?.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    });
    // Runtime and interaction mode stay with the server-resolved defaults.
    expect(input.overrides?.runtimeMode).toBeUndefined();
    expect(input.overrides?.interactionMode).toBeUndefined();
    // No first turn: the thread exists so the composer has somewhere to live.
    expect(input.initialTurn).toBeUndefined();
  });

  it("reuses the parent's worktree and branch", () => {
    const input = buildNewThreadFromRowBootstrapInput({
      parent: parent(),
      threadId: NEW_THREAD_ID,
      choice: "same-worktree",
      createdAt: CREATED_AT,
    });

    expect(input.overrides?.workspace).toEqual({
      mode: "existing-worktree",
      path: "/home/dev/worktrees/repo/feature-parent",
      branch: "feature/parent",
    });
  });

  it("falls back to the project checkout when the parent has no worktree", () => {
    const input = buildNewThreadFromRowBootstrapInput({
      parent: parent({ worktreePath: null, branch: "main" }),
      threadId: NEW_THREAD_ID,
      choice: "same-worktree",
      createdAt: CREATED_AT,
    });

    expect(input.overrides?.workspace).toEqual({ mode: "local" });
  });

  it("omits the branch when the parent worktree has none", () => {
    const input = buildNewThreadFromRowBootstrapInput({
      parent: parent({ branch: null }),
      threadId: NEW_THREAD_ID,
      choice: "same-worktree",
      createdAt: CREATED_AT,
    });

    expect(input.overrides?.workspace).toEqual({
      mode: "existing-worktree",
      path: "/home/dev/worktrees/repo/feature-parent",
    });
  });

  it("leaves the base ref to the project defaults for a new worktree", () => {
    const input = buildNewThreadFromRowBootstrapInput({
      parent: parent(),
      threadId: NEW_THREAD_ID,
      choice: "new-worktree",
      createdAt: CREATED_AT,
    });

    expect(input.overrides?.workspace).toEqual({ mode: "new-worktree" });
  });

  it("derives the bootstrap id from the thread so a double click is idempotent", () => {
    const first = buildNewThreadFromRowBootstrapInput({
      parent: parent(),
      threadId: NEW_THREAD_ID,
      choice: "new-worktree",
      createdAt: CREATED_AT,
    });
    const second = buildNewThreadFromRowBootstrapInput({
      parent: parent(),
      threadId: NEW_THREAD_ID,
      choice: "new-worktree",
      createdAt: "2026-08-10T12:00:05.000Z",
    });

    expect(second.bootstrapId).toBe(first.bootstrapId);
  });
});
