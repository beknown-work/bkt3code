/**
 * T3-CUSTOM(expbkt3): exclusive ownership for origin-bearing agent frames.
 *
 * Browser storage belongs to an origin, not to an iframe or URL fragment. Keep
 * one live URL frame per origin and hand ownership over in two commits: first
 * every candidate unmounts, then the requested slot mounts. That empty commit
 * prevents two same-origin applications from broadcasting or writing storage
 * concurrently while React moves a view between timeline and overlay.
 */
import { create } from "zustand";

export interface AgentUiUrlFrameRegistration {
  readonly slotId: string;
  readonly renderId: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly priority: "inline" | "expanded";
}

interface AgentUiUrlFrameCoordinatorState {
  readonly registrations: Readonly<Record<string, AgentUiUrlFrameRegistration>>;
  readonly activeSlotByOrigin: Readonly<Record<string, string | null>>;
  readonly pendingSlotByOrigin: Readonly<Record<string, string | null>>;
  register: (registration: AgentUiUrlFrameRegistration) => void;
  unregister: (slotId: string) => void;
  activate: (slotId: string) => void;
  settle: (origin: string) => void;
  reset: () => void;
}

const priority = (registration: AgentUiUrlFrameRegistration): number =>
  registration.priority === "expanded" ? 1 : 0;

function bestRegistration(
  registrations: Readonly<Record<string, AgentUiUrlFrameRegistration>>,
  origin: string,
): AgentUiUrlFrameRegistration | null {
  let best: AgentUiUrlFrameRegistration | null = null;
  for (const registration of Object.values(registrations)) {
    if (registration.origin !== origin) continue;
    if (
      best === null ||
      priority(registration) > priority(best) ||
      (priority(registration) === priority(best) &&
        (registration.createdAt > best.createdAt ||
          (registration.createdAt === best.createdAt && registration.slotId > best.slotId)))
    ) {
      best = registration;
    }
  }
  return best;
}

const initialState = {
  registrations: {},
  activeSlotByOrigin: {},
  pendingSlotByOrigin: {},
} as const;

export const useAgentUiUrlFrameCoordinator = create<AgentUiUrlFrameCoordinatorState>((set) => ({
  ...initialState,
  register: (registration) =>
    set((state) => {
      const previous = state.registrations[registration.slotId];
      if (
        previous?.renderId === registration.renderId &&
        previous.origin === registration.origin &&
        previous.createdAt === registration.createdAt &&
        previous.priority === registration.priority
      ) {
        return state;
      }

      const registrations = { ...state.registrations, [registration.slotId]: registration };
      const selectedSlot =
        state.pendingSlotByOrigin[registration.origin] ??
        state.activeSlotByOrigin[registration.origin] ??
        null;
      const selected = selectedSlot === null ? null : (registrations[selectedSlot] ?? null);
      const shouldActivate =
        selected === null ||
        registration.priority === "expanded" ||
        (selected.priority === "inline" && registration.createdAt > selected.createdAt);

      return {
        ...state,
        registrations,
        ...(shouldActivate && selectedSlot !== registration.slotId
          ? {
              activeSlotByOrigin: {
                ...state.activeSlotByOrigin,
                [registration.origin]: null,
              },
              pendingSlotByOrigin: {
                ...state.pendingSlotByOrigin,
                [registration.origin]: registration.slotId,
              },
            }
          : {}),
      };
    }),
  unregister: (slotId) =>
    set((state) => {
      const registration = state.registrations[slotId];
      if (!registration) return state;
      const registrations = { ...state.registrations };
      delete registrations[slotId];
      const wasSelected =
        state.activeSlotByOrigin[registration.origin] === slotId ||
        state.pendingSlotByOrigin[registration.origin] === slotId;
      if (!wasSelected) return { ...state, registrations };

      const fallback = bestRegistration(registrations, registration.origin);
      return {
        ...state,
        registrations,
        activeSlotByOrigin: {
          ...state.activeSlotByOrigin,
          [registration.origin]: null,
        },
        pendingSlotByOrigin: {
          ...state.pendingSlotByOrigin,
          [registration.origin]: fallback?.slotId ?? null,
        },
      };
    }),
  activate: (slotId) =>
    set((state) => {
      const registration = state.registrations[slotId];
      if (!registration) return state;
      if (
        state.activeSlotByOrigin[registration.origin] === slotId &&
        state.pendingSlotByOrigin[registration.origin] == null
      ) {
        return state;
      }
      return {
        ...state,
        activeSlotByOrigin: {
          ...state.activeSlotByOrigin,
          [registration.origin]: null,
        },
        pendingSlotByOrigin: {
          ...state.pendingSlotByOrigin,
          [registration.origin]: slotId,
        },
      };
    }),
  settle: (origin) =>
    set((state) => {
      const pendingSlot = state.pendingSlotByOrigin[origin] ?? null;
      const pending = pendingSlot === null ? null : (state.registrations[pendingSlot] ?? null);
      const next =
        pending?.origin === origin ? pending : bestRegistration(state.registrations, origin);
      if (next === null && state.activeSlotByOrigin[origin] == null && pendingSlot === null) {
        return state;
      }
      return {
        ...state,
        activeSlotByOrigin: { ...state.activeSlotByOrigin, [origin]: next?.slotId ?? null },
        pendingSlotByOrigin: { ...state.pendingSlotByOrigin, [origin]: null },
      };
    }),
  reset: () => set(initialState),
}));
