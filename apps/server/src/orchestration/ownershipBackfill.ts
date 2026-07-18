/**
 * ownershipBackfill - One-time legacy ownership assignment for team mode.
 *
 * Runs at startup (after migrations) only when Clerk team mode is configured.
 * Assigns every pre-ownership thread/project row (owner_user_id IS NULL) to the
 * configured default owner, resolved from `T3CODE_DEFAULT_OWNER_USER_ID` or, as
 * a fallback, `T3CODE_DEFAULT_OWNER_EMAIL` via Clerk. Idempotent (only touches
 * null rows) and fail-soft: if the owner can't be resolved (e.g. Clerk is
 * unreachable) it logs a warning and converges on a later boot.
 *
 * @module ownershipBackfill
 */
import type { UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ClerkDirectory } from "../auth/ClerkDirectory.ts";
import { ServerConfig } from "../config.ts";

export const runOwnershipBackfill = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const clerkAuth = config.clerkAuth;
  // Single-user mode: nothing to backfill, ownership stays null everywhere.
  if (clerkAuth === undefined) {
    return;
  }

  const clerkDirectory = yield* ClerkDirectory;
  const sql = yield* SqlClient.SqlClient;

  const explicitOwnerId =
    clerkAuth.defaultOwnerUserId !== undefined ? (clerkAuth.defaultOwnerUserId as UserId) : null;
  const adminUserId: UserId | null =
    explicitOwnerId ??
    (clerkAuth.defaultOwnerEmail !== undefined
      ? yield* clerkDirectory
          .findUserIdByEmail(clerkAuth.defaultOwnerEmail)
          .pipe(Effect.orElseSucceed(() => null))
      : null);

  if (adminUserId === null) {
    yield* Effect.logWarning(
      "ownership backfill skipped: could not resolve the default owner; will retry next boot",
      {
        defaultOwnerUserId: clerkAuth.defaultOwnerUserId ?? null,
        defaultOwnerEmail: clerkAuth.defaultOwnerEmail ?? null,
      },
    );
    return;
  }

  const threadResult = yield* sql`
    UPDATE projection_threads
    SET owner_user_id = ${adminUserId}
    WHERE owner_user_id IS NULL
  `;
  const projectResult = yield* sql`
    UPDATE projection_projects
    SET owner_user_id = ${adminUserId}
    WHERE owner_user_id IS NULL
  `;

  yield* Effect.logInfo("ownership backfill complete", {
    adminUserId,
    threadsUpdated: (threadResult as { readonly rowsAffected?: number }).rowsAffected ?? null,
    projectsUpdated: (projectResult as { readonly rowsAffected?: number }).rowsAffected ?? null,
  });
}).pipe(
  // Fail-soft: never block startup on backfill; converge on a later boot.
  Effect.catchCause((cause) =>
    Effect.logWarning("ownership backfill failed (will retry next boot)", { cause }),
  ),
);
