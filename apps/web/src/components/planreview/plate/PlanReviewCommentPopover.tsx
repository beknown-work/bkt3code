/**
 * T3-CUSTOM(expbkt3): the comment composer, anchored to what it comments on.
 *
 * Replaces a box in a strip at the foot of the whole panel. In a tall, narrow
 * panel that box could sit an entire screen away from the sentence it was about,
 * so the reviewer lost the thing they were describing while describing it.
 *
 * Positioned with `useSelectionAnchor`, frozen on open: clicking into the
 * textarea collapses the DOM selection, which would otherwise move the popover
 * out from under the pointer mid-click.
 */
import { useEffect, useRef } from "react";

import { Button } from "../../ui/button";
import { useSelectionAnchor } from "./useSelectionAnchor";

const IS_APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function PlanReviewCommentPopover({
  containerRef,
  quotedText,
  body,
  onBodyChange,
  onSubmit,
  onCancel,
}: {
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly quotedText: string;
  readonly body: string;
  readonly onBodyChange: (body: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  const anchor = useSelectionAnchor({ containerRef, frozen: true });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // The popover exists to be typed into, so it takes focus on open.
    inputRef.current?.focus();
  }, []);

  const canSubmit = body.trim().length > 0;

  return (
    <div
      className="absolute z-40 w-[19rem] max-w-[calc(100%-0.5rem)] -translate-x-1/2 overflow-hidden rounded-lg border bg-popover shadow-xl"
      style={
        anchor === null
          ? { bottom: "1rem", left: "50%" }
          : { top: anchor.bottom, left: anchor.left }
      }
      role="dialog"
      aria-label="Comment on selection"
    >
      <div className="flex items-start gap-2 border-b px-2.5 py-1.5">
        <p
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={quotedText}
        >
          &ldquo;{quotedText}&rdquo;
        </p>
        <button
          type="button"
          aria-label="Cancel comment"
          className="shrink-0 rounded px-1 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
          onClick={onCancel}
        >
          ✕
        </button>
      </div>

      <textarea
        ref={inputRef}
        className="max-h-48 w-full resize-y border-0 bg-transparent p-2.5 text-sm outline-none"
        rows={3}
        value={body}
        placeholder="What should change here?"
        aria-label="Comment body"
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (canSubmit) onSubmit();
          }
        }}
      />

      <div className="flex items-center justify-end gap-2 border-t px-2.5 py-1.5">
        <span aria-hidden className="mr-auto text-[11px] text-muted-foreground">
          {IS_APPLE ? "⌘" : "Ctrl"}+Enter
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={!canSubmit}>
          Comment
        </Button>
      </div>
    </div>
  );
}
