/**
 * T3-CUSTOM(expbkt3): Bound what a single thread activity can commit to storage.
 *
 * `OrchestrationThreadActivity.payload` is `Schema.Unknown` — whatever the
 * provider adapter produced, verbatim. That payload is then written twice: once
 * into the append-only `orchestration_events` log, and again into
 * `projection_thread_activities` when the projector applies the event. Nothing
 * between the adapter and the disk bounds its size.
 *
 * On bkt3 that turned into 2.8 GB of a 3.6 GB database. The bytes are tool
 * output, dominated by two paths:
 *
 *   $.data.item.aggregatedOutput      — command stdout/stderr
 *   $.data.item.result.content[].text — MCP tool result text
 *
 * The pathological case is recursive: T3's own MCP tools return thread
 * activities, so a `t3_get_session` call embeds other activities' captured
 * output inside its own result, which is then stored as a new activity. The
 * database feeds on itself and each round trip is re-logged through the WAL.
 *
 * This caps individual strings rather than dropping fields, because unlike a
 * never-rendered blob this content IS shown in the timeline — the head of a
 * command's output is the part anyone actually reads. Beyond the cap we keep a
 * marker recording what was dropped, so a truncated payload is self-describing
 * rather than silently short.
 *
 * Byte-identical passthrough is deliberate: the ~98% of activities already under
 * the cap return the exact same object reference, so this cannot perturb
 * existing payloads or add allocation to the hot ingest path.
 */

/**
 * Longest single string kept inside an activity payload.
 *
 * 32 KiB is far past what a reader scans in a timeline entry and still holds
 * whole test runs and build logs. Raising it costs storage roughly linearly in
 * the tail; lowering it starts truncating output people read.
 */
export const MAX_ACTIVITY_STRING_CHARS = 32_768;

/**
 * Longest array kept inside an activity payload. Guards the container form of
 * the same problem — `result.content[]` and nested `thread.activities[]` — where
 * no single string is oversized but the array is unbounded.
 */
export const MAX_ACTIVITY_ARRAY_ITEMS = 1_000;

/**
 * Deepest object nesting walked. Anything past this is replaced wholesale: a
 * payload that deep is a provider bug, and an unbounded walk on the ingest path
 * is its own hazard.
 */
export const MAX_ACTIVITY_DEPTH = 24;

const TRUNCATION_NOTE = "t3:truncated";

/**
 * Room reserved inside the cap for the marker itself.
 *
 * Load-bearing for idempotence: the result must come back at or under
 * `MAX_ACTIVITY_STRING_CHARS`, otherwise capping an already-capped string would
 * truncate it a second time. The backfill re-reads rows it may have already
 * rewritten, so a non-idempotent cap would eat real output on every pass.
 */
const MARKER_BUDGET_CHARS = 96;

function capString(value: string): string {
  if (value.length <= MAX_ACTIVITY_STRING_CHARS) {
    return value;
  }
  const kept = value.slice(0, MAX_ACTIVITY_STRING_CHARS - MARKER_BUDGET_CHARS);
  return `${kept}\n…[${TRUNCATION_NOTE} ${value.length - kept.length} of ${value.length} chars]`;
}

function capUnknown(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return capString(value);
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_ACTIVITY_DEPTH) {
      return `[${TRUNCATION_NOTE} array at depth ${depth}]`;
    }
    // The marker occupies one of the kept slots so the result lands exactly at
    // the cap, never above it — same idempotence requirement as `capString`.
    const overflowing = value.length > MAX_ACTIVITY_ARRAY_ITEMS;
    const limit = overflowing ? MAX_ACTIVITY_ARRAY_ITEMS - 1 : value.length;
    let changed = overflowing;
    const next: Array<unknown> = [];
    for (let index = 0; index < limit; index += 1) {
      const item = value[index];
      const capped = capUnknown(item, depth + 1);
      if (capped !== item) {
        changed = true;
      }
      next.push(capped);
    }
    if (overflowing) {
      next.push(`[${TRUNCATION_NOTE} ${value.length - limit} of ${value.length} items]`);
    }
    return changed ? next : value;
  }

  // Dates, typed arrays and other exotics are left alone: they are not part of
  // a JSON payload's shape, and rebuilding them here would lose their identity.
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }

  if (depth >= MAX_ACTIVITY_DEPTH) {
    return `[${TRUNCATION_NOTE} object at depth ${depth}]`;
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const capped = capUnknown(item, depth + 1);
    if (capped !== item) {
      changed = true;
    }
    next[key] = capped;
  }
  return changed ? next : value;
}

/**
 * Cap an activity payload before it is persisted.
 *
 * Returns the original reference untouched when everything is already within
 * the caps, so the common path neither copies nor re-serializes.
 */
export function capActivityPayload(payload: unknown): unknown {
  return capUnknown(payload, 0);
}

/**
 * Whether capping would change this payload. Used by the offline backfill to
 * skip rows it does not need to rewrite.
 */
export function isActivityPayloadCapped(payload: unknown): boolean {
  return capActivityPayload(payload) !== payload;
}
