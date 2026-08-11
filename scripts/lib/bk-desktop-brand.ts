/**
 * Fork-owned desktop brand identity.
 *
 * The Beknown fork ships its own macOS build so the team can run fork work as a
 * real app. That build must install *alongside* an upstream T3 Code rather than
 * over it, which means a distinct bundle id, product name, icon and user-data
 * directory. Everything specific to that identity lives here so the seams inside
 * upstream-owned files stay one-liners that delegate to this module — see
 * "Building features that survive upstream merges" in AGENTS.md.
 *
 * The brand is selected at *build* time via `T3CODE_BRAND=bk` and baked into the
 * packaged app (see `apps/desktop/src/branding/BkBrand.ts`). It is never read
 * from the environment on a user's machine, because nothing sets it there.
 *
 * Deliberately NOT changed by this brand:
 *
 * - The `t3code://` URL scheme. `@clerk/electron`'s OAuth transport supplies the
 *   `t3code://app/` redirect (see apps/web/src/components/clerk/authRedirect.ts),
 *   so renaming it risks breaking sign-in in the packaged app. The cost is that
 *   macOS picks one app when both this and upstream are installed and a
 *   `t3code://` link is opened.
 * - `DesktopAppStageLabel` in packages/contracts. It stays "Nightly" for the
 *   nightly-versioned builds this brand produces; only the displayed name
 *   changes, so the upstream contract union is untouched.
 */

/** Environment variable that selects the desktop brand at build time. */
export const DESKTOP_BRAND_ENV_VAR = "T3CODE_BRAND";

/** Value of {@link DESKTOP_BRAND_ENV_VAR} that selects the Beknown brand. */
export const BK_DESKTOP_BRAND_ID = "bk";

export type DesktopBrandId = "upstream" | "bk";

/** Repository whose GitHub releases the fork's desktop updater reads. */
export const BK_DESKTOP_UPDATE_REPOSITORY = "beknown-work/bkt3code";

export interface DesktopBrand {
  readonly id: DesktopBrandId;
  /** macOS/Windows bundle identifier and electron-builder `appId`. */
  readonly appId: string;
  /** electron-builder `productName`; also names the macOS `.app` and its data dir. */
  readonly productName: string;
  /** Name shown in-app (window title, About panel). */
  readonly displayName: string;
  /** electron-builder `artifactName` template. Braces are builder placeholders. */
  readonly artifactName: string;
  /** Directory under the OS app-data root that Electron uses for `userData`. */
  readonly userDataDirName: string;
  readonly appUserModelId: string;
  readonly linuxExecutableName: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

/**
 * BK icon sources. These live in the fork-owned `assets/bk/` directory rather
 * than in `BRAND_ASSET_PATHS`, because widening that file's `WebAssetBrand`
 * union would type-force a matching set of web favicons the fork's hosted app
 * does not use.
 */
export const BK_BRAND_ASSET_PATHS = {
  macIconPng: "assets/bk/bk-macos-1024.png",
  universalIconPng: "assets/bk/bk-universal-1024.png",
  windowsIconIco: "assets/bk/bk-windows.ico",
} as const;

export const BK_DESKTOP_BRAND: DesktopBrand = {
  id: "bk",
  appId: "work.beknown.bkt3code",
  productName: "BK T3 Code",
  displayName: "BK T3 Code",
  artifactName: "BK-T3-Code-${version}-${arch}.${ext}",
  userDataDirName: "bkt3code",
  appUserModelId: "work.beknown.bkt3code",
  linuxExecutableName: "bkt3code",
  linuxDesktopEntryName: "bkt3code.desktop",
  linuxWmClass: "bkt3code",
  macIconPng: BK_BRAND_ASSET_PATHS.macIconPng,
  linuxIconPng: BK_BRAND_ASSET_PATHS.universalIconPng,
  windowsIconIco: BK_BRAND_ASSET_PATHS.windowsIconIco,
};

export function isBkDesktopBrandId(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === BK_DESKTOP_BRAND_ID;
}

/** Resolves the brand from a build environment, defaulting to upstream. */
export function resolveDesktopBrandId(
  env: Readonly<Record<string, string | undefined>>,
): DesktopBrandId {
  return isBkDesktopBrandId(env[DESKTOP_BRAND_ENV_VAR]) ? "bk" : "upstream";
}

/**
 * Returns the fork brand when selected, otherwise `undefined` so callers fall
 * back to their existing upstream behaviour.
 */
export function resolveBkDesktopBrand(
  env: Readonly<Record<string, string | undefined>>,
): DesktopBrand | undefined {
  return resolveDesktopBrandId(env) === "bk" ? BK_DESKTOP_BRAND : undefined;
}
