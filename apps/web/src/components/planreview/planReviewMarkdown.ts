/**
 * T3-CUSTOM(expbkt3): markdown helpers for the plan review editor.
 *
 * Markdown is the canonical form: it is what the agent reads, what versions
 * store, and what diffs are computed from. The Plate value is a working cache.
 * The round trip itself lives in `PlanReviewEditor`, where the typed editor
 * instance is in scope.
 */

let planReviewIdSequence = 0;

/**
 * Client-side id for a new discussion. Ids only need to be unique within a
 * session — the server owns durable identity.
 */
export function nextPlanDiscussionId(): string {
  planReviewIdSequence += 1;
  return `plan-discussion:${Date.now()}-${planReviewIdSequence}`;
}

/** Collapses whitespace so quoted anchors survive editor reformatting. */
export function normalizeQuotedText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
