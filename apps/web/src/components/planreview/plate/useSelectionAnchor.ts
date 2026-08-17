/**
 * T3-CUSTOM(expbkt3): positions a floating surface against the DOM selection.
 *
 * Anchored to the selection rectangle rather than pulled in through
 * `@platejs/floating`: the panel is the only consumer, and one
 * `getBoundingClientRect` is far less weight than another positioning
 * dependency.
 *
 * Shared by the selection toolbar and the comment popover so the two agree on
 * where "beside the selection" is, and so the clamping that keeps a surface
 * inside a narrow right-hand panel is written once.
 */
import { useCallback, useEffect, useState } from "react";

export interface SelectionAnchor {
  /** Offsets within the scrolling container, not the viewport. */
  readonly top: number;
  readonly left: number;
  /** Bottom edge of the selection, for a surface that sits below it. */
  readonly bottom: number;
}

export interface UseSelectionAnchorOptions {
  readonly containerRef: React.RefObject<HTMLElement | null>;
  /**
   * Freezes the anchor. A popover opens against the selection and must not move
   * when clicking into its own textarea collapses that selection.
   */
  readonly frozen?: boolean;
}

export function useSelectionAnchor({
  containerRef,
  frozen = false,
}: UseSelectionAnchorOptions): SelectionAnchor | null {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);

  const syncToSelection = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return setAnchor(null);

    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      selection.toString().trim().length === 0
    ) {
      return setAnchor(null);
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return setAnchor(null);

    const rect = range.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return setAnchor(null);

    const left = Math.min(
      Math.max(4, rect.left - bounds.left + rect.width / 2),
      Math.max(4, bounds.width - 4),
    );
    setAnchor({
      // Sit just above the selection, clamped inside the panel so the surface
      // never escapes a narrow right-hand panel.
      top: Math.max(4, rect.top - bounds.top + container.scrollTop - 44),
      bottom: rect.bottom - bounds.top + container.scrollTop + 8,
      left,
    });
  }, [containerRef]);

  useEffect(() => {
    if (frozen) return;
    document.addEventListener("selectionchange", syncToSelection);
    window.addEventListener("resize", syncToSelection);
    return () => {
      document.removeEventListener("selectionchange", syncToSelection);
      window.removeEventListener("resize", syncToSelection);
    };
  }, [frozen, syncToSelection]);

  return anchor;
}
