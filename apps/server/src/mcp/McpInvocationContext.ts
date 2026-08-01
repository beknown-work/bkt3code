/**
 * T3-CUSTOM(expbkt3): Per-invocation capability and session-scope enforcement
 * for the experimental T3 MCP control plane.
 */
import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability =
  | "preview"
  | "t3.read"
  | "t3.control"
  | "t3.plan"
  | "t3.session.create"
  | "t3.project.create"
  | "t3.settings.manage";

export interface McpInvocationScope {
  readonly principal: "provider-session" | "external-user" | "external-operator";
  /** User whose authority and personal integrations back this invocation. */
  readonly actorUserId: UserId | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export function isExternalMcpOperator(scope: McpInvocationScope): boolean {
  return scope.principal === "external-operator";
}

export function canCreateMcpSessions(scope: McpInvocationScope): boolean {
  return scope.capabilities.has("t3.session.create") || isExternalMcpOperator(scope);
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
