/**
 * T3-CUSTOM(expbkt3): pairing a managed BK build with its central server.
 *
 * Upstream's primary-environment pairing exchanges a credential for a browser
 * *session cookie*. That works because upstream's primary is either the page's
 * own origin or a loopback backend the desktop trusts. A managed BK build's
 * primary is a remote HTTPS server the renderer is not same-origin with, and
 * the desktop's primary HTTP layer deliberately sends `credentials: "omit"` —
 * so a cookie issued there would never be presented again.
 *
 * The same pairing credential works over the OAuth token-exchange endpoint the
 * remote/SSH environments already use, which yields a bearer access token. We
 * keep that token (`fork/managedPrimaryCredential`) and the existing primary
 * bearer seam presents it on every HTTP request and WebSocket ticket.
 *
 * @module fork/managedPrimaryPairing
 */
import type { AuthBrowserSessionResult, AuthEnvironmentScope } from "@t3tools/contracts";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthEnvironmentScope as AuthEnvironmentScopeSchema,
  AuthTokenExchangeGrantType,
} from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { APP_VERSION } from "../branding";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { writeManagedPrimaryAccessToken } from "./managedPrimaryCredential";

const ALLOWED_SCOPES: ReadonlySet<AuthEnvironmentScope> = new Set(
  AuthEnvironmentScopeSchema.literals,
);

/**
 * Exchange a pairing credential for a bearer session on the managed primary
 * environment and record it.
 *
 * Returns the same shape upstream's cookie exchange returns, so the auth gate's
 * success and error handling is untouched. Failures propagate unmapped: the
 * caller already turns an `invalid_credential` auth error into the
 * "Invalid pairing token" message.
 */
export async function pairManagedPrimaryEnvironment(
  credential: string,
): Promise<AuthBrowserSessionResult> {
  const result = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.auth.token({
          headers: {},
          payload: {
            grant_type: AuthTokenExchangeGrantType,
            subject_token: credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            client_device_type: "desktop",
            client_version: APP_VERSION,
          },
        }),
      ),
    ),
  );

  writeManagedPrimaryAccessToken({
    accessToken: result.access_token,
    expiresInSeconds: result.expires_in,
  });

  return {
    authenticated: true,
    scopes: parseAllowedOAuthScope({ value: result.scope, allowedScopes: ALLOWED_SCOPES }) ?? [],
    sessionMethod: "bearer-access-token",
    expiresAt: DateTime.makeUnsafe(Date.now() + result.expires_in * 1_000),
  };
}
