/**
 * T3-CUSTOM(expbkt3): ExchangeIdentity - which Clerk verifier `/oauth/token` uses.
 *
 * Two kinds of client present an `identity_token` at the token exchange, and they
 * carry different JWTs:
 *
 * - a client pairing directly with this environment sends an ordinary Clerk browser
 *   session token, which only verifies against the Clerk secret (`ClerkDirectory`);
 * - relay-brokered and mobile clients send the relay-audience identity JWT, which
 *   verifies through `ClerkIdentityVerifier` (JWKS + audience `t3-code-relay`).
 *
 * Neither verifier accepts the other's token, so the exchange tries the direct one
 * and falls back. The order matters: falling back on a *rejected* token is what
 * keeps every pre-existing client working unchanged, while a verified non-member
 * must not fall through to a second chance.
 *
 * The policy lives here, apart from the HTTP wiring, because it is the whole of the
 * fork's behavior at this seam and needs to stay covered across upstream merges.
 *
 * @module auth/ExchangeIdentity
 */
import type { EnvironmentAuthInvalidError, EnvironmentInternalError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ClerkAuthError } from "./ClerkDirectory.ts";
import type { VerifiedClerkBrowserIdentity } from "./ClerkBrowserIdentity.ts";
import type { VerifiedClerkIdentity } from "./ClerkIdentityVerifier.ts";

/** The failures `/oauth/token` may already report while resolving an identity. */
export type ExchangeIdentityError = EnvironmentAuthInvalidError | EnvironmentInternalError;

export interface ExchangeIdentityResolution {
  /** The operator to bind to the session, or `null` for an unidentified exchange. */
  readonly identity: VerifiedClerkIdentity | null;
  /** True when Clerk reports the operator as an organization admin. */
  readonly administrativeGrant: boolean;
}

/**
 * Resolve the identity for a token exchange.
 *
 * `verifyRelayAudience` owns the no-token case, because that is where the
 * environment's `environmentUserIdentityMode` rule lives — it decides whether an
 * absent identity is acceptable or a `missing_identity` rejection.
 */
export const resolveExchangeIdentity = (input: {
  readonly token: string | undefined;
  readonly verifyDirect: (
    token: string,
  ) => Effect.Effect<VerifiedClerkBrowserIdentity, ClerkAuthError | ExchangeIdentityError>;
  readonly verifyRelayAudience: (
    token: string | undefined,
  ) => Effect.Effect<VerifiedClerkIdentity | null, ExchangeIdentityError>;
  readonly onNotOrgMember: () => Effect.Effect<never, ExchangeIdentityError>;
}): Effect.Effect<ExchangeIdentityResolution, ExchangeIdentityError> => {
  const viaRelayAudience = (
    token: string | undefined,
  ): Effect.Effect<ExchangeIdentityResolution, ExchangeIdentityError> =>
    input
      .verifyRelayAudience(token)
      .pipe(Effect.map((identity) => ({ identity, administrativeGrant: false })));

  const token = input.token;
  if (token === undefined) {
    return viaRelayAudience(token);
  }

  return input.verifyDirect(token).pipe(
    Effect.map(
      (verified): ExchangeIdentityResolution => ({
        identity: verified.identity,
        administrativeGrant: verified.administrativeGrant,
      }),
    ),
    Effect.catchTag("ClerkAuthError", (error) =>
      // A verified identity that is simply outside the organization is a decision,
      // not a failed guess at the token format. Retrying it against the other
      // verifier would either fail confusingly or, worse, admit someone the org
      // gate just turned away.
      error.reason === "not_org_member" ? input.onNotOrgMember() : viaRelayAudience(token),
    ),
  );
};
