/**
 * T3-CUSTOM(expbkt3): the selection toolbar that makes the panel feel like a
 * document rather than a textarea.
 *
 * Anchored to the DOM selection rectangle rather than pulled in through
 * `@platejs/floating`: the panel is the only consumer, and one `getBoundingRect`
 * is far less weight than another positioning dependency.
 */
import {
  BoldPlugin,
  CodePlugin,
  HighlightPlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from "@platejs/basic-nodes/react";
import {
  BoldIcon,
  CodeIcon,
  HighlighterIcon,
  ItalicIcon,
  MessageSquarePlusIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "lucide-react";
import { useMarkToolbarButton, useMarkToolbarButtonState } from "platejs/react";
import { useCallback, useEffect, useState, type ComponentType } from "react";

import { cn } from "../../../lib/utils";

interface ToolbarPosition {
  readonly top: number;
  readonly left: number;
}

function MarkButton({
  nodeType,
  label,
  icon: Icon,
}: {
  readonly nodeType: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}) {
  const state = useMarkToolbarButtonState({ nodeType });
  const { props } = useMarkToolbarButton(state);

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={props.pressed}
      title={label}
      onClick={props.onClick}
      onMouseDown={props.onMouseDown}
      className={cn(
        "flex size-7 items-center justify-center rounded transition-colors hover:bg-accent",
        props.pressed && "bg-accent text-accent-foreground",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

export function PlanReviewFloatingToolbar({
  containerRef,
  onComment,
  readOnly,
}: {
  readonly containerRef: React.RefObject<HTMLElement | null>;
  readonly onComment: () => void;
  readonly readOnly: boolean;
}) {
  const [position, setPosition] = useState<ToolbarPosition | null>(null);

  const syncToSelection = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return setPosition(null);

    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      selection.toString().trim().length === 0
    ) {
      return setPosition(null);
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return setPosition(null);

    const rect = range.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return setPosition(null);

    setPosition({
      // Sit just above the selection, clamped inside the panel so the toolbar
      // never escapes a narrow right-hand panel.
      top: Math.max(4, rect.top - bounds.top + container.scrollTop - 44),
      left: Math.min(
        Math.max(4, rect.left - bounds.left + rect.width / 2),
        Math.max(4, bounds.width - 4),
      ),
    });
  }, [containerRef]);

  useEffect(() => {
    document.addEventListener("selectionchange", syncToSelection);
    window.addEventListener("resize", syncToSelection);
    return () => {
      document.removeEventListener("selectionchange", syncToSelection);
      window.removeEventListener("resize", syncToSelection);
    };
  }, [syncToSelection]);

  if (position === null) return null;

  return (
    <div
      className="pointer-events-auto absolute z-30 -translate-x-1/2 rounded-lg border bg-popover p-0.5 shadow-lg"
      style={{ top: position.top, left: position.left }}
      // Keep the selection alive: losing it would clear the toolbar mid-click.
      onMouseDown={(event) => event.preventDefault()}
      role="toolbar"
      aria-label="Formatting"
    >
      <div className="flex items-center gap-0.5">
        {readOnly ? null : (
          <>
            <MarkButton nodeType={BoldPlugin.key} label="Bold" icon={BoldIcon} />
            <MarkButton nodeType={ItalicPlugin.key} label="Italic" icon={ItalicIcon} />
            <MarkButton nodeType={UnderlinePlugin.key} label="Underline" icon={UnderlineIcon} />
            <MarkButton
              nodeType={StrikethroughPlugin.key}
              label="Strikethrough"
              icon={StrikethroughIcon}
            />
            <MarkButton nodeType={HighlightPlugin.key} label="Highlight" icon={HighlighterIcon} />
            <MarkButton nodeType={CodePlugin.key} label="Inline code" icon={CodeIcon} />
            <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
          </>
        )}
        <button
          type="button"
          aria-label="Comment on selection"
          title="Comment on selection"
          onClick={onComment}
          className="flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors hover:bg-accent"
        >
          <MessageSquarePlusIcon className="size-4" />
          Comment
        </button>
      </div>
    </div>
  );
}
