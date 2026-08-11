# BK desktop build (macOS)

Fork-owned. How to build the Beknown-branded macOS desktop app from `bkmain` and share it with the team.

The fork does not need a new app: `apps/desktop` is upstream's Electron app, and the browser client is the same `apps/web` SPA that `deploy-bkt3.yml` already deploys to bkt3.dev.beknown.live. What this adds is a _distinct identity_ so the fork build installs alongside an upstream T3 Code, and a publish path with working auto-update.

|              |                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------- |
| Bundle id    | `work.beknown.bkt3code`                                                                     |
| App name     | `BK T3 Code`                                                                                |
| User data    | `~/Library/Application Support/bkt3code`                                                    |
| Architecture | Apple Silicon (`arm64`) only                                                                |
| Signing      | Unsigned                                                                                    |
| Releases     | Prereleases on [`beknown-work/bkt3code`](https://github.com/beknown-work/bkt3code/releases) |

## Prerequisites (your Mac)

- macOS on Apple Silicon. **The build must run on macOS** — electron-builder cannot cross-compile a mac DMG, and `build-bk-desktop-dmg.ts` refuses to run anywhere else.
- Node `^24.13.1` and pnpm `11.10.0` (see `engines` / `packageManager` in the root `package.json`).
- Rust with the `aarch64-apple-darwin` target, for the `native/resource-monitor` crate that gets bundled:
  ```sh
  rustup target add aarch64-apple-darwin
  ```
- Xcode Command Line Tools, for `sips` and `iconutil` (PNG → `.icns`):
  ```sh
  xcode-select --install
  ```
- `gh`, authenticated (`gh auth login`), to pick the next build number and publish.
- A `.env.local` at the repo root carrying the same Clerk publishable key the bkt3 deployment uses:
  ```sh
  VITE_CLERK_PUBLISHABLE_KEY=pk_live_...
  ```
  Without it the app builds but ships with team mode off — no sign-in gate, no member tagging, no "Assigned to me". The build prints a warning if the key is missing; treat that warning as a failure unless you deliberately want a keyless build.

## Build

```sh
git checkout bkmain && git pull
pnpm install
pnpm dist:desktop:bk
```

Artifacts land in `release/`:

| File                             | Purpose                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| `BK-T3-Code-<version>-arm64.dmg` | What a teammate downloads and installs                            |
| `BK-T3-Code-<version>-arm64.zip` | Squirrel.Mac payload — this is what auto-update actually installs |
| `*.blockmap`                     | Differential download support, one per installer                  |
| `nightly-mac.yml`                | The manifest electron-updater reads                               |

That is five files in total: the DMG, the ZIP, a `.blockmap` for each, and the manifest.

### Versioning

Builds are stamped `X.Y.Z-nightly.YYYYMMDD.N`, where `X.Y.Z` is one patch above the current `apps/desktop/package.json` version and `N` counts that day's builds. This is not cosmetic — see "Why the nightly channel" below. The build number is resolved from the tags already published, so consecutive builds always increase. To stamp one yourself:

```sh
pnpm dist:desktop:bk --build-version 0.0.32-nightly.20260810.2
```

## Publish

```sh
pnpm publish:desktop:bk --build-version <the version just built>
```

Add `--dry-run` to run every check and print the `gh` command without publishing.

Do not insert a `--` separator before the flags. With pnpm 11.10.0 the separator reaches the script itself and the Effect CLI then reports `Missing required flag: --build-version`.

This creates a **prerelease** on `beknown-work/bkt3code` with five assets — the DMG and ZIP, a `.blockmap` for each, and `nightly-mac.yml`. Three guards run first, and each one blocks publication:

1. **The tag must be nightly-form.** `.github/workflows/release.yml` triggers on `v*.*.*` with `!v*-nightly.*` excluded, and it has no dry-run mode — a wrong tag would publish `t3` to npm, cut a public GitHub Release, and re-alias `app.t3.codes`. Only nightly-form tags are excluded from that trigger.
2. **The version must be strictly newer** than the newest published one, or electron-updater will never offer it.
3. **`nightly-mac.yml` must be present**, or auto-update silently does nothing.

After publishing, confirm the release pipeline did not fire:

```sh
gh run list --repo beknown-work/bkt3code --workflow release.yml -L 3
```

## Installing (send this to teammates)

1. Download the `.dmg` from the [latest prerelease](https://github.com/beknown-work/bkt3code/releases).
2. Drag **BK T3 Code** to Applications.
3. The build is unsigned, so macOS quarantines it. Clear that once:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/BK T3 Code.app"
   ```
4. Later builds arrive through the in-app updater: the rocket button downloads on the first click and installs on the second.

It installs beside upstream T3 Code and keeps its own settings, saved environments and sessions.

## Why the nightly channel

A GitHub _prerelease_ is invisible to electron-updater's `latest` channel, so "prerelease + auto-update" only works on the nightly channel. `resolveDesktopUpdateChannel` in `scripts/build-desktop-artifact.ts` routes `X.Y.Z-nightly.YYYYMMDD.N` versions there, publishing as a prerelease with a `nightly-mac.yml` manifest — which is exactly the shape we want, with no new updater code. The version format is therefore load-bearing, not decoration.

The fork brand deliberately wins over the nightly branding, so these builds are named `BK T3 Code` rather than `T3 Code (Nightly)`.

## What is not changed, and why

- **The `t3code://` URL scheme.** `@clerk/electron`'s OAuth transport supplies the `t3code://app/` redirect (see `apps/web/src/components/clerk/authRedirect.ts`), so renaming it risks breaking sign-in in the packaged app. Consequence: if a teammate also has upstream T3 Code installed, macOS picks one of them for `t3code://` deep links.
- **`DesktopAppStageLabel`** in `packages/contracts` stays `"Nightly"` for these builds. Only the displayed name changes, so no upstream contract union needs a new member.
- **Code signing.** Apple certificates are bound to upstream's `com.t3tools.t3code` App ID, so fork builds are unsigned. Squirrel.Mac is stricter about unsigned _update_ payloads than about first install: if auto-update fails in practice, the fallback is a manual DMG reinstall, and signing becomes a prerequisite.

## Troubleshooting

### Blank window, and sign-in fails with `native_api_disabled`

Symptom: the app launches, the Dock icon and About panel are correct, but the
window renders nothing, and Clerk returns HTTP 400:

```json
{ "code": "native_api_disabled", "message": "Native API disabled" }
```

Cause: a **prerequisite on the Clerk instance, not a build problem**. In a
packaged desktop build `apps/web/src/main.tsx` mounts `ElectronClerkProvider`
from `@clerk/electron/react`, which talks to Clerk's Native API. When that API is
disabled the provider never finishes loading, so nothing beneath it renders — one
root cause producing both symptoms.

The fork hit this on its first desktop build because the hosted web client uses
the plain browser `ClerkProvider`, which needs no Native API. Upstream documents
the requirement in
[T3 Connect: Desktop OAuth Redirect Allowlist](../internals/t3-connect.md#desktop-oauth-redirect-allowlist)
and lists it as a release step.

Fix, on the Beknown production Clerk instance (`clerk.beknown.live`):

1. **Clerk Dashboard → Native applications → enable the Native API.** This alone
   resolves the blank window.
2. Add `t3code://app/` to the mobile SSO redirect allowlist (and
   `t3code-dev://app/` if you want local desktop development to sign in too).
3. Confirm `t3code://app` is in the instance's Backend API `allowed_origins`.
   There is no dashboard UI for this; see the `PATCH /v1/instance` call in the
   T3 Connect doc. A `native_api_disabled` response that already echoes
   `Origin: t3code://app` indicates this part is configured.

To confirm the diagnosis, or to ship a usable build before the dashboard change,
build with no Clerk key: `resolveAppClerkMode()` returns `"disabled"` when the key
is absent, `main.tsx` then mounts no provider, and the app renders normally with
team mode off — no sign-in gate, no member tagging, no "Assigned to me". There is
no separate switch; key presence _is_ the switch.

## Icons

`assets/bk/` is generated from upstream's production artwork by recolouring the tile, so the fork icon tracks any upstream refresh:

```sh
pnpm icons:bk         # regenerate
pnpm icons:bk:check   # verify the committed output matches
```

Replace `BK_ICON_BASE_COLOR` in `scripts/lib/bk-brand-icons.ts` to change the colour, or drop a real 1024×1024 icon at `assets/bk/bk-macos-1024.png` and stop running the generator.

## Rollout

Per [AGENTS.md](../../AGENTS.md), changes ship to `expbkmain` and are verified at expbkt3.dev.beknown.live before merging to `bkmain`. Merging to `bkmain` restarts `t3-bkmain.service` and kills the agent sessions running on it.

## Files

| Path                                   | Role                                              |
| -------------------------------------- | ------------------------------------------------- |
| `scripts/lib/bk-desktop-brand.ts`      | Brand identity — bundle id, name, icons, data dir |
| `scripts/lib/bk-desktop-release.ts`    | Version format, ordering, tag-safety rules        |
| `scripts/lib/bk-brand-icons.ts`        | Icon tint and downscale helpers                   |
| `scripts/build-bk-desktop-dmg.ts`      | Build wrapper (`pnpm dist:desktop:bk`)            |
| `scripts/publish-bk-desktop-dmg.ts`    | Publish wrapper (`pnpm publish:desktop:bk`)       |
| `scripts/generate-bk-brand-icons.ts`   | Icon generator (`pnpm icons:bk`)                  |
| `apps/desktop/src/branding/BkBrand.ts` | Runtime brand, baked in at build time             |
