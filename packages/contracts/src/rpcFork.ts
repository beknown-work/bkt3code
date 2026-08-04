/**
 * T3-CUSTOM(expbkt3): Fork websocket RPC definitions.
 *
 * Method names and RPC definitions that exist only in this fork: personal MCP,
 * source-control identity profiles, environment user management, server
 * resource + provider rate-limit streams, and the execution stop / event replay
 * orchestration RPCs. Upstream-owned `rpc.ts` merges these through a single
 * spread in `WS_METHODS` and one in `WsRpcGroup`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
  OrchestrationStopExecutionError,
} from "./orchestration.ts";
import {
  PersonalMcpProfile,
  PersonalMcpProfileUpdate,
  PersonalMcpSettingsError,
  PersonalMcpTokenResult,
} from "./personalMcp.ts";
import { LinearIssueStatusInput, LinearIssueStatusResult } from "./linearIssue.ts";
import { ProviderRateLimitsStreamSnapshot } from "./providerRateLimits.ts";
import { ServerResourceSample } from "./server.ts";
import {
  GitHubSourceControlProfile,
  SourceControlProfileArchiveInput,
  SourceControlProfileError,
  SourceControlProfileIdInput,
  SourceControlProfileReplaceCredentialInput,
  SourceControlProfileUpsertInput,
  SourceControlProfilesListResult,
  SourceControlConvertRemoteInput,
  SourceControlConvertRemoteResult,
  SourceControlThreadOwnerSetInput,
} from "./sourceControlProfiles.ts";
import {
  EnvironmentUser,
  EnvironmentUserDirectoryResult,
  EnvironmentUserIdInput,
  EnvironmentUserManagementError,
  EnvironmentUserSourceControlProfileSetInput,
  EnvironmentUserUpdateInput,
} from "./users.ts";

export const WS_FORK_METHODS = {
  personalMcpGetProfile: "personalMcp.getProfile",
  personalMcpUpdateProfile: "personalMcp.updateProfile",
  personalMcpRotateToken: "personalMcp.rotateToken",
  personalMcpRevokeToken: "personalMcp.revokeToken",
  sourceControlProfilesList: "sourceControl.profiles.list",
  sourceControlProfilesUpsert: "sourceControl.profiles.upsert",
  sourceControlProfilesTest: "sourceControl.profiles.test",
  sourceControlProfilesReplaceCredential: "sourceControl.profiles.replaceCredential",
  sourceControlProfilesDisconnect: "sourceControl.profiles.disconnect",
  sourceControlProfilesArchive: "sourceControl.profiles.archive",
  sourceControlThreadOwnerSet: "sourceControl.threadOwner.set",
  sourceControlConvertRemote: "sourceControl.remote.convertToHttps",
  usersList: "users.list",
  usersUpdate: "users.update",
  usersRevokeSessions: "users.revokeSessions",
  usersSourceControlProfileSet: "users.sourceControlProfile.set",
  subscribeServerResources: "subscribeServerResources",
  subscribeProviderRateLimits: "subscribeProviderRateLimits",
  linearIssuesResolve: "linearIssues.resolve",
} as const;

export const WsPersonalMcpGetProfileRpc = Rpc.make(WS_FORK_METHODS.personalMcpGetProfile, {
  payload: Schema.Struct({}),
  success: PersonalMcpProfile,
  error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
});

export const WsPersonalMcpUpdateProfileRpc = Rpc.make(WS_FORK_METHODS.personalMcpUpdateProfile, {
  payload: PersonalMcpProfileUpdate,
  success: PersonalMcpProfile,
  error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
});

export const WsPersonalMcpRotateTokenRpc = Rpc.make(WS_FORK_METHODS.personalMcpRotateToken, {
  payload: Schema.Struct({}),
  success: PersonalMcpTokenResult,
  error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
});

export const WsPersonalMcpRevokeTokenRpc = Rpc.make(WS_FORK_METHODS.personalMcpRevokeToken, {
  payload: Schema.Struct({}),
  success: PersonalMcpProfile,
  error: Schema.Union([PersonalMcpSettingsError, EnvironmentAuthorizationError]),
});

export const WsSourceControlProfilesListRpc = Rpc.make(WS_FORK_METHODS.sourceControlProfilesList, {
  payload: Schema.Struct({}),
  success: SourceControlProfilesListResult,
  error: Schema.Union([SourceControlProfileError, EnvironmentAuthorizationError]),
});

export const WsSourceControlProfilesUpsertRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlProfilesUpsert,
  {
    payload: SourceControlProfileUpsertInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([
      SourceControlProfileError,
      EnvironmentUserManagementError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsSourceControlProfilesTestRpc = Rpc.make(WS_FORK_METHODS.sourceControlProfilesTest, {
  payload: SourceControlProfileIdInput,
  success: GitHubSourceControlProfile,
  error: Schema.Union([
    SourceControlProfileError,
    EnvironmentUserManagementError,
    EnvironmentAuthorizationError,
  ]),
});

export const WsSourceControlProfilesReplaceCredentialRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlProfilesReplaceCredential,
  {
    payload: SourceControlProfileReplaceCredentialInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([
      SourceControlProfileError,
      EnvironmentUserManagementError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsSourceControlProfilesDisconnectRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlProfilesDisconnect,
  {
    payload: SourceControlProfileIdInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([
      SourceControlProfileError,
      EnvironmentUserManagementError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsSourceControlProfilesArchiveRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlProfilesArchive,
  {
    payload: SourceControlProfileArchiveInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([
      SourceControlProfileError,
      EnvironmentUserManagementError,
      EnvironmentAuthorizationError,
    ]),
  },
);

export const WsSourceControlThreadOwnerSetRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlThreadOwnerSet,
  {
    payload: SourceControlThreadOwnerSetInput,
    success: GitHubSourceControlProfile,
    error: Schema.Union([SourceControlProfileError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlConvertRemoteRpc = Rpc.make(
  WS_FORK_METHODS.sourceControlConvertRemote,
  {
    payload: SourceControlConvertRemoteInput,
    success: SourceControlConvertRemoteResult,
    error: Schema.Union([SourceControlProfileError, EnvironmentAuthorizationError]),
  },
);

export const WsUsersListRpc = Rpc.make(WS_FORK_METHODS.usersList, {
  payload: Schema.Struct({}),
  success: EnvironmentUserDirectoryResult,
  error: Schema.Union([EnvironmentUserManagementError, EnvironmentAuthorizationError]),
});

export const WsUsersUpdateRpc = Rpc.make(WS_FORK_METHODS.usersUpdate, {
  payload: EnvironmentUserUpdateInput,
  success: EnvironmentUser,
  error: Schema.Union([EnvironmentUserManagementError, EnvironmentAuthorizationError]),
});

export const WsUsersRevokeSessionsRpc = Rpc.make(WS_FORK_METHODS.usersRevokeSessions, {
  payload: EnvironmentUserIdInput,
  success: EnvironmentUser,
  error: Schema.Union([EnvironmentUserManagementError, EnvironmentAuthorizationError]),
});

export const WsUsersSourceControlProfileSetRpc = Rpc.make(
  WS_FORK_METHODS.usersSourceControlProfileSet,
  {
    payload: EnvironmentUserSourceControlProfileSetInput,
    success: EnvironmentUser,
    error: Schema.Union([EnvironmentUserManagementError, EnvironmentAuthorizationError]),
  },
);

export const WsSubscribeServerResourcesRpc = Rpc.make(WS_FORK_METHODS.subscribeServerResources, {
  payload: Schema.Struct({}),
  success: ServerResourceSample,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeProviderRateLimitsRpc = Rpc.make(
  WS_FORK_METHODS.subscribeProviderRateLimits,
  {
    payload: Schema.Struct({}),
    success: ProviderRateLimitsStreamSnapshot,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsLinearIssuesResolveRpc = Rpc.make(WS_FORK_METHODS.linearIssuesResolve, {
  payload: LinearIssueStatusInput,
  success: LinearIssueStatusResult,
  error: EnvironmentAuthorizationError,
});

export const WsOrchestrationStopExecutionRpc = Rpc.make(ORCHESTRATION_WS_METHODS.stopExecution, {
  payload: OrchestrationRpcSchemas.stopExecution.input,
  success: OrchestrationRpcSchemas.stopExecution.output,
  error: Schema.Union([OrchestrationStopExecutionError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: Schema.Union([OrchestrationReplayEventsError, EnvironmentAuthorizationError]),
});

export const FORK_WS_RPCS = [
  WsPersonalMcpGetProfileRpc,
  WsPersonalMcpUpdateProfileRpc,
  WsPersonalMcpRotateTokenRpc,
  WsPersonalMcpRevokeTokenRpc,
  WsSourceControlProfilesListRpc,
  WsSourceControlProfilesUpsertRpc,
  WsSourceControlProfilesTestRpc,
  WsSourceControlProfilesReplaceCredentialRpc,
  WsSourceControlProfilesDisconnectRpc,
  WsSourceControlProfilesArchiveRpc,
  WsSourceControlThreadOwnerSetRpc,
  WsSourceControlConvertRemoteRpc,
  WsUsersListRpc,
  WsUsersUpdateRpc,
  WsUsersRevokeSessionsRpc,
  WsUsersSourceControlProfileSetRpc,
  WsSubscribeServerResourcesRpc,
  WsSubscribeProviderRateLimitsRpc,
  WsLinearIssuesResolveRpc,
  WsOrchestrationStopExecutionRpc,
  WsOrchestrationReplayEventsRpc,
] as const;
