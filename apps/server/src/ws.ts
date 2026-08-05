import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  CommandId,
  type DiscoveredLocalServerList,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  type ProjectId,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  UserId,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  OrchestrationReplayEventsError,
  OrchestrationStopExecutionError,
  type ServerSelfUpdateError,
  type ServerSelfUpdateProgressEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  RpcClientId,
  EnvironmentAuthorizationError,
  SourceControlProfileError,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { withExecutionSnapshot } from "@t3tools/shared/threadExecution";
import { clamp } from "effect/Number";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
// T3-CUSTOM(expbkt3): HttpClient is passed to fork-only Linear status handlers.
import {
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import * as OrchestrationCommandDispatcher from "./orchestration/dispatchCommand.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadExecutionSupervisor } from "./execution/ThreadExecutionSupervisor.ts";
import { OrchestrationAccessControl } from "./orchestration/Services/AccessControl.ts";
import { OrchestrationAccessControlLive } from "./orchestration/Layers/AccessControl.ts";
import { ClerkDirectory, ClerkDirectoryLive } from "./auth/ClerkDirectory.ts";
// T3-CUSTOM(expbkt3): fork RPC handlers
import { makeForkWsHandlers } from "./wsForkHandlers.ts";
// T3-CUSTOM(expbkt3): per-connection access control helpers
import { filterShellSnapshot } from "./orchestration/accessRules.ts";
import { makeWsVisibility } from "./orchestration/wsVisibility.ts";
import { awaitShellProjectionSequence } from "./orchestration/shellProjectionBarrier.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderRateLimits from "./provider/ProviderRateLimits.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as UserMcpProfileStore from "./mcp/UserMcpProfileStore.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentUserService from "./auth/EnvironmentUserService.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as SystemResourceMonitor from "./observability/SystemResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlProfileService from "./sourceControl/SourceControlProfileService.ts";
import {
  CurrentSourceControlExecutionEnvironment,
  withSourceControlExecutionEnvironment,
} from "./sourceControl/SourceControlExecutionEnvironment.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import { githubSshRemoteToHttps } from "./sourceControl/GitHubRemoteUrl.ts";
import * as ThreadSourceControlActionLock from "./sourceControl/ThreadSourceControlActionLock.ts";
import {
  applyAssignedSourceControlProfile,
  creationSourceControlProfileId,
} from "./sourceControl/ThreadSourceControlProfileSelection.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import { isThreadDetailEvent } from "./orchestration/threadDetailEvent.ts";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isOrchestrationGetTurnDiffError = Schema.is(OrchestrationGetTurnDiffError);
const isOrchestrationGetFullThreadDiffError = Schema.is(OrchestrationGetFullThreadDiffError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const EDITOR_DISCOVERY_TIMEOUT = Duration.seconds(5);

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  discovery.pipe(
    Effect.timeoutOption(EDITOR_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(() => [])),
  );

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

// Same bound for thread resume. The replay reads the *global* event range and
// filters per-thread afterwards, so a stale cursor far behind the head would
// otherwise decode every intervening event's payload — reconnects with cursors
// hundreds of thousands of events behind have OOM-killed servers on large
// databases. Past this gap the client is reset with a fresh thread snapshot.
const THREAD_RESUME_MAX_GAP = 1_000;

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const executionSupervisor = yield* ThreadExecutionSupervisor;
      const orchestrationCommandDispatcher =
        yield* OrchestrationCommandDispatcher.OrchestrationCommandDispatcher;
      const accessControl = yield* OrchestrationAccessControl;
      const clerkDirectory = yield* ClerkDirectory;
      // T3-CUSTOM(expbkt3): Identity binding preserves the transport subject, so
      // authorization must prefer the durable user attached to the session;
      // unidentified local operators remain unrestricted.
      const actorUserId = Option.getOrNull(
        accessControl.actorFor(currentSession.subject, currentSession.userId),
      );
      // T3-CUSTOM(expbkt3): Local/single-user transports share a deterministic
      // personal profile; team-mode connections use the authenticated Clerk id.
      const personalMcpUserId = actorUserId ?? UserId.make("local-user");
      const personalMcpProfiles = yield* UserMcpProfileStore.UserMcpProfileStore;
      // T3-CUSTOM(expbkt3): Bifrost-backed Linear status lookup.
      const httpClient = yield* HttpClient.HttpClient;
      // Whether that operator is a Clerk org admin (may manage project access).
      // Stable for the connection's identity, so resolve once.
      const actorIsAdmin =
        actorUserId === null ? false : yield* clerkDirectory.isOrgAdmin(actorUserId);
      // T3-CUSTOM(expbkt3): BEGIN per-connection access control (wsVisibility.ts)
      const {
        visibleAggregateIdsForActor,
        requireThreadAccess,
        applyShellVisibility,
        applyShellItemVisibility,
        authorizeNormalizedCommand,
      } = makeWsVisibility({
        projectionSnapshotQuery,
        accessControl,
        actorUserId,
        actorIsAdmin,
      });
      // T3-CUSTOM(expbkt3): END
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const gitVcsDriver = yield* GitVcsDriver.GitVcsDriver;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const providerRateLimits = yield* ProviderRateLimits.ProviderRateLimits;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const crypto = yield* Crypto.Crypto;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const repositoryIdentityResolver =
        yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const environmentUsers = yield* EnvironmentUserService.EnvironmentUserService;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const sourceControlProfiles = yield* SourceControlProfileService.SourceControlProfileService;
      const sourceControlActionLock =
        yield* ThreadSourceControlActionLock.ThreadSourceControlActionLock;
      const providerService = yield* ProviderService.ProviderService;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const systemResourceMonitor = yield* SystemResourceMonitor.SystemResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const relayClient = yield* RelayClient.RelayClient;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForRpcMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                Option.match(
                  yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId),
                  {
                    onNone: () => null,
                    onSome: (project) => project.workspaceRoot,
                  },
                ) ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            }).pipe(Effect.orElseSucceed(() => event));
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toUnfencedShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
          case "project.member-added":
          case "project.member-removed":
          case "project.owner-transferred":
            return projectUpsertOrRemove(event.payload.projectId, event.sequence);
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return threadUpsertOrRemove(event.payload.threadId, event.sequence);
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
        }
      };

      const toShellStreamEvent = Effect.fn("Ws.toShellStreamEvent")(function* (
        event: OrchestrationEvent,
      ) {
        // Domain events and projection updates are independent subscribers to
        // the event stream. Without this barrier, a fast shell subscriber can
        // observe thread.created first, query a projection that does not yet
        // contain the thread, and permanently drop the sidebar upsert. A page
        // reload appeared to fix it only because its fresh snapshot was read
        // after projection catch-up.
        yield* awaitShellProjectionSequence({
          eventSequence: event.sequence,
          eventType: event.type,
          readSnapshotSequence: projectionSnapshotQuery.getSnapshotSequence,
        });
        return yield* toUnfencedShellStreamEvent(event);
      });

      // Coalescing makes each projection read represent every event for that
      // aggregate in the current window. Retry a typed persistence failure once
      // so a brief read failure cannot strand the shell at its previous state.
      // If both attempts fail, log and drop the stream item; treating an error as
      // a missing row would incorrectly remove a still-active aggregate.
      const retryShellProjectionRead = <A, E>(
        aggregateKind: "project" | "thread",
        aggregateId: string,
        read: Effect.Effect<A, E>,
      ): Effect.Effect<Option.Option<A>, never, never> =>
        read.pipe(
          Effect.retry({ times: 1 }),
          Effect.map(Option.some),
          Effect.tapError((error) =>
            Effect.logWarning("orchestration shell projection refetch failed", {
              aggregateKind,
              aggregateId,
              error,
            }),
          ),
          Effect.orElseSucceed(() => Option.none()),
        );

      const projectUpsertOrRemove = (
        projectId: ProjectId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "project",
          projectId,
          projectionSnapshotQuery.getProjectShellById(projectId),
        ).pipe(
          Effect.map(
            Option.flatMap((project) =>
              Option.match(project, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-removed" as const,
                    sequence,
                    projectId,
                  }),
                onSome: (nextProject) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "project-upserted" as const,
                    sequence,
                    project: nextProject,
                  }),
              }),
            ),
          ),
        );

      // Refetch a thread's shell and emit an upsert if it is still active, or a
      // `thread-removed` if the projection has no active row for it. Emitting a
      // removal on a `none` (rather than dropping the event) is what keeps
      // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
      // into a later refetchable event for the same thread, the refetch returns
      // `none` for the now-inactive row and this still tells the sidebar to drop
      // it. A `thread-removed` the client does not have is a harmless no-op. The
      // projection commits in the same transaction before the event publishes,
      // so a `none` reliably means the thread is deleted or archived, not
      // not-yet-persisted.
      const threadUpsertOrRemove = (
        threadId: ThreadId,
        sequence: number,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
        retryShellProjectionRead(
          "thread",
          threadId,
          projectionSnapshotQuery.getThreadShellById(threadId),
        ).pipe(
          Effect.map(
            Option.flatMap((thread) =>
              Option.match(thread, {
                onNone: () =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-removed" as const,
                    sequence,
                    threadId,
                  }),
                onSome: (nextThread) =>
                  Option.some<OrchestrationShellStreamEvent>({
                    kind: "thread-upserted" as const,
                    sequence,
                    thread: nextThread,
                  }),
              }),
            ),
          ),
        );

      // Turn a batch of domain events into shell stream items, coalescing by
      // aggregate first. `toShellStreamEvent` re-reads the *current* projected
      // shell for an aggregate, so within a batch only the latest event per
      // aggregate matters: a burst of streaming `thread.message-sent` deltas for
      // one thread collapses into a single shell refetch, and an unrelated
      // `thread.created` in the same batch is never stuck behind those DB reads.
      //
      // Input events arrive in ascending sequence; we keep the last (highest
      // sequence) event per aggregate, then re-sort ascending before emitting so
      // the client — which applies shell items strictly by increasing sequence
      // and drops any `sequence <= snapshotSequence` — never skips a coalesced
      // item. The refetch runs with bounded concurrency (order-preserving).
      const SHELL_REFETCH_CONCURRENCY = 8;
      const coalesceShellEvents = (
        events: ReadonlyArray<OrchestrationEvent>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
        Effect.gen(function* () {
          if (events.length === 0) {
            return [];
          }
          const latestByAggregate = new Map<string, OrchestrationEvent>();
          for (const event of events) {
            latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
          }
          const survivors = Array.from(latestByAggregate.values()).sort(
            (left, right) => left.sequence - right.sequence,
          );
          const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
            concurrency: SHELL_REFETCH_CONCURRENCY,
          });
          return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
        });

      // Small time/size window over which to coalesce shell events. The window
      // bounds the worst-case added latency for a brand-new thread to appear in
      // the sidebar (imperceptible), while collapsing high-frequency streaming
      // traffic so it can't serialize the shell stream behind per-event DB reads.
      const SHELL_COALESCE_WINDOW = Duration.millis(50);
      const SHELL_COALESCE_MAX_CHUNK = 512;
      const coalesceShellStream = <E, R>(
        stream: Stream.Stream<OrchestrationEvent, E, R>,
      ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
        stream.pipe(
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellEvents),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      type ExecutionShellStreamItem = Extract<
        OrchestrationShellStreamItem,
        { readonly kind: "execution" }
      >;

      type ShellLiveInput =
        | { readonly kind: "event"; readonly event: OrchestrationEvent }
        | {
            readonly kind: "execution";
            readonly execution: ExecutionShellStreamItem;
          }
        | { readonly kind: "synchronized" };

      // A completion marker is queued alongside raw live events so it cannot
      // overtake an event still waiting in the coalescing window. Split each
      // batch at markers and coalesce only the event segments on either side.
      const coalesceShellLiveInputs = (
        inputs: ReadonlyArray<ShellLiveInput>,
      ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
        Effect.gen(function* () {
          const output: Array<OrchestrationShellStreamItem> = [];
          let pendingEvents: Array<OrchestrationEvent> = [];

          for (const input of inputs) {
            if (input.kind === "event") {
              pendingEvents.push(input.event);
              continue;
            }

            output.push(...(yield* coalesceShellEvents(pendingEvents)));
            pendingEvents = [];
            output.push(
              input.kind === "execution" ? input.execution : { kind: "synchronized" as const },
            );
          }

          output.push(...(yield* coalesceShellEvents(pendingEvents)));
          return output;
        });

      const coalesceShellLiveStream = <E, R>(
        stream: Stream.Stream<ShellLiveInput, E, R>,
      ): Stream.Stream<OrchestrationShellStreamItem, E, R> =>
        stream.pipe(
          Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
          Stream.mapEffect(coalesceShellLiveInputs),
          Stream.flatMap((items) => Stream.fromIterable(items)),
        );

      const dispatchAuthorizedCommand = (normalizedCommand: OrchestrationCommand) =>
        orchestrationCommandDispatcher.dispatch(normalizedCommand, { actorUserId });
      const dispatchNormalizedCommand = (normalizedCommand: OrchestrationCommand) =>
        authorizeNormalizedCommand(normalizedCommand).pipe(
          Effect.andThen(dispatchAuthorizedCommand(normalizedCommand)),
        );
      const withThreadExecution = Effect.fn("ws.withThreadExecution")(function* <
        T extends { readonly id: ThreadId; readonly latestTurn: OrchestrationLatestTurn | null },
      >(thread: T) {
        return withExecutionSnapshot(thread, yield* executionSupervisor.getSnapshot(thread.id));
      });
      const withShellExecutions = Effect.fn("ws.withShellExecutions")(function* <
        T extends {
          readonly threads: ReadonlyArray<{
            readonly id: ThreadId;
            readonly latestTurn: OrchestrationLatestTurn | null;
          }>;
        },
      >(snapshot: T) {
        const executions = yield* executionSupervisor.getSnapshots(
          snapshot.threads.map((thread) => thread.id),
        );
        return {
          ...snapshot,
          threads: snapshot.threads.map((thread) => {
            const execution = executions.get(thread.id);
            return execution ? withExecutionSnapshot(thread, execution) : thread;
          }),
        };
      });
      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: yield* resolveAvailableEditorsForConfig(
            externalLauncher.resolveAvailableEditors(),
          ),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
          shellResumeCompletionMarker: true,
          threadResumeCompletionMarker: true,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const resolveSelectedSourceControlEnvironment = Effect.fn(
        "ws.resolveSelectedSourceControlEnvironment",
      )(function* (
        profileId:
          | SourceControlProfileService.SourceControlExecutionContext["profileId"]
          | undefined,
      ) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            () =>
              new SourceControlProfileError({
                operation: "resolve-profile",
                reason: "profile-persist-failed",
                detail: "Could not read source-control identity settings.",
              }),
          ),
        );
        if (settings.sourceControlIdentityMode === "thread-profile") {
          if (currentSession.userId === null) {
            return yield* new SourceControlProfileError({
              operation: "resolve-profile",
              reason: "missing-profile",
              detail: "Sign in before using authenticated source-control operations.",
            });
          }
          const context = yield* sourceControlProfiles.resolveUserExecutionContext(
            UserId.make(currentSession.userId),
            {},
          );
          if (context === null) {
            return null;
          }
          return {
            profileId: context.profileId,
            environment: context.environment,
          };
        }
        if (profileId !== undefined) {
          const context = yield* sourceControlProfiles.resolveExecutionContext(profileId, {});
          return {
            profileId: context.profileId,
            environment: context.environment,
          };
        }
        return null;
      });

      const resolveThreadSourceControlEnvironment = Effect.fn(
        "ws.resolveThreadSourceControlEnvironment",
      )(function* (threadId: ThreadId | undefined) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            () =>
              new SourceControlProfileError({
                operation: "resolve-thread-profile",
                reason: "profile-persist-failed",
                detail: "Could not read source-control identity settings.",
                ...(threadId !== undefined ? { threadId } : {}),
              }),
          ),
        );
        if (settings.sourceControlIdentityMode === "machine") {
          return null;
        }
        if (threadId === undefined) {
          return yield* new SourceControlProfileError({
            operation: "resolve-thread-profile",
            reason: "missing-profile",
            detail: "This Git operation must identify its owning thread.",
          });
        }

        const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
          Effect.mapError(
            () =>
              new SourceControlProfileError({
                operation: "resolve-thread-profile",
                reason: "thread-not-found",
                detail: "Could not read the thread's GitHub owner.",
                threadId,
              }),
          ),
        );
        if (Option.isNone(thread)) {
          return yield* new SourceControlProfileError({
            operation: "resolve-thread-profile",
            reason: "thread-not-found",
            detail: "The selected thread no longer exists.",
            threadId,
          });
        }
        const context = yield* sourceControlProfiles.resolveThreadExecutionContext(
          threadId,
          thread.value.ownerUserId,
          {},
        );
        return context === null
          ? null
          : { profileId: context.profileId, environment: context.environment };
      });

      const withThreadSourceControl = <A, E, R>(
        threadId: ThreadId | undefined,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | SourceControlProfileError, R> =>
        Effect.flatMap(resolveThreadSourceControlEnvironment(threadId), (executionEnvironment) =>
          withSourceControlExecutionEnvironment(effect, executionEnvironment),
        );

      const withThreadActionLock = <A, E, R>(
        threadId: ThreadId | undefined,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        threadId === undefined ? effect : sourceControlActionLock.runExclusive(threadId, effect);

      const withThreadSourceControlStream = <A, E, R>(
        threadId: ThreadId | undefined,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | SourceControlProfileError, R> =>
        Stream.unwrap(
          resolveThreadSourceControlEnvironment(threadId).pipe(
            Effect.map((executionEnvironment) =>
              stream.pipe(
                Stream.provideService(
                  CurrentSourceControlExecutionEnvironment,
                  executionEnvironment,
                ),
              ),
            ),
          ),
        );

      const ensureGitHubRemotesUseHttps = Effect.fn("ws.ensureGitHubRemotesUseHttps")(
        function* (input: { readonly cwd: string; readonly threadId?: ThreadId | undefined }) {
          const executionEnvironment = yield* resolveThreadSourceControlEnvironment(input.threadId);
          if (executionEnvironment === null) return;
          const remote = yield* withSourceControlExecutionEnvironment(
            gitVcsDriver.execute({
              operation: "SourceControlRemote.validateHttps",
              cwd: input.cwd,
              args: ["remote", "get-url", "origin"],
              allowNonZeroExit: true,
            }),
            executionEnvironment,
          ).pipe(
            Effect.mapError(
              () =>
                new SourceControlProfileError({
                  operation: "validate-remote",
                  reason: "validation-failed",
                  detail: "GitHub remotes could not be validated before the authenticated action.",
                  profileId: executionEnvironment.profileId,
                  ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
                }),
            ),
          );
          if (remote.exitCode === 0 && githubSshRemoteToHttps(remote.stdout.trim()) !== null) {
            return yield* new SourceControlProfileError({
              operation: "validate-remote",
              reason: "ssh-remote",
              detail:
                "Convert the GitHub remote to HTTPS before fetching, pushing, or preparing a pull request.",
              profileId: executionEnvironment.profileId,
              ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            });
          }
        },
      );

      const withThreadSourceControlEnvironment = <
        A extends {
          readonly threadId: string;
          readonly env?: Readonly<Record<string, string>> | undefined;
        },
      >(
        input: A,
      ): Effect.Effect<A, SourceControlProfileError> =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(input.threadId);
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              () =>
                new SourceControlProfileError({
                  operation: "resolve-terminal-profile",
                  reason: "profile-persist-failed",
                  detail: "Could not read source-control identity settings.",
                  threadId,
                }),
            ),
          );
          if (settings.sourceControlIdentityMode === "machine") {
            return input;
          }
          const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
            Effect.mapError(
              () =>
                new SourceControlProfileError({
                  operation: "resolve-terminal-profile",
                  reason: "thread-not-found",
                  detail: "Could not read the terminal's thread owner.",
                  threadId,
                }),
            ),
          );
          if (Option.isNone(thread)) {
            return yield* new SourceControlProfileError({
              operation: "resolve-terminal-profile",
              reason: "thread-not-found",
              detail: "The terminal's thread no longer exists.",
              threadId,
            });
          }
          const context = yield* sourceControlProfiles.resolveThreadExecutionContext(
            threadId,
            thread.value.ownerUserId,
            {},
          );
          if (context === null) {
            return input;
          }
          const merged = SourceControlProfileService.mergeSourceControlEnvironment(
            input.env ?? {},
            context.environment,
          );
          const env = Object.fromEntries(
            Object.entries(merged).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          );
          return { ...input, env } as A;
        });

      // T3-CUSTOM(expbkt3): BEGIN fork RPC handlers (wsForkHandlers.ts)
      const forkHandlers = makeForkWsHandlers({
        currentSessionId,
        actorUserId,
        personalMcpUserId,
        personalMcpProfiles,
        httpClient,
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
      });
      // T3-CUSTOM(expbkt3): END

      return WsRpcGroup.of({
        // T3-CUSTOM(expbkt3): fork RPC handlers live in wsForkHandlers.ts
        ...forkHandlers,
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              let normalizedCommand = yield* normalizeDispatchCommand(command);
              const sourceControlSettings = yield* serverSettings.getSettings;
              const identityMode = sourceControlSettings.sourceControlIdentityMode;
              if (identityMode === "thread-profile") {
                // T3-CUSTOM(expbkt3): New-thread attribution defaults to the
                // authenticated environment user's linked GitHub profile. This
                // also closes the profile-query loading race in every client.
                const assignedProfileId =
                  actorUserId === null
                    ? null
                    : (Object.values(sourceControlSettings.sourceControlProfiles).find(
                        (profile) =>
                          profile.ownerUserId !== null &&
                          String(profile.ownerUserId) === String(actorUserId),
                      )?.id ?? null);
                normalizedCommand = applyAssignedSourceControlProfile(
                  normalizedCommand,
                  assignedProfileId,
                );
                const creationProfileId = creationSourceControlProfileId(normalizedCommand);
                if (creationProfileId === null) {
                  return yield* new OrchestrationDispatchCommandError({
                    message:
                      "Assign a connected GitHub profile to your user in Settings before creating a thread.",
                  });
                }
                let validation: Effect.Effect<unknown, SourceControlProfileError> | null = null;
                if (creationProfileId !== undefined) {
                  validation = sourceControlProfiles.resolveExecutionContext(creationProfileId);
                } else if (normalizedCommand.type === "thread.owner.transfer") {
                  validation = sourceControlProfiles.resolveThreadExecutionContext(
                    normalizedCommand.threadId,
                    normalizedCommand.userId,
                  );
                } else if (normalizedCommand.type === "thread.turn.start") {
                  const threadId = normalizedCommand.threadId;
                  validation = projectionSnapshotQuery.getThreadShellById(threadId).pipe(
                    Effect.mapError(
                      () =>
                        new SourceControlProfileError({
                          operation: "resolve-thread-profile",
                          reason: "thread-not-found",
                          detail: "Could not read the selected thread.",
                          threadId,
                        }),
                    ),
                    Effect.flatMap(
                      Option.match({
                        onNone: () =>
                          Effect.fail(
                            new SourceControlProfileError({
                              operation: "resolve-thread-profile",
                              reason: "thread-not-found",
                              detail: "The selected thread no longer exists.",
                              threadId,
                            }),
                          ),
                        onSome: (thread) =>
                          sourceControlProfiles.resolveThreadExecutionContext(
                            threadId,
                            thread.ownerUserId,
                          ),
                      }),
                    ),
                  );
                }
                if (validation !== null) {
                  yield* validation.pipe(
                    Effect.mapError(
                      (error) =>
                        new OrchestrationDispatchCommandError({
                          message: error.detail,
                        }),
                    ),
                  );
                }
              }
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.orElseSucceed(() => false),
                      )
                  : false;
              const dispatchEffect =
                normalizedCommand.type === "thread.owner.transfer"
                  ? Effect.gen(function* () {
                      yield* authorizeNormalizedCommand(normalizedCommand);
                      const threadOption = yield* projectionSnapshotQuery
                        .getThreadDetailById(normalizedCommand.threadId)
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new OrchestrationDispatchCommandError({
                                message: "Could not read the thread before transferring ownership.",
                                cause,
                              }),
                          ),
                        );
                      if (Option.isNone(threadOption)) {
                        return yield* new OrchestrationDispatchCommandError({
                          message: "The selected thread no longer exists.",
                        });
                      }
                      const thread = threadOption.value;
                      if (yield* terminalManager.hasRunningCommand(normalizedCommand.threadId)) {
                        return yield* new OrchestrationDispatchCommandError({
                          message: "Wait for the active terminal command before changing owner.",
                        });
                      }
                      if (
                        thread.latestTurn?.state === "running" ||
                        thread.session?.status === "starting" ||
                        thread.session?.status === "running"
                      ) {
                        return yield* new OrchestrationDispatchCommandError({
                          message: "Wait for the active provider turn before changing owner.",
                        });
                      }
                      if (thread.session !== null && thread.session.status !== "stopped") {
                        yield* providerService
                          .stopSession({ threadId: normalizedCommand.threadId })
                          .pipe(
                            Effect.mapError(
                              (cause) =>
                                new OrchestrationDispatchCommandError({
                                  message:
                                    "The provider session could not be stopped before changing owner.",
                                  cause,
                                }),
                            ),
                          );
                      }
                      yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                        Effect.mapError(
                          (cause) =>
                            new OrchestrationDispatchCommandError({
                              message:
                                "The thread terminals could not be closed before changing owner.",
                              cause,
                            }),
                        ),
                      );
                      const result = yield* dispatchAuthorizedCommand(normalizedCommand);
                      yield* terminalManager
                        .close({ threadId: normalizedCommand.threadId })
                        .pipe(Effect.ignore);
                      return result;
                    })
                  : dispatchNormalizedCommand(normalizedCommand);
              const result = yield* normalizedCommand.type === "thread.turn.start"
                ? sourceControlActionLock.runExclusive(normalizedCommand.threadId, dispatchEffect)
                : normalizedCommand.type === "thread.owner.transfer"
                  ? sourceControlActionLock
                      .tryRunExclusive(normalizedCommand.threadId, dispatchEffect)
                      .pipe(
                        Effect.flatMap(
                          Option.match({
                            onNone: () =>
                              Effect.fail(
                                new OrchestrationDispatchCommandError({
                                  message:
                                    "Wait for the active turn or Git action before changing owner.",
                                }),
                              ),
                            onSome: Effect.succeed,
                          }),
                        ),
                      )
                  : dispatchEffect;
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.stopExecution]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.stopExecution,
            Effect.gen(function* () {
              yield* requireThreadAccess(input.threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationStopExecutionError({
                      message: cause.message,
                      cause,
                    }),
                ),
              );
              return yield* executionSupervisor.stopExecution(input).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationStopExecutionError({
                      message: "Failed to stop thread execution",
                      cause,
                    }),
                ),
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              // Team mode: drop events for threads/projects the operator can't
              // see so a raw replay never leaks other users' work.
              Effect.flatMap((events) =>
                actorUserId === null
                  ? Effect.succeed(events)
                  : visibleAggregateIdsForActor(actorUserId).pipe(
                      Effect.map(({ threadIds, projectIds }) =>
                        events.filter((event) =>
                          event.aggregateKind === "thread"
                            ? threadIds.has(event.aggregateId)
                            : projectIds.has(event.aggregateId),
                        ),
                      ),
                    ),
              ),
              Effect.map((events) => events.map(projectActivityEvent)),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            Effect.gen(function* () {
              yield* requireThreadAccess(input.threadId);
              return yield* checkpointDiffQuery.getTurnDiff(input);
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationGetTurnDiffError(cause)
                  ? cause
                  : new OrchestrationGetTurnDiffError({
                      message: "Failed to load turn diff",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            Effect.gen(function* () {
              yield* requireThreadAccess(input.threadId);
              return yield* checkpointDiffQuery.getFullThreadDiff(input);
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationGetFullThreadDiffError(cause)
                  ? cause
                  : new OrchestrationGetFullThreadDiffError({
                      message: "Failed to load full thread diff",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchThreads,
            projectionSnapshotQuery.searchThreads(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationSearchThreadsError({
                    message: "Failed to search threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // Coalesce the live shell stream per aggregate over a small window
              // so bursts of high-frequency events (streaming message deltas,
              // activity appends) collapse into a single shell refetch and never
              // serialize a brand-new thread's `thread.created` behind hundreds
              // of per-event DB reads. See coalesceShellStream.
              // Attach live delivery into a scope-bound buffer BEFORE loading any
              // snapshot or draining catch-up, otherwise an event published while
              // the snapshot query is in flight is lost (it is past the snapshot's
              // sequence but the live subscription is not attached yet). Every
              // path below emits from this same buffered live tail. Overlapping
              // events are deduped by sequence on the client.
              const liveBuffer = yield* Queue.unbounded<ShellLiveInput>();
              yield* Effect.forkScoped(
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.runForEach((event) =>
                    Queue.offer(liveBuffer, { kind: "event" as const, event }),
                  ),
                ),
                { startImmediately: true },
              );
              yield* Effect.forkScoped(
                executionSupervisor.streamSnapshots.pipe(
                  Stream.runForEach((execution) =>
                    Queue.offer(liveBuffer, {
                      kind: "execution" as const,
                      execution: { kind: "execution" as const, execution },
                    }),
                  ),
                ),
                { startImmediately: true },
              );
              const bufferedLiveStream = applyShellItemVisibility(
                coalesceShellLiveStream(Stream.fromQueue(liveBuffer)),
              );

              const loadSnapshot = Effect.gen(function* () {
                const rawSnapshot = yield* projectionSnapshotQuery.getShellSnapshot();
                const visibleSnapshot =
                  actorUserId === null
                    ? rawSnapshot
                    : filterShellSnapshot(rawSnapshot, actorUserId);
                return yield* withShellExecutions(visibleSnapshot);
              }).pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              // Offer the completion marker into the same queue as live events.
              // Anything buffered while snapshot/replay work was in flight is
              // therefore delivered before the client is told it is synchronized.
              const synchronizedThenLive =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      applyShellItemVisibility(
                        Stream.fromEffect(
                          Queue.offer(liveBuffer, { kind: "synchronized" as const }).pipe(
                            Effect.andThen(Queue.takeAll(liveBuffer)),
                            Effect.flatMap(coalesceShellLiveInputs),
                          ),
                        ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      ),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. If the client is too far
              // behind, we fall back to a fresh snapshot instead of an unbounded
              // replay (see below).
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                // Gap too large: replaying every intervening event (each a shell
                // refetch) is far more expensive than a single O(active-threads)
                // snapshot. A cursor ahead of this engine's authoritative state
                // is also invalid, so reset it with a snapshot. Send the snapshot
                // followed by the buffered live tail, exactly as the
                // no-afterSequence path does.
                if (replayGap < 0 || replayGap > SHELL_RESUME_MAX_GAP) {
                  const snapshot = yield* loadSnapshot;
                  return Stream.concat(
                    Stream.make({ kind: "snapshot" as const, snapshot }),
                    synchronizedThenLive,
                  );
                }
                const catchUpStream = applyShellVisibility(
                  coalesceShellStream(
                    // Replay only through the head captured above. Newer events
                    // are already covered by the live subscription, so this bound
                    // cannot chase a moving event-store head or grow the live
                    // buffer indefinitely while waiting for an empty page.
                    orchestrationEngine.readEvents(afterSequence, replayGap),
                  ),
                ).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, synchronizedThenLive);
              }

              const snapshot = yield* loadSnapshot;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.map((snapshot) =>
                actorUserId === null ? snapshot : filterShellSnapshot(snapshot, actorUserId),
              ),
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              // Team mode: reject a thread the operator can't access (as
              // not-found — no existence leak).
              if (actorUserId !== null) {
                const accessible = yield* accessControl
                  .canAccessThread(actorUserId, input.threadId)
                  .pipe(Effect.orElseSucceed(() => false));
                if (!accessible) {
                  return yield* new OrchestrationGetSnapshotError({
                    message: `Thread ${input.threadId} was not found`,
                    cause: input.threadId,
                  });
                }
              }

              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              // Close the stream once the operator is untagged from this thread
              // so an open viewer who loses access is kicked out live.
              const takeUntilSelfRemoved = <E, R>(
                stream: Stream.Stream<OrchestrationThreadStreamItem, E, R>,
              ): Stream.Stream<OrchestrationThreadStreamItem, E, R> =>
                actorUserId === null
                  ? stream
                  : stream.pipe(
                      Stream.takeUntil(
                        (item) =>
                          item.kind === "event" &&
                          item.event.type === "thread.member-removed" &&
                          item.event.payload.userId === actorUserId,
                      ),
                    );

              const domainLiveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event: projectActivityEvent(event),
                })),
              );
              const executionLiveStream = executionSupervisor.streamSnapshots.pipe(
                Stream.filter((execution) => execution.threadId === input.threadId),
                Stream.map((execution) => ({ kind: "execution" as const, execution })),
              );
              const liveStream: Stream.Stream<OrchestrationThreadStreamItem> = Stream.merge(
                domainLiveStream,
                executionLiveStream,
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
              yield* Effect.forkScoped(
                liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
              );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer);

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // The replay is bounded to the projection head captured below. The
              // catch-up range is normally tiny (a fresh HTTP snapshot sequence),
              // but a stale cached cursor can sit hundreds of thousands of global
              // events behind — replaying that decodes every intervening event
              // (including every other thread's tool payloads) only to discard
              // almost all of them, which has OOM-killed servers on large
              // databases. A truncated replay would silently drop this thread's
              // events, so past the gap cap we reset the client with a fresh
              // thread snapshot instead, exactly like subscribeShell above.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                if (replayGap >= 0 && replayGap <= THREAD_RESUME_MAX_GAP) {
                  const catchUpStream = orchestrationEngine
                    .readEvents(afterSequence, replayGap)
                    .pipe(
                      Stream.filter(isThisThreadDetailEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to replay thread ${input.threadId} events`,
                            cause,
                          }),
                      ),
                    );
                  const afterCatchUp =
                    input.requestCompletionMarker === true
                      ? Stream.concat(
                          Stream.fromEffect(
                            Queue.offer(liveBuffer, { kind: "synchronized" as const }),
                          ).pipe(Stream.drain),
                          bufferedLiveStream,
                        )
                      : bufferedLiveStream;
                  return takeUntilSelfRemoved(Stream.concat(catchUpStream, afterCatchUp));
                }
                // Gap too large (or cursor ahead of authoritative state): fall
                // through to the snapshot path so the client converges from a
                // fresh thread detail instead of an unbounded replay.
              }

              const loadedSnapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(input.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(loadedSnapshot)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }
              const snapshot = {
                ...loadedSnapshot.value,
                thread: yield* withThreadExecution(loadedSnapshot.value.thread),
              };

              const afterSnapshot =
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        Queue.offer(liveBuffer, { kind: "synchronized" as const }),
                      ).pipe(Stream.drain),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream;
              return takeUntilSelfRemoved(
                Stream.concat(
                  Stream.make({
                    kind: "snapshot" as const,
                    snapshot: projectThreadDetailSnapshot(snapshot),
                  }),
                  afterSnapshot,
                ),
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverSelfUpdate.update(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          observeRpcStream(
            WS_METHODS.serverUpdateServerWithProgress,
            Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
              serverSelfUpdate
                .update(input, (stage) =>
                  Queue.offer(queue, {
                    type: "progress",
                    stage,
                  }).pipe(Effect.asVoid),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Queue.offer(queue, {
                      type: "complete",
                      result,
                    }),
                  ),
                  Effect.catchTags({
                    ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                  }),
                  Effect.andThen(Queue.end(queue)),
                  Effect.forkScoped,
                ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) => {
          // Profile metadata is writable only through the credential-aware
          // source-control profile RPCs. A generic settings client must not be
          // able to replace a validated login/account binding.
          const { sourceControlProfiles: _ignoredProfileMetadata, ...clientWritablePatch } = patch;
          const requiresUserAdministrator =
            patch.environmentUserIdentityMode !== undefined ||
            patch.sourceControlIdentityMode !== undefined;
          return observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            Effect.gen(function* () {
              if (requiresUserAdministrator) {
                yield* environmentUsers.assertAdministrator(currentSessionId);
              }
              const updated = yield* serverSettings
                .updateSettings(clientWritablePatch)
                .pipe(Effect.map(ServerSettings.redactServerSettingsForClient));
              if (patch.environmentUserIdentityMode === "required") {
                yield* environmentUsers.revokeUnidentifiedSessions;
              }
              return updated;
            }),
            {
              "rpc.aggregate": "server",
            },
          );
        },
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetResourceTelemetryHistory,
            resourceTelemetry.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRetryResourceTelemetry, resourceTelemetry.retry, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetBackgroundPolicy, backgroundPolicy.snapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(WS_METHODS.cloudGetRelayClientStatus, relayClient.resolve, {
            "rpc.aggregate": "cloud",
          }),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                relayClient
                  .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                  .pipe(
                    Effect.flatMap((status) =>
                      Queue.offer(queue, {
                        type: "complete",
                        status,
                      }),
                    ),
                    Effect.catchTag("RelayClientInstallError", (error) =>
                      Queue.fail(
                        queue,
                        new RelayClientInstallFailedError({
                          reason: error.reason,
                          message: error.message,
                        }),
                      ),
                    ),
                    Effect.andThen(Queue.end(queue)),
                    Effect.forkScoped,
                  ),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            Effect.gen(function* () {
              const executionEnvironment = yield* resolveSelectedSourceControlEnvironment(
                input.sourceControlProfileId,
              );
              return yield* withSourceControlExecutionEnvironment(
                sourceControlRepositories.lookupRepository(input),
                executionEnvironment,
              );
            }),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            Effect.gen(function* () {
              const executionEnvironment = yield* resolveSelectedSourceControlEnvironment(
                input.sourceControlProfileId,
              );
              if (
                executionEnvironment !== null &&
                input.remoteUrl !== undefined &&
                githubSshRemoteToHttps(input.remoteUrl) !== null
              ) {
                return yield* new SourceControlProfileError({
                  operation: "clone-repository",
                  reason: "ssh-remote",
                  detail: "Use the repository's HTTPS clone URL with a GitHub profile.",
                  profileId: executionEnvironment.profileId,
                });
              }
              const cloneInput =
                executionEnvironment === null ? input : { ...input, protocol: "https" as const };
              return yield* withSourceControlExecutionEnvironment(
                sourceControlRepositories.cloneRepository(cloneInput),
                executionEnvironment,
              );
            }),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            Effect.gen(function* () {
              const executionEnvironment = yield* resolveSelectedSourceControlEnvironment(
                input.sourceControlProfileId,
              );
              const publishInput =
                executionEnvironment === null ? input : { ...input, protocol: "https" as const };
              return yield* withSourceControlExecutionEnvironment(
                sourceControlRepositories
                  .publishRepository(publishInput)
                  .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                executionEnvironment,
              );
            }),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchContents,
            workspaceEntries.searchContents(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchContentsError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWriteFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              if (input.resource._tag !== "workspace-file") {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.resource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            withThreadSourceControlStream(
              input.threadId,
              vcsStatusBroadcaster.streamStatus(input, {
                automaticRemoteRefreshInterval: automaticGitFetchInterval,
              }),
            ),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            withThreadSourceControl(input.threadId, vcsStatusBroadcaster.refreshStatus(input.cwd)),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            withThreadActionLock(
              input.threadId,
              Effect.gen(function* () {
                yield* ensureGitHubRemotesUseHttps(input);
                return yield* withThreadSourceControl(
                  input.threadId,
                  gitWorkflow.pullCurrentBranch(input.cwd).pipe(
                    Effect.matchCauseEffect({
                      onFailure: (cause) => Effect.failCause(cause),
                      onSuccess: (result) =>
                        refreshGitStatus(input.cwd).pipe(
                          Effect.ignore({ log: true }),
                          Effect.as(result),
                        ),
                    }),
                  ),
                );
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            withThreadSourceControlStream(
              input.threadId,
              Stream.callback<
                GitActionProgressEvent,
                GitManagerServiceError | SourceControlProfileError
              >((queue) =>
                withThreadActionLock(
                  input.threadId,
                  Effect.gen(function* () {
                    if (input.action !== "commit") {
                      yield* ensureGitHubRemotesUseHttps(input);
                    }
                    yield* gitWorkflow
                      .runStackedAction(input, {
                        actionId: input.actionId,
                        progressReporter: {
                          publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                        },
                      })
                      .pipe(
                        Effect.matchCauseEffect({
                          onFailure: (cause) => Queue.failCause(queue, cause),
                          onSuccess: () =>
                            refreshGitStatus(input.cwd).pipe(
                              Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                            ),
                        }),
                      );
                  }),
                ).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
              ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            withThreadSourceControl(input.threadId, gitWorkflow.resolvePullRequest(input)),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            withThreadActionLock(
              input.threadId,
              Effect.gen(function* () {
                yield* ensureGitHubRemotesUseHttps(input);
                return yield* withThreadSourceControl(
                  input.threadId,
                  gitWorkflow
                    .preparePullRequestThread(input)
                    .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
                );
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalOpen,
            withThreadActionLock(
              ThreadId.make(input.threadId),
              withThreadSourceControlEnvironment(input).pipe(Effect.flatMap(terminalManager.open)),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.unwrap(
              withThreadActionLock(
                ThreadId.make(input.threadId),
                withThreadSourceControlEnvironment(input).pipe(
                  Effect.map((resolvedInput) =>
                    Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
                      Effect.acquireRelease(
                        terminalManager.attachStream(resolvedInput, (event) =>
                          Queue.offer(queue, event),
                        ),
                        (unsubscribe) => Effect.sync(unsubscribe),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalWrite,
            withThreadActionLock(ThreadId.make(input.threadId), terminalManager.write(input)),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalRestart,
            withThreadActionLock(
              ThreadId.make(input.threadId),
              withThreadSourceControlEnvironment(input).pipe(
                Effect.flatMap(terminalManager.restart),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan();
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                });
                yield* portDiscovery.subscribe((servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, { servers, scannedAt });
                  }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeBackgroundPolicy,
            Stream.unwrap(
              Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeResourceTelemetry,
            Stream.unwrap(
              Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
    }),
  );

// T3-CUSTOM(expbkt3): BEGIN — reuse the authenticated web RPC implementation
// from the compact MCP web-UI bridge instead of maintaining a second set of
// handlers that can drift from the browser.
export const makeAuthenticatedWsRpcHandlerLayer = (
  session: EnvironmentAuth.AuthenticatedSession,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  serverSelfUpdate: ServerSelfUpdate.ServerSelfUpdate["Service"],
) =>
  makeWsRpcLayer(session, previewAutomationBroker).pipe(
    Layer.provide(OrchestrationAccessControlLive),
    Layer.provide(ClerkDirectoryLive),
    Layer.provide(ProviderMaintenanceRunner.layer),
    Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
    Layer.provide(
      SourceControlDiscovery.layer.pipe(
        Layer.provide(
          SourceControlProviderRegistry.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                AzureDevOpsCli.layer,
                BitbucketApi.layer,
                GitHubCli.layer,
                GitLabCli.layer,
              ),
            ),
            Layer.provideMerge(GitVcsDriver.layer),
            Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
          ),
        ),
        Layer.provide(VcsProcess.layer),
      ),
    ),
  );
// T3-CUSTOM(expbkt3): END

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeAuthenticatedWsRpcHandlerLayer(
              session,
              previewAutomationBroker,
              serverSelfUpdate,
            ).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
