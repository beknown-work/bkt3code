// T3-CUSTOM(expbkt3): SQLite repository for durable thread bootstrap state.
import { ResolvedThreadBootstrapRequest, ThreadBootstrapProgress } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadBootstrap,
  ProjectionThreadBootstrapRepository,
  type ProjectionThreadBootstrapRepositoryShape,
} from "../Services/ProjectionThreadBootstraps.ts";

const ProjectionThreadBootstrapDbRow = ProjectionThreadBootstrap.mapFields(
  Struct.assign({
    progress: Schema.fromJsonString(ThreadBootstrapProgress),
    request: Schema.fromJsonString(ResolvedThreadBootstrapRequest),
  }),
);

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadBootstrap,
    execute: (row) => sql`
      INSERT INTO projection_thread_bootstraps (
        thread_id,
        bootstrap_id,
        status,
        public_state_json,
        request_json,
        created_at,
        updated_at
      ) VALUES (
        ${row.threadId},
        ${row.bootstrapId},
        ${row.status},
        ${JSON.stringify(row.progress)},
        ${JSON.stringify(row.request)},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        bootstrap_id = excluded.bootstrap_id,
        status = excluded.status,
        public_state_json = excluded.public_state_json,
        request_json = excluded.request_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ProjectionThreadBootstrap.fields.threadId }),
    Result: ProjectionThreadBootstrapDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        bootstrap_id AS "bootstrapId",
        status,
        public_state_json AS "progress",
        request_json AS "request",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_bootstraps
      WHERE thread_id = ${threadId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadBootstrapDbRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        bootstrap_id AS "bootstrapId",
        status,
        public_state_json AS "progress",
        request_json AS "request",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_bootstraps
      WHERE status <> 'ready'
      ORDER BY created_at ASC, thread_id ASC
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: Schema.Struct({ threadId: ProjectionThreadBootstrap.fields.threadId }),
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_bootstraps
      WHERE thread_id = ${threadId}
    `,
  });

  return {
    upsert: (row) =>
      upsertRow(row).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadBootstrapRepository.upsert:query")),
      ),
    getByThreadId: (threadId) =>
      getRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadBootstrapRepository.getByThreadId:query"),
        ),
      ),
    listIncomplete: () =>
      listRows().pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadBootstrapRepository.listIncomplete:query"),
        ),
      ),
    deleteByThreadId: (threadId) =>
      deleteRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadBootstrapRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies ProjectionThreadBootstrapRepositoryShape;
});

export const ProjectionThreadBootstrapRepositoryLive = Layer.effect(
  ProjectionThreadBootstrapRepository,
  makeRepository,
);
