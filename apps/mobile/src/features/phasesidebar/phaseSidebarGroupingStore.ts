// T3-CUSTOM(expbkt3): the phase sidebar's grouping preferences on mobile.
//
// The shape, the defaults, the sanitizer and every edit are client-runtime's;
// this hook only reads the blob out of device preferences and writes the
// result of a pure operation back. Web keeps the same preferences in a zustand
// store — same operations, different storage.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  type PhaseSidebarGroupingPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function usePhaseSidebarGrouping(): PhaseSidebarGroupingPreferences {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value.phaseSidebarGrouping ?? DEFAULT_PHASE_SIDEBAR_GROUPING)
    : DEFAULT_PHASE_SIDEBAR_GROUPING;
}

/**
 * Applies one pure grouping operation and persists the result. Reads the
 * latest value at call time, so two quick edits do not clobber each other.
 */
export function useUpdatePhaseSidebarGrouping(): (
  apply: (current: PhaseSidebarGroupingPreferences) => PhaseSidebarGroupingPreferences,
) => void {
  const grouping = usePhaseSidebarGrouping();
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (apply) => {
      const next = apply(grouping);
      if (next === grouping) return;
      updatePreferences({ phaseSidebarGrouping: next });
    },
    [grouping, updatePreferences],
  );
}
