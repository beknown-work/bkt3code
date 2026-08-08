/**
 * T3-CUSTOM(expbkt3): the two marks that make a review readable at a glance.
 *
 * A commented span is highlighted so the reviewer can see what they annotated
 * without opening the rail, and a tracked edit is coloured the way every diff
 * in this app is: green for what an edit adds, red struck through for what it
 * removes.
 *
 * Presentational only. Plate's hover/active comment focus rides on typed plugin
 * options that the base `CommentPlugin` config does not expose, and the rail
 * already carries the discussion; wiring focus can follow once we need it.
 */
import { PlateLeaf, type PlateLeafProps } from "platejs/react";

import { cn } from "../../../lib/utils";

export function CommentLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      className="border-amber-400/50 border-b-2 bg-amber-300/15 transition-colors hover:bg-amber-300/30"
    >
      {props.children}
    </PlateLeaf>
  );
}

export function SuggestionLeaf(props: PlateLeafProps) {
  // `type: "remove"` marks text the reviewer deleted while suggesting; it stays
  // visible until the suggestion is accepted, which is the point of tracking.
  const data = (props.leaf as { suggestion?: { type?: string } }).suggestion;
  const isRemoval = data?.type === "remove";

  return (
    <PlateLeaf
      {...props}
      className={cn(
        "transition-colors",
        isRemoval
          ? "bg-red-500/15 text-red-700 line-through dark:text-red-300"
          : "bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-300",
      )}
    >
      {props.children}
    </PlateLeaf>
  );
}
