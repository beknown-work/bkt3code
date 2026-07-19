/**
 * BootstrapStepper.logic - pure derivation of new-thread bootstrap progress.
 *
 * When a user sends the first message in a new thread, the server runs a
 * multi-step bootstrap (create thread → prepare worktree → launch setup script
 * → start the turn) before the dispatch RPC resolves — ~15s during which the UI
 * would otherwise look frozen. `deriveBootstrapSteps` turns the live thread
 * (streamed independently of the RPC) plus the plan captured at dispatch time
 * into an ordered checklist the timeline renders.
 *
 * @module components/chat/BootstrapStepper.logic
 */
import type { Thread } from "../../types";

/**
 * Which stages this bootstrap will run, known client-side at dispatch time.
 * Captured up front because absence of a live signal (e.g. no worktreePath yet)
 * is otherwise ambiguous between "not expected" and "not arrived".
 */
export interface BootstrapPlan {
  readonly createThread: boolean;
  readonly worktree: boolean;
  readonly setupScript: boolean;
}

export type BootstrapStepId = "create" | "worktree" | "setup" | "agent";
export type BootstrapStepStatus = "pending" | "active" | "done" | "error";

export interface BootstrapStep {
  readonly id: BootstrapStepId;
  readonly label: string;
  readonly status: BootstrapStepStatus;
}

const STEP_LABEL: Record<BootstrapStepId, string> = {
  create: "Creating thread",
  worktree: "Preparing worktree",
  setup: "Running setup script",
  agent: "Starting agent",
};

/**
 * Derive the ordered bootstrap checklist from the plan + the live server thread
 * (which may still be `null` before `thread.created` streams in). Stages run in
 * order, so the first not-yet-terminal step is the "active" one and later steps
 * are "pending". Setup completion cannot be observed during bootstrap (the
 * server launches the script and returns immediately), so setup is marked done
 * once the agent stage begins — it reflects "launched", not "finished".
 */
export function deriveBootstrapSteps(input: {
  plan: BootstrapPlan;
  liveThread: Thread | null;
}): ReadonlyArray<BootstrapStep> {
  const { plan, liveThread } = input;
  const threadExists = liveThread !== null;
  const worktreeReady = (liveThread?.worktreePath ?? null) !== null;
  const activities = liveThread?.activities ?? [];
  const setupFailed = activities.some((activity) => activity.kind === "setup-script.failed");
  const agentStarted = (liveThread?.latestTurn ?? null) !== null;

  const specs: Array<{ id: BootstrapStepId; done: boolean; error: boolean }> = [];
  if (plan.createThread) {
    specs.push({ id: "create", done: threadExists, error: false });
  }
  if (plan.worktree) {
    specs.push({ id: "worktree", done: worktreeReady, error: false });
  }
  if (plan.setupScript) {
    specs.push({ id: "setup", done: agentStarted && !setupFailed, error: setupFailed });
  }
  specs.push({ id: "agent", done: agentStarted, error: false });

  let activeAssigned = false;
  return specs.map((spec) => {
    let status: BootstrapStepStatus;
    if (spec.error) {
      status = "error";
    } else if (spec.done) {
      status = "done";
    } else if (!activeAssigned) {
      status = "active";
      activeAssigned = true;
    } else {
      status = "pending";
    }
    return { id: spec.id, label: STEP_LABEL[spec.id], status };
  });
}
