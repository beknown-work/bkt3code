import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveGitHubPublishConfig,
} from "./build-desktop-artifact.ts";
import { BK_BRAND_ASSET_PATHS, DESKTOP_BRAND_ENV_VAR } from "./lib/bk-desktop-brand.ts";
import { BK_MANAGED_CHANNEL_ENV_VAR } from "./lib/bk-managed-environment.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

// The brand is read from the build environment rather than passed in, so the
// upstream signatures of these functions stay byte-identical and the next
// upstream merge has nothing to reconcile. Tests therefore drive process.env.
const originalBrand = process.env[DESKTOP_BRAND_ENV_VAR];
const originalChannel = process.env[BK_MANAGED_CHANNEL_ENV_VAR];

// Set once, before any Config read. Effect's default ConfigProvider snapshots
// process.env on first use, so a per-test assignment would be silently ignored
// by every test after the first.
process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY = "beknown-work/bkt3code";

function withBkBrand(variant?: "staging" | "production"): void {
  process.env[DESKTOP_BRAND_ENV_VAR] = "bk";
  if (variant) process.env[BK_MANAGED_CHANNEL_ENV_VAR] = variant;
}

function restore(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

afterEach(() => {
  restore(DESKTOP_BRAND_ENV_VAR, originalBrand);
  restore(BK_MANAGED_CHANNEL_ENV_VAR, originalChannel);
});

describe("desktop brand overrides in build-desktop-artifact", () => {
  it("leaves upstream product names untouched", () => {
    expect(resolveDesktopProductName("0.0.17")).toBe("T3 Code (Alpha)");
    expect(resolveDesktopProductName("0.0.17-nightly.20260413.42")).toBe("T3 Code (Nightly)");
  });

  it("names fork builds after the fork, not the nightly channel", () => {
    withBkBrand();
    // Every fork build is nightly-versioned so it reaches the nightly updater
    // channel, so the brand has to win over the nightly label.
    expect(resolveDesktopProductName("0.0.17-production-nightly.20260413.42")).toBe("BK T3 Code");
    expect(resolveDesktopProductName("0.0.17")).toBe("BK T3 Code");
  });

  it("names the staging app distinctly, so it installs beside production", () => {
    withBkBrand("staging");
    expect(resolveDesktopProductName("0.0.17-staging-nightly.20260413.42")).toBe(
      "BK T3 Code (Staging)",
    );
  });

  it("leaves upstream icon selection untouched", () => {
    expect(resolveDesktopBuildIconAssets("0.0.17")).toEqual({
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });
    expect(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42")).toEqual({
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("uses the fork icon set for fork builds, overriding the nightly icons", () => {
    withBkBrand();
    expect(resolveDesktopBuildIconAssets("0.0.17-production-nightly.20260413.42")).toEqual({
      macIconPng: BK_BRAND_ASSET_PATHS.macIconPng,
      linuxIconPng: BK_BRAND_ASSET_PATHS.universalIconPng,
      windowsIconIco: BK_BRAND_ASSET_PATHS.windowsIconIco,
    });
  });
});

describe("updater channel in the publish config", () => {
  const publishConfig = (version: string) =>
    Effect.runSync(
      resolveGitHubPublishConfig(/-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest"),
    );

  it("leaves upstream on the plain nightly channel", () => {
    expect(publishConfig("0.0.17-nightly.20260413.42")).toMatchObject({
      releaseType: "prerelease",
      channel: "nightly",
    });
  });

  it("gives each fork app its own channel, which is what separates their updates", () => {
    // Both apps publish into one repository. electron-updater picks a release by
    // matching semver.prerelease(tag)[0] against the running app's channel, so
    // these strings are the entire isolation mechanism — and they must equal the
    // version's first prerelease identifier.
    withBkBrand("staging");
    expect(publishConfig("0.0.17-staging-nightly.20260413.42")).toMatchObject({
      owner: "beknown-work",
      repo: "bkt3code",
      releaseType: "prerelease",
      channel: "staging-nightly",
    });

    withBkBrand("production");
    expect(publishConfig("0.0.17-production-nightly.20260413.42")).toMatchObject({
      releaseType: "prerelease",
      channel: "production-nightly",
    });
  });

  it("keeps the stable channel free of a fork channel name", () => {
    // A non-nightly version is a real release; it must not carry a channel key at
    // all, or electron-builder writes a manifest nothing reads.
    withBkBrand("staging");
    expect(publishConfig("0.0.17")).toMatchObject({ releaseType: "release" });
    expect(publishConfig("0.0.17")).not.toHaveProperty("channel");
  });
});
