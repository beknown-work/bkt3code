import { describe, expect, it } from "vite-plus/test";

import { claimIsStale, ALERT_CLAIM_TTL_MS } from "./alertDedupe";
import {
  buildNotificationSnapshot,
  clampUnreadThreshold,
  detectNotificationAlerts,
  type NotificationEnvironments,
  type NotificationRules,
  type NotificationSnapshot,
  type NotificationThreadState,
} from "./notificationEvents.logic";
import {
  sanitizeNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from "./notificationPreferences";
import { BUILT_IN_TONES, findBuiltInTone, toneDurationMs } from "./notificationTones";

const thread = (overrides: Partial<NotificationThreadState> = {}): NotificationThreadState => ({
  threadKey: "env-1:thread-1",
  environmentId: "env-1",
  title: "Refactor the sidebar",
  needsInput: false,
  needsApproval: false,
  unreadCompletion: false,
  hasCompletedTurn: false,
  ...overrides,
});

const environments = (
  ready: ReadonlyArray<string> = ["env-1", "env-2"],
  known: ReadonlyArray<string> = ["env-1", "env-2"],
): NotificationEnvironments => ({ known: new Set(known), ready: new Set(ready) });

const snapshot = (
  threads: ReadonlyArray<NotificationThreadState>,
  options: {
    readonly previous?: NotificationSnapshot | null;
    readonly environments?: NotificationEnvironments;
  } = {},
): NotificationSnapshot =>
  buildNotificationSnapshot({
    previous: options.previous ?? null,
    threads,
    environments: options.environments ?? environments(),
  });

const rules = (overrides: Partial<NotificationRules> = {}): NotificationRules => ({
  enabledEvents: {
    "needs-input": true,
    approval: true,
    "thread-completed": true,
    "unread-threshold": true,
  },
  unreadThreshold: 3,
  focusedThreadKey: null,
  ...overrides,
});

describe("detectNotificationAlerts", () => {
  it("stays silent until it has a baseline, so a reload never alarms", () => {
    const next = snapshot([thread({ needsInput: true })]);

    expect(detectNotificationAlerts({ previous: null, next, rules: rules() })).toEqual([]);
  });

  it("fires on the transition into needs-input and not while it persists", () => {
    const idle = snapshot([thread()]);
    const waiting = snapshot([thread({ needsInput: true })]);

    const first = detectNotificationAlerts({ previous: idle, next: waiting, rules: rules() });
    expect(first.map((alert) => alert.eventId)).toEqual(["needs-input"]);
    expect(first[0]?.dedupeKey).toBe("needs-input:env-1:thread-1");
    expect(first[0]?.body).toBe("Refactor the sidebar");

    expect(detectNotificationAlerts({ previous: waiting, next: waiting, rules: rules() })).toEqual(
      [],
    );
  });

  it("treats a thread that arrives already waiting as pre-existing", () => {
    // A session created elsewhere shows up mid-flight; only a client that
    // watched it change should chime.
    const before = snapshot([]);
    const after = snapshot([thread({ needsInput: true })]);

    expect(detectNotificationAlerts({ previous: before, next: after, rules: rules() })).toEqual([]);
  });

  it("suppresses per-thread alerts for the thread you are looking at", () => {
    const idle = snapshot([thread()]);
    const waiting = snapshot([thread({ needsInput: true })]);

    expect(
      detectNotificationAlerts({
        previous: idle,
        next: waiting,
        rules: rules({ focusedThreadKey: "env-1:thread-1" }),
      }),
    ).toEqual([]);
  });

  it("reports a question rather than doubling up with approval or completion", () => {
    const idle = snapshot([thread()]);
    const busy = snapshot([
      thread({ needsInput: true, needsApproval: true, unreadCompletion: true }),
    ]);

    expect(
      detectNotificationAlerts({ previous: idle, next: busy, rules: rules() }).map(
        (alert) => alert.eventId,
      ),
    ).toEqual(["needs-input"]);
  });

  it("honours per-event switches", () => {
    const idle = snapshot([thread()]);
    const waiting = snapshot([thread({ needsInput: true })]);

    expect(
      detectNotificationAlerts({
        previous: idle,
        next: waiting,
        rules: rules({
          enabledEvents: {
            "needs-input": false,
            approval: true,
            "thread-completed": true,
            "unread-threshold": true,
          },
        }),
      }),
    ).toEqual([]);
  });

  it("counts unread across every thread, not per project", () => {
    const counted = snapshot([
      thread({ threadKey: "env-1:a", environmentId: "env-1", unreadCompletion: true }),
      thread({ threadKey: "env-2:b", environmentId: "env-2", unreadCompletion: true }),
      thread({ threadKey: "env-2:c", environmentId: "env-2" }),
    ]);

    expect(counted.unreadCount).toBe(2);
  });
});

describe("the unread pile-up alert", () => {
  const threshold = rules({
    enabledEvents: {
      "needs-input": true,
      approval: true,
      "thread-completed": false,
      "unread-threshold": true,
    },
  });

  /** `count` rows unread out of four, chained onto whatever came before. */
  const unreadRows = (count: number, previous: NotificationSnapshot | null = null) =>
    snapshot(
      Array.from({ length: 4 }, (_, index) =>
        thread({
          threadKey: `env-1:thread-${index}`,
          title: `Thread ${index}`,
          unreadCompletion: index < count,
          hasCompletedTurn: true,
        }),
      ),
      { previous },
    );

  const alertsFor = (previous: NotificationSnapshot, next: NotificationSnapshot) =>
    detectNotificationAlerts({ previous, next, rules: threshold });

  it("fires when a row tips the pile over the threshold", () => {
    const below = unreadRows(2);
    const crossing = alertsFor(below, unreadRows(3, below));

    expect(crossing.map((alert) => alert.eventId)).toEqual(["unread-threshold"]);
    expect(crossing[0]?.title).toBe("3 agents are waiting for you");
    // Named, because the point of the alert is the row that just arrived.
    expect(crossing[0]?.body).toBe("Thread 2");
    expect(crossing[0]?.dedupeKey).toBe("unread-threshold:env-1:thread-2");
  });

  it("fires once more for each further row, and stays quiet in between", () => {
    const three = unreadRows(3);
    const four = unreadRows(4, three);

    expect(alertsFor(three, four).map((alert) => alert.eventId)).toEqual(["unread-threshold"]);
    // The pile is large but nothing joined it: silence.
    expect(alertsFor(four, unreadRows(4, four))).toEqual([]);
  });

  it("stays quiet while an already-unread row runs another turn", () => {
    // The regression that made the alarm feel constant. A row that is already
    // unread reports `unreadCompletion: false` for the length of its next turn,
    // which used to drop the count under the threshold and re-alarm the moment
    // the turn finished — with the same rows on screen the whole time.
    const settled = unreadRows(3);
    const rows = (overrides: Partial<NotificationThreadState>) =>
      Array.from({ length: 4 }, (_, index) =>
        thread({
          threadKey: `env-1:thread-${index}`,
          unreadCompletion: index < 3,
          hasCompletedTurn: true,
          ...(index === 0 ? overrides : {}),
        }),
      );

    const working = snapshot(rows({ unreadCompletion: false, hasCompletedTurn: false }), {
      previous: settled,
    });
    expect(working.unreadCount).toBe(3);
    expect(alertsFor(settled, working)).toEqual([]);

    const finished = snapshot(rows({}), { previous: working });
    expect(finished.unreadCount).toBe(3);
    expect(alertsFor(working, finished)).toEqual([]);
  });

  it("treats a row you opened and that then finishes again as a new arrival", () => {
    const settled = unreadRows(3);
    const read = unreadRows(2, settled);
    expect(read.unreadCount).toBe(2);

    expect(alertsFor(read, unreadRows(3, read)).map((alert) => alert.eventId)).toEqual([
      "unread-threshold",
    ]);
  });

  it("says nothing on first paint, however full the pile already is", () => {
    // Every environment starts unready, so the rows arrive in one piece and are
    // adopted as the baseline. This is the page-load alarm.
    const cold = snapshot([], { environments: environments([]) });
    const loaded = snapshot(
      Array.from({ length: 4 }, (_, index) =>
        thread({
          threadKey: `env-1:thread-${index}`,
          unreadCompletion: true,
          hasCompletedTurn: true,
        }),
      ),
      { previous: cold, environments: environments(["env-1"]) },
    );

    expect(loaded.unreadCount).toBe(4);
    expect(alertsFor(cold, loaded)).toEqual([]);
  });

  it("holds the pile steady while an environment is disconnected", () => {
    const both = snapshot(
      [
        thread({ threadKey: "env-1:a", unreadCompletion: true, hasCompletedTurn: true }),
        thread({ threadKey: "env-1:b", unreadCompletion: true, hasCompletedTurn: true }),
        thread({
          threadKey: "env-2:c",
          environmentId: "env-2",
          unreadCompletion: true,
          hasCompletedTurn: true,
        }),
      ],
      { previous: snapshot([]) },
    );
    expect(both.unreadCount).toBe(3);

    // env-2 drops. Its rows are unobservable, not read — the count must hold,
    // or the alarm re-arms behind your back.
    const dropped = snapshot(
      [
        thread({ threadKey: "env-1:a", unreadCompletion: true, hasCompletedTurn: true }),
        thread({ threadKey: "env-1:b", unreadCompletion: true, hasCompletedTurn: true }),
      ],
      { previous: both, environments: environments(["env-1"]) },
    );
    expect(dropped.unreadCount).toBe(3);
    expect(alertsFor(both, dropped)).toEqual([]);

    // ...and coming back is not three rows arriving at once.
    const restored = snapshot(
      [
        thread({ threadKey: "env-1:a", unreadCompletion: true, hasCompletedTurn: true }),
        thread({ threadKey: "env-1:b", unreadCompletion: true, hasCompletedTurn: true }),
        thread({
          threadKey: "env-2:c",
          environmentId: "env-2",
          unreadCompletion: true,
          hasCompletedTurn: true,
        }),
      ],
      { previous: dropped },
    );
    expect(restored.unreadCount).toBe(3);
    expect(alertsFor(dropped, restored)).toEqual([]);
  });

  it("lets go of rows whose environment is no longer linked", () => {
    const both = snapshot(
      [
        thread({ threadKey: "env-1:a", unreadCompletion: true, hasCompletedTurn: true }),
        thread({
          threadKey: "env-2:c",
          environmentId: "env-2",
          unreadCompletion: true,
          hasCompletedTurn: true,
        }),
      ],
      { previous: snapshot([]) },
    );

    const unlinked = snapshot(
      [thread({ threadKey: "env-1:a", unreadCompletion: true, hasCompletedTurn: true })],
      { previous: both, environments: environments(["env-1"], ["env-1"]) },
    );

    expect(unlinked.unreadCount).toBe(1);
  });

  it("does not double up with the per-thread alert for the same row", () => {
    const withCompletion = rules({
      enabledEvents: {
        "needs-input": true,
        approval: true,
        "thread-completed": true,
        "unread-threshold": true,
      },
    });
    const below = unreadRows(2);
    const crossing = unreadRows(3, below);

    expect(
      detectNotificationAlerts({ previous: below, next: crossing, rules: withCompletion }).map(
        (alert) => alert.eventId,
      ),
    ).toEqual(["thread-completed"]);
  });

  it("ignores a row that joins the pile below the threshold", () => {
    const one = unreadRows(1);

    expect(alertsFor(one, unreadRows(2, one))).toEqual([]);
  });
});

describe("clampUnreadThreshold", () => {
  it("keeps the threshold inside a usable range", () => {
    expect(clampUnreadThreshold(0)).toBe(1);
    expect(clampUnreadThreshold(3)).toBe(3);
    expect(clampUnreadThreshold(2.6)).toBe(3);
    expect(clampUnreadThreshold(999)).toBe(50);
    expect(clampUnreadThreshold(Number.NaN)).toBe(3);
  });
});

describe("notification preferences", () => {
  it("restores defaults for anything unreadable in storage", () => {
    expect(sanitizeNotificationPreferences(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(sanitizeNotificationPreferences({ enabled: "yes", unreadThreshold: -4 })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      unreadThreshold: 1,
    });
  });

  it("keeps a valid stored event while defaulting its neighbours", () => {
    const restored = sanitizeNotificationPreferences({
      events: { "needs-input": { enabled: false, toneId: "bell", volume: 0.25 } },
    });

    expect(restored.events["needs-input"]).toEqual({
      enabled: false,
      toneId: "bell",
      volume: 0.25,
    });
    expect(restored.events.approval).toEqual(DEFAULT_NOTIFICATION_PREFERENCES.events.approval);
  });

  it("ships every default pointing at a tone that exists", () => {
    for (const preference of Object.values(DEFAULT_NOTIFICATION_PREFERENCES.events)) {
      expect(findBuiltInTone(preference.toneId)).not.toBeNull();
    }
  });
});

describe("built-in tones", () => {
  it("are unique, audible, and bounded in length", () => {
    expect(new Set(BUILT_IN_TONES.map((tone) => tone.id)).size).toBe(BUILT_IN_TONES.length);
    for (const tone of BUILT_IN_TONES) {
      expect(tone.voices.length).toBeGreaterThan(0);
      // Anything longer than a couple of seconds stops being a notification.
      expect(toneDurationMs(tone)).toBeLessThanOrEqual(2_000);
      for (const voice of tone.voices) {
        expect(voice.frequency).toBeGreaterThan(20);
        expect(voice.frequency).toBeLessThan(20_000);
        expect(voice.gain).toBeGreaterThan(0);
        expect(voice.gain).toBeLessThanOrEqual(1);
        expect(voice.durationMs).toBeGreaterThan(0);
      }
    }
  });
});

describe("claimIsStale", () => {
  it("lets one tab win and the rest skip inside the window", () => {
    const now = 1_000_000;

    expect(claimIsStale(null, now)).toBe(true);
    expect(claimIsStale(String(now), now)).toBe(false);
    expect(claimIsStale(String(now - ALERT_CLAIM_TTL_MS + 1), now)).toBe(false);
    expect(claimIsStale(String(now - ALERT_CLAIM_TTL_MS), now)).toBe(true);
    expect(claimIsStale("not-a-number", now)).toBe(true);
    // A claim from a tab whose clock runs fast must not cause a stampede.
    expect(claimIsStale(String(now + 60_000), now)).toBe(false);
  });
});
