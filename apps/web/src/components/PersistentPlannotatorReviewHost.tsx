import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  MAX_HIDDEN_MOUNTED_PLANNOTATOR_THREADS,
  reconcileMountedPlannotatorThreadIds,
} from "./ChatView.logic";
import { PlannotatorFocusSurface } from "./PlannotatorFocusSurface";
import { SidebarInset } from "./ui/sidebar";
import { useComposerDraftStore } from "../composerDraftStore";
import { type RightPanelSurface, useRightPanelStore } from "../rightPanelStore";

type PlannotatorSurface = Extract<RightPanelSurface, { kind: "plannotator" }>;

interface PersistentPlannotatorFocusSurfaceProps {
  threadRef: ScopedThreadRef;
  surface: PlannotatorSurface;
  visible: boolean;
}

export function hidePlannotatorReview(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().close(threadRef);
}

const PersistentPlannotatorFocusSurface = memo(function PersistentPlannotatorFocusSurface({
  threadRef,
  surface,
  visible,
}: PersistentPlannotatorFocusSurfaceProps) {
  const hide = useCallback(() => {
    hidePlannotatorReview(threadRef);
  }, [threadRef]);
  const remove = useCallback(() => {
    useRightPanelStore.getState().closeSurface(threadRef, surface.id);
  }, [surface.id, threadRef]);
  const handleDecision = useCallback(
    (decision: "approved" | "feedback" | "denied") => {
      if (decision === "approved") {
        useComposerDraftStore.getState().setInteractionMode(threadRef, "default");
      }
      remove();
    },
    [remove, threadRef],
  );

  return (
    <PlannotatorFocusSurface
      url={surface.url}
      visible={visible}
      onClose={hide}
      onDecision={handleDecision}
    />
  );
});

interface PersistentPlannotatorReviewHostProps {
  activeThreadRef: ScopedThreadRef | null;
  activeSurface: PlannotatorSurface | null;
}

export function PersistentPlannotatorReviewHost({
  activeThreadRef,
  activeSurface,
}: PersistentPlannotatorReviewHostProps) {
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const openThreadKeys = useRightPanelStore(
    useShallow((state) =>
      Object.entries(state.byThreadKey).flatMap(([threadKey, panelState]) =>
        panelState.surfaces.some((surface) => surface.kind === "plannotator") ? [threadKey] : [],
      ),
    ),
  );
  const renderedThreadKeys = useMemo(
    () =>
      reconcileMountedPlannotatorThreadIds({
        currentThreadIds: openThreadKeys,
        openThreadIds: openThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadPlannotatorOpen: activeSurface !== null,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PLANNOTATOR_THREADS,
      }),
    [activeSurface, activeThreadKey, openThreadKeys],
  );
  const selectedSurfaces = useRightPanelStore(
    useShallow((state) =>
      renderedThreadKeys.map((threadKey) =>
        state.byThreadKey[threadKey]?.surfaces.find(
          (surface): surface is PlannotatorSurface => surface.kind === "plannotator",
        ),
      ),
    ),
  );
  const mountedSurfaces = useMemo(
    () =>
      renderedThreadKeys.flatMap((threadKey, index) => {
        const threadRef = parseScopedThreadKey(threadKey);
        const surface = selectedSurfaces[index];
        return threadRef && surface ? [{ threadKey, threadRef, surface }] : [];
      }),
    [renderedThreadKeys, selectedSurfaces],
  );

  return (
    <SidebarInset
      className={
        activeSurface
          ? "h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh"
          : "hidden"
      }
      aria-hidden={activeSurface ? undefined : true}
    >
      {mountedSurfaces.map(({ threadKey, threadRef, surface }) => (
        <PersistentPlannotatorFocusSurface
          key={threadKey}
          threadRef={threadRef}
          surface={surface}
          visible={
            threadKey === activeThreadKey &&
            activeSurface !== null &&
            surface.id === activeSurface.id
          }
        />
      ))}
    </SidebarInset>
  );
}
