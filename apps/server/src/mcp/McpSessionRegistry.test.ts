import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PERSONAL_T3_CONDUCTOR_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("keeps provider credentials valid across MCP inactivity", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-2");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("expires a never-used provider credential at its maximum lifetime", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-3"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 1_001;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("renews the maximum lifetime whenever a provider credential is used", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-4");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    for (let index = 0; index < 20; index++) {
      timestamp += 90;
      expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
    }

    expect(timestamp).toBeGreaterThan(issued.expiresAt);
  }),
);

it.effect("resolves the enabled external operator key without storing it in the registry", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadExternalMcpSettings: () =>
          Effect.succeed({
            enabled: true,
            apiKey: "t3exp_12345678901234567890123456789012",
          }),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const resolved = yield* registry.resolve("t3exp_12345678901234567890123456789012");
    expect(resolved?.principal).toBe("external-operator");
    expect(resolved?.capabilities.has("t3.control")).toBe(true);
    expect(yield* registry.resolve("incorrect_123456789012345678901234567890")).toBeUndefined();
  }),
);

it.effect("binds Conductor credentials and upstream MCP servers to the actor user", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-tushar");
    const conductorThreadId = ThreadId.make("thread-tushar-conductor");
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadPersonalProfile: (requestedUserId) =>
          Effect.succeed(
            requestedUserId === userId
              ? {
                  userId,
                  conductor: {
                    ...DEFAULT_PERSONAL_T3_CONDUCTOR_SETTINGS,
                    enabled: true,
                    threadId: conductorThreadId,
                  },
                  externalAccessEnabled: true,
                  externalTokenConfigured: true,
                  externalTokenPrefix: "t3usr_test…",
                  integrations: [
                    {
                      id: "bifrost",
                      name: "Bifrost",
                      url: "https://bifrost.example/mcp",
                      enabled: true,
                      authMode: "x-bf-vk",
                      customHeaderName: "",
                      credentialConfigured: true,
                      providerInstanceIds: [],
                      allowedTools: ["linear_get_issue"],
                    },
                  ],
                  updatedAt: "2026-07-27T00:00:00.000Z",
                }
              : undefined,
          ),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const issued = yield* registry.issue({
      threadId: conductorThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      actorUserId: userId,
    });
    expect(issued.config.actorUserId).toBe(userId);
    expect(issued.config.upstreamServers.map((server) => server.id)).toEqual(["bifrost"]);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.actorUserId).toBe(userId);
    expect(resolved?.capabilities.has("t3.session.create")).toBe(true);
  }),
);

it.effect("grants user-wide session authority to every user-bound ACP", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-priya");
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadPersonalProfile: () =>
          Effect.succeed({
            userId,
            conductor: DEFAULT_PERSONAL_T3_CONDUCTOR_SETTINGS,
            externalAccessEnabled: false,
            externalTokenConfigured: false,
            externalTokenPrefix: "",
            integrations: [],
            updatedAt: "2026-07-27T00:00:00.000Z",
          }),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-priya-work"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: userId,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.actorUserId).toBe(userId);
    expect(resolved?.capabilities.has("t3.session.create")).toBe(true);
  }),
);

it.effect("does not grant user-wide session authority without a bound user", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-local-operator"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      actorUserId: null,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.actorUserId).toBeNull();
    expect(resolved?.capabilities.has("t3.session.create")).toBe(false);
  }),
);

it.effect("pre-registers the shared Bifrost proxy for user sessions before setup", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-bifrost");
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadPersonalProfile: () =>
          Effect.succeed({
            userId,
            conductor: DEFAULT_PERSONAL_T3_CONDUCTOR_SETTINGS,
            externalAccessEnabled: false,
            externalTokenConfigured: false,
            externalTokenPrefix: "",
            integrations: [],
            updatedAt: "2026-07-27T00:00:00.000Z",
          }),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-bifrost"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      actorUserId: userId,
    });

    expect(issued.config.upstreamServers).toEqual([
      {
        id: "bifrost",
        name: "Bifrost",
        endpoint: "http://127.0.0.1:43123/mcp/upstream/bifrost",
        authMode: "x-bf-vk",
        allowedTools: [],
      },
    ]);
  }),
);

it.effect("resolves a personal external token only while the external endpoint is enabled", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-tushar");
    let endpointEnabled = true;
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadExternalMcpSettings: () => Effect.succeed({ enabled: endpointEnabled, apiKey: "" }),
        resolveExternalUserToken: (rawToken) =>
          Effect.succeed(
            rawToken === "t3usr_personal-token"
              ? { userId, conductorThreadId: "thread-tushar-conductor" }
              : undefined,
          ),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const resolved = yield* registry.resolve("t3usr_personal-token");
    expect(resolved?.principal).toBe("external-user");
    expect(resolved?.actorUserId).toBe(userId);
    expect(resolved?.capabilities.has("t3.session.create")).toBe(true);

    endpointEnabled = false;
    expect(yield* registry.resolve("t3usr_personal-token")).toBeUndefined();
  }),
);
