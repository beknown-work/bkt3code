/**
 * T3-CUSTOM(expbkt3): tests for the `/oauth/token` identity verifier policy.
 *
 * This is the seam that lets a client pair with a remote fork environment running
 * `environmentUserIdentityMode: "required"`. It must add that ability without
 * disturbing the relay-audience token every existing client already sends.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { EnvironmentAuthInvalidError, EnvironmentUserId } from "@t3tools/contracts";
import { ClerkAuthError } from "./ClerkDirectory.ts";
import { resolveExchangeIdentity } from "./ExchangeIdentity.ts";
import type { VerifiedClerkIdentity } from "./ClerkIdentityVerifier.ts";

const BROWSER_USER = EnvironmentUserId.make("user_browser");
const RELAY_USER = EnvironmentUserId.make("user_relay");

const browserIdentity: VerifiedClerkIdentity = {
  userId: BROWSER_USER,
  displayName: "Browser Operator",
  primaryEmail: "browser@example.com",
  avatarUrl: null,
};

const relayIdentity: VerifiedClerkIdentity = {
  userId: RELAY_USER,
  displayName: "Relay Operator",
  primaryEmail: "relay@example.com",
  avatarUrl: null,
};

const authInvalid = (reason: "invalid_identity" | "missing_identity") =>
  new EnvironmentAuthInvalidError({
    code: "auth_invalid",
    reason,
    traceId: "test-trace",
  });

const verifyDirectSucceeds = (administrativeGrant: boolean) => () =>
  Effect.succeed({
    identity: browserIdentity,
    subject: `clerk:${BROWSER_USER}`,
    administrativeGrant,
  });

const verifyDirectFails = (reason: ClerkAuthError["reason"]) => () =>
  Effect.fail(new ClerkAuthError({ reason, message: `direct verifier: ${reason}` }));

const relayVerifierReturning = (identity: VerifiedClerkIdentity | null) => {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    verify: (token: string | undefined) => {
      calls.push(token);
      return Effect.succeed(identity);
    },
  };
};

const neverCalledDirect = (): never => {
  throw new Error("direct verifier should not run");
};

const rejectNotOrgMember = () => Effect.fail(authInvalid("invalid_identity"));

describe("token exchange identity policy", () => {
  it.effect("binds a direct Clerk browser token without consulting the relay verifier", () =>
    Effect.gen(function* () {
      const relay = relayVerifierReturning(relayIdentity);
      const result = yield* resolveExchangeIdentity({
        token: "clerk-browser-token",
        verifyDirect: verifyDirectSucceeds(false),
        verifyRelayAudience: relay.verify,
        onNotOrgMember: rejectNotOrgMember,
      });

      expect(result.identity?.userId).toBe(BROWSER_USER);
      expect(result.administrativeGrant).toBe(false);
      expect(relay.calls).toEqual([]);
    }),
  );

  it.effect("carries a Clerk org admin through as an administrative grant", () =>
    Effect.gen(function* () {
      const relay = relayVerifierReturning(null);
      const result = yield* resolveExchangeIdentity({
        token: "clerk-browser-token",
        verifyDirect: verifyDirectSucceeds(true),
        verifyRelayAudience: relay.verify,
        onNotOrgMember: rejectNotOrgMember,
      });

      expect(result.administrativeGrant).toBe(true);
    }),
  );

  // The regression this whole seam has to avoid: relay and mobile clients send a
  // token the direct verifier cannot read, and they must keep working untouched.
  it.effect("falls back to the relay verifier when the direct one rejects the token", () =>
    Effect.gen(function* () {
      const relay = relayVerifierReturning(relayIdentity);
      const result = yield* resolveExchangeIdentity({
        token: "relay-audience-token",
        verifyDirect: verifyDirectFails("invalid_token"),
        verifyRelayAudience: relay.verify,
        onNotOrgMember: rejectNotOrgMember,
      });

      expect(result.identity?.userId).toBe(RELAY_USER);
      expect(result.administrativeGrant).toBe(false);
      expect(relay.calls).toEqual(["relay-audience-token"]);
    }),
  );

  it.effect("falls back when Clerk is not configured on this environment", () =>
    Effect.gen(function* () {
      const relay = relayVerifierReturning(relayIdentity);
      const result = yield* resolveExchangeIdentity({
        token: "relay-audience-token",
        verifyDirect: verifyDirectFails("disabled"),
        verifyRelayAudience: relay.verify,
        onNotOrgMember: rejectNotOrgMember,
      });

      expect(result.identity?.userId).toBe(RELAY_USER);
    }),
  );

  // A non-member is a decision, not a misread token. Falling back here would give
  // an account the org gate just refused a second verifier to try.
  it.effect("rejects a verified non-member instead of retrying the other verifier", () =>
    Effect.gen(function* () {
      const relay = relayVerifierReturning(relayIdentity);
      const error = yield* resolveExchangeIdentity({
        token: "outsider-token",
        verifyDirect: verifyDirectFails("not_org_member"),
        verifyRelayAudience: relay.verify,
        onNotOrgMember: rejectNotOrgMember,
      }).pipe(Effect.flip);

      expect(error.reason).toBe("invalid_identity");
      expect(relay.calls).toEqual([]);
    }),
  );

  // The absent-token case belongs to the relay verifier, because that is where the
  // environment's `environmentUserIdentityMode` rule is enforced.
  it.effect("delegates an absent token so the identity-mode rule still decides", () =>
    Effect.gen(function* () {
      const relay = relayVerifierReturning(null);
      const result = yield* resolveExchangeIdentity({
        token: undefined,
        verifyDirect: neverCalledDirect,
        verifyRelayAudience: relay.verify,
        onNotOrgMember: rejectNotOrgMember,
      });

      expect(result).toEqual({ identity: null, administrativeGrant: false });
      expect(relay.calls).toEqual([undefined]);
    }),
  );

  it.effect("propagates a required-identity rejection for an absent token", () =>
    Effect.gen(function* () {
      const error = yield* resolveExchangeIdentity({
        token: undefined,
        verifyDirect: neverCalledDirect,
        verifyRelayAudience: () => Effect.fail(authInvalid("missing_identity")),
        onNotOrgMember: rejectNotOrgMember,
      }).pipe(Effect.flip);

      expect(error.reason).toBe("missing_identity");
    }),
  );
});
