/**
 * T3-CUSTOM(expbkt3): which agent view, if any, is expanded over the transcript.
 *
 * Deliberately not persisted and deliberately global-but-single: expanding a
 * view is a transient reading posture, and only one can own the transcript at a
 * time. Keeping it in a store rather than in the timeline row is what lets the
 * overlay mount beside the message list — outside the virtualized rows, which
 * clip and recycle — while the card that opened it stays a plain row.
 */
import { create } from "zustand";

import type { ScopedThreadRef } from "@t3tools/contracts";

export interface ExpandedAgentUiView {
  readonly threadRef: ScopedThreadRef;
  readonly renderId: string;
}

interface AgentUiExpandedStoreState {
  readonly expanded: ExpandedAgentUiView | null;
  expand: (view: ExpandedAgentUiView) => void;
  collapse: () => void;
}

export const useAgentUiExpandedStore = create<AgentUiExpandedStoreState>((set) => ({
  expanded: null,
  expand: (view) => set({ expanded: view }),
  collapse: () => set({ expanded: null }),
}));
