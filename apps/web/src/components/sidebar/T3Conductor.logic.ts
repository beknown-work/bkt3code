/**
 * T3-CUSTOM(expbkt3): Pure presentation and bootstrap helpers for the
 * permanent experimental T3 Conductor. Keeping policy here makes the small
 * upstream sidebar seam straightforward to merge and independently test.
 */
import {
  ThreadId,
  type OrchestrationThreadShell,
  type T3ConductorSettings,
} from "@t3tools/contracts";

export const T3_CONDUCTOR_TITLE = "T3 Conductor";
const LINEAR_ISSUE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*-\d+$/i;
const LINEAR_ISSUE_URL_PATTERN =
  /^https:\/\/linear\.app\/([a-z0-9][a-z0-9-]*)\/issue\/([a-z][a-z0-9]*-\d+)(?:\/[^?#\s]*)?(?:[?#].*)?$/i;

export interface T3ConductorLinearIssue {
  readonly identifier: string;
  readonly url: string;
}

/**
 * Accepts the compact identifier people normally paste from Linear, or a
 * complete Linear issue URL. Bare identifiers use BeKnown's workspace while
 * full URLs preserve their own Linear workspace.
 */
export function resolveT3ConductorLinearIssue(value: string): T3ConductorLinearIssue | null {
  const candidate = value.trim();
  if (!candidate) return null;

  if (LINEAR_ISSUE_IDENTIFIER_PATTERN.test(candidate)) {
    const identifier = candidate.toUpperCase();
    return {
      identifier,
      url: `https://linear.app/beknown/issue/${identifier}`,
    };
  }

  const match = LINEAR_ISSUE_URL_PATTERN.exec(candidate);
  if (!match) return null;
  const workspace = match[1]!;
  const identifier = match[2]!.toUpperCase();
  return {
    identifier,
    url: `https://linear.app/${workspace}/issue/${identifier}`,
  };
}

/**
 * Produces one installation/workspace-scoped identity without relying on a
 * settings round trip. Multiple tabs therefore converge on the same thread
 * even when they all observe an empty setting during initial provisioning.
 */
export function deriveT3ConductorThreadId(environmentId: string, workspacePath: string): ThreadId {
  const input = `${environmentId}\0${workspacePath.trim().replaceAll("\\", "/").replace(/\/+$/, "")}`;
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const multipliers = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex += 1) {
      const multiplied = Math.imul(hashes[hashIndex]! ^ code, multipliers[hashIndex]!);
      hashes[hashIndex] = multiplied ^ (multiplied >>> 13);
    }
  }

  const hex = hashes.map((hash) => (hash >>> 0).toString(16).padStart(8, "0")).join("");
  return ThreadId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`,
  );
}

export function resolveT3ConductorThreadId(input: {
  readonly configuredThreadId: string;
  readonly environmentId: string;
  readonly workspacePath: string;
}): ThreadId {
  const configuredThreadId = input.configuredThreadId.trim();
  return configuredThreadId
    ? ThreadId.make(configuredThreadId)
    : deriveT3ConductorThreadId(input.environmentId, input.workspacePath);
}

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
  readonly linearIssueUrl?: string;
}): string {
  const additionalInstructions = input.personalityInstructions.trim();
  const linearIssue = resolveT3ConductorLinearIssue(input.linearIssueUrl ?? "");
  return [
    "You are T3 Conductor, the permanent master orchestration agent for this T3 Code installation.",
    `Your home workspace is ${input.workspacePath}.`,
    ...(linearIssue
      ? [
          `Your dedicated Linear coordination ticket is ${linearIssue.identifier}: ${linearIssue.url}.`,
        ]
      : []),
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
