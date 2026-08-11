import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  compareNightlyVersions,
  composeNightlyVersion,
  formatBuildDate,
  isNightlyReleaseAsset,
  isReleaseWorkflowSafeTag,
  parseNightlyVersion,
  resolveNewestNightlyVersion,
  resolveNextCounter,
  tagFromVersion,
  versionFromTag,
} from "./bk-desktop-release.ts";

describe("bk-desktop-release versioning", () => {
  it("formats the build date in UTC", () => {
    expect(formatBuildDate(DateTime.makeUnsafe("2026-08-10T23:59:59Z"))).toBe("20260810");
    // A local-time formatter would roll these to a neighbouring day depending on
    // the machine's offset, which would let the ordering key move backwards.
    expect(formatBuildDate(DateTime.makeUnsafe("2026-01-05T00:00:00Z"))).toBe("20260105");
    expect(formatBuildDate(DateTime.makeUnsafe("2026-12-31T00:00:00Z"))).toBe("20261231");
  });

  it("composes and parses nightly versions symmetrically", () => {
    const version = composeNightlyVersion("0.0.32", "20260810", 3);
    expect(version).toBe("0.0.32-nightly.20260810.3");
    expect(parseNightlyVersion(version)).toEqual({
      baseVersion: "0.0.32",
      date: "20260810",
      counter: 3,
    });
  });

  it("rejects malformed composed versions rather than shipping them", () => {
    expect(() => composeNightlyVersion("0.0", "20260810", 1)).toThrow();
    expect(() => composeNightlyVersion("0.0.32", "2026081", 1)).toThrow();
    expect(() => composeNightlyVersion("0.0.32", "20260810", 0)).not.toThrow();
  });

  it("does not parse non-nightly versions", () => {
    expect(parseNightlyVersion("0.0.32")).toBeUndefined();
    expect(parseNightlyVersion("0.0.32-alpha.1")).toBeUndefined();
    expect(parseNightlyVersion("0.0.32-nightly.20260810")).toBeUndefined();
  });

  it("round-trips tags and versions", () => {
    expect(tagFromVersion("0.0.32-nightly.20260810.1")).toBe("v0.0.32-nightly.20260810.1");
    expect(versionFromTag("v0.0.32-nightly.20260810.1")).toBe("0.0.32-nightly.20260810.1");
    expect(versionFromTag("0.0.32-nightly.20260810.1")).toBe("0.0.32-nightly.20260810.1");
  });
});

describe("release.yml trigger safety", () => {
  it("accepts nightly-form tags, which release.yml excludes", () => {
    expect(isReleaseWorkflowSafeTag("v0.0.32-nightly.20260810.1")).toBe(true);
  });

  it("rejects every tag shape that release.yml's v*.*.* trigger would match", () => {
    // Each of these would publish t3 to npm and re-alias app.t3.codes.
    expect(isReleaseWorkflowSafeTag("v0.0.32")).toBe(false);
    expect(isReleaseWorkflowSafeTag("v1.2.3-alpha.1")).toBe(false);
    expect(isReleaseWorkflowSafeTag("v0.0.0-test.1")).toBe(false);
    expect(isReleaseWorkflowSafeTag("v0.0.32-nightly")).toBe(false);
    expect(isReleaseWorkflowSafeTag("bk-desktop-20260810")).toBe(false);
    expect(isReleaseWorkflowSafeTag("0.0.32-nightly.20260810.1")).toBe(false);
  });
});

describe("nightly ordering and counters", () => {
  it("orders by base version, then date, then counter", () => {
    const parse = (version: string) => {
      const parsed = parseNightlyVersion(version);
      if (!parsed) throw new Error(`unparseable: ${version}`);
      return parsed;
    };

    expect(
      compareNightlyVersions(
        parse("0.0.32-nightly.20260810.1"),
        parse("0.0.32-nightly.20260810.2"),
      ),
    ).toBeLessThan(0);
    expect(
      compareNightlyVersions(
        parse("0.0.32-nightly.20260811.1"),
        parse("0.0.32-nightly.20260810.9"),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareNightlyVersions(
        parse("0.0.33-nightly.20260101.1"),
        parse("0.0.32-nightly.20261231.9"),
      ),
    ).toBeGreaterThan(0);
    // Base version compares numerically, not as strings: 10 > 9.
    expect(
      compareNightlyVersions(parse("0.0.10-nightly.20260810.1"), parse("0.0.9-nightly.20260810.1")),
    ).toBeGreaterThan(0);
  });

  it("starts at 1 and increments within the same base version and date", () => {
    expect(resolveNextCounter([], "0.0.32", "20260810")).toBe(1);
    expect(
      resolveNextCounter(
        ["v0.0.32-nightly.20260810.1", "v0.0.32-nightly.20260810.2"],
        "0.0.32",
        "20260810",
      ),
    ).toBe(3);
  });

  it("restarts the counter on a new date or base version", () => {
    const published = ["v0.0.32-nightly.20260810.7"];
    expect(resolveNextCounter(published, "0.0.32", "20260811")).toBe(1);
    expect(resolveNextCounter(published, "0.0.33", "20260810")).toBe(1);
  });

  it("ignores unrelated and upstream-shaped tags when counting", () => {
    expect(
      resolveNextCounter(
        ["v0.0.32", "some-other-tag", "v0.0.32-nightly.20260810.4"],
        "0.0.32",
        "20260810",
      ),
    ).toBe(5);
  });

  it("finds the newest published version across dates", () => {
    expect(
      resolveNewestNightlyVersion([
        "v0.0.32-nightly.20260810.1",
        "v0.0.33-nightly.20260101.9",
        "v0.0.32-nightly.20260811.4",
      ]),
    ).toEqual({ baseVersion: "0.0.33", date: "20260101", counter: 9 });
    expect(resolveNewestNightlyVersion(["v0.0.32", "junk"])).toBeUndefined();
  });
});

describe("release asset selection", () => {
  it("includes the installer and everything auto-update needs", () => {
    expect(isNightlyReleaseAsset("BK-T3-Code-0.0.32-nightly.20260810.1-arm64.dmg")).toBe(true);
    // Squirrel.Mac update payload.
    expect(isNightlyReleaseAsset("BK-T3-Code-0.0.32-nightly.20260810.1-arm64.zip")).toBe(true);
    // Differential download map and the manifest electron-updater reads.
    expect(isNightlyReleaseAsset("BK-T3-Code-0.0.32-arm64.dmg.blockmap")).toBe(true);
    expect(isNightlyReleaseAsset("nightly-mac.yml")).toBe(true);
  });

  it("excludes the stable manifest and build leftovers", () => {
    // latest-mac.yml belongs to the stable channel; publishing it here would be
    // misleading and is never read by a nightly-channel client.
    expect(isNightlyReleaseAsset("latest-mac.yml")).toBe(false);
    expect(isNightlyReleaseAsset("builder-debug.yml")).toBe(false);
    expect(isNightlyReleaseAsset("BK T3 Code.app")).toBe(false);
  });
});
