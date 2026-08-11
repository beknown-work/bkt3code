import { describe, expect, it } from "vite-plus/test";

import { shouldRefreshThreadTitle } from "./titleRefreshCadence.ts";

const settings = (overrides: Partial<{ enabled: boolean; refreshEveryUserPrompts: number }> = {}) =>
  ({ enabled: true, refreshEveryUserPrompts: 3, ...overrides }) as const;

describe("shouldRefreshThreadTitle", () => {
  it("leaves the first prompt to upstream's one-shot titling", () => {
    expect(shouldRefreshThreadTitle({ userMessageCount: 1, settings: settings() })).toBe(false);
    // A cadence of 1 must not fight the first-turn rename either.
    expect(
      shouldRefreshThreadTitle({
        userMessageCount: 1,
        settings: settings({ refreshEveryUserPrompts: 1 }),
      }),
    ).toBe(false);
  });

  it("refreshes on every multiple of the configured cadence", () => {
    const every3 = settings();
    expect(shouldRefreshThreadTitle({ userMessageCount: 2, settings: every3 })).toBe(false);
    expect(shouldRefreshThreadTitle({ userMessageCount: 3, settings: every3 })).toBe(true);
    expect(shouldRefreshThreadTitle({ userMessageCount: 4, settings: every3 })).toBe(false);
    expect(shouldRefreshThreadTitle({ userMessageCount: 6, settings: every3 })).toBe(true);
    expect(shouldRefreshThreadTitle({ userMessageCount: 9, settings: every3 })).toBe(true);
  });

  it("refreshes on every prompt at a cadence of one", () => {
    const every1 = settings({ refreshEveryUserPrompts: 1 });
    expect(shouldRefreshThreadTitle({ userMessageCount: 2, settings: every1 })).toBe(true);
    expect(shouldRefreshThreadTitle({ userMessageCount: 3, settings: every1 })).toBe(true);
  });

  it("treats zero as off, and never fires when disabled", () => {
    expect(
      shouldRefreshThreadTitle({
        userMessageCount: 12,
        settings: settings({ refreshEveryUserPrompts: 0 }),
      }),
    ).toBe(false);
    expect(
      shouldRefreshThreadTitle({ userMessageCount: 12, settings: settings({ enabled: false }) }),
    ).toBe(false);
  });
});
