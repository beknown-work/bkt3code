import { describe, expect, it } from "vite-plus/test";

import { claimIsStale, ALERT_CLAIM_TTL_MS } from "./alertDedupe";
import {
  buildNotificationSnapshot,
  clampUnreadThreshold,
  detectNotificationAlerts,
  type NotificationRules,
  type NotificationThreadState,
} from "./notificationEvents.logic";
import {
  sanitizeNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from "./notificationPreferences";
import { BUILT_IN_TONES, findBuiltInTone, toneDurationMs } from "./notificationTones";

const thread = (overrides: Partial<NotificationThreadState> = {}): NotificationThreadState => ({
  threadKey: "env-1:thread-1",
  title: "Refactor the sidebar",
  needsInput: false,
  needsApproval: false,
  unreadCompletion: false,
  ...overrides,
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
    const next = buildNotificationSnapshot([thread({ needsInput: true })]);

    expect(detectNotificationAlerts({ previous: null, next, rules: rules() })).toEqual([]);
  });

  it("fires on the transition into needs-input and not while it persists", () => {
    const idle = buildNotificationSnapshot([thread()]);
    const waiting = buildNotificationSnapshot([thread({ needsInput: true })]);

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
    const before = buildNotificationSnapshot([]);
    const after = buildNotificationSnapshot([thread({ needsInput: true })]);

    expect(detectNotificationAlerts({ previous: before, next: after, rules: rules() })).toEqual([]);
  });

  it("suppresses per-thread alerts for the thread you are looking at", () => {
    const idle = buildNotificationSnapshot([thread()]);
    const waiting = buildNotificationSnapshot([thread({ needsInput: true })]);

    expect(
      detectNotificationAlerts({
        previous: idle,
        next: waiting,
        rules: rules({ focusedThreadKey: "env-1:thread-1" }),
      }),
    ).toEqual([]);
  });

  it("reports a question rather than doubling up with approval or completion", () => {
    const idle = buildNotificationSnapshot([thread()]);
    const busy = buildNotificationSnapshot([
      thread({ needsInput: true, needsApproval: true, unreadCompletion: true }),
    ]);

    expect(
      detectNotificationAlerts({ previous: idle, next: busy, rules: rules() }).map(
        (alert) => alert.eventId,
      ),
    ).toEqual(["needs-input"]);
  });

  it("honours per-event switches", () => {
    const idle = buildNotificationSnapshot([thread()]);
    const waiting = buildNotificationSnapshot([thread({ needsInput: true })]);

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

  it("fires the pile-up alert once per crossing and re-arms only after it drops", () => {
    const unreadRows = (count: number) =>
      buildNotificationSnapshot(
        Array.from({ length: 4 }, (_, index) =>
          thread({ threadKey: `env-1:thread-${index}`, unreadCompletion: index < count }),
        ),
      );
    const threshold = rules({
      enabledEvents: {
        "needs-input": true,
        approval: true,
        "thread-completed": false,
        "unread-threshold": true,
      },
    });

    const crossing = detectNotificationAlerts({
      previous: unreadRows(2),
      next: unreadRows(3),
      rules: threshold,
    });
    expect(crossing.map((alert) => alert.eventId)).toEqual(["unread-threshold"]);
    expect(crossing[0]?.title).toBe("3 agents are waiting for you");

    // Climbing further while already over the line must stay quiet.
    expect(
      detectNotificationAlerts({ previous: unreadRows(3), next: unreadRows(4), rules: threshold }),
    ).toEqual([]);
    // Dropping below and climbing again re-arms it.
    expect(
      detectNotificationAlerts({
        previous: unreadRows(1),
        next: unreadRows(3),
        rules: threshold,
      }).map((alert) => alert.eventId),
    ).toEqual(["unread-threshold"]);
  });

  it("counts unread across every thread, not per project", () => {
    const snapshot = buildNotificationSnapshot([
      thread({ threadKey: "env-1:a", unreadCompletion: true }),
      thread({ threadKey: "env-2:b", unreadCompletion: true }),
      thread({ threadKey: "env-2:c" }),
    ]);

    expect(snapshot.unreadCount).toBe(2);
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
