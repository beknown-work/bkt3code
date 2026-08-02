/**
 * T3-CUSTOM(expbkt3): Fork websocket RPC handlers.
 *
 * Personal MCP, source-control identity profiles, environment user management,
 * resource/rate-limit streams, and the execution-stop + event-replay
 * orchestration RPCs. Upstream-owned `ws.ts` builds these in one marked seam and
 * spreads them into `WsRpcGroup.of`, so adding or removing a fork RPC no longer
 * edits the upstream handler map.
 *
 * Every dependency is injected rather than resolved from context: the caller
 * passes the exact service instances and connection-scoped closures it already
 * built, so behaviour is identical to the previously inlined handlers.
 */
import {
  ORCHESTRATION_WS_METHODS,
  WS_FORK_METHODS,
  WS_METHODS,
  WsRpcGroup,
  EnvironmentAuthorizationError,
  OrchestrationGetSnapshotError,
  SourceControlProfileError,
  type AuthSessionId,
  type OrchestrationEvent,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as EnvironmentUserService from "./auth/EnvironmentUserService.ts";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import type * as UserMcpProfileStore from "./mcp/UserMcpProfileStore.ts";
import type * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as SystemResourceMonitor from "./observability/SystemResourceMonitor.ts";
import type { ProviderRateLimitsShape } from "./provider/ProviderRateLimits.ts";
import type { ProjectionRepositoryError } from "./persistence/Errors.ts";
import { githubSshRemoteToHttps } from "./sourceControl/GitHubRemoteUrl.ts";
import type * as SourceControlProfileService from "./sourceControl/SourceControlProfileService.ts";
import type { ThreadExecutionSupervisorShape } from "./execution/ThreadExecutionSupervisor.ts";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

type WsRpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
type ForkWsMethod = (typeof WS_FORK_METHODS)[keyof typeof WS_FORK_METHODS];

/** The fork's slice of the websocket handler map, typed by the RPC group. */
export type ForkWsHandlers = Pick<RpcGroup.HandlersFrom<WsRpcs>, ForkWsMethod>;

export interface ForkWsHandlerDeps {
  readonly currentSessionId: AuthSessionId;
  readonly actorUserId: UserId | null;
  /** Deterministic profile id for local/single-user transports. */
  readonly personalMcpUserId: UserId;
  readonly personalMcpProfiles: UserMcpProfileStore.UserMcpProfileStore["Service"];
  readonly sourceControlProfiles: SourceControlProfileService.SourceControlProfileService["Service"];
  readonly environmentUsers: EnvironmentUserService.EnvironmentUserService["Service"];
  readonly systemResourceMonitor: SystemResourceMonitor.SystemResourceMonitor["Service"];
  readonly providerRateLimits: ProviderRateLimitsShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineService["Service"];
  readonly gitVcsDriver: GitVcsDriver.GitVcsDriver["Service"];
  readonly executionSupervisor: ThreadExecutionSupervisorShape;
  /** Serialises source-control actions per thread. */
  readonly sourceControlActionLock: {
    readonly runExclusive: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  };
  readonly enrichOrchestrationEvents: (
    events: ReadonlyArray<OrchestrationEvent>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never, never>;
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
  readonly requireThreadAccess: (
    threadId: ThreadId,
  ) => Effect.Effect<void, OrchestrationGetSnapshotError>;
  readonly visibleAggregateIdsForActor: (
    userId: UserId,
  ) => Effect.Effect<
    { readonly threadIds: ReadonlySet<string>; readonly projectIds: ReadonlySet<string> },
    ProjectionRepositoryError
  >;
}

export const makeForkWsHandlers = ({
  currentSessionId,
  actorUserId,
  personalMcpUserId,
  personalMcpProfiles,
  sourceControlProfiles,
  environmentUsers,
  systemResourceMonitor,
  providerRateLimits,
  projectionSnapshotQuery,
  orchestrationEngine,
  gitVcsDriver,
  executionSupervisor,
  sourceControlActionLock,
  enrichOrchestrationEvents,
  observeRpcEffect,
  observeRpcStream,
  requireThreadAccess,
  visibleAggregateIdsForActor,
}: ForkWsHandlerDeps) =>
  ({
    [WS_METHODS.personalMcpGetProfile]: (_input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpGetProfile,
        personalMcpProfiles.get(personalMcpUserId),
        { "rpc.aggregate": "personal-mcp" },
      ),
    [WS_METHODS.personalMcpUpdateProfile]: (input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpUpdateProfile,
        personalMcpProfiles.update(personalMcpUserId, input),
        { "rpc.aggregate": "personal-mcp" },
      ),
    [WS_METHODS.personalMcpRotateToken]: (_input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpRotateToken,
        personalMcpProfiles.rotateExternalToken(personalMcpUserId),
        { "rpc.aggregate": "personal-mcp" },
      ),
    [WS_METHODS.personalMcpRevokeToken]: (_input) =>
      observeRpcEffect(
        WS_METHODS.personalMcpRevokeToken,
        personalMcpProfiles.revokeExternalToken(personalMcpUserId),
        { "rpc.aggregate": "personal-mcp" },
      ),
    [WS_METHODS.sourceControlProfilesList]: (_input) =>
      observeRpcEffect(WS_METHODS.sourceControlProfilesList, sourceControlProfiles.list, {
        "rpc.aggregate": "source-control-profile",
      }),
    [WS_METHODS.sourceControlProfilesUpsert]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesUpsert,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.upsert(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlProfilesTest]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesTest,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.test(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlProfilesReplaceCredential]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesReplaceCredential,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.replaceCredential(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlProfilesDisconnect]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesDisconnect,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.disconnect(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlProfilesArchive]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlProfilesArchive,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(sourceControlProfiles.archive(input))),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.usersList]: (_input) =>
      observeRpcEffect(WS_METHODS.usersList, environmentUsers.list(currentSessionId), {
        "rpc.aggregate": "users",
      }),
    [WS_METHODS.usersUpdate]: (input) =>
      observeRpcEffect(
        WS_METHODS.usersUpdate,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(environmentUsers.update(input))),
        { "rpc.aggregate": "users" },
      ),
    [WS_METHODS.usersRevokeSessions]: (input) =>
      observeRpcEffect(
        WS_METHODS.usersRevokeSessions,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(environmentUsers.revokeSessions(input))),
        { "rpc.aggregate": "users" },
      ),
    [WS_METHODS.usersSourceControlProfileSet]: (input) =>
      observeRpcEffect(
        WS_METHODS.usersSourceControlProfileSet,
        environmentUsers
          .assertAdministrator(currentSessionId)
          .pipe(Effect.andThen(environmentUsers.setSourceControlProfile(input))),
        { "rpc.aggregate": "users" },
      ),
    [WS_METHODS.sourceControlThreadOwnerSet]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlThreadOwnerSet,
        // T3-CUSTOM(expbkt3): GitHub identity follows durable T3
        // ownership. Keep this RPC decodable for older clients.
        Effect.fail(
          new SourceControlProfileError({
            operation: "switch-thread-owner",
            reason: "validation-failed",
            detail:
              "GitHub identity follows the durable thread owner. Transfer thread ownership instead.",
            profileId: input.sourceControlProfileId,
            threadId: input.threadId,
          }),
        ),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.sourceControlConvertRemote]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlConvertRemote,
        sourceControlActionLock.runExclusive(
          input.threadId,
          Effect.gen(function* () {
            const threadOption = yield* projectionSnapshotQuery
              .getThreadShellById(input.threadId)
              .pipe(
                Effect.mapError(
                  () =>
                    new SourceControlProfileError({
                      operation: "convert-remote",
                      reason: "thread-not-found",
                      detail: "Could not read the selected thread.",
                      threadId: input.threadId,
                    }),
                ),
              );
            if (Option.isNone(threadOption)) {
              return yield* new SourceControlProfileError({
                operation: "convert-remote",
                reason: "thread-not-found",
                detail: "The selected thread no longer exists.",
                threadId: input.threadId,
              });
            }
            const context = yield* sourceControlProfiles.resolveThreadExecutionContext(
              input.threadId,
              threadOption.value.ownerUserId,
            );
            const environment = context?.environment ?? process.env;
            const current = yield* gitVcsDriver
              .execute({
                operation: "SourceControlRemote.getUrl",
                cwd: input.cwd,
                args: ["remote", "get-url", input.remoteName],
                env: environment,
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new SourceControlProfileError({
                      operation: "convert-remote",
                      reason: "remote-not-found",
                      detail: `Git remote '${input.remoteName}' could not be read.`,
                      threadId: input.threadId,
                    }),
                ),
              );
            const previousUrl = current.stdout.trim();
            const remoteUrl = githubSshRemoteToHttps(previousUrl);
            if (remoteUrl === null) {
              return yield* new SourceControlProfileError({
                operation: "convert-remote",
                reason: "ssh-remote",
                detail: "The selected remote is not a GitHub SSH URL that can be converted.",
                threadId: input.threadId,
              });
            }
            yield* gitVcsDriver
              .execute({
                operation: "SourceControlRemote.setUrl",
                cwd: input.cwd,
                args: ["remote", "set-url", input.remoteName, remoteUrl],
                env: environment,
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new SourceControlProfileError({
                      operation: "convert-remote",
                      reason: "validation-failed",
                      detail: "The GitHub remote could not be converted to HTTPS.",
                      threadId: input.threadId,
                    }),
                ),
              );
            return { remoteName: input.remoteName, previousUrl, remoteUrl };
          }),
        ),
        { "rpc.aggregate": "source-control-profile" },
      ),
    [WS_METHODS.subscribeServerResources]: (_input) =>
      observeRpcStream(WS_METHODS.subscribeServerResources, systemResourceMonitor.stream, {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.subscribeProviderRateLimits]: (_input) =>
      observeRpcStream(WS_METHODS.subscribeProviderRateLimits, providerRateLimits.stream, {
        "rpc.aggregate": "server",
      }),
  }) satisfies ForkWsHandlers;
