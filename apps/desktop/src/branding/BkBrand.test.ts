import { BK_DESKTOP_BRAND, BK_DESKTOP_BRANDS } from "../../../../scripts/lib/bk-desktop-brand.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  BK_RUNTIME_BRAND,
  BK_RUNTIME_BRANDS,
  isBkBrandBuild,
  resolveRuntimeBrand,
} from "./BkBrand.ts";

describe("BkBrand", () => {
  it("reports the upstream brand when the build define is absent", () => {
    // The define only exists in a packaged bundle. The typeof guard in
    // isBkBrandBuild is what stops this being a ReferenceError under vitest and
    // in the unbundled dev run.
    expect(isBkBrandBuild()).toBe(false);
    expect(resolveRuntimeBrand()).toBeUndefined();
  });

  it("stays in sync with the brand the packager writes into the bundle", () => {
    // These two modules cannot import each other at runtime — the packaged main
    // process cannot reach scripts/ — so the values are duplicated. If they drift,
    // the app's Info.plist name and its user-data directory disagree and the app
    // silently reads the wrong state.
    for (const variant of ["staging", "production"] as const) {
      const runtime = BK_RUNTIME_BRANDS[variant];
      const packaged = BK_DESKTOP_BRANDS[variant];
      expect(runtime.userDataDirName).toBe(packaged.userDataDirName);
      expect(runtime.appUserModelId).toBe(packaged.appUserModelId);
      expect(runtime.linuxDesktopEntryName).toBe(packaged.linuxDesktopEntryName);
      expect(runtime.linuxWmClass).toBe(packaged.linuxWmClass);
      // The displayed name must match the bundle's productName, or the window title
      // and the app in Finder disagree.
      expect(runtime.displayName).toBe(packaged.productName);
      // The channel decides which releases this app's updater will even see, so a
      // mismatch here means an app that never updates.
      expect(runtime.updateChannel).toBe(packaged.updateChannel);
    }
  });

  it("defaults to production, matching the packager's default variant", () => {
    expect(BK_RUNTIME_BRAND).toBe(BK_RUNTIME_BRANDS.production);
    expect(BK_RUNTIME_BRAND.displayName).toBe(BK_DESKTOP_BRAND.productName);
  });

  it("keeps a fork-specific legacy directory per app", () => {
    // resolveUserDataPath in ../app/DesktopAppIdentity.ts prefers the legacy
    // directory whenever it exists. If this ever became upstream's
    // "T3 Code (Alpha)", a fork install would adopt an upstream app's settings,
    // saved environments and sessions — and if the two fork apps shared one,
    // staging would adopt production's.
    expect(BK_RUNTIME_BRANDS.production.legacyUserDataDirName).toBe("BK T3 Code");
    expect(BK_RUNTIME_BRANDS.staging.legacyUserDataDirName).toBe("BK T3 Code (Staging)");
    for (const brand of Object.values(BK_RUNTIME_BRANDS)) {
      expect(brand.legacyUserDataDirName).not.toBe("T3 Code (Alpha)");
      expect(brand.legacyUserDataDirName).not.toBe(brand.userDataDirName);
    }
    expect(BK_RUNTIME_BRANDS.staging.legacyUserDataDirName).not.toBe(
      BK_RUNTIME_BRANDS.production.legacyUserDataDirName,
    );
  });
});
