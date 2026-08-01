import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderRateLimitSnapshot,
  ProviderRateLimitUpdate,
  ProviderRateLimitsStreamSnapshot,
} from "./providerRateLimits.ts";

const decodeUpdate = Schema.decodeUnknownSync(ProviderRateLimitUpdate);
const decodeSnapshot = Schema.decodeUnknownSync(ProviderRateLimitSnapshot);
const decodeStreamSnapshot = Schema.decodeUnknownSync(ProviderRateLimitsStreamSnapshot);
const at = (value: string) => DateTime.makeUnsafe(value);

describe("ProviderRateLimitUpdate", () => {
  it("decodes a full replacement update", () => {
    const update = decodeUpdate({
      mode: "replace",
      availability: "available",
      windows: [
        {
          windowId: "codex:primary",
          label: "Primary",
          usedPercent: 26,
          resetsAt: at("2026-08-01T12:00:00.000Z"),
          windowDurationMinutes: 300,
          category: "rolling",
        },
      ],
      observedAt: at("2026-08-01T10:00:00.000Z"),
    });

    expect(update.mode).toBe("replace");
    expect(update.windows[0]?.usedPercent).toBe(26);
    expect(DateTime.formatIso(update.observedAt)).toBe("2026-08-01T10:00:00.000Z");
  });

  it("decodes a sparse merge and an unavailable replacement", () => {
    expect(
      decodeUpdate({
        mode: "merge",
        availability: "available",
        windows: [
          {
            windowId: "claude:five-hour",
            label: "Five-hour",
            usedPercent: 64.4,
            resetsAt: null,
            category: "rolling",
          },
        ],
        observedAt: at("2026-08-01T10:01:00.000Z"),
      }).windows,
    ).toHaveLength(1);

    expect(
      decodeUpdate({
        mode: "replace",
        availability: "not-applicable",
        windows: [],
        observedAt: at("2026-08-01T10:01:00.000Z"),
      }).availability,
    ).toBe("not-applicable");
  });

  it("rejects malformed percentages and window identifiers", () => {
    for (const usedPercent of [-0.1, 100.1, Number.NaN]) {
      expect(() =>
        decodeUpdate({
          mode: "merge",
          availability: "available",
          windows: [
            {
              windowId: "window",
              label: "Window",
              usedPercent,
              resetsAt: null,
              category: "other",
            },
          ],
          observedAt: at("2026-08-01T10:01:00.000Z"),
        }),
      ).toThrow();
    }

    expect(() =>
      decodeUpdate({
        mode: "merge",
        availability: "available",
        windows: [
          {
            windowId: "   ",
            label: "Window",
            usedPercent: 50,
            resetsAt: null,
            category: "other",
          },
        ],
        observedAt: at("2026-08-01T10:01:00.000Z"),
      }),
    ).toThrow();
  });
});

describe("ProviderRateLimitSnapshot", () => {
  it("decodes unknown and not-applicable states without readings", () => {
    const snapshot = decodeSnapshot({
      providerInstanceId: "claudeAgent",
      driverKind: "claudeAgent",
      availability: "unknown",
      windows: [],
      observedAt: null,
      lastRefreshFailed: false,
    });

    expect(snapshot.observedAt).toBeNull();
    expect(snapshot.windows).toEqual([]);
  });

  it("decodes an environment stream snapshot", () => {
    const snapshot = decodeStreamSnapshot({
      revision: 2,
      entries: [
        {
          providerInstanceId: "codex",
          driverKind: "codex",
          availability: "available",
          windows: [],
          observedAt: at("2026-08-01T10:00:00.000Z"),
          lastRefreshFailed: false,
        },
      ],
    });

    expect(snapshot.revision).toBe(2);
    expect(snapshot.entries[0]?.driverKind).toBe("codex");
  });
});
