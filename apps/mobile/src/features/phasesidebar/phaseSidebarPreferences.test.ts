// T3-CUSTOM(expbkt3): fork-owned coverage for the sidebar's pure preference logic.
import { describe, expect, it } from "@effect/vitest";

import { pruneVisitTimestamps, resolvePhaseSidebarEnabled } from "./phaseSidebarPreferences";

const at = (hour: number) => `2026-08-31T${String(hour).padStart(2, "0")}:00:00.000Z`;

describe("pruneVisitTimestamps", () => {
  it("leaves a map that fits under the cap untouched", () => {
    const visits = { a: at(1), b: at(2) };
    expect(pruneVisitTimestamps(visits, 5)).toBe(visits);
  });

  it("keeps the most recently visited threads when over the cap", () => {
    const pruned = pruneVisitTimestamps({ old: at(1), mid: at(2), fresh: at(3) }, 2);
    expect(Object.keys(pruned).sort()).toEqual(["fresh", "mid"]);
  });

  it("drops unparseable timestamps before real ones", () => {
    const pruned = pruneVisitTimestamps({ broken: "not-a-date", real: at(1) }, 1);
    expect(Object.keys(pruned)).toEqual(["real"]);
  });

  it("keeps exactly the cap when trimming", () => {
    const visits = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`t${index}`, at(index)]),
    );
    expect(Object.keys(pruneVisitTimestamps(visits, 4))).toHaveLength(4);
  });
});

describe("resolvePhaseSidebarEnabled", () => {
  it("is off while preferences are still loading", () => {
    expect(resolvePhaseSidebarEnabled({ preference: true, preferencesLoaded: false })).toBe(false);
  });

  it("is off for a device that has never chosen", () => {
    expect(resolvePhaseSidebarEnabled({ preference: undefined, preferencesLoaded: true })).toBe(
      false,
    );
  });

  it("is on only when explicitly enabled", () => {
    expect(resolvePhaseSidebarEnabled({ preference: true, preferencesLoaded: true })).toBe(true);
    expect(resolvePhaseSidebarEnabled({ preference: false, preferencesLoaded: true })).toBe(false);
  });
});
