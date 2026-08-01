/**
 * ownershipBackfill - One-time legacy ownership assignment for team mode.
 *
 * Runs at startup (after migrations) only when Clerk team mode is configured.
 * Restores a creator from durable events or legacy membership first, then
 * assigns any remaining ownerless thread/project to the configured default or
 * earliest active administrator. Idempotent and fail-soft: if the fallback
 * owner cannot be resolved it logs a warning and converges on a later boot.
 *
 * @module ownershipBackfill
 */
import type { UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ClerkDirectory } from "../auth/ClerkDirectory.ts";
import { ServerConfig } from "../config.ts";

/** Assigns every collaborative projection a deterministic durable owner. */
export const backfillProjectionOwnership = Effect.fn("backfillProjectionOwnership")(function* (
  adminUserId: UserId,
) {
  const sql = yield* SqlClient.SqlClient;

  // Prefer the actor recorded by modern created events. This repairs a stale
  // projection without rewriting event history.
  const creatorThreadResult = yield* sql`
    UPDATE projection_threads AS thread
    SET owner_user_id = (
      SELECT json_extract(created.payload_json, '$.createdByUserId')
      FROM orchestration_events AS created
      WHERE created.event_type = 'thread.created'
        AND created.stream_id = thread.thread_id
        AND json_extract(created.payload_json, '$.createdByUserId') IS NOT NULL
      ORDER BY created.stream_version ASC
      LIMIT 1
    )
    WHERE (owner_user_id IS NULL OR owner_user_id = ${adminUserId})
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS transferred
        WHERE transferred.event_type = 'thread.owner-transferred'
          AND transferred.stream_id = thread.thread_id
      )
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created
        WHERE created.event_type = 'thread.created'
          AND created.stream_id = thread.thread_id
          AND json_extract(created.payload_json, '$.createdByUserId') IS NOT NULL
      )
  `;
  const creatorProjectResult = yield* sql`
    UPDATE projection_projects AS project
    SET owner_user_id = (
      SELECT json_extract(created.payload_json, '$.createdByUserId')
      FROM orchestration_events AS created
      WHERE created.event_type = 'project.created'
        AND created.stream_id = project.project_id
        AND json_extract(created.payload_json, '$.createdByUserId') IS NOT NULL
      ORDER BY created.stream_version ASC
      LIMIT 1
    )
    WHERE (owner_user_id IS NULL OR owner_user_id = ${adminUserId})
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS transferred
        WHERE transferred.event_type = 'project.owner-transferred'
          AND transferred.stream_id = project.project_id
      )
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created
        WHERE created.event_type = 'project.created'
          AND created.stream_id = project.project_id
          AND json_extract(created.payload_json, '$.createdByUserId') IS NOT NULL
      )
  `;

  // Pre-identity imports stored the historical assignee as a system-added
  // member. Promote that person instead of assigning the environment admin.
  const legacyThreadResult = yield* sql`
    UPDATE projection_threads AS thread
    SET owner_user_id = (
      SELECT member.user_id
      FROM projection_thread_members AS member
      WHERE member.thread_id = thread.thread_id
        AND member.added_by_user_id IS NULL
      ORDER BY member.added_at ASC, member.user_id ASC
      LIMIT 1
    )
    WHERE (owner_user_id IS NULL OR owner_user_id = ${adminUserId})
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS transferred
        WHERE transferred.event_type = 'thread.owner-transferred'
          AND transferred.stream_id = thread.thread_id
      )
      AND EXISTS (
        SELECT 1
        FROM projection_thread_members AS member
        WHERE member.thread_id = thread.thread_id
          AND member.added_by_user_id IS NULL
      )
  `;
  const legacyProjectResult = yield* sql`
    UPDATE projection_projects AS project
    SET owner_user_id = (
      SELECT member.user_id
      FROM projection_project_members AS member
      WHERE member.project_id = project.project_id
        AND member.added_by_user_id IS NULL
      ORDER BY member.added_at ASC, member.user_id ASC
      LIMIT 1
    )
    WHERE (owner_user_id IS NULL OR owner_user_id = ${adminUserId})
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS transferred
        WHERE transferred.event_type = 'project.owner-transferred'
          AND transferred.stream_id = project.project_id
      )
      AND EXISTS (
        SELECT 1
        FROM projection_project_members AS member
        WHERE member.project_id = project.project_id
          AND member.added_by_user_id IS NULL
      )
  `;

  // If older data has members but no creator metadata, the earliest member is
  // the best durable owner. Truly unassigned rows fall back to the configured
  // administrator, so collaborative mode never exposes an ownerless thread.
  yield* sql`
    UPDATE projection_threads AS thread
    SET owner_user_id = (
      SELECT member.user_id
      FROM projection_thread_members AS member
      WHERE member.thread_id = thread.thread_id
      ORDER BY member.added_at ASC, member.user_id ASC
      LIMIT 1
    )
    WHERE owner_user_id IS NULL
      AND EXISTS (
        SELECT 1 FROM projection_thread_members AS member
        WHERE member.thread_id = thread.thread_id
      )
  `;
  yield* sql`
    UPDATE projection_projects AS project
    SET owner_user_id = (
      SELECT member.user_id
      FROM projection_project_members AS member
      WHERE member.project_id = project.project_id
      ORDER BY member.added_at ASC, member.user_id ASC
      LIMIT 1
    )
    WHERE owner_user_id IS NULL
      AND EXISTS (
        SELECT 1 FROM projection_project_members AS member
        WHERE member.project_id = project.project_id
      )
  `;
  const threadResult = yield* sql`
    UPDATE projection_threads SET owner_user_id = ${adminUserId} WHERE owner_user_id IS NULL
  `;
  const projectResult = yield* sql`
    UPDATE projection_projects SET owner_user_id = ${adminUserId} WHERE owner_user_id IS NULL
  `;

  yield* sql`
    DELETE FROM projection_thread_members
    WHERE user_id = (
      SELECT thread.owner_user_id FROM projection_threads AS thread
      WHERE thread.thread_id = projection_thread_members.thread_id
    )
  `;
  yield* sql`
    DELETE FROM projection_project_members
    WHERE user_id = (
      SELECT project.owner_user_id FROM projection_projects AS project
      WHERE project.project_id = projection_project_members.project_id
    )
  `;

  return {
    restoredThreads:
      ((creatorThreadResult as { readonly rowsAffected?: number }).rowsAffected ?? 0) +
      ((legacyThreadResult as { readonly rowsAffected?: number }).rowsAffected ?? 0),
    restoredProjects:
      ((creatorProjectResult as { readonly rowsAffected?: number }).rowsAffected ?? 0) +
      ((legacyProjectResult as { readonly rowsAffected?: number }).rowsAffected ?? 0),
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
  const sql = yield* SqlClient.SqlClient;
  const explicitOwnerId =
    clerkAuth.defaultOwnerUserId !== undefined ? (clerkAuth.defaultOwnerUserId as UserId) : null;
  const configuredAdminUserId: UserId | null =
    explicitOwnerId ??
    (clerkAuth.defaultOwnerEmail !== undefined
      ? yield* clerkDirectory
          .findUserIdByEmail(clerkAuth.defaultOwnerEmail)
          .pipe(Effect.orElseSucceed(() => null))
      : null);
  const localAdmin = yield* sql<{ readonly userId: string }>`
    SELECT user_id AS "userId"
    FROM environment_users
    WHERE role = 'admin' AND status = 'active'
    ORDER BY first_seen_at ASC, user_id ASC
    LIMIT 1
  `;
  const adminUserId: UserId | null =
    configuredAdminUserId ??
    (localAdmin[0] === undefined ? null : (localAdmin[0].userId as UserId));

  if (adminUserId === null) {
    yield* Effect.logWarning(
      "ownership backfill skipped: could not resolve a configured or active admin owner; will retry next boot",
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
