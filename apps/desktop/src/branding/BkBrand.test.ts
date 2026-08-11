import { BK_DESKTOP_BRAND } from "../../../../scripts/lib/bk-desktop-brand.ts";
import { describe, expect, it } from "vite-plus/test";

import { BK_RUNTIME_BRAND, isBkBrandBuild, resolveRuntimeBrand } from "./BkBrand.ts";

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
    expect(BK_RUNTIME_BRAND.userDataDirName).toBe(BK_DESKTOP_BRAND.userDataDirName);
    expect(BK_RUNTIME_BRAND.appUserModelId).toBe(BK_DESKTOP_BRAND.appUserModelId);
    expect(BK_RUNTIME_BRAND.linuxDesktopEntryName).toBe(BK_DESKTOP_BRAND.linuxDesktopEntryName);
    expect(BK_RUNTIME_BRAND.linuxWmClass).toBe(BK_DESKTOP_BRAND.linuxWmClass);
    // The displayed name must match the bundle's productName, or the window title
    // and the app in Finder disagree.
    expect(BK_RUNTIME_BRAND.displayName).toBe(BK_DESKTOP_BRAND.productName);
  });

  it("keeps a fork-specific legacy directory", () => {
    // resolveUserDataPath in ../app/DesktopAppIdentity.ts prefers the legacy
    // directory whenever it exists. If this ever became upstream's
    // "T3 Code (Alpha)", a fork install would adopt an upstream app's settings,
    // saved environments and sessions.
    expect(BK_RUNTIME_BRAND.legacyUserDataDirName).toBe("BK T3 Code");
    expect(BK_RUNTIME_BRAND.legacyUserDataDirName).not.toBe("T3 Code (Alpha)");
    expect(BK_RUNTIME_BRAND.legacyUserDataDirName).not.toBe(BK_RUNTIME_BRAND.userDataDirName);
  });
});
