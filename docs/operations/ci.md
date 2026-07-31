# CI quality gates

- `.github/workflows/ci.yml` runs `vp check` (lint + typecheck), `vpr typecheck`, and `vp run test` on pull requests and pushes to `main`.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The release workflow auto-enables signing only when platform credentials are present. macOS passkey builds additionally require `APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing. Without the core signing credentials, it still releases unsigned artifacts.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.

## Beknown deployment workflows

Each deployed branch has its own workflow. All three install dependencies, run
`vp check` and `vp run typecheck`, build the web client and server bundle, and
upload a SHA-addressed artifact (`apps/web/dist`, `apps/server/dist`, and a
`SHA` file) that the dev server installs. They run on GitHub-hosted
`ubuntu-latest`; application code is never built on the shared box.

The fork branches (`bkmain`, `expbkmain`) additionally run `vp run test`.
`t3main` does not: it carries upstream application code, upstream's own
`ci.yml` gates `main` on lint, typecheck, and a build rather than the full
suite, and the suite fails there on
`apps/web/src/lib/imageCompression.test.ts` (times out on `ubuntu-latest`).
The fix for that test exists in the fork lineage, and porting it would mean
editing upstream source on `t3main`.

| Workflow                                             | Branch      | Web build flags                                                       | Artifact        |
| ---------------------------------------------------- | ----------- | --------------------------------------------------------------------- | --------------- |
| `.github/workflows/deploy-t3.yml` (on `t3main` only) | `t3main`    | none                                                                  | `t3-<sha>`      |
| `.github/workflows/deploy-bkt3.yml`                  | `bkmain`    | `VITE_T3_EXPERIMENTAL_CONTROL_CENTER=true`, `VITE_T3_CONDUCTOR=false` | `bkt3-<sha>`    |
| `.github/workflows/deploy-expbkt3.yml`               | `expbkmain` | `VITE_T3_EXPERIMENTAL_CONTROL_CENTER=true`, `VITE_T3_CONDUCTOR=true`  | `expbkt3-<sha>` |

`deploy/t3/deploy-t3.yml` is the source of truth for the `t3main` workflow file,
since `t3main` is upstream `main` plus only that file and a `.gitmodules` entry.
Artifacts are retained for
7 days; a commit older than that must be re-run before it can be deployed.

- See [Beknown deployments](./deployments.md) for the server side: timers,
  health checks, rollback, and the branch/environment map.
