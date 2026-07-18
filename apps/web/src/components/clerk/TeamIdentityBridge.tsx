/**
 * TeamIdentityBridge - mirror the signed-in Clerk user into the identity atom.
 *
 * Rendered inside ClerkProvider (team mode only). It writes the current Clerk
 * `userId` into `currentClerkUserAtom` so the rest of the app can read the
 * operator identity without depending on Clerk hooks. Pattern mirrors
 * `ManagedRelayAuthProvider`. Renders nothing.
 *
 * @module components/clerk/TeamIdentityBridge
 */
import { useAuth } from "@clerk/react";
import { useEffect } from "react";

import type { UserId } from "@t3tools/contracts";
import { setCurrentClerkUser } from "../../state/identity";

export function TeamIdentityBridge(): null {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    setCurrentClerkUser(isSignedIn && userId ? (userId as UserId) : null);
  }, [isLoaded, isSignedIn, userId]);

  useEffect(() => () => setCurrentClerkUser(null), []);

  return null;
}
