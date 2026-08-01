import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { EnvironmentUserId, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

const SOURCE_CONTROL_PROFILE_SLUG_MAX_CHARS = 64;
const SOURCE_CONTROL_PROFILE_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const SourceControlProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SOURCE_CONTROL_PROFILE_SLUG_MAX_CHARS),
  Schema.isPattern(SOURCE_CONTROL_PROFILE_SLUG_PATTERN),
).pipe(Schema.brand("SourceControlProfileId"));
export type SourceControlProfileId = typeof SourceControlProfileId.Type;

export const SourceControlIdentityMode = Schema.Literals(["machine", "thread-profile"]);
export type SourceControlIdentityMode = typeof SourceControlIdentityMode.Type;

export const SourceControlCredentialStatus = Schema.Literals(["connected", "invalid", "missing"]);
export type SourceControlCredentialStatus = typeof SourceControlCredentialStatus.Type;

export const GitHubSourceControlProfileMetadata = Schema.Struct({
  id: SourceControlProfileId,
  provider: Schema.Literal("github"),
  label: TrimmedNonEmptyString,
  login: TrimmedNonEmptyString,
  accountId: PositiveInt,
  avatarUrl: Schema.NullOr(Schema.String),
  gitName: TrimmedNonEmptyString,
  gitEmail: TrimmedNonEmptyString,
  ownerUserId: Schema.NullOr(EnvironmentUserId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  archived: Schema.Boolean,
});
export type GitHubSourceControlProfileMetadata = typeof GitHubSourceControlProfileMetadata.Type;

export const GitHubSourceControlProfile = Schema.Struct({
  ...GitHubSourceControlProfileMetadata.fields,
  credentialStatus: SourceControlCredentialStatus,
});
export type GitHubSourceControlProfile = typeof GitHubSourceControlProfile.Type;

export const SourceControlProfilesListResult = Schema.Struct({
  identityMode: SourceControlIdentityMode,
  profiles: Schema.Array(GitHubSourceControlProfile),
});
export type SourceControlProfilesListResult = typeof SourceControlProfilesListResult.Type;

const SourceControlProfileCredential = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));

export const SourceControlProfileUpsertInput = Schema.Struct({
  id: Schema.optional(SourceControlProfileId),
  label: TrimmedNonEmptyString,
  gitName: TrimmedNonEmptyString,
  gitEmail: TrimmedNonEmptyString,
  credential: Schema.optional(SourceControlProfileCredential),
});
export type SourceControlProfileUpsertInput = typeof SourceControlProfileUpsertInput.Type;

export const SourceControlProfileIdInput = Schema.Struct({
  profileId: SourceControlProfileId,
});
export type SourceControlProfileIdInput = typeof SourceControlProfileIdInput.Type;

export const SourceControlProfileReplaceCredentialInput = Schema.Struct({
  profileId: SourceControlProfileId,
  credential: SourceControlProfileCredential,
});
export type SourceControlProfileReplaceCredentialInput =
  typeof SourceControlProfileReplaceCredentialInput.Type;

export const SourceControlProfileArchiveInput = Schema.Struct({
  profileId: SourceControlProfileId,
  archived: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type SourceControlProfileArchiveInput = typeof SourceControlProfileArchiveInput.Type;

export const SourceControlThreadOwnerSetInput = Schema.Struct({
  threadId: ThreadId,
  sourceControlProfileId: SourceControlProfileId,
});
export type SourceControlThreadOwnerSetInput = typeof SourceControlThreadOwnerSetInput.Type;

export const SourceControlConvertRemoteInput = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  remoteName: TrimmedNonEmptyString,
});
export type SourceControlConvertRemoteInput = typeof SourceControlConvertRemoteInput.Type;

export const SourceControlConvertRemoteResult = Schema.Struct({
  remoteName: TrimmedNonEmptyString,
  previousUrl: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type SourceControlConvertRemoteResult = typeof SourceControlConvertRemoteResult.Type;

export const SourceControlProfileErrorReason = Schema.Literals([
  "missing-profile",
  "missing-credential",
  "invalid-credential",
  "identity-mismatch",
  "archived-profile",
  "insufficient-permission",
  "invalid-email",
  "thread-not-found",
  "thread-busy",
  "unsupported-runtime",
  "ssh-remote",
  "remote-not-found",
  "profile-persist-failed",
  "credential-store-failed",
  "validation-failed",
]);
export type SourceControlProfileErrorReason = typeof SourceControlProfileErrorReason.Type;

export class SourceControlProfileError extends Schema.TaggedErrorClass<SourceControlProfileError>()(
  "SourceControlProfileError",
  {
    operation: TrimmedNonEmptyString,
    reason: SourceControlProfileErrorReason,
    detail: TrimmedNonEmptyString,
    profileId: Schema.optional(SourceControlProfileId),
    threadId: Schema.optional(ThreadId),
  },
) {
  override get message(): string {
    return `Source-control identity ${this.operation} failed: ${this.detail}`;
  }
}

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const ChangeRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type ChangeRequestMergeability = typeof ChangeRequestMergeability.Type;
export const ChangeRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
  "unknown",
]);
export type ChangeRequestReviewDecision = typeof ChangeRequestReviewDecision.Type;
export const ChangeRequestChecksStatus = Schema.Literals(["pass", "fail", "pending", "unknown"]);
export type ChangeRequestChecksStatus = typeof ChangeRequestChecksStatus.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isDraft: Schema.optional(Schema.Boolean),
  mergeability: Schema.optional(ChangeRequestMergeability),
  mergeStateStatus: Schema.optional(TrimmedNonEmptyString),
  reviewDecision: Schema.optional(ChangeRequestReviewDecision),
  checksStatus: Schema.optional(ChangeRequestChecksStatus),
  autoMergeEnabled: Schema.optional(Schema.Boolean),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRepositoryOwnerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ChangeRequest = typeof ChangeRequest.Type;

export const SourceControlRepositoryCloneUrls = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryCloneUrls = typeof SourceControlRepositoryCloneUrls.Type;

export const SourceControlRepositoryVisibility = Schema.Literals(["private", "public"]);
export type SourceControlRepositoryVisibility = typeof SourceControlRepositoryVisibility.Type;

export const SourceControlCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type SourceControlCloneProtocol = typeof SourceControlCloneProtocol.Type;

export const SourceControlRepositoryInfo = Schema.Struct({
  provider: SourceControlProviderKind,
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryInfo = typeof SourceControlRepositoryInfo.Type;

export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
  sourceControlProfileId: Schema.optional(SourceControlProfileId),
});
export type SourceControlRepositoryLookupInput = typeof SourceControlRepositoryLookupInput.Type;

export const SourceControlCloneRepositoryInput = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
  sourceControlProfileId: Schema.optional(SourceControlProfileId),
});
export type SourceControlCloneRepositoryInput = typeof SourceControlCloneRepositoryInput.Type;

export const SourceControlCloneRepositoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type SourceControlCloneRepositoryResult = typeof SourceControlCloneRepositoryResult.Type;

export const SourceControlPublishRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  visibility: SourceControlRepositoryVisibility,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
  sourceControlProfileId: Schema.optional(SourceControlProfileId),
});
export type SourceControlPublishRepositoryInput = typeof SourceControlPublishRepositoryInput.Type;

export const SourceControlPublishStatus = Schema.Literals(["pushed", "remote_added"]);
export type SourceControlPublishStatus = typeof SourceControlPublishStatus.Type;

export const SourceControlPublishRepositoryResult = Schema.Struct({
  repository: SourceControlRepositoryInfo,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlPublishStatus,
});
export type SourceControlPublishRepositoryResult = typeof SourceControlPublishRepositoryResult.Type;

export const SourceControlDiscoveryStatus = Schema.Literals(["available", "missing"]);
export type SourceControlDiscoveryStatus = typeof SourceControlDiscoveryStatus.Type;

export const SourceControlProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type SourceControlProviderAuthStatus = typeof SourceControlProviderAuthStatus.Type;

export const SourceControlProviderAuth = Schema.Struct({
  status: SourceControlProviderAuthStatus,
  account: Schema.Option(TrimmedNonEmptyString),
  host: Schema.Option(TrimmedNonEmptyString),
  detail: Schema.Option(TrimmedNonEmptyString),
});
export type SourceControlProviderAuth = typeof SourceControlProviderAuth.Type;

const SourceControlDiscoverySharedFields = {
  label: TrimmedNonEmptyString,
  executable: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlDiscoveryStatus,
  version: Schema.Option(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  detail: Schema.Option(TrimmedNonEmptyString),
} as const;

export const VcsDiscoveryItem = Schema.Struct({
  kind: VcsDriverKind,
  implemented: Schema.Boolean,
  ...SourceControlDiscoverySharedFields,
});
export type VcsDiscoveryItem = typeof VcsDiscoveryItem.Type;

export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
export type SourceControlProviderDiscoveryItem = typeof SourceControlProviderDiscoveryItem.Type;

export const SourceControlDiscoveryResult = Schema.Struct({
  versionControlSystems: Schema.Array(VcsDiscoveryItem),
  sourceControlProviders: Schema.Array(SourceControlProviderDiscoveryItem),
});
export type SourceControlDiscoveryResult = typeof SourceControlDiscoveryResult.Type;

export class SourceControlProviderError extends Schema.TaggedErrorClass<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    cwd: Schema.String,
    command: Schema.optional(Schema.String),
    repository: Schema.optional(Schema.String),
    reference: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control provider ${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export class SourceControlRepositoryError extends Schema.TaggedErrorClass<SourceControlRepositoryError>()(
  "SourceControlRepositoryError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control repository operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}
