# AGENTS.md

## Beknown Fork and Deployments

This repository is the Beknown fork of T3 Code (`origin` =
`beknown-work/bkt3code`, `upstream` = `pingdotgg/t3code`). Three environments run
on the shared dev server from one git repository and three linked worktrees:

| Environment            | Branch      | Worktree                            | Domain                     | Port  | Service              |
| ---------------------- | ----------- | ----------------------------------- | -------------------------- | ----- | -------------------- |
| t3 (upstream-style)    | `t3main`    | `/home/ubuntu/repos/t3code`         | `t3.dev.beknown.live`      | 18082 | `t3-beknown.service` |
| bkt3 (fork production) | `bkmain`    | `/home/ubuntu/repos/t3code-bkmain`  | `bkt3.dev.beknown.live`    | 18083 | `t3-bkmain.service`  |
| expbkt3 (fork staging) | `expbkmain` | `/home/ubuntu/repos/t3code-expbkt3` | `expbkt3.dev.beknown.live` | 18085 | `t3-expbkt3.service` |

Branch semantics:

- `main` — byte-pure mirror of upstream. Never deployed, never carries fork
  commits. Pushing to it deploys nothing.
- `t3main` — `main` plus two fork-owned files: `.github/workflows/deploy-t3.yml`
  and the `.gitmodules` entry that declares the vendored alchemy gitlink so
  `actions/checkout` can clean credentials. Deploys t3.dev. Updated by merging
  `main` in; never force-pushed.
- `bkmain` — the fork's production line. Deploys bkt3. All fork work merges here
  through pull requests.
- `expbkmain` — long-lived staging branch for drastic changes, above all upstream
  merges. Deploys expbkt3, and is reset from `bkmain` between experiments.

Coding sessions always run on the bkt3 instance, in worktrees under
`/home/ubuntu/.t3/bkt3-dev/worktrees/`. Do not start work in a deployment
worktree; those are checkouts the deploy scripts fast-forward.

How to update an environment: merge to its branch. The branch's GitHub Actions
workflow validates and uploads a SHA-addressed build artifact, and a systemd
timer on the box installs that exact artifact within a minute of the run turning
green. Application code is never built on the server. Full detail, manual deploy
commands, and the upstream-merge workflow are in
[docs/operations/deployments.md](./docs/operations/deployments.md).

Deploying restarts the target service, which **kills the agent sessions hosted on
it** — a bkt3 deploy ends the session that triggered it and interrupts every
other in-flight turn on bkt3. Trigger manual deploys from the other instance or
from a human shell, and warn the user before merging to `bkmain`.

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
  - This is a hard rule on the Beknown dev server: it is shared by both T3 Code deployments, every agent session, branch databases, and self-hosted runners, and full-suite runs have OOM-crashed it. Never run a repo-wide build either — deployments install GitHub-built artifacts instead.
  - The verification loop is: push the branch, open the PR, watch CI remotely with `gh pr checks <n> --watch` and `gh run view <id> --log-failed`, then push fixes from here. The fork's deploy workflows run on GitHub-hosted `ubuntu-latest`, so they are real offload.
  - Local verification stays scoped: one test file or package, one targeted build, or a `curl` against a running dev service. Check headroom with `free -g` and `uptime` first; if available memory is under ~6G or load is above ~12, move the work to CI.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator or Android Emulator available on the host to one isolated environment and verify the affected flow. On compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in the T3 Code in-app browser or another available agent browser; use Android when it is the affected or viable platform.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Dev Servers

- In a linked git worktree, dev state defaults to that worktree's gitignored `.t3`. This deliberately outranks an ambient `T3CODE_HOME`, which could otherwise select the installed app's live `~/.t3/userdata` database. An explicit `--home-dir` still wins.
- Start the web stack with `vp run dev`. Add `--share` when someone needs to open it from another device on the tailnet.
- Browser dev is single-origin: Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the backend. Do not set `VITE_HTTP_URL` or `VITE_WS_URL` for `dev`/`dev:web`.
- Worktree paths supply stable preferred port offsets. Read the actual server and web ports from the `[dev-runner]` line because occupied ports can still shift them.
- Before handing off a `--share` URL, open its origin in a controlled browser and confirm the app loads. A successful curl is insufficient because browsers reject some otherwise reachable ports.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
