// T3-CUSTOM(expbkt3): fork-owned coverage for the reaper's event-liveness queries.
//
// These queries run on the event loop every sweep against a database that on
// bkt3 is several GB. Correctness alone is not enough: the plan assertion is
// what stops a future edit from dropping `aggregate_kind` and turning the
// lookup back into a full table scan (2026-09-03 bkt3 outage).
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
// @effect-diagnostics nodeBuiltinImport:off - the source guard reads this test's sibling file, not a runtime path.
import * as NodeFS from "node:fs";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { latestThreadEventAt, listRunningSessionRows } from "./reconcileRunningTurns.ts";

const seedEvent = (input: {
  readonly threadId: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly aggregateKind?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json
      ) VALUES (
        ${`event-${input.threadId}-${input.aggregateKind ?? "thread"}-${input.version}`},
        ${input.aggregateKind ?? "thread"},
        ${input.threadId},
        ${input.version},
        'thread.activity-appended',
        ${input.occurredAt},
        'provider',
        '{}',
        '{}'
      )
    `;
  });

const seedRunningThread = (input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly startedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at)
      VALUES (${input.threadId}, 'project-1', 'thread', ${input.startedAt}, ${input.startedAt}, NULL)
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, active_turn_id, updated_at
      ) VALUES (${input.threadId}, 'running', 'codex', 'codex', ${input.turnId}, ${input.startedAt})
    `;
    yield* sql`
      INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, started_at, checkpoint_files_json)
      VALUES (${input.threadId}, ${input.turnId}, 'running', ${input.startedAt}, ${input.startedAt}, '[]')
    `;
  });

it.layer(SqlitePersistenceMemory)("reconcileRunningTurns event queries", (it) => {
  it.effect("reports the most recently appended thread event as lastActivityAt", () =>
    Effect.gen(function* () {
      yield* seedRunningThread({
        threadId: "thread-a",
        turnId: "turn-a",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* seedEvent({
        threadId: "thread-a",
        version: 1,
        occurredAt: "2026-01-01T00:01:00.000Z",
      });
      yield* seedEvent({
        threadId: "thread-a",
        version: 2,
        occurredAt: "2026-01-01T00:05:00.000Z",
      });
      // Another stream's newer event must not leak into thread-a's answer.
      yield* seedEvent({
        threadId: "thread-b",
        version: 1,
        occurredAt: "2026-01-01T09:00:00.000Z",
      });
      // A non-thread aggregate sharing the stream id is not thread activity.
      yield* seedEvent({
        threadId: "thread-a",
        version: 1,
        occurredAt: "2026-01-01T10:00:00.000Z",
        aggregateKind: "project",
      });

      const rows = yield* listRunningSessionRows;
      assert.lengthOf(rows, 1);
      assert.strictEqual(rows[0]?.threadId, "thread-a");
      assert.strictEqual(rows[0]?.lastActivityAt, "2026-01-01T00:05:00.000Z");
      assert.strictEqual(rows[0]?.turnStartedAt, "2026-01-01T00:00:00.000Z");
      assert.strictEqual(yield* latestThreadEventAt("thread-a"), "2026-01-01T00:05:00.000Z");
      assert.isNull(yield* latestThreadEventAt("thread-none"));
    }),
  );

  it.effect("keeps aggregate_kind in every orchestration_events filter in the source", () =>
    Effect.sync(() => {
      // The plan test below explains the query text it is given; this guards
      // the text that actually ships.
      const source = NodeFS.readFileSync(
        new URL("./reconcileRunningTurns.ts", import.meta.url),
        "utf8",
      );
      const eventFilters =
        source.match(/FROM orchestration_events[\s\S]*?(?=ORDER BY|\)|`)/g) ?? [];
      assert.isAtLeast(eventFilters.length, 2);
      for (const filter of eventFilters) {
        assert.match(filter, /aggregate_kind = 'thread'/);
      }
    }),
  );

  it.effect(
    "serves both lookups from the (aggregate_kind, stream_id, sequence) index, never a table scan",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const explain = (query: string) =>
          sql
            .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
            .pipe(Effect.map((rows) => rows.map((row) => row.detail)));
        const running = yield* explain(`
          SELECT s.thread_id, (
            SELECT e.occurred_at FROM orchestration_events e
            WHERE e.aggregate_kind = 'thread' AND e.stream_id = s.thread_id
            ORDER BY e.sequence DESC LIMIT 1
          ) AS la
          FROM projection_thread_sessions s
          WHERE s.status IN ('running', 'starting')
        `);
        const latest = yield* explain(`
          SELECT occurred_at FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = 'thread-a'
          ORDER BY sequence DESC LIMIT 1
        `);

        const eventSteps = [...running, ...latest].filter((step) =>
          /orchestration_events|\be\b/.test(step),
        );
        assert.isAtLeast(eventSteps.length, 1);
        for (const step of eventSteps) {
          assert.match(step, /USING INDEX idx_orch_events_stream_sequence/);
          assert.notMatch(step, /^SCAN/);
        }
      }),
  );
});
