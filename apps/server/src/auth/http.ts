import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentResourceNotFoundError,
  type EnvironmentResourceNotFoundReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { resolveClerkBrowserIdentity } from "./ClerkBrowserIdentity.ts";
// T3-CUSTOM(expbkt3): direct-vs-relay identity policy for the token exchange.
import { resolveExchangeIdentity } from "./ExchangeIdentity.ts";
// T3-CUSTOM(expbkt3): pairing credentials carry the operator that created them.
import { issuePairingCredentialForPrincipal } from "./OperatorIdentity.ts";
import { ClerkDirectory } from "./ClerkDirectory.ts";
import * as ClerkIdentityVerifier from "./ClerkIdentityVerifier.ts";
import * as EnvironmentUserService from "./EnvironmentUserService.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "../cloud/traceRelayRequest.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const appendDpopChallengeOnUnauthorized = (error: EnvironmentAuthInvalidError) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      request.headers.authorization?.startsWith("DPoP ") === true;
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

export const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export function annotateEnvironmentRequest(endpoint: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure"
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            errorTag: causeErrorTag(exit.cause),
            cause: exit.cause,
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });
}

export function failEnvironmentAuthInvalid(reason: EnvironmentAuthInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentAuthInvalidError({ code: "auth_invalid", reason, traceId })),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          requiredScope,
          traceId,
        }),
      ),
    ),
  );
}

function failEnvironmentOperationForbidden(reason: "current_session_revoke_not_allowed") {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentNotFound(reason: EnvironmentResourceNotFoundReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
    ),
  );
}

export function failEnvironmentInternal(reason: EnvironmentInternalErrorReason, error?: unknown) {
  return Effect.gen(function* () {
    const traceId = yield* currentEnvironmentTraceId;
    if (error !== undefined) {
      yield* Effect.logError("environment api operation failed", {
        reason,
        traceId,
        cause: error,
      });
    }
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });
}

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

export const environmentAuthenticatedAuthLayer = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        return yield* httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
          session.subject === "cloud-connect" ? traceAuthenticatedRelayRequest : identity,
        );
      }).pipe(Effect.catchTag("EnvironmentAuthInvalidError", appendDpopChallengeOnUnauthorized));
  }),
);

export const authHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const clerkDirectory = yield* ClerkDirectory;
    const clerkIdentity = yield* ClerkIdentityVerifier.ClerkIdentityVerifier;
    const users = yield* EnvironmentUserService.EnvironmentUserService;
    const settings = yield* ServerSettings.ServerSettingsService;

    const resolveIdentity = (
      token: string | undefined,
    ): Effect.Effect<
      ClerkIdentityVerifier.VerifiedClerkIdentity | null,
      EnvironmentAuthInvalidError | EnvironmentInternalError
    > =>
      Effect.gen(function* () {
        const identityMode = yield* settings.getSettings.pipe(
          Effect.map((current) => current.environmentUserIdentityMode),
          Effect.catch((error) => failEnvironmentInternal("identity_management_failed", error)),
        );
        if (!token) {
          return identityMode === "required"
            ? yield* failEnvironmentAuthInvalid("missing_identity")
            : null;
        }
        const identity = yield* clerkIdentity.verify(token).pipe(
          Effect.catchTag("EnvironmentUserManagementError", (error) =>
            Effect.gen(function* () {
              return error.reason === "identity-not-configured"
                ? yield* failEnvironmentInternal("identity_management_failed", error)
                : yield* failEnvironmentAuthInvalid("invalid_identity");
            }),
          ),
        );
        yield* users.assertAllowed(identity.userId).pipe(
          Effect.catchTag("EnvironmentUserManagementError", (error) =>
            Effect.gen(function* () {
              return error.reason === "identity-blocked"
                ? yield* failEnvironmentAuthInvalid("blocked_identity")
                : yield* failEnvironmentInternal("identity_management_failed", error);
            }),
          ),
        );
        return identity;
      }).pipe(Effect.withSpan("environment.auth.resolveIdentity"));

    const persistIdentity = Effect.fn("environment.auth.persistIdentity")(function* (
      identity: ClerkIdentityVerifier.VerifiedClerkIdentity | null,
      administrativeGrant: boolean,
    ) {
      if (identity === null) return;
      yield* users
        .admit(identity, { administrativeGrant })
        .pipe(
          Effect.catchTag("EnvironmentUserManagementError", (error) =>
            failEnvironmentInternal("identity_management_failed", error),
          ),
        );
    });

    // T3-CUSTOM(expbkt3): Browser tokens are ordinary Clerk session tokens. They must be
    // verified with the Clerk secret + org membership, not the relay JWT audience verifier.
    const resolveDirectClerkIdentity = (token: string) =>
      resolveClerkBrowserIdentity(token).pipe(
        Effect.provideService(ClerkDirectory, clerkDirectory),
        Effect.catchTag("ClerkDirectoryError", (error) =>
          failEnvironmentInternal("identity_management_failed", error),
        ),
        Effect.tap(({ identity }) =>
          users.assertAllowed(identity.userId).pipe(
            Effect.catchTag("EnvironmentUserManagementError", (error) =>
              Effect.gen(function* () {
                return error.reason === "identity-blocked"
                  ? yield* failEnvironmentAuthInvalid("blocked_identity")
                  : yield* failEnvironmentInternal("identity_management_failed", error);
              }),
            ),
          ),
        ),
      );

    // T3-CUSTOM(expbkt3): BEGIN — identity for the `/oauth/token` exchange. Policy
    // and its rationale live in `ExchangeIdentity.ts`; this binds it to the two
    // verifiers already built above.
    //
    // A verified non-member fails as `invalid_identity` rather than the 403 that
    // `clerkSession` returns: this endpoint's declared error union has no forbidden
    // member, and widening it would ripple through every remote client's error type.
    const resolveTokenExchangeIdentity = (token: string | undefined) =>
      resolveExchangeIdentity({
        token,
        verifyDirect: resolveDirectClerkIdentity,
        verifyRelayAudience: resolveIdentity,
        onNotOrgMember: () => failEnvironmentAuthInvalid("invalid_identity"),
      });
    // T3-CUSTOM(expbkt3): END

    // T3-CUSTOM(expbkt3): BEGIN — revoke the caller and expire its HttpOnly browser cookie.
    const logoutHandler = Effect.fn("environment.auth.logout")(
      function* () {
        yield* annotateEnvironmentRequest("logout");
        const session = yield* EnvironmentAuthenticatedPrincipal;
        const revoked = yield* serverAuth.revokeSession(session.sessionId);

        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.expireCookieUnsafe(response, sessions.cookieName, {
              httpOnly: true,
              path: "/",
              sameSite: "lax",
            }),
          ),
        );
        yield* appendCredentialResponseHeaders;
        return { revoked };
      },
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("client_session_revoke_failed", error),
      ),
    );
    // T3-CUSTOM(expbkt3): END

    return handlers
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* serverAuth.getSessionState(request);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle("logout", logoutHandler) // T3-CUSTOM(expbkt3): Server-backed web logout.
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const identity = yield* resolveIdentity(args.payload.identityToken);
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              deriveAuthClientMetadata({
                request,
                ...(args.payload.client_version
                  ? { presented: { appVersion: args.payload.client_version } }
                  : {}),
              }),
              identity ? { userId: identity.userId } : undefined,
            );
            yield* persistIdentity(
              identity,
              result.response.scopes.includes(AuthAccessWriteScope),
            ).pipe(
              Effect.tapError(() =>
                sessions.verify(result.sessionToken).pipe(
                  Effect.flatMap((session) => sessions.revoke(session.sessionId)),
                  Effect.ignore,
                ),
              ),
            );
            const sessionCookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, sessions.cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "clerkSession",
        Effect.fn("environment.auth.clerkSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            // Verify the Clerk token and hard-gate on org membership before
            // minting a browser-session cookie bound to "clerk:<userId>".
            const verified = yield* resolveDirectClerkIdentity(args.payload.token);
            yield* persistIdentity(verified.identity, verified.administrativeGrant);
            const result = yield* serverAuth.createClerkBrowserSession(
              { subject: verified.subject, userId: verified.identity.userId },
              deriveAuthClientMetadata({
                request,
                ...(args.payload.client_version
                  ? { presented: { appVersion: args.payload.client_version } }
                  : {}),
              }),
            );
            const sessionCookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, sessions.cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          // A valid token for a non-member (or Clerk disabled) is forbidden;
          // a bad/expired token is auth_invalid.
          Effect.catchTag(
            "ClerkAuthError",
            (
              error,
            ): Effect.Effect<never, EnvironmentAuthInvalidError | EnvironmentHttpForbiddenError> =>
              error.reason === "invalid_token"
                ? failEnvironmentAuthInvalid("invalid_credential")
                : Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "bindIdentity",
        Effect.fn("environment.auth.bindIdentity")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            // T3-CUSTOM(expbkt3): This endpoint receives the direct browser session token.
            const verified = yield* resolveDirectClerkIdentity(args.payload.identityToken);
            const identity = verified.identity;
            yield* persistIdentity(
              identity,
              verified.administrativeGrant || session.scopes.has(AuthAccessWriteScope),
            );
            yield* sessions
              .bindUserId(session.sessionId, identity.userId)
              .pipe(
                Effect.catchIf(SessionStore.isSessionCredentialInternalError, (error) =>
                  failEnvironmentInternal("identity_management_failed", error),
                ),
              );
            yield* appendCredentialResponseHeaders;
            return { userId: identity.userId };
          },
          Effect.catchTag("ClerkAuthError", () => failEnvironmentAuthInvalid("invalid_identity")),
          Effect.catchTag("EnvironmentAuthInvalidError", appendDpopChallengeOnUnauthorized),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : parseAllowedOAuthScope({
                    value: args.payload.scope,
                    allowedScopes: new Set<AuthEnvironmentScope>([
                      AuthOrchestrationReadScope,
                      AuthOrchestrationOperateScope,
                      AuthTerminalOperateScope,
                      AuthReviewWriteScope,
                      AuthAccessReadScope,
                      AuthAccessWriteScope,
                      AuthRelayReadScope,
                      AuthRelayWriteScope,
                    ]),
                  });
            if (requestedScopes === null) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            const proofKeyThumbprint = args.headers.dpop
              ? yield* verifyRequestDpopProof({ request }).pipe(
                  Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
                    appendDpopChallengeHeader.pipe(
                      Effect.andThen(failEnvironmentAuthInvalid("invalid_credential")),
                    ),
                  ),
                  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                    failEnvironmentInternal("access_token_issuance_failed", error),
                  ),
                )
              : undefined;
            // T3-CUSTOM(expbkt3): accept a direct Clerk browser token here too, so a
            // remote client can pair against `environmentUserIdentityMode: "required"`.
            const { identity, administrativeGrant } = yield* resolveTokenExchangeIdentity(
              args.payload.identity_token,
            );
            yield* appendCredentialResponseHeaders;
            const result = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                  // T3-CUSTOM(expbkt3): persist client build identity for diagnostics.
                  ...(args.payload.client_version
                    ? { appVersion: args.payload.client_version }
                    : {}),
                },
              }),
              proofKeyThumbprint || identity
                ? {
                    ...(proofKeyThumbprint ? { proofKeyThumbprint } : {}),
                    ...(identity ? { userId: identity.userId } : {}),
                  }
                : undefined,
            );
            yield* persistIdentity(
              identity,
              // T3-CUSTOM(expbkt3): a Clerk org admin is admitted as an environment
              // admin, matching `bindIdentity`.
              administrativeGrant || result.scope.split(" ").includes(AuthAccessWriteScope),
            ).pipe(
              Effect.tapError(() =>
                sessions.verify(result.access_token).pipe(
                  Effect.flatMap((session) => sessions.revoke(session.sessionId)),
                  Effect.ignore,
                ),
              ),
            );
            return result;
          },
          traceRelayRequest,
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const delegatedScopes = args.payload.scopes ?? AuthStandardClientScopes;
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            // T3-CUSTOM(expbkt3): stamp the authenticated operator on the credential
            // so a client paired with it acts as them. The subject comes from the
            // session, never from the payload — `AuthCreatePairingCredentialInput`
            // has no `subject` field, so no client can mint one for a teammate.
            return yield* issuePairingCredentialForPrincipal({
              serverAuth,
              principal: session,
              scopes: delegatedScopes,
              ...(args.payload.label ? { label: args.payload.label } : {}),
            });
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_credential_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingLinks",
        Effect.fn("environment.auth.pairingLinks")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listPairingLinks();
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_links_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_link_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "clients",
        Effect.fn("environment.auth.clients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listClientSessions(session.sessionId);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_sessions_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeClientSession(
              session.sessionId,
              args.payload.sessionId,
            );
            return { revoked };
          },
          Effect.catchTag("ServerAuthForbiddenOperationError", () =>
            failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      );
  }),
);
