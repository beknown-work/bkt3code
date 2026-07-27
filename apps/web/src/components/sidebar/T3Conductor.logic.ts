/**
 * T3-CUSTOM(expbkt3): Pure presentation and bootstrap helpers for the
 * permanent experimental T3 Conductor. Keeping policy here makes the small
 * upstream sidebar seam straightforward to merge and independently test.
 */
import type { OrchestrationThreadShell, T3ConductorSettings } from "@t3tools/contracts";

export const T3_CONDUCTOR_TITLE = "T3 Conductor";

export function isT3ConductorThread(
  conductor: T3ConductorSettings,
  primaryEnvironmentId: string | null,
  thread: { readonly environmentId: string; readonly id: string },
): boolean {
  return (
    conductor.threadId.length > 0 &&
    primaryEnvironmentId !== null &&
    thread.environmentId === primaryEnvironmentId &&
    thread.id === conductor.threadId
  );
}

export function buildT3ConductorBootstrapPrompt(input: {
  readonly workspacePath: string;
  readonly personalityInstructions: string;
}): string {
  const additionalInstructions = input.personalityInstructions.trim();
  return [
    "You are T3 Conductor, the permanent master orchestration agent for this T3 Code installation.",
    `Your home workspace is ${input.workspacePath}.`,
    "",
    "Your standing mission:",
    "- Maintain an operator-level view of all T3 Code sessions and projects.",
    "- Use the native T3 Code MCP tools to inspect active work, catch-ups, approvals, questions, failures, and completed outcomes.",
    "- Surface sessions needing human attention first, then help prioritize and unblock the rest.",
    "- Help the user organize day-to-day work, delegate clearly, and keep session titles and next actions relevant.",
    "- Preserve this Conductor conversation as the long-lived coordination home. Never archive or delete it.",
    "- Be proactive, but do not approve risky actions or make unrelated changes without clear user intent.",
    ...(additionalInstructions
      ? ["", "Operator personality instructions:", additionalInstructions]
      : []),
    "",
    "This is your initialization turn. Briefly introduce yourself, inspect the available T3 session overview, and give the user a concise readiness briefing.",
  ].join("\n");
}

export interface T3ConductorStatusPresentation {
  readonly label: string;
  readonly tone: "neutral" | "active" | "attention" | "error";
}

export function resolveT3ConductorStatus(
  thread: Pick<
    OrchestrationThreadShell,
    "hasPendingUserInput" | "hasPendingApprovals" | "session"
  > | null,
  operationLabel: string | null,
  error: string | null,
): T3ConductorStatusPresentation {
  if (error) return { label: "Needs recovery", tone: "error" };
  if (operationLabel) return { label: operationLabel, tone: "active" };
  if (!thread) return { label: "Initializing", tone: "active" };
  if (thread.hasPendingUserInput) {
    return { label: "Needs your answer", tone: "attention" };
  }
  if (thread.hasPendingApprovals) {
    return { label: "Approval waiting", tone: "attention" };
  }
  switch (thread.session?.status) {
    case "running":
    case "starting":
      return { label: "Coordinating", tone: "active" };
    case "error":
      return { label: "Session error", tone: "error" };
    case "stopped":
    case "interrupted":
      return { label: "Waking up", tone: "active" };
    case "idle":
    case "ready":
      return { label: "Standing by", tone: "neutral" };
    default:
      return { label: "Ready for direction", tone: "neutral" };
  }
}
