/**
 * T3-CUSTOM(expbkt3): Authorization scopes for fork-only RPC methods.
 *
 * Upstream owns `RPC_REQUIRED_SCOPES` in `RpcAuthorization.ts`, and every method
 * in `WsRpcGroup` must appear there or `requiredScopeForRpcMethod` throws. The
 * fork's methods are declared here and spread in through a single seam so the
 * upstream table stays a one-line fork diff.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ORCHESTRATION_WS_METHODS,
  WS_FORK_METHODS,
} from "@t3tools/contracts";

export const FORK_RPC_REQUIRED_SCOPES = {
  [ORCHESTRATION_WS_METHODS.stopExecution]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.replayEvents]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.personalMcpGetProfile]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.personalMcpUpdateProfile]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.personalMcpRotateToken]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.personalMcpRevokeToken]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.subscribeServerResources]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.subscribeProviderRateLimits]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.sourceControlProfilesList]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.sourceControlProfilesUpsert]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesTest]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesReplaceCredential]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesDisconnect]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlProfilesArchive]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlThreadOwnerSet]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sourceControlConvertRemote]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.usersList]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.usersUpdate]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.usersRevokeSessions]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.usersSourceControlProfileSet]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.linearIssuesResolve]: AuthOrchestrationReadScope,
  // T3-CUSTOM(expbkt3): archived-session worktree reclaim. Scanning is a read;
  // exporting writes files and reclaiming deletes them, so both need operate.
  [WS_FORK_METHODS.sessionArchiveScan]: AuthOrchestrationReadScope,
  [WS_FORK_METHODS.sessionArchiveExport]: AuthOrchestrationOperateScope,
  [WS_FORK_METHODS.sessionArchiveReclaim]: AuthOrchestrationOperateScope,
} as const;
