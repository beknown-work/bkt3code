/**
 * T3-CUSTOM(expbkt3): Issues and revokes capability-scoped credentials for the
 * experimental T3 MCP endpoint.
 */
import {
  PersonalMcpIntegrationId,
  ProviderInstanceId,
  ThreadId,
  type PersonalMcpProfile,
  type UserId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as UserMcpProfileStore from "./UserMcpProfileStore.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly actorUserId?: UserId | null;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
  readonly expiresAt: number;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastUsedAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly idleTimeoutMs?: number;
  readonly maximumLifetimeMs?: number;
  readonly now?: () => number;
  readonly loadExternalMcpSettings?: () => Effect.Effect<{
    readonly enabled: boolean;
    readonly apiKey: string;
  }>;
  readonly loadPersonalProfile?: (userId: UserId) => Effect.Effect<PersonalMcpProfile | undefined>;
  readonly resolveExternalUserToken?: (
    rawToken: string,
  ) => Effect.Effect<UserMcpProfileStore.ResolvedPersonalMcpToken | undefined>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAXIMUM_LIFETIME_MS = 8 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const tokenHashesMatch = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
};

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maximumLifetimeMs = options.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneExpired = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) =>
          timestamp <= record.scope.expiresAt && timestamp - record.lastUsedAt <= idleTimeoutMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const expiresAt = issuedAt + maximumLifetimeMs;
      const actorUserId = request.actorUserId ?? null;
      const personalProfile =
        actorUserId === null || options.loadPersonalProfile === undefined
          ? undefined
          : yield* options.loadPersonalProfile(actorUserId);
      const isConductor =
        personalProfile !== undefined &&
        personalProfile.conductor.threadId.length > 0 &&
        personalProfile.conductor.threadId === request.threadId;
      const capabilities = new Set<McpInvocationContext.McpCapability>([
        "preview",
        "t3.read",
        "t3.control",
        "t3.plan",
      ]);
      if (isConductor) capabilities.add("t3.session.create");
      const scope: McpInvocationContext.McpInvocationScope = {
        principal: "provider-session",
        actorUserId,
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities,
        issuedAt,
        expiresAt,
      };
      const upstreamServers =
        personalProfile?.integrations
          .filter(
            (integration) =>
              integration.enabled &&
              integration.credentialConfigured &&
              (integration.providerInstanceIds.length === 0 ||
                integration.providerInstanceIds.includes(request.providerInstanceId)),
          )
          .map((integration) => ({
            id: PersonalMcpIntegrationId.make(integration.id),
            name: integration.name,
            endpoint: `${endpoint.slice(0, -"/mcp".length)}/mcp/upstream/${encodeURIComponent(integration.id)}`,
            authMode: integration.authMode,
            allowedTools: integration.allowedTools,
          })) ?? [];
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(pruneExpired(records, issuedAt));
        next.set(tokenHash, { tokenHash, scope, lastUsedAt: issuedAt });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          actorUserId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          upstreamServers,
        },
        expiresAt,
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      const providerScope = yield* SynchronizedRef.modify(state, ({ records }) => {
        const current = pruneExpired(records, timestamp);
        const record = current.get(tokenHash);
        if (!record) return [undefined, { records: current }] as const;
        const next = new Map(current);
        next.set(tokenHash, { ...record, lastUsedAt: timestamp });
        return [record.scope, { records: next }] as const;
      });
      if (providerScope) return providerScope;

      // T3-CUSTOM(expbkt3): The server-wide switch controls all long-lived
      // external credentials. Short-lived ACP credentials above remain
      // available so native in-session T3 tools keep working when it is off.
      const externalSettings = yield* (
        options.loadExternalMcpSettings?.() ?? Effect.succeed({ enabled: false, apiKey: "" })
      );
      if (!externalSettings.enabled) return undefined;

      const externalUser =
        options.resolveExternalUserToken === undefined
          ? undefined
          : yield* options.resolveExternalUserToken(rawToken);
      if (externalUser) {
        return {
          principal: "external-user",
          actorUserId: externalUser.userId,
          environmentId,
          threadId: ThreadId.make(externalUser.conductorThreadId || "external-user"),
          providerSessionId: `external-user:${externalUser.userId}`,
          providerInstanceId: ProviderInstanceId.make("external-user"),
          capabilities: new Set(["t3.read", "t3.control", "t3.plan", "t3.session.create"]),
          issuedAt: timestamp,
          expiresAt: timestamp + idleTimeoutMs,
        } satisfies McpInvocationContext.McpInvocationScope;
      }

      if (
        externalSettings.apiKey.length < 24 ||
        !tokenHashesMatch(yield* hashToken(externalSettings.apiKey), tokenHash)
      ) {
        return undefined;
      }
      return {
        principal: "external-operator",
        actorUserId: null,
        environmentId,
        threadId: ThreadId.make("external-operator"),
        providerSessionId: "external-operator",
        providerInstanceId: ProviderInstanceId.make("external-operator"),
        capabilities: new Set(["t3.read", "t3.control", "t3.plan"]),
        issuedAt: timestamp,
        expiresAt: Number.MAX_SAFE_INTEGER,
      } satisfies McpInvocationContext.McpInvocationScope;
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    issue,
    resolve,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const userProfiles = yield* UserMcpProfileStore.UserMcpProfileStore;
    return yield* makeWithOptions({
      loadExternalMcpSettings: () =>
        serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.experimental.externalMcp),
          Effect.orElseSucceed(() => ({ enabled: false, apiKey: "" })),
        ),
      loadPersonalProfile: (userId) =>
        userProfiles.get(userId).pipe(Effect.orElseSucceed(() => undefined)),
      resolveExternalUserToken: (token) =>
        userProfiles.resolveExternalToken(token).pipe(Effect.orElseSucceed(() => undefined)),
    });
  }).pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
