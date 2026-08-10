import { describe, expect, it } from "vite-plus/test";

import {
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
} from "./build-desktop-artifact.ts";
import { BK_BRAND_ASSET_PATHS, DESKTOP_BRAND_ENV_VAR } from "./lib/bk-desktop-brand.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

const BK_ENV = { [DESKTOP_BRAND_ENV_VAR]: "bk" } as const;

describe("desktop brand overrides in build-desktop-artifact", () => {
  it("leaves upstream product names untouched", () => {
    expect(resolveDesktopProductName("0.0.17", {})).toBe("T3 Code (Alpha)");
    expect(resolveDesktopProductName("0.0.17-nightly.20260413.42", {})).toBe("T3 Code (Nightly)");
  });

  it("names fork builds after the fork, not the nightly channel", () => {
    // Every fork build is nightly-versioned so it reaches the nightly updater
    // channel, so the brand has to win over the nightly label.
    expect(resolveDesktopProductName("0.0.17-nightly.20260413.42", BK_ENV)).toBe("BK T3 Code");
    expect(resolveDesktopProductName("0.0.17", BK_ENV)).toBe("BK T3 Code");
  });

  it("leaves upstream icon selection untouched", () => {
    expect(resolveDesktopBuildIconAssets("0.0.17", {})).toEqual({
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });
    expect(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42", {})).toEqual({
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("uses the fork icon set for fork builds, overriding the nightly icons", () => {
    expect(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42", BK_ENV)).toEqual({
      macIconPng: BK_BRAND_ASSET_PATHS.macIconPng,
      linuxIconPng: BK_BRAND_ASSET_PATHS.universalIconPng,
      windowsIconIco: BK_BRAND_ASSET_PATHS.windowsIconIco,
    });
  });
});
