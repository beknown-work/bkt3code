// T3-CUSTOM(expbkt3): per-environment nickname, icon and colour on mobile.
//
// Stored in device preferences under one map keyed by environment id — the
// same shape web keeps in localStorage — and resolved against the connection's
// label so an environment always has a name even before anyone renames it.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentAppearance } from "@t3tools/client-runtime/state/environment-appearance";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  resolveMobileEnvironmentAppearance,
  type MobileEnvironmentAppearance,
} from "./environmentAppearance";

const EMPTY: Readonly<Record<string, EnvironmentAppearance>> = {};

function useStoredAppearances(): Readonly<Record<string, EnvironmentAppearance>> {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value.environmentAppearanceByEnvironmentId ?? EMPTY)
    : EMPTY;
}

/** Appearance for every known environment, keyed by id. */
export function useEnvironmentAppearances(): ReadonlyMap<string, MobileEnvironmentAppearance> {
  const { environments } = useEnvironments();
  const stored = useStoredAppearances();
  return useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          resolveMobileEnvironmentAppearance({
            environmentId: environment.environmentId,
            label: environment.label,
            appearance: stored[environment.environmentId],
          }),
        ]),
      ),
    [environments, stored],
  );
}

export function useEnvironmentAppearance(
  environmentId: EnvironmentId | null,
): MobileEnvironmentAppearance | null {
  const appearances = useEnvironmentAppearances();
  return environmentId === null ? null : (appearances.get(environmentId) ?? null);
}

/** The raw stored override for one environment, for the editor's own state. */
export function useStoredEnvironmentAppearance(
  environmentId: EnvironmentId,
): EnvironmentAppearance | undefined {
  return useStoredAppearances()[environmentId];
}

/**
 * Write one environment's override. Passing null clears it, so the derived
 * default shows again. Dropped until preferences have loaded: writing over
 * defaults would erase every other environment's customisation.
 */
export function useUpdateEnvironmentAppearance(): (
  environmentId: EnvironmentId,
  appearance: EnvironmentAppearance | null,
) => void {
  const result = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (environmentId, appearance) => {
      if (!AsyncResult.isSuccess(result)) return;
      const current = result.value.environmentAppearanceByEnvironmentId ?? EMPTY;
      const next: Record<string, EnvironmentAppearance> = { ...current };
      if (appearance === null) {
        delete next[environmentId];
      } else {
        next[environmentId] = appearance;
      }
      updatePreferences({ environmentAppearanceByEnvironmentId: next });
    },
    [result, updatePreferences],
  );
}
