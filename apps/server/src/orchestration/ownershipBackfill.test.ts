import { UserId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { backfillProjectionOwnership } from "./ownershipBackfill.ts";

const DEFAULT_OWNER = UserId.make("user_default_owner");
const HISTORICAL_ASSIGNEE = UserId.make("user_historical_assignee");
const NOW = "2026-07-23T00:00:00.000Z";

it.layer(SqlitePersistenceMemory)("ownership backfill", (it) => {
  it.effect("preserves legacy assignments and repairs a previously injected default owner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, owner_user_id
        ) VALUES (
          'project-legacy', 'Legacy project', '/tmp/legacy', '[]', ${NOW}, ${NOW}, ${DEFAULT_OWNER}
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, owner_user_id
        ) VALUES (
          'thread-legacy', 'project-legacy', 'Legacy thread', ${NOW}, ${NOW}, ${DEFAULT_OWNER}
        )
      `;
      yield* sql`
        INSERT INTO projection_project_members (
          project_id, user_id, added_by_user_id, added_at
        ) VALUES (
          'project-legacy', ${HISTORICAL_ASSIGNEE}, NULL, ${NOW}
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_members (
          thread_id, user_id, added_by_user_id, added_at
        ) VALUES (
          'thread-legacy', ${HISTORICAL_ASSIGNEE}, NULL, ${NOW}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'event-project-created', 'project', 'project-legacy', 1, 'project.created', ${NOW},
            'server', '{"projectId":"project-legacy","createdByUserId":null}', '{}'
          ),
          (
            'event-thread-created', 'thread', 'thread-legacy', 1, 'thread.created', ${NOW},
            'server', '{"threadId":"thread-legacy","createdByUserId":null}', '{}'
          )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, owner_user_id
        ) VALUES (
          'thread-explicit-transfer', 'project-legacy', 'Explicit transfer', ${NOW}, ${NOW},
          ${DEFAULT_OWNER}
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_members (
          thread_id, user_id, added_by_user_id, added_at
        ) VALUES (
          'thread-explicit-transfer', ${HISTORICAL_ASSIGNEE}, NULL, ${NOW}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'event-explicit-thread-created', 'thread', 'thread-explicit-transfer', 1,
            'thread.created', ${NOW}, 'server',
            '{"threadId":"thread-explicit-transfer","createdByUserId":null}', '{}'
          ),
          (
            'event-explicit-thread-transfer', 'thread', 'thread-explicit-transfer', 2,
            'thread.owner-transferred', ${NOW}, 'client',
            '{"threadId":"thread-explicit-transfer","ownerUserId":"user_default_owner"}', '{}'
          )
      `;

      yield* backfillProjectionOwnership(DEFAULT_OWNER);

      const threads = yield* sql<{
        readonly threadId: string;
        readonly ownerUserId: string | null;
      }>`
        SELECT thread_id AS "threadId", owner_user_id AS "ownerUserId"
        FROM projection_threads
        WHERE thread_id IN ('thread-legacy', 'thread-explicit-transfer')
        ORDER BY thread_id
      `;
      const projects = yield* sql<{ readonly ownerUserId: string | null }>`
        SELECT owner_user_id AS "ownerUserId"
        FROM projection_projects
        WHERE project_id = 'project-legacy'
      `;
      assert.deepEqual(threads, [
        { threadId: "thread-explicit-transfer", ownerUserId: DEFAULT_OWNER },
        { threadId: "thread-legacy", ownerUserId: HISTORICAL_ASSIGNEE },
      ]);
      assert.deepEqual(projects, [{ ownerUserId: HISTORICAL_ASSIGNEE }]);
    }),
  );

  it.effect("restores the recorded creator before falling back to the default owner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, owner_user_id
        ) VALUES (
          'project-created', 'Created project', '/tmp/created', '[]', ${NOW}, ${NOW}, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, owner_user_id
        ) VALUES (
          'thread-created', 'project-created', 'Created thread', ${NOW}, ${NOW}, NULL
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'event-created-project', 'project', 'project-created', 1, 'project.created', ${NOW},
            'client', '{"projectId":"project-created","createdByUserId":"user_creator"}', '{}'
          ),
          (
            'event-created-thread', 'thread', 'thread-created', 1, 'thread.created', ${NOW},
            'client', '{"threadId":"thread-created","createdByUserId":"user_creator"}', '{}'
          )
      `;

      yield* backfillProjectionOwnership(DEFAULT_OWNER);

      const threads = yield* sql<{ readonly ownerUserId: string | null }>`
        SELECT owner_user_id AS "ownerUserId"
        FROM projection_threads
        WHERE thread_id = 'thread-created'
      `;
      const projects = yield* sql<{ readonly ownerUserId: string | null }>`
        SELECT owner_user_id AS "ownerUserId"
        FROM projection_projects
        WHERE project_id = 'project-created'
      `;
      assert.deepEqual(threads, [{ ownerUserId: "user_creator" }]);
      assert.deepEqual(projects, [{ ownerUserId: "user_creator" }]);
    }),
  );

  it.effect("assigns the default owner only when no prior assignment exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, owner_user_id
        ) VALUES (
          'project-unassigned', 'Unassigned project', '/tmp/unassigned', '[]', ${NOW}, ${NOW}, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at, owner_user_id
        ) VALUES (
          'thread-unassigned', 'project-unassigned', 'Unassigned thread', ${NOW}, ${NOW}, NULL
        )
      `;

      yield* backfillProjectionOwnership(DEFAULT_OWNER);

      const threads = yield* sql<{ readonly ownerUserId: string | null }>`
        SELECT owner_user_id AS "ownerUserId"
        FROM projection_threads
        WHERE thread_id = 'thread-unassigned'
      `;
      const projects = yield* sql<{ readonly ownerUserId: string | null }>`
        SELECT owner_user_id AS "ownerUserId"
        FROM projection_projects
        WHERE project_id = 'project-unassigned'
      `;
      assert.deepEqual(threads, [{ ownerUserId: DEFAULT_OWNER }]);
      assert.deepEqual(projects, [{ ownerUserId: DEFAULT_OWNER }]);
    }),
  );
});
