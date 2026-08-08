/**
 * T3-CUSTOM(expbkt3): Selection state for the bulk session manager table.
 *
 * Deliberately a *separate* store from `threadSelectionStore`, which the
 * sidebar owns. The manager's "select all filtered" routinely selects 100+
 * rows; sharing one store would light up the sidebar's own multi-select
 * chrome and bulk context menu for a selection the user made on another page.
 * Same shape and semantics (toggle, shift-range, prune), different lifetime.
 */
import { create } from "zustand";

export interface SessionManagerSelectionState {
  /** Currently selected scoped thread keys. */
  selectedThreadKeys: ReadonlySet<string>;
  /** The scoped thread key that anchors shift-click range selection. */
  anchorThreadKey: string | null;
}

interface SessionManagerSelectionStore extends SessionManagerSelectionState {
  /** Toggle a single scoped thread key (plain click on the row checkbox). */
  toggleThread: (threadKey: string) => void;
  /**
   * Select every key between the anchor and `threadKey` (Shift+Click).
   * `orderedThreadKeys` must be the keys in on-screen order, so the range
   * matches what the user sees rather than the underlying sort.
   */
  rangeSelectTo: (threadKey: string, orderedThreadKeys: readonly string[]) => void;
  /** Replace the whole selection (select-all-filtered / Cmd-A). */
  replaceSelection: (threadKeys: readonly string[]) => void;
  /** Clear all selection state. */
  clearSelection: () => void;
  /** Remove specific keys (e.g. after deletion). */
  removeFromSelection: (threadKeys: readonly string[]) => void;
  /**
   * Drop any selected key that is no longer a live row. Rows are live atoms,
   * so a thread can vanish mid-run (deleted elsewhere, filtered out by its own
   * update); a stale key would make the toolbar count lie.
   */
  pruneSelection: (liveThreadKeys: ReadonlySet<string>) => void;
  /** Set the anchor without selecting it. */
  setAnchor: (threadKey: string) => void;
  hasSelection: () => boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export const useSessionManagerSelectionStore = create<SessionManagerSelectionStore>((set, get) => ({
  selectedThreadKeys: EMPTY_SET,
  anchorThreadKey: null,

  toggleThread: (threadKey) => {
    set((state) => {
      const next = new Set(state.selectedThreadKeys);
      if (next.has(threadKey)) {
        next.delete(threadKey);
      } else {
        next.add(threadKey);
      }
      return {
        selectedThreadKeys: next,
        anchorThreadKey: next.has(threadKey) ? threadKey : state.anchorThreadKey,
      };
    });
  },

  rangeSelectTo: (threadKey, orderedThreadKeys) => {
    set((state) => {
      const anchor = state.anchorThreadKey;
      if (anchor === null) {
        const next = new Set(state.selectedThreadKeys);
        next.add(threadKey);
        return { selectedThreadKeys: next, anchorThreadKey: threadKey };
      }

      const anchorIndex = orderedThreadKeys.indexOf(anchor);
      const targetIndex = orderedThreadKeys.indexOf(threadKey);
      if (anchorIndex === -1 || targetIndex === -1) {
        // The anchor scrolled out of the filtered set — degrade to a toggle
        // rather than selecting an arbitrary range.
        const next = new Set(state.selectedThreadKeys);
        next.add(threadKey);
        return { selectedThreadKeys: next, anchorThreadKey: threadKey };
      }

      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const next = new Set(state.selectedThreadKeys);
      for (let index = start; index <= end; index += 1) {
        const key = orderedThreadKeys[index];
        if (key !== undefined) next.add(key);
      }
      // Anchor stays put so repeated shift-clicks grow from the same origin.
      return { selectedThreadKeys: next, anchorThreadKey: anchor };
    });
  },

  replaceSelection: (threadKeys) => {
    set((state) => ({
      selectedThreadKeys: new Set(threadKeys),
      anchorThreadKey: state.anchorThreadKey,
    }));
  },

  clearSelection: () => {
    const state = get();
    if (state.selectedThreadKeys.size === 0 && state.anchorThreadKey === null) return;
    set({ selectedThreadKeys: EMPTY_SET, anchorThreadKey: null });
  },

  setAnchor: (threadKey) => {
    if (get().anchorThreadKey === threadKey) return;
    set({ anchorThreadKey: threadKey });
  },

  removeFromSelection: (threadKeys) => {
    set((state) => {
      const toRemove = new Set(threadKeys);
      let changed = false;
      const next = new Set<string>();
      for (const key of state.selectedThreadKeys) {
        if (toRemove.has(key)) {
          changed = true;
        } else {
          next.add(key);
        }
      }
      if (!changed) return state;
      const anchorThreadKey =
        state.anchorThreadKey !== null && toRemove.has(state.anchorThreadKey)
          ? null
          : state.anchorThreadKey;
      return { selectedThreadKeys: next, anchorThreadKey };
    });
  },

  pruneSelection: (liveThreadKeys) => {
    set((state) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of state.selectedThreadKeys) {
        if (liveThreadKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      const anchorStale =
        state.anchorThreadKey !== null && !liveThreadKeys.has(state.anchorThreadKey);
      if (!changed && !anchorStale) return state;
      return {
        selectedThreadKeys: next,
        anchorThreadKey: anchorStale ? null : state.anchorThreadKey,
      };
    });
  },

  hasSelection: () => get().selectedThreadKeys.size > 0,
}));
