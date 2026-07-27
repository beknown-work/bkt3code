import type {
  EnvironmentId,
  PersonalMcpAuthMode,
  PersonalMcpIntegrationId,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";

export interface McpUpstreamServerConfig {
  readonly id: PersonalMcpIntegrationId;
  readonly name: string;
  readonly endpoint: string;
  readonly authMode: PersonalMcpAuthMode;
  readonly allowedTools: ReadonlyArray<string>;
}

export function upstreamMcpServerName(server: McpUpstreamServerConfig): string {
  return `t3_user_${server.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly actorUserId: UserId | null;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly upstreamServers: ReadonlyArray<McpUpstreamServerConfig>;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
