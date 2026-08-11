import { describe, expect, it } from "vite-plus/test";

import {
  BK_DESKTOP_BRAND,
  DESKTOP_BRAND_ENV_VAR,
  resolveBkDesktopBrand,
  resolveDesktopBrandId,
} from "./bk-desktop-brand.ts";

// Note: assertions about how build-desktop-artifact.ts consumes this brand live in
// scripts/bk-desktop-brand-overrides.test.ts, not here. Everything under
// scripts/lib/ is part of the apps/desktop TypeScript project (its vite.config
// imports this module), and importing a scripts/ root file from here puts that
// file outside the desktop project's file list, which fails its typecheck.

describe("bk-desktop-brand", () => {
  it("defaults to the upstream brand when the flag is absent", () => {
    expect(resolveDesktopBrandId({})).toBe("upstream");
    expect(resolveBkDesktopBrand({})).toBeUndefined();
  });

  it("selects the fork brand from the build flag, case- and space-insensitively", () => {
    expect(resolveDesktopBrandId({ [DESKTOP_BRAND_ENV_VAR]: "bk" })).toBe("bk");
    expect(resolveDesktopBrandId({ [DESKTOP_BRAND_ENV_VAR]: " BK " })).toBe("bk");
    expect(resolveBkDesktopBrand({ [DESKTOP_BRAND_ENV_VAR]: "bk" })).toBe(BK_DESKTOP_BRAND);
  });

  it("ignores unrelated brand values rather than guessing", () => {
    expect(resolveDesktopBrandId({ [DESKTOP_BRAND_ENV_VAR]: "beknown" })).toBe("upstream");
    expect(resolveDesktopBrandId({ [DESKTOP_BRAND_ENV_VAR]: "" })).toBe("upstream");
  });

  it("keeps the fork bundle id distinct from upstream so both can be installed", () => {
    expect(BK_DESKTOP_BRAND.appId).toBe("work.beknown.bkt3code");
    expect(BK_DESKTOP_BRAND.appId).not.toBe("com.t3tools.t3code");
  });

  it("gives the fork its own user-data directory", () => {
    // A shared directory would mean the fork app reads an upstream install's
    // settings, saved environments and sessions.
    expect(BK_DESKTOP_BRAND.userDataDirName).toBe("bkt3code");
    expect(BK_DESKTOP_BRAND.userDataDirName).not.toBe("t3code");
  });

  it("stamps artifacts with a fork-specific name", () => {
    expect(BK_DESKTOP_BRAND.artifactName).toBe("BK-T3-Code-${version}-${arch}.${ext}");
  });
});
