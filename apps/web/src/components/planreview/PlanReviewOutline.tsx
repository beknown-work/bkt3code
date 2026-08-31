/**
 * T3-CUSTOM(expbkt3): the plan's heading structure, with comment counts.
 *
 * A plan long enough to need reviewing is longer than the panel, and the rail of
 * comments alone does not say *where* in the plan the argument is. The counts are
 * the useful half: they show at a glance which sections the reviewer has already
 * been through and which they have not touched.
 *
 * Rendered only when the panel is wide enough to afford a third column — the
 * caller gates it with a container query, so this component never measures
 * anything and never re-renders on resize.
 */
import { memo } from "react";

import type { PlanOutlineHeading } from "@t3tools/client-runtime/state/planReviewMarkdown";
import { cn } from "../../lib/utils";

/** Indent per heading level, capped so a deep plan does not run out of column. */
const DEPTH_INDENT_CLASS = ["pl-2", "pl-2", "pl-4", "pl-6", "pl-8", "pl-8", "pl-8"] as const;

function PlanReviewOutlineImpl({
  headings,
  commentCounts,
  onSelectHeading,
}: {
  readonly headings: ReadonlyArray<PlanOutlineHeading>;
  /** Open-comment counts keyed by heading line index. */
  readonly commentCounts: ReadonlyMap<number, number>;
  readonly onSelectHeading: (heading: PlanOutlineHeading) => void;
}) {
  if (headings.length === 0) return null;

  return (
    <nav
      className="flex min-h-0 w-56 shrink-0 flex-col overflow-y-auto border-r py-2"
      aria-label="Plan contents"
    >
      <p className="px-3 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        Contents
      </p>
      <ul className="flex min-w-0 flex-col">
        {headings.map((heading) => {
          const count = commentCounts.get(heading.lineIndex) ?? 0;
          return (
            <li key={`${heading.lineIndex}:${heading.text}`} className="min-w-0">
              <button
                type="button"
                onClick={() => onSelectHeading(heading)}
                className={cn(
                  "flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors hover:bg-accent",
                  DEPTH_INDENT_CLASS[heading.depth] ?? "pl-8",
                  heading.depth <= 1 ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate" aria-label={heading.text}>
                  {heading.text}
                </span>
                {count > 0 ? (
                  <span
                    className="shrink-0 rounded-full bg-amber-400/20 px-1.5 text-[11px] text-amber-700 tabular-nums dark:text-amber-300"
                    aria-label={`${count} open ${count === 1 ? "comment" : "comments"}`}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export const PlanReviewOutline = memo(PlanReviewOutlineImpl);
