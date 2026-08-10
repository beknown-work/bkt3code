/**
 * T3-CUSTOM(expbkt3): Alert detection for the experimental notification system.
 *
 * Pure and dependency-free on purpose: everything that decides *whether* to
 * alert lives here, so the runtime component is only wiring. The rule that
 * matters is that alerts fire on TRANSITIONS, never on state — a thread that is
 * already waiting when you open the app must not chime, or every reconnect
 * becomes an alarm.
 *
 * The pile-up alert obeys the same rule, which it did not always. It used to
 * compare the unread *count* against the threshold and fire whenever the count
 * crossed it. A count is state, and this one moves for reasons that have
 * nothing to do with a new row arriving: threads stream in one environment at a
 * time on load, an environment that drops its connection takes its rows out of
 * the count and puts them back on reconnect, and a row that is already unread
 * leaves the count for the length of its next turn and re-enters when that turn
 * ends. Every one of those re-crossed the line and re-fired the alarm. Now the
 * pile is tracked as a set of rows, and the alert fires once for each row that
 * genuinely joins it while the pile is at or over the threshold.
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
  "unread-threshold":
    "Once the threshold below is reached, one alert for each further session that finishes without you opening it.",
};

/** One thread reduced to the states an alert can be derived from. */
export interface NotificationThreadState {
  readonly threadKey: string;
  /** Which environment owns the row, so environment churn stays describable. */
  readonly environmentId: string;
  readonly title: string;
  readonly needsInput: boolean;
  readonly needsApproval: boolean;
  /** An unseen completion as of right now. */
  readonly unreadCompletion: boolean;
  /**
   * Whether the latest turn has finished at all. False means a turn is in
   * flight, which is the difference between "you have read this" and "there is
   * nothing to read yet" — the two states `unreadCompletion` alone conflates.
   */
  readonly hasCompletedTurn: boolean;
}

/** What this client can currently see, per environment. */
export interface NotificationEnvironments {
  /** Every environment in the catalog, connected or not. */
  readonly known: ReadonlySet<string>;
  /** Those whose thread list has arrived; only these can be reasoned about. */
  readonly ready: ReadonlySet<string>;
}

export interface NotificationSnapshot {
  /** Threads from ready environments only. */
  readonly threadsByKey: ReadonlyMap<string, NotificationThreadState>;
  /**
   * The unread pile: thread key to owning environment. Carried across
   * snapshots rather than recomputed, so it survives in-flight turns and
   * environment outages.
   */
  readonly unreadEnvironmentByThreadKey: ReadonlyMap<string, string>;
  readonly unreadCount: number;
  readonly environments: NotificationEnvironments;
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

/**
 * Folds the current thread list into the previous snapshot.
 *
 * The unread pile is advanced rather than rebuilt, because "unread" is a fact
 * about a row that only two things can change: the row finishing a turn you
 * have not seen (joins), and you opening it after that turn (leaves). Anything
 * else the projection does to a row — a turn starting, the environment going
 * away, the whole list repopulating — is this client losing sight of the row,
 * not the row becoming read.
 */
export function buildNotificationSnapshot(input: {
  readonly previous: NotificationSnapshot | null;
  readonly threads: ReadonlyArray<NotificationThreadState>;
  readonly environments: NotificationEnvironments;
}): NotificationSnapshot {
  const { environments } = input;
  const threadsByKey = new Map<string, NotificationThreadState>();
  for (const thread of input.threads) {
    // A thread from an environment whose list has not arrived is a thread we
    // are seeing half of. Leave it out entirely rather than reason about it.
    if (!environments.ready.has(thread.environmentId)) continue;
    threadsByKey.set(thread.threadKey, thread);
  }

  const unread = new Map(input.previous?.unreadEnvironmentByThreadKey ?? []);
  for (const [threadKey, environmentId] of unread) {
    // Unlinked environments take their rows with them; there is no longer
    // anywhere for you to go and read them.
    if (!environments.known.has(environmentId)) {
      unread.delete(threadKey);
      continue;
    }
    // A disconnected or still-loading environment says nothing about its rows.
    // Holding them in the pile is what stops a reconnect from replaying the
    // whole pile as if every row had just arrived.
    if (!environments.ready.has(environmentId)) continue;
    if (!threadsByKey.has(threadKey)) unread.delete(threadKey);
  }

  for (const thread of threadsByKey.values()) {
    if (thread.unreadCompletion) {
      unread.set(thread.threadKey, thread.environmentId);
      continue;
    }
    // Not unread and no completed turn means a turn is in flight: the row is
    // between completions, not read. Leaving its membership alone is what stops
    // a busy thread from rejoining the pile — and re-alarming — every turn.
    if (thread.hasCompletedTurn) unread.delete(thread.threadKey);
  }

  return {
    threadsByKey,
    unreadEnvironmentByThreadKey: unread,
    unreadCount: unread.size,
    environments,
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
 * Environments whose rows only just became visible to this client.
 *
 * Their thread list arrives in one piece, so everything in it is pre-existing
 * by definition — the same reasoning `roseTo` applies to an unknown thread,
 * applied to a whole environment at once. This is what keeps a page load, a
 * reconnect, or a second environment finishing its handshake silent.
 */
function adoptedEnvironments(
  previous: NotificationSnapshot,
  next: NotificationSnapshot,
): ReadonlySet<string> {
  const adopted = new Set<string>();
  for (const environmentId of next.environments.ready) {
    if (!previous.environments.ready.has(environmentId)) adopted.add(environmentId);
  }
  return adopted;
}

function pileUpTitle(unreadCount: number): string {
  return unreadCount === 1
    ? "1 agent is waiting for you"
    : `${unreadCount} agents are waiting for you`;
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

  const adopted = adoptedEnvironments(previous, next);
  const alerts: Array<NotificationAlert> = [];
  // One tone per thread per pass: a row that already spoke for itself must not
  // also be counted as the row that tipped the pile over.
  const alertedThreadKeys = new Set<string>();

  for (const [threadKey, thread] of next.threadsByKey) {
    if (threadKey === rules.focusedThreadKey) continue;
    if (adopted.has(thread.environmentId)) continue;
    const before = previous.threadsByKey.get(threadKey);

    if (rules.enabledEvents["needs-input"] && roseTo(before, thread, (state) => state.needsInput)) {
      alerts.push({
        eventId: "needs-input",
        dedupeKey: `needs-input:${threadKey}`,
        title: "Agent needs your input",
        body: thread.title,
        threadKey,
      });
      alertedThreadKeys.add(threadKey);
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
      alertedThreadKeys.add(threadKey);
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
      alertedThreadKeys.add(threadKey);
    }
  }

  // Edge-triggered on the rows, not on the count: once the pile is at or over
  // the threshold, each row that joins it earns exactly one alert. A pile that
  // merely stays large is silent, and so is one that shrinks and refills
  // because an environment reconnected or a busy thread took another turn.
  if (
    rules.enabledEvents["unread-threshold"] &&
    rules.unreadThreshold > 0 &&
    next.unreadCount >= rules.unreadThreshold
  ) {
    const arrivals: Array<string> = [];
    for (const [threadKey, environmentId] of next.unreadEnvironmentByThreadKey) {
      if (previous.unreadEnvironmentByThreadKey.has(threadKey)) continue;
      if (adopted.has(environmentId)) continue;
      if (threadKey === rules.focusedThreadKey) continue;
      if (alertedThreadKeys.has(threadKey)) continue;
      arrivals.push(threadKey);
    }
    if (arrivals.length > 0) {
      arrivals.sort();
      const only = arrivals.length === 1 ? next.threadsByKey.get(arrivals[0]!) : undefined;
      alerts.push({
        eventId: "unread-threshold",
        // Keyed by what arrived, not by the count: two rows arriving seconds
        // apart are two alerts, while the same arrival seen by three tabs is
        // one.
        dedupeKey: `unread-threshold:${arrivals.join(",")}`,
        title: pileUpTitle(next.unreadCount),
        body: only?.title ?? "Finished sessions you have not opened yet.",
      });
    }
  }

  return alerts;
}

export const MIN_UNREAD_THRESHOLD = 1;
export const MAX_UNREAD_THRESHOLD = 50;

export function clampUnreadThreshold(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(MAX_UNREAD_THRESHOLD, Math.max(MIN_UNREAD_THRESHOLD, Math.round(value)));
}
