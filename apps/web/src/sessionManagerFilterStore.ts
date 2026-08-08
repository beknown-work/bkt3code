/**
 * T3-CUSTOM(expbkt3): Persisted filter + sort state for the bulk session
 * manager page.
 *
 * Modelled on `phaseSidebarFilterStore` (persist + sanitize/reconcile) but kept
 * separate on purpose: the manager and the sidebar answer different questions,
 * and sharing one blob would make a table filter silently hide sidebar rows.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type {
  PhaseSidebarAttentionKind,
  PhaseSidebarPhaseId,
} from "./components/sidebar/PhaseGroupedSidebar.logic";
import {
  DEFAULT_SESSION_MANAGER_FILTERS,
  DEFAULT_SESSION_MANAGER_SORT,
  nextSessionManagerSort,
  reconcileSessionManagerFilters,
  sanitizeSessionManagerFilters,
  sanitizeSessionManagerSort,
  type SessionManagerFilters,
  type SessionManagerLifecycle,
  type SessionManagerSort,
  type SessionManagerSortColumn,
} from "./components/sessionManager/SessionManagerPage.logic";
import { resolveStorage } from "./lib/storage";

export const SESSION_MANAGER_FILTER_STORAGE_KEY = "t3code:session-manager-filters:v1";

interface SessionManagerFilterStoreState extends SessionManagerFilters {
  readonly sort: SessionManagerSort;
  /** Which saved view is highlighted, or null when the filters are hand-set. */
  readonly activeViewId: string | null;
  setSearch: (search: string) => void;
  toggleRepository: (repositoryKey: string) => void;
  togglePhase: (phaseId: PhaseSidebarPhaseId) => void;
  toggleProvider: (providerKind: string) => void;
  togglePriority: (priorityRank: number) => void;
  toggleAttention: (kind: PhaseSidebarAttentionKind) => void;
  toggleOwner: (ownerUserId: string) => void;
  toggleLifecycle: (lifecycle: SessionManagerLifecycle) => void;
  setStaleDays: (days: number | null) => void;
  setFacet: <K extends keyof SessionManagerFilters>(
    facet: K,
    value: SessionManagerFilters[K],
  ) => void;
  cycleSort: (column: SessionManagerSortColumn) => void;
  setSort: (sort: SessionManagerSort) => void;
  applyView: (viewId: string, filters: SessionManagerFilters, sort?: SessionManagerSort) => void;
  clearAll: () => void;
  reconcile: (options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
    readonly ownerUserIds: ReadonlySet<string>;
  }) => void;
}

function toggleValue<T>(values: ReadonlyArray<T>, value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

export const useSessionManagerFilterStore = create<SessionManagerFilterStoreState>()(
  persist(
    (set) => ({
      ...DEFAULT_SESSION_MANAGER_FILTERS,
      sort: DEFAULT_SESSION_MANAGER_SORT,
      activeViewId: null,

      setSearch: (search) => set({ search, activeViewId: null }),
      toggleRepository: (repositoryKey) =>
        set((state) => ({
          repositoryKeys: toggleValue(state.repositoryKeys, repositoryKey),
          activeViewId: null,
        })),
      togglePhase: (phaseId) =>
        set((state) => ({ phaseIds: toggleValue(state.phaseIds, phaseId), activeViewId: null })),
      toggleProvider: (providerKind) =>
        set((state) => ({
          providerKinds: toggleValue(state.providerKinds, providerKind),
          activeViewId: null,
        })),
      togglePriority: (priorityRank) =>
        set((state) => ({
          priorities: toggleValue(state.priorities, priorityRank),
          activeViewId: null,
        })),
      toggleAttention: (kind) =>
        set((state) => ({
          attentionKinds: toggleValue(state.attentionKinds, kind),
          activeViewId: null,
        })),
      toggleOwner: (ownerUserId) =>
        set((state) => ({
          ownerUserIds: toggleValue(state.ownerUserIds, ownerUserId),
          activeViewId: null,
        })),
      toggleLifecycle: (lifecycle) =>
        set((state) => {
          const next = toggleValue(state.lifecycles, lifecycle);
          // Never let the user switch every lifecycle off — the table would go
          // permanently empty with no obvious cause.
          return {
            lifecycles: next.length > 0 ? next : state.lifecycles,
            activeViewId: null,
          };
        }),
      setStaleDays: (staleDays) => set({ staleDays, activeViewId: null }),
      setFacet: (facet, value) => set({ [facet]: value, activeViewId: null } as never),
      cycleSort: (column) => set((state) => ({ sort: nextSessionManagerSort(state.sort, column) })),
      setSort: (sort) => set({ sort }),
      applyView: (viewId, filters, sort) =>
        set((state) => ({
          ...filters,
          sort: sort ?? state.sort,
          activeViewId: viewId,
        })),
      clearAll: () => set({ ...DEFAULT_SESSION_MANAGER_FILTERS, activeViewId: null }),
      reconcile: (options) =>
        set((state) => {
          const reconciled = reconcileSessionManagerFilters(state, options);
          return reconciled === (state as SessionManagerFilters) ? state : reconciled;
        }),
    }),
    {
      name: SESSION_MANAGER_FILTER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        // The search box is deliberately NOT persisted: a stale query hiding
        // every row across a reload is indistinguishable from an outage.
        repositoryKeys: state.repositoryKeys,
        phaseIds: state.phaseIds,
        providerKinds: state.providerKinds,
        priorities: state.priorities,
        attentionKinds: state.attentionKinds,
        ownerUserIds: state.ownerUserIds,
        lifecycles: state.lifecycles,
        staleDays: state.staleDays,
        sort: state.sort,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeSessionManagerFilters(persisted),
        search: "",
        sort: sanitizeSessionManagerSort(
          persisted && typeof persisted === "object"
            ? (persisted as { readonly sort?: unknown }).sort
            : undefined,
        ),
        activeViewId: null,
      }),
    },
  ),
);
