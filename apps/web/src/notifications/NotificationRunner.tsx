/**
 * T3-CUSTOM(expbkt3): Runtime for experimental notification alerts.
 *
 * Mounted once from `__root.tsx`. It owns no UI — it observes the thread
 * projection the sidebar already consumes, hands transitions to the pure
 * detector, and plays/pops whatever comes back. Everything decidable lives in
 * `notificationEvents.logic.ts`; this file is wiring and browser APIs.
 */
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { hasUnseenCompletion } from "../components/Sidebar.logic";
import { useThreadShells } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { claimAlert, pruneAlertClaims } from "./alertDedupe";
import { showBrowserNotification } from "./browserNotifications";
import {
  buildNotificationSnapshot,
  detectNotificationAlerts,
  type NotificationAlert,
  type NotificationSnapshot,
  type NotificationThreadState,
} from "./notificationEvents.logic";
import { useNotificationPreferences } from "./notificationPreferences";
import { playTone } from "./notificationSound";

/** Claim keys accumulate one entry per alert; sweep them on a slow timer. */
const CLAIM_PRUNE_INTERVAL_MS = 60_000;

export function NotificationRunner() {
  const threads = useThreadShells();
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const preferences = useNotificationPreferences();
  const navigate = useNavigate();
  // `useParams` on the root route: the chat route's params when one is open,
  // an empty object everywhere else.
  const openThreadId = useParams({ strict: false }).threadId;
  const openEnvironmentId = useParams({ strict: false }).environmentId;

  const previousRef = useRef<NotificationSnapshot | null>(null);
  // Read through refs inside the effect so preference edits never replay the
  // detector against a stale baseline.
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const timer = window.setInterval(() => pruneAlertClaims(Date.now()), CLAIM_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const current = preferencesRef.current;
    const states: Array<NotificationThreadState> = threads.map((thread) => {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return {
        threadKey,
        title: thread.title,
        needsInput:
          thread.hasPendingUserInput || thread.execution?.turn?.state === "waiting-for-input",
        needsApproval:
          thread.hasPendingApprovals || thread.execution?.turn?.state === "waiting-for-approval",
        unreadCompletion: hasUnseenCompletion({
          ...thread,
          lastVisitedAt: lastVisitedAtByThreadKey[threadKey],
        }),
      };
    });
    const next = buildNotificationSnapshot(states);
    const previous = previousRef.current;
    previousRef.current = next;

    if (!current.enabled) return;

    // Built through the same helper the rows use, so the key format has exactly
    // one definition even though the router hands back plain strings.
    const focusedThreadKey =
      openThreadId !== undefined &&
      openEnvironmentId !== undefined &&
      document.visibilityState === "visible"
        ? scopedThreadKey(
            scopeThreadRef(EnvironmentId.make(openEnvironmentId), ThreadId.make(openThreadId)),
          )
        : null;

    const alerts = detectNotificationAlerts({
      previous,
      next,
      rules: {
        enabledEvents: {
          "needs-input": current.events["needs-input"].enabled,
          approval: current.events.approval.enabled,
          "thread-completed": current.events["thread-completed"].enabled,
          "unread-threshold": current.events["unread-threshold"].enabled,
        },
        unreadThreshold: current.unreadThreshold,
        focusedThreadKey,
      },
    });

    for (const alert of alerts) {
      if (!claimAlert(alert.dedupeKey, Date.now())) continue;
      presentAlert(alert);
    }

    function presentAlert(alert: NotificationAlert) {
      const eventPreference = current.events[alert.eventId];
      void playTone(eventPreference.toneId, eventPreference.volume);

      // The tab you are looking at already shows the row highlight and badge, so
      // a native notification there would be pure duplication.
      if (!current.browserNotifications || document.visibilityState === "visible") return;
      showBrowserNotification({
        title: alert.title,
        body: alert.body,
        tag: alert.dedupeKey,
        onActivate: () => {
          const ref = alert.threadKey === undefined ? null : parseScopedThreadKey(alert.threadKey);
          if (ref === null) return;
          void navigateRef.current({
            to: "/$environmentId/$threadId",
            params: { environmentId: ref.environmentId, threadId: ref.threadId },
          });
        },
      });
    }
  }, [lastVisitedAtByThreadKey, openEnvironmentId, openThreadId, threads]);

  return null;
}
