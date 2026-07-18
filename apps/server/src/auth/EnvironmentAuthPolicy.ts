import type { ServerAuthDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { resolveSessionCookieName } from "./utils.ts";
import { isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

export class EnvironmentAuthPolicy extends Context.Service<
  EnvironmentAuthPolicy,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  }
>()("t3/auth/EnvironmentAuthPolicy") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const isRemoteReachable = isWildcardHost(config.host) || !isLoopbackHost(config.host);

  const policy =
    config.mode === "desktop"
      ? isRemoteReachable
        ? "remote-reachable"
        : "desktop-managed-local"
      : isRemoteReachable
        ? "remote-reachable"
        : "loopback-browser";

  const baseBootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    policy === "desktop-managed-local"
      ? ["desktop-bootstrap"]
      : config.mode === "desktop" && policy === "remote-reachable"
        ? ["desktop-bootstrap", "one-time-token"]
        : ["one-time-token"];

  // Team mode: advertise the Clerk sign-in bootstrap method and (when a
  // publishable key is configured) a runtime descriptor so the SPA can detect
  // team mode and render its Clerk sign-in surface without build-time coupling.
  const clerkConfig = config.clerkAuth;
  const bootstrapMethods: ServerAuthDescriptor["bootstrapMethods"] =
    clerkConfig !== undefined ? [...baseBootstrapMethods, "clerk-session"] : baseBootstrapMethods;
  const clerk: ServerAuthDescriptor["clerk"] =
    clerkConfig?.publishableKey !== undefined
      ? {
          publishableKey: clerkConfig.publishableKey,
          organizationId: clerkConfig.organizationId ?? null,
        }
      : undefined;

  const descriptor: ServerAuthDescriptor = {
    policy,
    bootstrapMethods,
    sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
    }),
    ...(clerk !== undefined ? { clerk } : {}),
  };

  return EnvironmentAuthPolicy.of({
    getDescriptor: () =>
      Effect.succeed(descriptor).pipe(Effect.withSpan("EnvironmentAuthPolicy.getDescriptor")),
  });
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make);
