/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type UserId,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderValidationError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderSessionExecutionOptions,
} from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
// T3-CUSTOM(expbkt3): session-identity markers for provider processes.
import { withSessionIdentityEnvironment } from "../../identity/SessionIdentityEnvironment.ts";
const isModelSelection = Schema.is(ModelSelection);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly sourceControlIdentityRequired?: boolean;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.sourceControlIdentityRequired !== undefined
      ? { sourceControlIdentityRequired: extra.sourceControlIdentityRequired }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readSourceControlIdentityRequired(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): boolean {
  return Boolean(
    runtimePayload &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    "sourceControlIdentityRequired" in runtimePayload &&
    runtimePayload.sourceControlIdentityRequired === true,
  );
}

/**
 * Provider session starts spawn a child process and complete a protocol
 * handshake. The codex app-server JSON-RPC client awaits an unbounded
 * deferred, so an alive-but-wedged child (locked CODEX_HOME, stalled MCP
 * server) would otherwise hang the caller — and with it the single provider
 * command worker — forever. Fail instead, so the failure surfaces as a
 * thread error the user can act on.
 */
const PROVIDER_SESSION_START_TIMEOUT_MS = 60_000;

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const serverConfig = yield* ServerConfig.ServerConfig;
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessionGenerations = new Map<string, number>();
  interface ProviderSessionStartup {
    readonly instanceId: ProviderInstanceId;
    readonly generation: number;
    readonly settled: Deferred.Deferred<void>;
    cancelRequested: boolean;
  }
  const sessionStartups = new Map<ThreadId, ProviderSessionStartup>();
  const lifecycleSemaphores = yield* SynchronizedRef.make<
    ReadonlyMap<ThreadId, Semaphore.Semaphore>
  >(new Map());
  const getLifecycleSemaphore = (threadId: ThreadId) =>
    SynchronizedRef.modify(lifecycleSemaphores, (semaphores) => {
      const existing = semaphores.get(threadId);
      if (existing !== undefined) return [existing, semaphores] as const;
      const semaphore = Semaphore.makeUnsafe(1);
      return [semaphore, new Map(semaphores).set(threadId, semaphore)] as const;
    });
  const withThreadLifecycle =
    (threadId: ThreadId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.flatMap(getLifecycleSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));
  const sessionGenerationKey = (instanceId: ProviderInstanceId, threadId: ThreadId) =>
    `${instanceId}\u0000${threadId}`;
  const bumpSessionGeneration = (instanceId: ProviderInstanceId, threadId: ThreadId) => {
    const key = sessionGenerationKey(instanceId, threadId);
    const generation = (sessionGenerations.get(key) ?? 0) + 1;
    sessionGenerations.set(key, generation);
    return generation;
  };
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const prepareMcpSession = (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    actorUserId: UserId | null = null,
  ) =>
    McpSessionRegistry.issueActiveMcpCredential({
      threadId,
      providerInstanceId,
      actorUserId,
    }).pipe(
      Effect.tap((credential) =>
        credential
          ? Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config))
          : Effect.void,
      ),
    );
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
  const logLifecycleInvariant = Effect.fn("logLifecycleInvariant")(function* (input: {
    readonly operation: "start" | "recover" | "stop" | "terminate";
    readonly threadId: ThreadId;
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly expectsAdapterSession: boolean;
  }) {
    const startupPresent = sessionStartups.has(input.threadId);
    const adapterSessionPresent = yield* input.adapter.hasSession(input.threadId);
    if (!startupPresent && adapterSessionPresent === input.expectsAdapterSession) return;
    yield* Effect.logWarning("provider.session.lifecycle-invariant-violated", {
      operation: input.operation,
      threadId: input.threadId,
      provider: input.adapter.provider,
      startupPresent,
      adapterSessionPresent,
      expectsAdapterSession: input.expectsAdapterSession,
    });
  });

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly sourceControlIdentityRequired?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      const canonical = correlateRuntimeEventWithInstance(source, event);
      const generation =
        canonical.sessionGeneration ??
        sessionGenerations.get(sessionGenerationKey(source.instanceId, canonical.threadId));
      return generation === undefined ? canonical : { ...canonical, sessionGeneration: generation };
    }).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(Effect.andThen(publishRuntimeEvent(canonicalEvent))),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
    readonly executionOptions?: ProviderSessionExecutionOptions;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          yield* logLifecycleInvariant({
            operation: "recover",
            threadId: input.binding.threadId,
            adapter,
            expectsAdapterSession: true,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
      if (
        readSourceControlIdentityRequired(input.binding.runtimePayload) &&
        input.executionOptions?.environment === undefined
      ) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' without its source-control identity environment.`,
        );
      }

      yield* prepareMcpSession(
        input.binding.threadId,
        bindingInstanceId,
        input.executionOptions?.actorUserId ?? null,
      );
      const resumed = yield* adapter
        .startSession(
          {
            threadId: input.binding.threadId,
            provider: input.binding.provider,
            providerInstanceId: bindingInstanceId,
            ...(persistedCwd ? { cwd: persistedCwd } : {}),
            ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
            ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
            runtimeMode: input.binding.runtimeMode ?? "full-access",
          },
          // T3-CUSTOM(expbkt3): a recovered session is a freshly spawned
          // process, so it needs the identity markers too.
          withSessionIdentityEnvironment(input.executionOptions),
        )
        .pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(PROVIDER_SESSION_START_TIMEOUT_MS),
            orElse: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: input.binding.provider,
                  method: "session/start",
                  detail: `Provider session start timed out after ${PROVIDER_SESSION_START_TIMEOUT_MS}ms while recovering thread '${input.binding.threadId}'.`,
                }),
              ),
          }),
          Effect.onError(() => clearMcpSession(input.binding.threadId)),
        );
      bumpSessionGeneration(bindingInstanceId, input.binding.threadId);
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      yield* logLifecycleInvariant({
        operation: "recover",
        threadId: input.binding.threadId,
        adapter,
        expectsAdapterSession: true,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
      withThreadLifecycle(input.binding.threadId),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
    readonly executionOptions?: ProviderSessionExecutionOptions;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
      ...(input.executionOptions ? { executionOptions: input.executionOptions } : {}),
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      runtimeMode: recovered.session.runtimeMode,
      isActive: true,
    } as const;
  });

  const terminateExistingSessionsForThread = Effect.fn("terminateExistingSessionsForThread")(
    function* (threadId: ThreadId) {
      const currentAdapters = yield* getAdapterEntries;
      const terminated = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        Effect.gen(function* () {
          if (!(yield* adapter.hasSession(threadId))) return null;
          const termination = yield* adapter.terminateSession(threadId);
          if (!termination.verified || !termination.processTreeExited) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Existing provider session '${threadId}' could not be terminated before replacement.`,
            );
          }
          yield* analytics.record("provider.session.stopped", {
            provider: adapter.provider,
          });
          return { instanceId, provider: adapter.provider } as const;
        }),
      );
      const terminatedEntries = terminated.filter((entry) => entry !== null);
      if (terminatedEntries.length === 0) return;

      yield* clearMcpSession(threadId);
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      if (binding === undefined) return;
      const matchingEntry = terminatedEntries.find((entry) => entry.provider === binding.provider);
      yield* directory.upsert({
        threadId,
        provider: binding.provider,
        providerInstanceId:
          binding.providerInstanceId ??
          matchingEntry?.instanceId ??
          terminatedEntries[0]!.instanceId,
        status: "stopped",
        runtimePayload: { activeTurnId: null },
      });
    },
  );

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput, executionOptions) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        yield* terminateExistingSessionsForThread(threadId);
        yield* prepareMcpSession(
          threadId,
          resolvedInstanceId,
          executionOptions?.actorUserId ?? null,
        );
        const generation = bumpSessionGeneration(resolvedInstanceId, threadId);
        const settled = yield* Deferred.make<void>();
        const startup: ProviderSessionStartup = {
          instanceId: resolvedInstanceId,
          generation,
          settled,
          cancelRequested: false,
        };
        sessionStartups.set(threadId, startup);
        const sessionWithInstance = yield* Effect.gen(function* () {
          const session = yield* adapter
            .startSession(
              {
                ...input,
                providerInstanceId: resolvedInstanceId,
                ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
                ...(effectiveResumeCursor !== undefined
                  ? { resumeCursor: effectiveResumeCursor }
                  : {}),
              },
              // T3-CUSTOM(expbkt3): fold the session-identity markers into the
              // environment the adapter spawns with.
              withSessionIdentityEnvironment(executionOptions),
            )
            .pipe(Effect.onError(() => clearMcpSession(threadId)));

          if (session.provider !== adapter.provider) {
            yield* clearMcpSession(threadId);
            return yield* toValidationError(
              "ProviderService.startSession",
              `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
            );
          }
          const sessionWithInstance = {
            ...session,
            providerInstanceId: resolvedInstanceId,
          };
          yield* upsertSessionBinding(sessionWithInstance, threadId, {
            modelSelection: input.modelSelection,
            sourceControlIdentityRequired: executionOptions?.environment !== undefined,
          });

          if (startup.cancelRequested) {
            const termination = yield* adapter.terminateSession(threadId);
            if (!termination.verified || !termination.processTreeExited) {
              return yield* toValidationError(
                "ProviderService.startSession",
                `Provider session '${threadId}' startup cancellation could not be verified.`,
              );
            }
            yield* clearMcpSession(threadId);
            yield* directory.upsert({
              threadId,
              provider: adapter.provider,
              providerInstanceId: resolvedInstanceId,
              status: "stopped",
              runtimePayload: { activeTurnId: null },
            });
            return yield* new ProviderAdapterRequestError({
              provider: resolvedProvider,
              method: "startSession",
              detail: "Provider session startup was cancelled.",
            });
          }

          yield* analytics.record("provider.session.started", {
            provider: sessionWithInstance.provider,
            runtimeMode: input.runtimeMode,
            hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
            hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
            hasModel:
              typeof input.modelSelection?.model === "string" &&
              input.modelSelection.model.trim().length > 0,
          });
          return sessionWithInstance;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => sessionStartups.get(threadId) === startup).pipe(
              Effect.flatMap((isCurrent) =>
                isCurrent
                  ? Effect.sync(() => sessionStartups.delete(threadId))
                  : Effect.logWarning("provider.session.startup-entry-replaced", {
                      threadId,
                      provider: resolvedProvider,
                      generation,
                      currentGeneration: sessionStartups.get(threadId)?.generation,
                    }),
              ),
              Effect.andThen(Deferred.succeed(settled, undefined)),
              Effect.asVoid,
            ),
          ),
        );
        yield* logLifecycleInvariant({
          operation: "start",
          threadId,
          adapter,
          expectsAdapterSession: true,
        });
        // Changing runtime mode restarts the session, so the transition is only
        // observable here, by diffing against the mode the previous session for
        // this thread was bound to. Recording it separately is what makes the
        // "started supervised, switched to full access" funnel answerable.
        const previousRuntimeMode = persistedBinding?.runtimeMode;
        if (previousRuntimeMode !== undefined && previousRuntimeMode !== input.runtimeMode) {
          yield* analytics.record("provider.runtime_mode.changed", {
            provider: sessionWithInstance.provider,
            from: previousRuntimeMode,
            to: input.runtimeMode,
          });
        }

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
        withThreadLifecycle(threadId),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(
    function* (rawInput, executionOptions) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.sendTurn",
        schema: ProviderSendTurnInput,
        payload: rawInput,
      });

      const attachments = parsed.attachments ?? [];
      if (!parsed.input && attachments.length === 0) {
        return yield* toValidationError(
          "ProviderService.sendTurn",
          "Either input text or at least one attachment is required",
        );
      }

      // Adapters inline attachment pixels into the model prompt, but the model's
      // tools cannot dereference pixels. Appending the on-disk path is what lets
      // a turn like "include this screenshot in the PR" copy the actual file.
      // This runs after schema decode, so the appended lines are exempt from the
      // PROVIDER_SEND_TURN_MAX_INPUT_CHARS check; attachment count is capped, so
      // the overhead is bounded. Unresolvable ids are skipped here and surface
      // as adapter errors when the file is read for inlining.
      const attachmentPathLines = attachments.flatMap((attachment) => {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        return attachmentPath === null
          ? []
          : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`];
      });
      const inputTextWithAttachmentPaths =
        attachmentPathLines.length === 0
          ? parsed.input
          : [parsed.input, attachmentPathLines.join("\n")]
              .filter((part): part is string => typeof part === "string" && part.length > 0)
              .join("\n\n");

      const input = {
        ...parsed,
        ...(inputTextWithAttachmentPaths !== undefined
          ? { input: inputTextWithAttachmentPaths }
          : {}),
        attachments,
      };
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "send-turn",
        "provider.thread_id": input.threadId,
        "provider.interaction_mode": input.interactionMode,
        "provider.attachment_count": input.attachments.length,
      });
      let metricProvider = "unknown";
      let metricModel = input.modelSelection?.model;
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
          ...(executionOptions ? { executionOptions } : {}),
        });
        metricProvider = routed.adapter.provider;
        metricModel = input.modelSelection?.model;
        yield* Effect.annotateCurrentSpan({
          "provider.kind": routed.adapter.provider,
          ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
        });
        // A turn is the clearest sign a session is still alive. The MCP
        // credential is minted once at session start and cannot be rotated into
        // an already-spawned agent process, so we keep the existing token valid
        // rather than issuing a new one: sessions that go a long time between
        // browser tool calls used to lose the toolkit outright.
        yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
        const turn = yield* routed.adapter.sendTurn(input);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.sendTurn",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
        yield* analytics.record("provider.turn.sent", {
          provider: routed.adapter.provider,
          model: input.modelSelection?.model,
          interactionMode: input.interactionMode,
          // Session-start events alone skew runtime mode toward users who toggle
          // often, since every toggle restarts the session. Recording it per turn
          // gives a usage-weighted view and lets it cross with interactionMode.
          runtimeMode: routed.runtimeMode,
          attachmentCount: input.attachments.length,
          hasInput: typeof input.input === "string" && input.input.trim().length > 0,
        });
        return turn;
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          timer: providerTurnDuration,
          attributes: () =>
            providerTurnMetricAttributes({
              provider: metricProvider,
              model: metricModel,
              extra: {
                operation: "send",
              },
            }),
        }),
      );
    },
  );

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput, executionOptions) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        // Recovery is deliberately off: interrupting a dead session must not
        // respawn the agent it is trying to stop. Callers turn this failure
        // into a clean interrupted state instead.
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: false,
          ...(executionOptions ? { executionOptions } : {}),
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        if (!routed.isActive) {
          return yield* new ProviderAdapterRequestError({
            provider: routed.adapter.provider,
            method: "turn/interrupt",
            detail: `No live provider session for thread '${input.threadId}'; interrupt does not respawn sessions.`,
          });
        }
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const inspectSession: ProviderServiceMethod<"inspectSession"> = Effect.fn("inspectSession")(
    function* (threadId) {
      const startup = sessionStartups.get(threadId);
      if (startup) {
        const adapter = yield* registry.getByInstance(startup.instanceId);
        const inspected = yield* adapter.inspectSession(threadId);
        if (inspected !== null) {
          return { ...inspected, generation: startup.generation };
        }
        return {
          threadId,
          generation: startup.generation,
          state: "starting",
          activeProviderTurnId: null,
          runtimeAlive: true,
        } as const;
      }
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      if (!binding?.providerInstanceId) return null;
      const adapter = yield* registry.getByInstance(binding.providerInstanceId);
      const inspected = yield* adapter.inspectSession(threadId);
      return inspected === null
        ? null
        : {
            ...inspected,
            generation:
              sessionGenerations.get(sessionGenerationKey(binding.providerInstanceId, threadId)) ??
              inspected.generation,
          };
    },
  );

  // T3-CUSTOM(expbkt3): expose persisted provider history to the durable
  // coordinator so a missed terminal event never causes duplicate work.
  const readThread: NonNullable<ProviderServiceMethod<"readThread">> = Effect.fn("readThread")(
    function* (threadId, executionOptions) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.readThread",
        allowRecovery: true,
        ...(executionOptions ? { executionOptions } : {}),
      });
      return yield* routed.adapter.readThread(routed.threadId);
    },
  );

  const requestTurnInterrupt: ProviderServiceMethod<"requestTurnInterrupt"> = Effect.fn(
    "requestTurnInterrupt",
  )(function* (input) {
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.requestTurnInterrupt",
      allowRecovery: false,
    });
    if (!routed.isActive) return { acknowledged: true, acknowledgedAt: yield* nowIso };
    return yield* routed.adapter.requestTurnInterrupt(routed.threadId, input.turnId);
  });

  const terminateSession: ProviderServiceMethod<"terminateSession"> = Effect.fn("terminateSession")(
    function* (input) {
      const startup = sessionStartups.get(input.threadId);
      if (startup) {
        startup.cancelRequested = true;
      }
      return yield* Effect.gen(function* () {
        if (startup) {
          yield* Deferred.await(startup.settled);
        }
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        const providerInstanceId = binding?.providerInstanceId ?? startup?.instanceId;
        if (!providerInstanceId) {
          return { verified: true, graceful: true, processTreeExited: true };
        }
        const adapter = yield* registry.getByInstance(providerInstanceId);
        if (!(yield* adapter.hasSession(input.threadId))) {
          yield* clearMcpSession(input.threadId);
          if (binding !== undefined) {
            yield* directory.upsert({
              threadId: input.threadId,
              provider: binding.provider,
              providerInstanceId,
              status: "stopped",
              runtimePayload: { activeTurnId: null },
            });
          }
          yield* logLifecycleInvariant({
            operation: "terminate",
            threadId: input.threadId,
            adapter,
            expectsAdapterSession: false,
          });
          return { verified: true, graceful: true, processTreeExited: true };
        }
        const termination = yield* adapter.terminateSession(input.threadId);
        if (!termination.verified || !termination.processTreeExited) {
          return yield* toValidationError(
            "ProviderService.terminateSession",
            `Provider session '${input.threadId}' termination could not be verified.`,
          );
        }
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: adapter.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: { activeTurnId: null },
        });
        yield* logLifecycleInvariant({
          operation: "terminate",
          threadId: input.threadId,
          adapter,
          expectsAdapterSession: false,
        });
        return termination;
      }).pipe(withThreadLifecycle(input.threadId));
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput, executionOptions) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
          ...(executionOptions ? { executionOptions } : {}),
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput, executionOptions) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
        ...(executionOptions ? { executionOptions } : {}),
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
        yield* logLifecycleInvariant({
          operation: "stop",
          threadId: input.threadId,
          adapter: routed.adapter,
          expectsAdapterSession: false,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
        withThreadLifecycle(input.threadId),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput, executionOptions) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
        ...(executionOptions ? { executionOptions } : {}),
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    for (const startup of sessionStartups.values()) startup.cancelRequested = true;
    sessionStartups.clear();
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    // The service launcher SIGKILLs us 5s after SIGTERM. Stopping adapters
    // one at a time (each waiting on its own child) can overrun that budget
    // and lose the binding rewrite below, so stop them together and give up
    // on stragglers rather than the whole shutdown.
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll(), {
      concurrency: "unbounded",
    }).pipe(Effect.timeoutOption(Duration.seconds(3)), Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  // No adapter can hold a live session at process start, so any binding still
  // marked running/starting is debris from the previous process — a SIGKILL
  // skips runStopAll entirely. Reconciling at boot keeps the reaper's view and
  // recovery decisions honest. directory.upsert preserves resumeCursor, so
  // lazy recovery is unaffected.
  yield* directory.listBindings().pipe(
    Effect.orElseSucceed(() => []),
    Effect.flatMap((bindings) =>
      Effect.forEach(
        bindings.filter(
          (binding) =>
            binding.providerInstanceId !== undefined &&
            binding.status !== "stopped" &&
            binding.status !== "error",
        ),
        (binding) =>
          nowIso.pipe(
            Effect.flatMap((lastRuntimeEventAt) =>
              directory.upsert({
                threadId: binding.threadId,
                provider: binding.provider,
                ...(binding.providerInstanceId !== undefined
                  ? { providerInstanceId: binding.providerInstanceId }
                  : {}),
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.bootReconcile",
                  lastRuntimeEventAt,
                },
              }),
            ),
          ),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to reconcile provider session bindings at boot", {
        errorTag: causeErrorTag(cause),
      }),
    ),
  );

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    inspectSession,
    readThread,
    requestTurnInterrupt,
    terminateSession,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
