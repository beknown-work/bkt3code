// T3-CUSTOM(expbkt3): how the experimental sidebar is sectioned — lifecycle,
// project, or the user's own groups — plus which sections are collapsed.
//
// A fork-owned store rather than a client setting: the shape is decided by
// client-runtime (which mobile shares), every edit is one of its pure
// operations, and keeping it here adds no hunks to an upstream-owned file.
// The groups are per device by design — they key sessions across every
// connected environment, so there is no single server that could own them.
import {
  assignPhaseSidebarThreadToGroup,
  createPhaseSidebarCustomGroup,
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  deletePhaseSidebarCustomGroup,
  movePhaseSidebarCustomGroup,
  prunePhaseSidebarGrouping,
  renamePhaseSidebarCustomGroup,
  sanitizePhaseSidebarGrouping,
  setPhaseSidebarGroupBy,
  setPhaseSidebarGroupOrder,
  togglePhaseSidebarSectionCollapsed,
  type PhaseSidebarGroupBy,
  type PhaseSidebarGroupOrder,
  type PhaseSidebarGroupingPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const PHASE_SIDEBAR_GROUPING_STORAGE_KEY = "t3code:phase-sidebar-grouping:v1";

interface PhaseSidebarGroupingStoreState {
  readonly grouping: PhaseSidebarGroupingPreferences;
  setGroupBy: (groupBy: PhaseSidebarGroupBy) => void;
  setGroupOrder: (order: PhaseSidebarGroupOrder) => void;
  /** Returns the new group's id, or null when the label was blank. */
  createGroup: (label: string, threadKeys?: ReadonlyArray<string>) => string | null;
  renameGroup: (id: string, label: string) => void;
  deleteGroup: (id: string) => void;
  moveGroup: (id: string, direction: "up" | "down") => void;
  assignThread: (threadKey: string, groupId: string | null) => void;
  toggleSectionCollapsed: (sectionKey: string) => void;
  prune: (liveThreadKeys: ReadonlySet<string>) => void;
}

export const usePhaseSidebarGroupingStore = create<PhaseSidebarGroupingStoreState>()(
  persist(
    (set, get) => ({
      grouping: DEFAULT_PHASE_SIDEBAR_GROUPING,
      setGroupBy: (groupBy) =>
        set((state) => ({ grouping: setPhaseSidebarGroupBy(state.grouping, groupBy) })),
      setGroupOrder: (order) =>
        set((state) => ({ grouping: setPhaseSidebarGroupOrder(state.grouping, order) })),
      createGroup: (label, threadKeys) => {
        const result = createPhaseSidebarCustomGroup(get().grouping, {
          label,
          ...(threadKeys ? { threadKeys } : {}),
        });
        if (result.id !== null) set({ grouping: result.preferences });
        return result.id;
      },
      renameGroup: (id, label) =>
        set((state) => ({ grouping: renamePhaseSidebarCustomGroup(state.grouping, id, label) })),
      deleteGroup: (id) =>
        set((state) => ({ grouping: deletePhaseSidebarCustomGroup(state.grouping, id) })),
      moveGroup: (id, direction) =>
        set((state) => ({
          grouping: movePhaseSidebarCustomGroup(state.grouping, id, direction),
        })),
      assignThread: (threadKey, groupId) =>
        set((state) => ({
          grouping: assignPhaseSidebarThreadToGroup(state.grouping, threadKey, groupId),
        })),
      toggleSectionCollapsed: (sectionKey) =>
        set((state) => ({
          grouping: togglePhaseSidebarSectionCollapsed(state.grouping, sectionKey),
        })),
      prune: (liveThreadKeys) =>
        set((state) => {
          const next = prunePhaseSidebarGrouping(state.grouping, liveThreadKeys);
          return next === state.grouping ? state : { grouping: next };
        }),
    }),
    {
      name: PHASE_SIDEBAR_GROUPING_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ grouping: state.grouping }),
      merge: (persisted, current) => ({
        ...current,
        grouping: sanitizePhaseSidebarGrouping(
          persisted && typeof persisted === "object"
            ? (persisted as { readonly grouping?: unknown }).grouping
            : undefined,
        ),
      }),
    },
  ),
);
