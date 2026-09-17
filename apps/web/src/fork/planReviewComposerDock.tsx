/**
 * T3-CUSTOM(expbkt3): relocates the one live thread composer into plan review.
 *
 * The composer owns durable draft and attachment state, so plan review must not
 * render a smaller imitation or mount a second instance. React always portals
 * it into the same stable element; this module only moves that element between
 * its normal home and the plan rail. Local composer state therefore survives
 * opening and closing a review.
 */
import type { ComponentProps } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

import { ComposerSurface } from "../components/chat/ComposerSurface";

interface PlanReviewComposerDockState {
  readonly target: HTMLElement | null;
  readonly setTarget: (target: HTMLElement | null) => void;
}

const usePlanReviewComposerDockStore = create<PlanReviewComposerDockState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
}));

/** The destination rendered at the bottom of the plan review control rail. */
export function PlanReviewConversationComposerTarget() {
  const setTarget = usePlanReviewComposerDockStore((state) => state.setTarget);
  const targetRef = useCallback(
    (node: HTMLDivElement | null) => {
      setTarget(node);
    },
    [setTarget],
  );

  return (
    <div className="min-w-0 border-t bg-background p-2" data-plan-review-conversation-composer>
      <div ref={targetRef} className="min-w-0" data-plan-review-composer-target />
    </div>
  );
}

/** Keep one mounted composer while its portal container moves between homes. */
export function PlanReviewComposerDock(props: ComponentProps<typeof ComposerSurface.Shell>) {
  const target = usePlanReviewComposerDockStore((state) => state.target);
  const homeRef = useRef<HTMLDivElement | null>(null);
  const [portalNode] = useState(() => document.createElement("div"));

  useLayoutEffect(() => {
    const destination = target ?? homeRef.current;
    if (destination === null) return;

    portalNode.className = target === null ? "contents" : "block min-w-0 w-full";
    if (target === null) {
      delete portalNode.dataset.planReviewComposerDocked;
    } else {
      portalNode.dataset.planReviewComposerDocked = "true";
    }
    destination.append(portalNode);
  }, [portalNode, target]);

  useLayoutEffect(
    () => () => {
      portalNode.remove();
    },
    [portalNode],
  );

  return (
    <>
      <div ref={homeRef} className="contents" data-plan-review-composer-home />
      {createPortal(<ComposerSurface.Shell {...props} />, portalNode)}
    </>
  );
}

export function resetPlanReviewComposerDockForTests() {
  usePlanReviewComposerDockStore.setState({ target: null });
}
