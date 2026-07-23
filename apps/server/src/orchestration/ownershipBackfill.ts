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

/**
 * Repairs the legacy relay shape where the historical assignee was persisted
 * as a member on an ownerless entity, then assigns the default owner only to
 * entities that truly have no owner or assignee.
 */
export const backfillProjectionOwnership = Effect.fn("backfillProjectionOwnership")(function* (
  adminUserId: UserId,
) {
  const sql = yield* SqlClient.SqlClient;

  // Earlier startup backfills assigned the configured default owner to every
  // null owner. Relay-imported entities already had their historical assignee
  // represented by a system-added member row, so that default owner displaced
  // the visible assignee after a restart. Restore those exact legacy rows to
  // ownerless + assigned; their member record remains the durable assignment.
  const restoredThreadResult = yield* sql`
    UPDATE projection_threads AS thread
    SET owner_user_id = NULL
    WHERE owner_user_id = ${adminUserId}
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created
        WHERE created.event_type = 'thread.created'
          AND created.stream_id = thread.thread_id
          AND json_extract(created.payload_json, '$.createdByUserId') IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM projection_thread_members AS member
        WHERE member.thread_id = thread.thread_id
          AND member.added_by_user_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS transferred
        WHERE transferred.event_type = 'thread.owner-transferred'
          AND transferred.stream_id = thread.thread_id
      )
  `;
  const restoredProjectResult = yield* sql`
    UPDATE projection_projects AS project
    SET owner_user_id = NULL
    WHERE owner_user_id = ${adminUserId}
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created
        WHERE created.event_type = 'project.created'
          AND created.stream_id = project.project_id
          AND json_extract(created.payload_json, '$.createdByUserId') IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM projection_project_members AS member
        WHERE member.project_id = project.project_id
          AND member.added_by_user_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS transferred
        WHERE transferred.event_type = 'project.owner-transferred'
          AND transferred.stream_id = project.project_id
      )
  `;

  const threadResult = yield* sql`
    UPDATE projection_threads AS thread
    SET owner_user_id = ${adminUserId}
    WHERE owner_user_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM projection_thread_members AS member
        WHERE member.thread_id = thread.thread_id
      )
  `;
  const projectResult = yield* sql`
    UPDATE projection_projects AS project
    SET owner_user_id = ${adminUserId}
    WHERE owner_user_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM projection_project_members AS member
        WHERE member.project_id = project.project_id
      )
  `;

  return {
    restoredThreads:
      (restoredThreadResult as { readonly rowsAffected?: number }).rowsAffected ?? null,
    restoredProjects:
      (restoredProjectResult as { readonly rowsAffected?: number }).rowsAffected ?? null,
    threadsUpdated: (threadResult as { readonly rowsAffected?: number }).rowsAffected ?? null,
    projectsUpdated: (projectResult as { readonly rowsAffected?: number }).rowsAffected ?? null,
  };
});

export const runOwnershipBackfill = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const clerkAuth = config.clerkAuth;
  // Single-user mode: nothing to backfill, ownership stays null everywhere.
  if (clerkAuth === undefined) {
    return;
  }

  const clerkDirectory = yield* ClerkDirectory;
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

  const result = yield* backfillProjectionOwnership(adminUserId);

  yield* Effect.logInfo("ownership backfill complete", {
    adminUserId,
    ...result,
  });
}).pipe(
  // Fail-soft: never block startup on backfill; converge on a later boot.
  Effect.catchCause((cause) =>
    Effect.logWarning("ownership backfill failed (will retry next boot)", { cause }),
  ),
);
