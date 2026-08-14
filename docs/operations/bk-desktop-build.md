# BK desktop apps (macOS)

Fork-owned. How the two Beknown-branded macOS desktop apps are built, published and auto-updated.

The fork does not need a new app: `apps/desktop` is upstream's Electron app, and the browser client is the same `apps/web` SPA that `deploy-bkt3.yml` already deploys. What this adds is _two distinct identities_ so each fork build installs alongside upstream T3 Code and alongside each other, and a publish path with working auto-update.

| Branch      | App                    | Bundle id                       | User data                                        | Orchestrates             |
| ----------- | ---------------------- | ------------------------------- | ------------------------------------------------ | ------------------------ |
| `expbkmain` | `BK T3 Code (Staging)` | `work.beknown.bkt3code.staging` | `~/Library/Application Support/bkt3code-staging` | expbkt3.dev.beknown.live |
| `bkmain`    | `BK T3 Code`           | `work.beknown.bkt3code`         | `~/Library/Application Support/bkt3code`         | bkt3.dev.beknown.live    |

Both are Apple Silicon (`arm64`) only, self-signed, and published as prereleases on [`beknown-work/bkt3code`](https://github.com/beknown-work/bkt3code/releases).

## How it runs

Every push to `expbkmain` or `bkmain` triggers `.github/workflows/bk-desktop-release.yml` on a self-hosted macOS runner — a team Mac — which builds that branch's app and publishes it. Running apps poll every 4 minutes, download in the background, and raise a native notification when a build is ready. Clicking it restarts into the new version.

You can also cut a build by hand from `workflow_dispatch`, or locally (see [Manual builds](#manual-builds)).

## What keeps the two apps apart

One repository holds both apps' releases, and the **updater channel** is the only thing separating them. electron-updater's `GitHubProvider` walks the releases feed and takes the first release whose `semver.prerelease(tag)[0]` equals the running app's channel, then reads `<channel>-mac.yml` from it. So the channel has to be the version's first prerelease identifier:

| App        | Version                               | Channel              | Manifest                     |
| ---------- | ------------------------------------- | -------------------- | ---------------------------- |
| Staging    | `X.Y.Z-staging-nightly.YYYYMMDD.N`    | `staging-nightly`    | `staging-nightly-mac.yml`    |
| Production | `X.Y.Z-production-nightly.YYYYMMDD.N` | `production-nightly` | `production-nightly-mac.yml` |

A staging release is therefore invisible to a production app, and vice versa.

Keeping `-nightly.YYYYMMDD.N` as the **suffix** is load-bearing, not decoration:

- Upstream's `resolveDesktopUpdateChannel` and `isNightlyDesktopVersion` both test `/-nightly\.\d{8}\.\d+$/`. Matching it is what makes these builds publish as prereleases with `allowPrerelease` on — a GitHub prerelease is invisible to the `latest` channel, so "prerelease + auto-update" only works on a nightly-style channel.
- `.github/workflows/release.yml` triggers on `v*.*.*` with `!v*-nightly.*` excluded. Both channels' tags fall inside that exclusion, so the upstream release pipeline — which publishes `t3` to npm, cuts a public GitHub Release and re-aliases app.t3.codes, with no dry-run mode — cannot fire.
- The `DesktopUpdateChannel` contract union stays `"latest" | "nightly"`. Only the string handed to `autoUpdater.channel` changes, so the settings UI and persisted setting are untouched.

`X.Y.Z` is one patch above the current `apps/desktop/package.json` version, and `N` counts that channel's builds that day. Counters are per channel, so a staging build cannot consume production's number.

## Code signing

**Auto-update does not work unsigned.** Squirrel.Mac validates an update bundle against the installed app's designated requirement; an unsigned app has no requirement to satisfy, so the download succeeds and the install silently does not.

Apple's certificates are bound to upstream's `com.t3tools.t3code` App ID, so the fork signs with a **self-signed** certificate from the build Mac's login keychain instead. The designated requirement is then `identifier + leaf certificate hash`, which is stable across builds as long as the same certificate signs every one of them.

Consequences, all accepted:

- **The certificate is load-bearing.** Rotating or losing it breaks auto-update for every installed app and forces everyone to reinstall by hand. Back it up.
- **Not notarised.** Gatekeeper still quarantines the download, cleared once per install with the `xattr` step below.
- **Upstream's `--signed` flag is not used.** It routes mac builds through `resolveMacPasskeySigningConfiguration`, which requires an Apple Team ID and a provisioning profile the fork does not have. `T3CODE_BK_SIGNING_IDENTITY` is the fork's own switch; it also turns the hardened runtime off, which exists to satisfy notarisation and otherwise only adds entitlement-shaped launch failures.

### Creating the certificate (once)

On the runner Mac:

1. **Keychain Access → Certificate Assistant → Create a Certificate.**
2. Name it something stable, e.g. `BK Code Signing`. Identity Type **Self Signed Root**, Certificate Type **Code Signing**.
3. Confirm it is usable: `security find-identity -v -p codesigning`.
4. Export it (`.cer`, public certificate only) and send it to each teammate, who installs it in **login** and sets it to **Always Trust** for code signing.
5. Add the common name as the repository secret `BK_MACOS_SIGNING_IDENTITY`.

## Runner setup (once)

`beknown-work/bkt3code` → Settings → Actions → Runners → **New self-hosted runner**, macOS/arm64. Install it as a service so it survives reboot:

```sh
./svc.sh install
./svc.sh start
```

Prerequisites on that Mac:

- Node `^24.13.1` and pnpm `11.10.0` (see `engines` / `packageManager` in the root `package.json`).
- Rust with the `aarch64-apple-darwin` target, for the bundled `native/resource-monitor` crate:
  ```sh
  rustup target add aarch64-apple-darwin
  ```
- Xcode Command Line Tools, for `sips` and `iconutil` (PNG → `.icns`):
  ```sh
  xcode-select --install
  ```
- `gh`, authenticated, for local publishing. CI uses `GITHUB_TOKEN`.
- The signing certificate above, in an **unlocked** login keychain. A locked keychain is the classic headless-signing failure: the identity exists but is unusable, and electron-builder only says so at the end of a 15-minute build. The workflow checks for it up front.

Repository secrets:

| Secret                       | Purpose                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BK_MACOS_SIGNING_IDENTITY`  | Common name of the self-signed certificate                                                                                                                             |
| `VITE_CLERK_PUBLISHABLE_KEY` | `pk_live_...`, the same key the bkt3 deployment uses. Without it the app builds but ships with team mode off — no sign-in gate, no member tagging, no "Assigned to me" |

### Why a self-hosted runner on a public repository is acceptable here

GitHub warns against this because a fork's pull request could run attacker-controlled code on your machine. The workflow's triggers are the guard: `push` to `expbkmain`/`bkmain` and `workflow_dispatch` both require write access, and **neither can be fired from a fork**. Do not add a `pull_request` trigger to this workflow.

Pair that with **Settings → Actions → Fork pull request workflows from outside collaborators → Require approval for all external contributors**.

## Manual builds

```sh
git checkout bkmain && git pull
pnpm install
export T3CODE_BK_SIGNING_IDENTITY="BK Code Signing"
pnpm dist:desktop:bk --channel production
```

`--channel` is required: it selects the app's bundle id, product name, user-data directory, updater channel and the central server the build orchestrates, all at once. Omitting the signing identity still builds — useful for a quick local run — but the build cannot be published.

Artifacts land in `release/`: the DMG a teammate downloads, the ZIP that auto-update actually installs, a `.blockmap` for each, and the channel manifest.

```sh
pnpm publish:desktop:bk --channel production --build-version <the version just built>
```

Add `--dry-run` to run every check and print the `gh` command without publishing. Do not insert a `--` separator before the flags: with pnpm 11.10.0 the separator reaches the script itself and the Effect CLI reports `Missing required flag`.

To pick a version yourself: `pnpm version:desktop:bk --channel production` prints the next one.

Five guards run before anything is published, each blocking:

1. **The tag must be nightly-form**, so `release.yml` cannot fire.
2. **The version's channel must be the channel being published**, or the other app's users get offered the build.
3. **The version must be strictly newer** than the newest published one _on that channel_, or electron-updater will never offer it.
4. **The build must be code signed**, or Squirrel.Mac cannot install it as an update.
5. **The channel manifest must be present**, or auto-update silently does nothing.

After publishing, confirm the upstream pipeline did not fire:

```sh
gh run list --repo beknown-work/bkt3code --workflow release.yml -L 3
```

## Installing (send this to teammates)

1. Install the `BK Code Signing` certificate and set it to **Always Trust** (one-time).
2. Download the `.dmg` from the [latest prerelease](https://github.com/beknown-work/bkt3code/releases) — `BK T3 Code` for day-to-day work, `BK T3 Code (Staging)` to try `expbkmain`.
3. Drag it to Applications.
4. Builds are not notarised, so macOS quarantines them. Clear that once per app:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/BK T3 Code.app"
   ```
5. Later builds arrive on their own: the app notifies you when one is ready, and clicking the notification restarts into it. The sidebar update button still works if you dismiss the notification.

Each app keeps its own settings, saved environments and sessions, and both install beside upstream T3 Code.

> **The first signed build must be installed by hand.** Auto-update from an unsigned build to a signed one cannot validate, because there was no designated requirement to match.

## What is not changed, and why

- **The `t3code://` URL scheme.** `@clerk/electron`'s OAuth transport supplies the `t3code://app/` redirect (see `apps/web/src/components/clerk/authRedirect.ts`), so renaming it risks breaking sign-in in the packaged app. Consequence: with several of upstream, staging and production installed, macOS picks one for `t3code://` deep links. Sign-in still completes — possibly in the sibling app.
- **`DesktopAppStageLabel`** in `packages/contracts` stays `"Nightly"` for these builds. Only the displayed name changes, so no upstream contract union needs a new member.

## Troubleshooting

### The app never offers an update

Check, in order:

1. The release exists and is a **prerelease** with the right manifest asset for that channel.
2. The version is strictly newer than the installed one _within the same channel_.
3. The installed app and the update are signed with the **same** certificate: `codesign -dv --verbose=4 "/Applications/BK T3 Code.app"` and compare the leaf hash against the built app.

### Blank window, and sign-in fails with `native_api_disabled`

Symptom: the app launches, the Dock icon and About panel are correct, but the window renders nothing, and Clerk returns HTTP 400:

```json
{ "code": "native_api_disabled", "message": "Native API disabled" }
```

Cause: a **prerequisite on the Clerk instance, not a build problem**. In a packaged desktop build `apps/web/src/main.tsx` mounts `ElectronClerkProvider` from `@clerk/electron/react`, which talks to Clerk's Native API. When that API is disabled the provider never finishes loading, so nothing beneath it renders — one root cause producing both symptoms.

The fork hit this on its first desktop build because the hosted web client uses the plain browser `ClerkProvider`, which needs no Native API. Upstream documents the requirement in [T3 Connect: Desktop OAuth Redirect Allowlist](../internals/t3-connect.md#desktop-oauth-redirect-allowlist).

Fix, on the Beknown production Clerk instance (`clerk.beknown.live`):

1. **Clerk Dashboard → Native applications → enable the Native API.** This alone resolves the blank window.
2. Add `t3code://app/` to the mobile SSO redirect allowlist (and `t3code-dev://app/` if you want local desktop development to sign in too).
3. Confirm `t3code://app` is in the instance's Backend API `allowed_origins`. There is no dashboard UI for this; see the `PATCH /v1/instance` call in the T3 Connect doc. A `native_api_disabled` response that already echoes `Origin: t3code://app` indicates this part is configured.

To confirm the diagnosis, or to ship a usable build before the dashboard change, build with no Clerk key: `resolveAppClerkMode()` returns `"disabled"` when the key is absent, `main.tsx` then mounts no provider, and the app renders normally with team mode off. There is no separate switch; key presence _is_ the switch.

## Icons

`assets/bk/` is generated from upstream's production artwork by recolouring the tile, so the fork icon tracks any upstream refresh:

```sh
pnpm icons:bk         # regenerate
pnpm icons:bk:check   # verify the committed output matches
```

Replace `BK_ICON_BASE_COLOR` in `scripts/lib/bk-brand-icons.ts` to change the colour, or drop a real 1024×1024 icon at `assets/bk/bk-macos-1024.png` and stop running the generator. Both apps currently share one icon set; give staging its own by adding a variant to `BK_BRAND_ASSET_PATHS`.

## Rollout

Per [AGENTS.md](../../AGENTS.md), changes ship to `expbkmain` and are verified at expbkt3.dev.beknown.live before merging to `bkmain`. Merging to `bkmain` restarts `t3-bkmain.service` and kills the agent sessions running on it.

## Files

| Path                                                | Role                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `scripts/lib/bk-desktop-brand.ts`                   | The two brand identities — bundle id, name, icons, data dir, updater channel |
| `scripts/lib/bk-desktop-release.ts`                 | Version format, per-channel ordering, tag-safety rules                       |
| `scripts/lib/bk-desktop-signing.ts`                 | Self-signed identity resolution                                              |
| `scripts/lib/bk-managed-environment.ts`             | Which central server a build orchestrates                                    |
| `scripts/lib/bk-brand-icons.ts`                     | Icon tint and downscale helpers                                              |
| `scripts/build-bk-desktop-dmg.ts`                   | Build wrapper (`pnpm dist:desktop:bk`)                                       |
| `scripts/publish-bk-desktop-dmg.ts`                 | Publish wrapper (`pnpm publish:desktop:bk`)                                  |
| `scripts/resolve-bk-desktop-version.ts`             | Next version for a channel (`pnpm version:desktop:bk`)                       |
| `scripts/generate-bk-brand-icons.ts`                | Icon generator (`pnpm icons:bk`)                                             |
| `.github/workflows/bk-desktop-release.yml`          | Self-hosted macOS build and publish                                          |
| `apps/desktop/src/branding/BkBrand.ts`              | Runtime brand, baked in at build time                                        |
| `apps/desktop/src/electron/ElectronNotification.ts` | Native notifications                                                         |
| `apps/desktop/src/updates/DesktopUpdates.ts`        | Channel selection, auto-download, update-ready notification                  |
