/**
 * Fork-owned runtime brand for the packaged desktop app.
 *
 * The brand is chosen at build time (`T3CODE_BRAND=bk`) and baked into the
 * bundle by `apps/desktop/vite.config.ts` as `__T3CODE_BUILD_BRAND__`. It cannot
 * be read from `process.env` at runtime, because nothing sets that variable on a
 * user's machine — the same reason the Clerk publishable key is baked in via
 * `__T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__` (see `../app/DesktopClerk.ts`).
 *
 * The values here must stay in sync with `scripts/lib/bk-desktop-brand.ts`,
 * which is what the packager writes into the app bundle. `BkBrand.test.ts`
 * asserts that.
 */

declare const __T3CODE_BUILD_BRAND__: string | undefined;

/** Identity applied when the fork brand is active. */
export const BK_RUNTIME_BRAND = {
  baseName: "BK T3 Code",
  displayName: "BK T3 Code",
  userDataDirName: "bkt3code",
  /**
   * Must stay fork-specific. `resolveUserDataPath` in `../app/DesktopAppIdentity.ts`
   * prefers the legacy directory whenever it exists, so inheriting upstream's
   * "T3 Code (Alpha)" would make a fork build adopt an installed upstream app's
   * settings, saved environments and sessions. This is the productName-derived
   * directory Electron would default to, which is the fork's own equivalent of
   * the upstream migration.
   */
  legacyUserDataDirName: "BK T3 Code",
  appUserModelId: "work.beknown.bkt3code",
  linuxDesktopEntryName: "bkt3code.desktop",
  linuxWmClass: "bkt3code",
} as const;

/**
 * True when this bundle was packaged with the fork brand.
 *
 * The `typeof` guard matters: the define is absent under `vitest` and in the
 * unbundled dev run, where the identifier would otherwise throw a ReferenceError.
 */
export function isBkBrandBuild(): boolean {
  return typeof __T3CODE_BUILD_BRAND__ !== "undefined" && __T3CODE_BUILD_BRAND__ === "bk";
}

/** The fork brand when active, otherwise `undefined` for upstream behaviour. */
export function resolveRuntimeBrand(): typeof BK_RUNTIME_BRAND | undefined {
  return isBkBrandBuild() ? BK_RUNTIME_BRAND : undefined;
}
