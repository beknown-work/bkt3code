/**
 * T3-CUSTOM(expbkt3): Alert detection for the experimental notification system.
 *
 * Pure and dependency-free on purpose: everything that decides *whether* to
 * alert lives here, so the runtime component is only wiring. The rule that
 * matters is that alerts fire on TRANSITIONS, never on state — a thread that is
 * already waiting when you open the app must not chime, or every reconnect
 * becomes an alarm.
 */

export type NotificationEventId =
  | "needs-input"
  | "approval"
  | "thread-completed"
  | "unread-threshold";

export const NOTIFICATION_EVENT_IDS = [
  "needs-input",
  "approval",
  "thread-completed",
  "unread-threshold",
] as const satisfies ReadonlyArray<NotificationEventId>;

export const NOTIFICATION_EVENT_LABELS: Readonly<Record<NotificationEventId, string>> = {
  "needs-input": "Agent asks a question",
  approval: "Agent requests approval",
  "thread-completed": "Agent finishes a turn",
  "unread-threshold": "Unread agents pile up",
};

export const NOTIFICATION_EVENT_DESCRIPTIONS: Readonly<Record<NotificationEventId, string>> = {
  "needs-input": "A session is blocked on a structured question and cannot continue without you.",
  approval: "A session is waiting for you to approve a tool call, plan, or command.",
  "thread-completed": "A session finished its turn. Noisy by design — off unless you want it.",
  "unread-threshold": "Finished sessions you have not opened reach the threshold below.",
};

/** One thread reduced to the states an alert can be derived from. */
export interface NotificationThreadState {
  readonly threadKey: string;
  readonly title: string;
  readonly needsInput: boolean;
  readonly needsApproval: boolean;
  readonly unreadCompletion: boolean;
}

export interface NotificationSnapshot {
  readonly threadsByKey: ReadonlyMap<string, NotificationThreadState>;
  readonly unreadCount: number;
}

export interface NotificationAlert {
  readonly eventId: NotificationEventId;
  /** Stable within one alert so concurrent tabs can suppress duplicates. */
  readonly dedupeKey: string;
  readonly title: string;
  readonly body: string;
  /** Absent for the aggregate threshold alert, which belongs to no one thread. */
  readonly threadKey?: string;
}

export interface NotificationRules {
  readonly enabledEvents: Readonly<Record<NotificationEventId, boolean>>;
  readonly unreadThreshold: number;
  /** Suppresses per-thread alerts for the thread you are already looking at. */
  readonly focusedThreadKey: string | null;
}

export function buildNotificationSnapshot(
  threads: ReadonlyArray<NotificationThreadState>,
): NotificationSnapshot {
  return {
    threadsByKey: new Map(threads.map((thread) => [thread.threadKey, thread])),
    unreadCount: threads.reduce((count, thread) => count + (thread.unreadCompletion ? 1 : 0), 0),
  };
}

function roseTo(
  previous: NotificationThreadState | undefined,
  next: NotificationThreadState,
  select: (state: NotificationThreadState) => boolean,
): boolean {
  // A thread we have never seen counts as pre-existing, never as a transition.
  // Reconnects repopulate the projection thread by thread, so treating an
  // unknown thread as "just changed" would turn every reconnect into an alarm.
  // The case this gives up — a brand-new session that asks a question the
  // instant it appears — is the session you just opened, and focus suppression
  // would have silenced it anyway.
  if (previous === undefined) return false;
  return select(next) && !select(previous);
}

/**
 * Alerts implied by the move from `previous` to `next`.
 *
 * `previous` being null means this client has no baseline yet (first render, or
 * a reconnect that rebuilt the projection). That case yields nothing at all —
 * the snapshot is adopted silently as the new baseline.
 */
export function detectNotificationAlerts(input: {
  readonly previous: NotificationSnapshot | null;
  readonly next: NotificationSnapshot;
  readonly rules: NotificationRules;
}): ReadonlyArray<NotificationAlert> {
  const { previous, next, rules } = input;
  if (previous === null) return [];

  const alerts: Array<NotificationAlert> = [];
  for (const [threadKey, thread] of next.threadsByKey) {
    if (threadKey === rules.focusedThreadKey) continue;
    const before = previous.threadsByKey.get(threadKey);

    if (rules.enabledEvents["needs-input"] && roseTo(before, thread, (state) => state.needsInput)) {
      alerts.push({
        eventId: "needs-input",
        dedupeKey: `needs-input:${threadKey}`,
        title: "Agent needs your input",
        body: thread.title,
        threadKey,
      });
      // A thread that just asked a question is not also reported as waiting for
      // approval or as newly unread; the question is the actionable state.
      continue;
    }

    if (rules.enabledEvents.approval && roseTo(before, thread, (state) => state.needsApproval)) {
      alerts.push({
        eventId: "approval",
        dedupeKey: `approval:${threadKey}`,
        title: "Agent needs approval",
        body: thread.title,
        threadKey,
      });
      continue;
    }

    if (
      rules.enabledEvents["thread-completed"] &&
      roseTo(before, thread, (state) => state.unreadCompletion)
    ) {
      alerts.push({
        eventId: "thread-completed",
        dedupeKey: `thread-completed:${threadKey}`,
        title: "Agent finished",
        body: thread.title,
        threadKey,
      });
    }
  }

  // Edge-triggered: crossing the threshold fires once. It re-arms only after the
  // count falls back below it, so clearing one of four unread sessions and
  // letting it climb again does not re-alert.
  if (
    rules.enabledEvents["unread-threshold"] &&
    rules.unreadThreshold > 0 &&
    next.unreadCount >= rules.unreadThreshold &&
    previous.unreadCount < rules.unreadThreshold
  ) {
    alerts.push({
      eventId: "unread-threshold",
      dedupeKey: `unread-threshold:${next.unreadCount}`,
      title: `${next.unreadCount} agents are waiting for you`,
      body: "Finished sessions you have not opened yet.",
    });
  }

  return alerts;
}

export const MIN_UNREAD_THRESHOLD = 1;
export const MAX_UNREAD_THRESHOLD = 50;

export function clampUnreadThreshold(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(MAX_UNREAD_THRESHOLD, Math.max(MIN_UNREAD_THRESHOLD, Math.round(value)));
}
