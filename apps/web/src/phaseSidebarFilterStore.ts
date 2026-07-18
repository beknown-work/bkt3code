import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  EMPTY_PHASE_SIDEBAR_FILTERS,
  reconcilePhaseSidebarFilters,
  sanitizePhaseSidebarFilters,
  type PhaseSidebarFilters,
  type PhaseSidebarPhaseId,
} from "./components/sidebar/PhaseGroupedSidebar.logic";
import { resolveStorage } from "./lib/storage";

export const PHASE_SIDEBAR_FILTER_STORAGE_KEY = "t3code:phase-sidebar-filters:v1";

interface PhaseSidebarFilterStoreState extends PhaseSidebarFilters {
  toggleRepository: (repositoryKey: string) => void;
  togglePhase: (phaseId: PhaseSidebarPhaseId) => void;
  toggleProvider: (providerKind: string) => void;
  toggleAssignedToMe: () => void;
  clearAll: () => void;
  reconcile: (options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
    readonly assignmentAvailable: boolean;
  }) => void;
}

function toggleValue<T extends string>(values: ReadonlyArray<T>, value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

export const usePhaseSidebarFilterStore = create<PhaseSidebarFilterStoreState>()(
  persist(
    (set) => ({
      ...EMPTY_PHASE_SIDEBAR_FILTERS,
      toggleRepository: (repositoryKey) =>
        set((state) => ({ repositoryKeys: toggleValue(state.repositoryKeys, repositoryKey) })),
      togglePhase: (phaseId) =>
        set((state) => ({ phaseIds: toggleValue(state.phaseIds, phaseId) })),
      toggleProvider: (providerKind) =>
        set((state) => ({ providerKinds: toggleValue(state.providerKinds, providerKind) })),
      toggleAssignedToMe: () => set((state) => ({ assignedToMe: !state.assignedToMe })),
      clearAll: () => set(EMPTY_PHASE_SIDEBAR_FILTERS),
      reconcile: (options) => set((state) => reconcilePhaseSidebarFilters(state, options)),
    }),
    {
      name: PHASE_SIDEBAR_FILTER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        repositoryKeys: state.repositoryKeys,
        phaseIds: state.phaseIds,
        providerKinds: state.providerKinds,
        assignedToMe: state.assignedToMe,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePhaseSidebarFilters(persisted),
      }),
    },
  ),
);
