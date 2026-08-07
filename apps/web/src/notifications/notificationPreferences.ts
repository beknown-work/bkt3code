/**
 * T3-CUSTOM(expbkt3): Per-browser notification preferences.
 *
 * Deliberately local: the unread count these thresholds compare against is
 * itself localStorage state (`threadLastVisitedAtById`), so a server-side
 * preference would describe a number the server cannot compute.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import {
  clampUnreadThreshold,
  NOTIFICATION_EVENT_IDS,
  type NotificationEventId,
} from "./notificationEvents.logic";
import { DEFAULT_TONE_ID } from "./notificationTones";

export const NOTIFICATION_PREFERENCES_STORAGE_KEY = "t3code:notifications:v1";

export interface NotificationEventPreference {
  readonly enabled: boolean;
  readonly toneId: string;
  /** 0..1. */
  readonly volume: number;
}

export interface NotificationPreferences {
  /** Master switch. Off means no sound and no native notification, ever. */
  readonly enabled: boolean;
  /** Native notifications when the tab is not visible. Sound is independent. */
  readonly browserNotifications: boolean;
  readonly unreadThreshold: number;
  readonly events: Readonly<Record<NotificationEventId, NotificationEventPreference>>;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  browserNotifications: true,
  unreadThreshold: 3,
  events: {
    "needs-input": { enabled: true, toneId: "chime", volume: 0.7 },
    approval: { enabled: true, toneId: "ping", volume: 0.6 },
    // A turn completing is the most frequent event in the app; opting in is the
    // only sane default.
    "thread-completed": { enabled: false, toneId: "marimba", volume: 0.5 },
    "unread-threshold": { enabled: true, toneId: "alarm", volume: 0.7 },
  },
};

function sanitizeEvent(value: unknown, fallback: NotificationEventPreference) {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<Record<keyof NotificationEventPreference, unknown>>;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : fallback.enabled,
    toneId:
      typeof candidate.toneId === "string" && candidate.toneId.trim().length > 0
        ? candidate.toneId
        : fallback.toneId,
    volume:
      typeof candidate.volume === "number" && Number.isFinite(candidate.volume)
        ? Math.min(1, Math.max(0, candidate.volume))
        : fallback.volume,
  } satisfies NotificationEventPreference;
}

export function sanitizeNotificationPreferences(value: unknown): NotificationPreferences {
  if (!value || typeof value !== "object") return DEFAULT_NOTIFICATION_PREFERENCES;
  const candidate = value as Partial<Record<keyof NotificationPreferences, unknown>>;
  const events = (candidate.events ?? {}) as Record<string, unknown>;
  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : DEFAULT_NOTIFICATION_PREFERENCES.enabled,
    browserNotifications:
      typeof candidate.browserNotifications === "boolean"
        ? candidate.browserNotifications
        : DEFAULT_NOTIFICATION_PREFERENCES.browserNotifications,
    unreadThreshold: clampUnreadThreshold(
      typeof candidate.unreadThreshold === "number"
        ? candidate.unreadThreshold
        : DEFAULT_NOTIFICATION_PREFERENCES.unreadThreshold,
    ),
    events: Object.fromEntries(
      NOTIFICATION_EVENT_IDS.map((eventId) => [
        eventId,
        sanitizeEvent(events[eventId], DEFAULT_NOTIFICATION_PREFERENCES.events[eventId]),
      ]),
    ) as NotificationPreferences["events"],
  };
}

interface NotificationPreferencesStore extends NotificationPreferences {
  setEnabled: (enabled: boolean) => void;
  setBrowserNotifications: (enabled: boolean) => void;
  setUnreadThreshold: (threshold: number) => void;
  setEventPreference: (
    eventId: NotificationEventId,
    patch: Partial<NotificationEventPreference>,
  ) => void;
  resetToneUsage: (toneId: string) => void;
}

export const useNotificationPreferences = create<NotificationPreferencesStore>()(
  persist(
    (set) => ({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      setEnabled: (enabled) => set({ enabled }),
      setBrowserNotifications: (browserNotifications) => set({ browserNotifications }),
      setUnreadThreshold: (threshold) => set({ unreadThreshold: clampUnreadThreshold(threshold) }),
      setEventPreference: (eventId, patch) =>
        set((state) => ({
          events: { ...state.events, [eventId]: { ...state.events[eventId], ...patch } },
        })),
      // Deleting a custom tone must not leave events pointing at a sound that no
      // longer exists, which would silently mute them.
      resetToneUsage: (toneId) =>
        set((state) => ({
          events: Object.fromEntries(
            NOTIFICATION_EVENT_IDS.map((eventId) => [
              eventId,
              state.events[eventId].toneId === toneId
                ? { ...state.events[eventId], toneId: DEFAULT_TONE_ID }
                : state.events[eventId],
            ]),
          ) as NotificationPreferences["events"],
        })),
    }),
    {
      name: NOTIFICATION_PREFERENCES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        enabled: state.enabled,
        browserNotifications: state.browserNotifications,
        unreadThreshold: state.unreadThreshold,
        events: state.events,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeNotificationPreferences(persisted),
      }),
    },
  ),
);
