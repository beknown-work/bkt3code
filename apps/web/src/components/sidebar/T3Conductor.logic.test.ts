/**
 * T3-CUSTOM(expbkt3): Focused policy tests for the permanent Conductor seam.
 */
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import {
  buildT3ConductorBootstrapPrompt,
  isT3ConductorThread,
  resolveT3ConductorStatus,
} from "./T3Conductor.logic";

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
