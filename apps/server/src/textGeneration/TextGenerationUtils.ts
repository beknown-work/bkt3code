import { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/**
 * Like {@link limitSection}, but keeps the END of the value. Used for session
 * transcripts, where the most recent work matters more than the opening.
 */
export function limitSectionTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `[truncated]\n\n${value.slice(value.length - maxChars)}`;
}

export const MAX_CATCHUP_SUMMARY_LINES = 3;
export const MAX_ROLLING_SUMMARY_CHARS = 1_500;

/**
 * Clamp a catch-up note to at most three plain-text lines. The prompt asks for
 * this shape, but the cap is enforced here so a chatty model can never grow the
 * card without bound. This is the only place the note is shortened — the cards
 * render it in full, so truncating in CSS as well would clip the last line
 * whenever it wrapped on a narrow viewport.
 */
export function sanitizeCatchupSummary(raw: string): string {
  const lines = raw
    .trim()
    .split(/\r?\n/g)
    .map((line) =>
      line
        .trim()
        // Strip markdown list/heading markers; the card renders plain text.
        .replace(/^([-*+]|\d+[.)]|#{1,6})\s+/, "")
        .trim(),
    )
    .filter((line) => line.length > 0);

  return lines.slice(0, MAX_CATCHUP_SUMMARY_LINES).join("\n");
}

// T3-CUSTOM(expbkt3): BEGIN — bulk session manager work summary sanitizers.
//
// The bulk table renders thirty of these at once, so the caps are tighter than
// the catch-up card's and enforced here rather than trusted from the prompt: a
// chatty model must not be able to stretch a table row.
export const WORK_SUMMARY_STAGES = [
  "planning",
  "implementing",
  "blocked",
  "awaiting-review",
  "done",
] as const;
export type WorkSummaryStage = (typeof WORK_SUMMARY_STAGES)[number];

/** Roughly four sentences of prose. */
export const MAX_WORK_SUMMARY_CHARS = 700;
/** One scannable line in a table cell. */
export const MAX_WORK_SUMMARY_REMAINING_CHARS = 90;

const WORK_SUMMARY_STAGE_SET: ReadonlySet<string> = new Set(WORK_SUMMARY_STAGES);

/** Collapse to a single plain-text paragraph, strip list/heading markers, cap. */
export function sanitizeWorkSummary(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)
    .map((line) =>
      line
        .trim()
        .replace(/^([-*+]|\d+[.)]|#{1,6})\s+/, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ");

  return normalized.length <= MAX_WORK_SUMMARY_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_WORK_SUMMARY_CHARS).trimEnd()}...`;
}

/** First line only, no markers, capped to one table-cell line. */
export function sanitizeWorkSummaryRemaining(raw: string): string {
  const firstLine =
    raw
      .trim()
      .split(/\r?\n/g)
      .map((line) =>
        line
          .trim()
          .replace(/^([-*+]|\d+[.)]|#{1,6})\s+/, "")
          .trim(),
      )
      .find((line) => line.length > 0) ?? "";
  const normalized = firstLine.replace(/\s+/g, " ");
  return normalized.length <= MAX_WORK_SUMMARY_REMAINING_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_WORK_SUMMARY_REMAINING_CHARS - 3).trimEnd()}...`;
}

/**
 * Unknown stage falls back to "implementing" — the neutral middle bucket. A
 * wrong-but-plausible stage is a smaller lie in a sortable column than a
 * missing row or an invented sixth value.
 */
export function sanitizeWorkSummaryStage(raw: string): WorkSummaryStage {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return WORK_SUMMARY_STAGE_SET.has(normalized) ? (normalized as WorkSummaryStage) : "implementing";
}

/** Clamp to 0..100 and round; non-finite input reports zero progress. */
export function sanitizeWorkSummaryPercent(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(raw)));
}
// T3-CUSTOM(expbkt3): END

/** Keep the stored rolling summary bounded regardless of model behavior. */
export function sanitizeRollingSummary(raw: string): string {
  const normalized = raw.trim();
  return normalized.length <= MAX_ROLLING_SUMMARY_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_ROLLING_SUMMARY_CHARS).trimEnd()}...`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${normalized.slice(0, 47).trimEnd()}...`;
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
