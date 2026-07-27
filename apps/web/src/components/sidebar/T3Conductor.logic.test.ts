/**
 * T3-CUSTOM(expbkt3): Focused policy tests for the permanent Conductor seam.
 */
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import {
  buildT3ConductorBootstrapPrompt,
  deriveT3ConductorThreadId,
  isT3ConductorThread,
  resolveT3ConductorThreadId,
  resolveT3ConductorStatus,
} from "./T3Conductor.logic";

describe("T3 Conductor thread identity", () => {
  it("converges across callers and changes only with its environment or workspace", () => {
    const first = deriveT3ConductorThreadId("primary", "/workspace/t3/");

    expect(deriveT3ConductorThreadId("primary", "/workspace/t3")).toBe(first);
    expect(deriveT3ConductorThreadId("secondary", "/workspace/t3")).not.toBe(first);
    expect(deriveT3ConductorThreadId("primary", "/workspace/other")).not.toBe(first);
  });

  it("preserves an already provisioned durable identity", () => {
    expect(
      resolveT3ConductorThreadId({
        configuredThreadId: "existing-conductor",
        environmentId: "primary",
        workspacePath: "/workspace/t3",
      }),
    ).toBe("existing-conductor");
  });
});

describe("buildT3ConductorBootstrapPrompt", () => {
  it("binds the durable identity, workspace, native tools, and operator personality", () => {
    const prompt = buildT3ConductorBootstrapPrompt({
      workspacePath: "/workspace/t3",
      personalityInstructions: "Call out stale work.",
    });

    expect(prompt).toContain("permanent master orchestration agent");
    expect(prompt).toContain("/workspace/t3");
    expect(prompt).toContain("native T3 Code MCP tools");
    expect(prompt).toContain("Never archive or delete it");
    expect(prompt).toContain("Call out stale work.");
  });
});

describe("isT3ConductorThread", () => {
  const conductor = {
    ...DEFAULT_SERVER_SETTINGS.experimental.t3Conductor,
    threadId: "conductor-1",
    enabled: true,
  };

  it("reserves only the configured primary-environment thread", () => {
    expect(
      isT3ConductorThread(conductor, "primary", {
        environmentId: "primary",
        id: "conductor-1",
      }),
    ).toBe(true);
    expect(
      isT3ConductorThread(conductor, "primary", {
        environmentId: "secondary",
        id: "conductor-1",
      }),
    ).toBe(false);
  });
});

describe("resolveT3ConductorStatus", () => {
  const thread = {
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    session: null,
  };

  it("prioritizes human input above runtime state", () => {
    expect(resolveT3ConductorStatus({ ...thread, hasPendingUserInput: true }, null, null)).toEqual({
      label: "Needs your answer",
      tone: "attention",
    });
  });

  it("shows an active provisioning operation before a thread exists", () => {
    expect(resolveT3ConductorStatus(null, "Taking the podium", null)).toEqual({
      label: "Taking the podium",
      tone: "active",
    });
  });

  it("surfaces provisioning errors", () => {
    expect(resolveT3ConductorStatus(thread, null, "Workspace not found")).toEqual({
      label: "Needs recovery",
      tone: "error",
    });
  });
});
