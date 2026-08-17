/**
 * T3-CUSTOM(expbkt3): Reclaim bytes already committed by uncapped activities.
 *
 * `capActivityPayload` bounds new writes. This rewrites the rows written before
 * it existed — on bkt3, ~2.8 GB of a 3.6 GB database, dominated by command
 * stdout (`$.data.item.aggregatedOutput`) and MCP result text
 * (`$.data.item.result.content[].text`), each stored twice: once in the event
 * log, once in the projection.
 *
 * It imports the server's own cap so the backfill and the runtime can never
 * drift apart, and rewrites rows in place rather than deleting them — no row,
 * no sequence, and no thread history disappears, so both the projection
 * bootstrap replay (from the persisted cursor) and the WebSocket reconnect
 * replay keep working exactly as before. Only the tail of oversized strings goes.
 *
 * This runs against a LIVE production database, so it is deliberately timid:
 * small batches in short transactions, a sleep between them, a busy timeout,
 * passive WAL checkpoints so its own writes cannot balloon the WAL, and an
 * I/O-pressure brake so it can never recreate the disk saturation that started
 * this work. It is resumable and idempotent.
 *
 * The batch defaults are not arbitrary. SQLite in WAL mode admits exactly one
 * writer, so every transaction taken here is a transaction the server cannot
 * take. The first production run used 100 rows per transaction — roughly 5 MB of
 * rewrites — and held the write lock long enough that two `runtime` event
 * appends exceeded the SERVER's busy timeout and were dropped
 * (`thread.token-usage.updated`, `task.progress`). Our own busy timeout does not
 * help there: it governs how long WE wait, not how long the server waits on us.
 * The only lever that protects the server is keeping each transaction short, so
 * the default batch is small and the sleep between batches is long. Raise them
 * only against an idle instance.
 *
 * Usage:
 *   node scripts/compact-activity-payloads.ts --db <path> [--dry-run]
 *   node scripts/compact-activity-payloads.ts --db <path> --apply [--batch 200]
 *
 * Runs under bare `node` against a deployed instance, so it uses node builtins
 * and console rather than the Effect APIs.
 */
// @effect-diagnostics nodeBuiltinImport:off - operational script, no Effect runtime.
// @effect-diagnostics globalConsole:off - plain CLI output.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";

import {
  capActivityPayload,
  MAX_ACTIVITY_STRING_CHARS,
} from "../apps/server/src/orchestration/activityPayloadCap.ts";

interface Options {
  readonly db: string;
  readonly apply: boolean;
  readonly batch: number;
  readonly sleepMs: number;
  readonly maxIoPressure: number;
  readonly checkpointEvery: number;
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const db = get("--db");
  if (!db) {
    console.error("--db <path to state.sqlite> is required");
    process.exit(2);
  }
  return {
    db,
    apply: argv.includes("--apply"),
    // Small and slow by default: see the note on write-lock contention above.
    batch: Number(get("--batch") ?? 25),
    sleepMs: Number(get("--sleep") ?? 250),
    maxIoPressure: Number(get("--max-io-pressure") ?? 25),
    checkpointEvery: Number(get("--checkpoint-every") ?? 20),
  };
}

/**
 * `some avg10` from the kernel's pressure-stall counters: the share of the last
 * ten seconds in which at least one task was stalled on I/O. The brake reads
 * this rather than load average because load counts CPU work this script does
 * not do.
 */
function ioPressureAvg10(): number {
  try {
    const text = NodeFS.readFileSync("/proc/pressure/io", "utf8");
    const match = /some\s+avg10=([0-9.]+)/.exec(text);
    return match?.[1] ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface TableSpec {
  readonly label: string;
  readonly table: string;
  /** Monotonic key used to page through the table and to resume. */
  readonly cursorColumn: string;
  readonly extraWhere: string;
  /** Pull the activity payload out of the row's JSON, and put it back. */
  readonly read: (parsed: unknown) => unknown;
  readonly write: (parsed: unknown, capped: unknown) => unknown;
}

/**
 * The projection stores the activity payload directly; the event log wraps it in
 * `{ threadId, activity: { ..., payload } }`. Both are filtered by total row
 * length first: a payload at or under the string cap cannot contain a string
 * above it, so the prefilter is safe as well as cheap (and, on the event log,
 * index-assisted through `idx_orchestration_events_event_type_stream`).
 */
const TABLES: ReadonlyArray<TableSpec> = [
  {
    label: "projection_thread_activities",
    table: "projection_thread_activities",
    cursorColumn: "rowid",
    extraWhere: "",
    read: (parsed) => parsed,
    write: (_parsed, capped) => capped,
  },
  {
    label: "orchestration_events",
    table: "orchestration_events",
    cursorColumn: "sequence",
    extraWhere: "AND event_type = 'thread.activity-appended'",
    read: (parsed) => (parsed as { activity?: { payload?: unknown } })?.activity?.payload,
    write: (parsed, capped) => {
      const row = parsed as { activity: Record<string, unknown> };
      return { ...row, activity: { ...row.activity, payload: capped } };
    },
  },
];

async function compactTable(
  db: NodeSqlite.DatabaseSync,
  spec: TableSpec,
  options: Options,
): Promise<{ rows: number; before: number; after: number }> {
  const select = db.prepare(
    `SELECT ${spec.cursorColumn} AS cursor, payload_json AS payload
       FROM ${spec.table}
      WHERE ${spec.cursorColumn} > ?
        AND LENGTH(payload_json) > ?
        ${spec.extraWhere}
      ORDER BY ${spec.cursorColumn}
      LIMIT ?`,
  );
  const update = db.prepare(
    `UPDATE ${spec.table} SET payload_json = ? WHERE ${spec.cursorColumn} = ?`,
  );

  let cursor = 0;
  let rows = 0;
  let before = 0;
  let after = 0;
  let batches = 0;

  for (;;) {
    const pressure = ioPressureAvg10();
    if (pressure > options.maxIoPressure) {
      console.log(`  ! io pressure ${pressure}% > ${options.maxIoPressure}% — backing off 30s`);
      await sleep(30_000);
      continue;
    }

    const page = select.all(cursor, MAX_ACTIVITY_STRING_CHARS, options.batch) as Array<{
      cursor: number;
      payload: string;
    }>;
    if (page.length === 0) {
      break;
    }

    const rewrites: Array<[string, number]> = [];
    for (const row of page) {
      cursor = row.cursor;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        // A payload we cannot parse is one we must not rewrite.
        continue;
      }
      const original = spec.read(parsed);
      const capped = capActivityPayload(original);
      if (capped === original) {
        continue;
      }
      const next = JSON.stringify(spec.write(parsed, capped));
      if (next.length >= row.payload.length) {
        continue;
      }
      rows += 1;
      before += row.payload.length;
      after += next.length;
      rewrites.push([next, row.cursor]);
    }

    if (options.apply && rewrites.length > 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const [payload, key] of rewrites) {
          update.run(payload, key);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    batches += 1;
    if (options.apply && batches % options.checkpointEvery === 0) {
      // Passive: never blocks the server, just stops our own writes from
      // growing the WAL without bound.
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    }
    if (batches % 50 === 0) {
      console.log(
        `  ${spec.label}: ${rows} rows, ${((before - after) / 1048576).toFixed(0)} MB reclaimable so far (cursor ${cursor})`,
      );
    }
    await sleep(options.sleepMs);
  }

  return { rows, before, after };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const db = new NodeSqlite.DatabaseSync(options.db, { readOnly: !options.apply });
  db.exec("PRAGMA busy_timeout = 30000");

  const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const pagesBefore = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  console.log(
    `${options.apply ? "APPLY" : "DRY RUN"}  ${options.db}\n` +
      `  size=${((pagesBefore * pageSize) / 1048576).toFixed(0)} MB  ` +
      `cap=${MAX_ACTIVITY_STRING_CHARS} chars  batch=${options.batch}\n`,
  );

  let totalRows = 0;
  let totalReclaimed = 0;
  for (const spec of TABLES) {
    const result = await compactTable(db, spec, options);
    totalRows += result.rows;
    totalReclaimed += result.before - result.after;
    console.log(
      `  ${spec.label}: ${result.rows} rows, ` +
        `${(result.before / 1048576).toFixed(0)} MB -> ${(result.after / 1048576).toFixed(0)} MB ` +
        `(${((result.before - result.after) / 1048576).toFixed(0)} MB reclaimed)`,
    );
  }

  if (options.apply) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const freelist = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number })
      .freelist_count;
    console.log(
      `\n  free pages now ${freelist} (${((freelist * pageSize) / 1048576).toFixed(0)} MB reusable).\n` +
        `  The file does not shrink until VACUUM; freed pages are reused first, so growth stops here.`,
    );
  }
  console.log(
    `\n  TOTAL: ${totalRows} rows, ${(totalReclaimed / 1048576).toFixed(0)} MB${options.apply ? " reclaimed" : " reclaimable"}`,
  );
  db.close();
}

await main();
