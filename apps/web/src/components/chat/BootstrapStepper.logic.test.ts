import { describe, expect, it } from "vite-plus/test";

import type { Thread } from "../../types";
import {
  deriveBootstrapSteps,
  type BootstrapPlan,
  type BootstrapStepId,
  type BootstrapStepStatus,
} from "./BootstrapStepper.logic";

const FULL_PLAN: BootstrapPlan = { createThread: true, worktree: true, setupScript: true };
const LOCAL_PLAN: BootstrapPlan = { createThread: true, worktree: false, setupScript: false };

// deriveBootstrapSteps only reads worktreePath / activities / latestTurn.
function fakeThread(partial: {
  worktreePath?: string | null;
  activities?: ReadonlyArray<{ kind: string }>;
  latestTurn?: unknown;
}): Thread {
  return {
    worktreePath: partial.worktreePath ?? null,
    activities: partial.activities ?? [],
    latestTurn: partial.latestTurn ?? null,
  } as unknown as Thread;
}

function statuses(
  steps: ReadonlyArray<{ id: BootstrapStepId; status: BootstrapStepStatus }>,
): Record<string, BootstrapStepStatus> {
  return Object.fromEntries(steps.map((step) => [step.id, step.status]));
}

describe("deriveBootstrapSteps", () => {
  it("marks create active and the rest pending before the thread exists", () => {
    const steps = deriveBootstrapSteps({ plan: FULL_PLAN, liveThread: null });
    expect(steps.map((step) => step.id)).toEqual(["create", "worktree", "setup", "agent"]);
    expect(statuses(steps)).toEqual({
      create: "active",
      worktree: "pending",
      setup: "pending",
      agent: "pending",
    });
  });

  it("advances to worktree once the thread exists", () => {
    const steps = deriveBootstrapSteps({ plan: FULL_PLAN, liveThread: fakeThread({}) });
    expect(statuses(steps)).toEqual({
      create: "done",
      worktree: "active",
      setup: "pending",
      agent: "pending",
    });
  });

  it("advances to setup once the worktree is ready", () => {
    const steps = deriveBootstrapSteps({
      plan: FULL_PLAN,
      liveThread: fakeThread({ worktreePath: "/tmp/wt" }),
    });
    expect(statuses(steps)).toEqual({
      create: "done",
      worktree: "done",
      setup: "active",
      agent: "pending",
    });
  });

  it("completes every step once the agent turn starts", () => {
    const steps = deriveBootstrapSteps({
      plan: FULL_PLAN,
      liveThread: fakeThread({ worktreePath: "/tmp/wt", latestTurn: { turnId: "t1" } }),
    });
    expect(statuses(steps)).toEqual({
      create: "done",
      worktree: "done",
      setup: "done",
      agent: "done",
    });
  });

  it("marks setup as error on setup-script.failed while the agent still proceeds", () => {
    const steps = deriveBootstrapSteps({
      plan: FULL_PLAN,
      liveThread: fakeThread({
        worktreePath: "/tmp/wt",
        activities: [{ kind: "setup-script.failed" }],
      }),
    });
    expect(statuses(steps)).toEqual({
      create: "done",
      worktree: "done",
      setup: "error",
      agent: "active",
    });
  });

  it("renders only create + agent for a local-only thread", () => {
    const steps = deriveBootstrapSteps({ plan: LOCAL_PLAN, liveThread: fakeThread({}) });
    expect(steps.map((step) => step.id)).toEqual(["create", "agent"]);
    expect(statuses(steps)).toEqual({ create: "done", agent: "active" });
  });
});
