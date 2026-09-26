import { describe, expect, it } from "vite-plus/test";

import { FOCUS_RESYNC_AFTER_MS, makeFocusWakeupTracker } from "./focusWakeup.expbkt3";

const trackerAt = () => {
  let nowMs = 1_000_000;
  const tracker = makeFocusWakeupTracker(() => nowMs);
  return { tracker, advance: (ms: number) => (nowMs += ms) };
};

describe("focus wakeups", () => {
  it("only probes on a quick alt-tab", () => {
    const { tracker, advance } = trackerAt();
    tracker.markInactive();
    advance(5_000);
    expect(tracker.onFocus()).toBe("application-focus");
  });

  it("resyncs after the window was away for a minute", () => {
    const { tracker, advance } = trackerAt();
    tracker.markInactive();
    advance(FOCUS_RESYNC_AFTER_MS / 2);
    // A second blur (another window) does not restart the absence.
    tracker.markInactive();
    advance(FOCUS_RESYNC_AFTER_MS / 2);
    expect(tracker.onFocus()).toBe("application-active");
    // The return was consumed; an immediate refocus only probes.
    expect(tracker.onFocus()).toBe("application-focus");
  });

  it("does not resync twice when visibility already did", () => {
    const { tracker, advance } = trackerAt();
    tracker.markInactive();
    advance(10 * FOCUS_RESYNC_AFTER_MS);
    tracker.markResynced();
    expect(tracker.onFocus()).toBe("application-focus");
  });

  it("probes a focus with no recorded absence", () => {
    expect(trackerAt().tracker.onFocus()).toBe("application-focus");
  });
});
