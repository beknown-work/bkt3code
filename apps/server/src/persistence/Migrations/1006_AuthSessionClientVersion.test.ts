import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("1006_AuthSessionClientVersion", (it) => {
  it.effect("adds client_app_version after the existing migration history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 1005 });

      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
      assert.isFalse(before.some((column) => column.name === "client_app_version"));

      yield* runMigrations();
      const after = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
      assert.isTrue(after.some((column) => column.name === "client_app_version"));
    }),
  );
});
