/**
 * T3-CUSTOM(expbkt3): persisted per-environment nickname, icon and colour.
 *
 * Mirrors `phaseSidebarFilterStore.ts` — zustand + persist through `resolveStorage`,
 * so it degrades the same way when storage is unavailable. Keyed by environment id
 * rather than connection id: the same machine reached over a different transport is
 * still the same machine to the operator.
 *
 * @module environmentAppearanceStore
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  sanitizeEnvironmentAppearance,
  type EnvironmentAppearance,
} from "./state/environmentAppearance";
import { resolveStorage } from "./lib/storage";

export const ENVIRONMENT_APPEARANCE_STORAGE_KEY = "t3code:environment-appearance:v1";

interface EnvironmentAppearanceStoreState {
  readonly appearanceByEnvironmentId: Readonly<Record<string, EnvironmentAppearance>>;
  setAppearance: (environmentId: string, appearance: EnvironmentAppearance) => void;
  resetAppearance: (environmentId: string) => void;
}

export const useEnvironmentAppearanceStore = create<EnvironmentAppearanceStoreState>()(
  persist(
    (set) => ({
      appearanceByEnvironmentId: {},
      setAppearance: (environmentId, appearance) =>
        set((state) => {
          const sanitized = sanitizeEnvironmentAppearance(appearance);
          const next = { ...state.appearanceByEnvironmentId };
          // An appearance with nothing set is indistinguishable from the derived
          // default, so drop the key rather than storing an empty object forever.
          if (sanitized === null) {
            delete next[environmentId];
          } else {
            next[environmentId] = sanitized;
          }
          return { appearanceByEnvironmentId: next };
        }),
      resetAppearance: (environmentId) =>
        set((state) => {
          const next = { ...state.appearanceByEnvironmentId };
          delete next[environmentId];
          return { appearanceByEnvironmentId: next };
        }),
    }),
    {
      name: ENVIRONMENT_APPEARANCE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      merge: (persisted, current) => {
        const stored =
          typeof persisted === "object" && persisted !== null
            ? (persisted as Partial<EnvironmentAppearanceStoreState>)
            : {};
        const raw = stored.appearanceByEnvironmentId ?? {};
        const sanitized: Record<string, EnvironmentAppearance> = {};
        for (const [environmentId, appearance] of Object.entries(raw)) {
          const value = sanitizeEnvironmentAppearance(appearance);
          if (value !== null) sanitized[environmentId] = value;
        }
        return { ...current, appearanceByEnvironmentId: sanitized };
      },
    },
  ),
);
