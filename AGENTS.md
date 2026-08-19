# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

> **You are in the Beknown fork**, not upstream. Read "Beknown fork and deployments" and "Building features that survive upstream merges" below before writing code. Everything else in this file is upstream's guidance and still applies.

## Beknown fork and deployments

This repository is the Beknown fork of T3 Code (`origin` = `beknown-work/bkt3code`, `upstream` = `pingdotgg/t3code`). Three environments run on the shared dev server from one git repository and three linked worktrees:

| Environment            | Branch      | Worktree                            | Domain                     | Port  | Service              |
| ---------------------- | ----------- | ----------------------------------- | -------------------------- | ----- | -------------------- |
| t3 (upstream-style)    | `t3main`    | `/home/ubuntu/repos/t3code`         | `t3.dev.beknown.live`      | 18082 | `t3-beknown.service` |
| bkt3 (fork production) | `bkmain`    | `/home/ubuntu/repos/t3code-bkmain`  | `bkt3.dev.beknown.live`    | 18083 | `t3-bkmain.service`  |
| expbkt3 (fork staging) | `expbkmain` | `/home/ubuntu/repos/t3code-expbkt3` | `expbkt3.dev.beknown.live` | 18085 | `t3-expbkt3.service` |

Branch semantics:

- `main` — byte-pure mirror of upstream. Never deployed, never carries fork commits. Pushing to it deploys nothing.
- `t3main` — `main` plus two fork-owned files: `.github/workflows/deploy-t3.yml` and a `.gitmodules` entry declaring the vendored alchemy gitlink so `actions/checkout` can clean credentials. Deploys t3.dev. Updated by merging `main` in; never force-pushed.
- `bkmain` — the fork's production line. Deploys bkt3. All fork work merges here through pull requests.
- `expbkmain` — long-lived staging branch for drastic changes, above all upstream merges. Deploys expbkt3, and is reset from `bkmain` between experiments.

Coding sessions always run on the bkt3 instance, in worktrees under `/home/ubuntu/.t3/bkt3-dev/worktrees/`. Do not start work in a deployment worktree; those are checkouts the deploy scripts fast-forward.

How to update an environment: merge to its branch. The branch's GitHub Actions workflow validates and uploads a SHA-addressed build artifact, and a systemd timer on the box installs that exact artifact within a minute of the run turning green. Application code is never built on the server. Full detail, manual deploy commands, and the upstream-merge workflow are in [docs/operations/deployments.md](./docs/operations/deployments.md).

Deploying restarts the target service, which **kills the agent sessions hosted on it** — a bkt3 deploy ends the session that triggered it and interrupts every other in-flight turn on bkt3. Trigger manual deploys from the other instance or from a human shell, and warn the user before merging to `bkmain`.

**Ship to `expbkmain` first.** Every fork change — features, not just upstream merges — goes to `expbkmain` and is verified running at expbkt3.dev.beknown.live before it merges to `bkmain`. bkt3 hosts the team's live coding sessions, so a regression there interrupts real work, and the failure modes that matter most (migrations against an existing database, startup ordering, provider processes) only appear on a real deploy. expbkt3 is cheap to break: reset it from `bkmain`, merge the branch, wait for the timer, and exercise the change in the browser. Only then open or merge the `bkmain` PR.

**Merging to `expbkmain` is pre-authorised, and you own it until it is live.** You do
not need to ask before merging a green PR to `expbkmain` — merge it, then stay on it:
watch the branch workflow, wait for the systemd timer to install the artifact, and
confirm the running service is on the merge SHA. Report once, when it is deployed, not
when it is merged. "Merged" is not a delivery; the reviewer cannot verify anything until
expbkt3 is actually serving the new build, and a build or install can still fail after a
green PR. Ground truth is `/home/ubuntu/.t3/expbkt3-dev/deployed-sha` matching the merge
commit, plus `t3-expbkt3.service` active. This authorisation covers `expbkmain` only —
`bkmain` still needs a human, because deploying it kills the team's live sessions.

## Building features that survive upstream merges

We track a fast-moving upstream. Every line this fork changes inside an upstream-owned file is a line that has to be re-resolved, by hand, on every future merge — and a merge that touches 25 files of core code costs a day and risks silently dropping fork behavior. Cost is driven by _where_ we write code far more than by how much we write.

**Nudge the developer toward these when a change starts editing upstream files.** Say it plainly: "this can be built as an additive module instead of editing `ChatView.tsx`; that keeps the next upstream merge cheap." If they still want the inline edit, do it — just make the seam as small as possible and mark it.

Ranked from cheapest to most expensive to maintain:

1. **New files in fork-owned directories.** A feature living in its own module or package costs nothing at merge time — git has no competing change to reconcile. Prefer a new `apps/server/src/plannotator/` over threading logic through `server.ts`.
2. **One call site in an upstream file, delegating to fork code.** If upstream code must invoke ours, aim for a single import plus a single line, not logic scattered through the file. One-line conflicts resolve in seconds; interleaved ones need real thought.
3. **Composition over modification.** Wrap an upstream component rather than editing it. Render `<ForkFeature><UpstreamThing /></ForkFeature>` instead of adding branches inside `UpstreamThing`.
4. **Configuration and feature flags over branching.** Fork behavior gated by a flag (`VITE_T3_EXPERIMENTAL_CONTROL_CENTER`, a server setting) keeps upstream's code path intact and lets us disable our feature to isolate a regression after a merge.
5. **Additive schema changes.** Add fields and new union members; avoid renaming or reordering upstream ones. Renames conflict with every upstream change to the same symbol.
6. **Number fork database migrations from 1000 up.** Upstream keeps the low numbers, so its migrations land at their own index and merges stop being a judgment call. Applied migrations are keyed by `${id}_${name}` in `effect_sql_migrations`, so renumbering one that already ran makes it run a second time on live data — indices 33-42 are a frozen legacy fork block for exactly that reason. The full allocation rule sits above the registry in `apps/server/src/persistence/Migrations.ts`; apply it mechanically instead of re-deriving it.

Rules that apply regardless of approach:

- **Prefer the bridge to the fork.** New automation belongs in `t3-linear-bridge` (the Go control plane on the same host), not in this repo. It already has the seams: a durable outbox action switch, worker-loop registration, webhook inbox lanes, and hot-reloading managed config — and it talks to T3 only through `/api/orchestration/shell` and `/api/orchestration/dispatch`, so it costs zero merge surface. Fork this repo only when the feature genuinely needs one of: UI, new per-session storage, or an in-process hook into the provider/orchestration layers. Poll latency (~2s) is the bridge's one real limitation; weigh that before choosing the fork.
- **Mark every fork edit inside an upstream file** with a `T3-CUSTOM(expbkt3)` comment, so the seam is greppable during a merge and reviewable afterwards. This is enforced in CI by `scripts/check-fork-markers.ts` (workflow: `.github/workflows/fork-markers.yml`), which fails a PR that adds unmarked hunks to an upstream-owned file. `scripts/fork-marker-baseline.json` grandfathers the existing backlog and is a ratchet — it may shrink, never grow. See [expbkt3 customization boundaries](./docs/operations/expbkt3-customizations.md).
- **Never reformat, reorder, or opportunistically refactor upstream code.** A moved import or re-wrapped line produces a conflict with zero product value. Keep diffs minimal and local — this is the single cheapest discipline available.
- **Cover fork behavior with tests in fork-owned test files.** After a merge, those tests are the only thing that proves a customization survived conflict resolution.
- **Upstream anything generally useful.** A fix accepted upstream is a fix we stop re-merging forever; it converts a permanent tax into a one-time contribution. Bug fixes and small primitives are usually welcome upstream — check before building the fork-only version.
- **Merge upstream often, in small batches.** Conflict pain grows faster than linearly with the size of the delta: two 15-commit merges are far cheaper than one 30-commit merge, because each conflict is reasoned about with less surrounding drift. Treat a monthly cadence as the ceiling, not the target. The end-to-end procedure — mirror sync, measuring the conflict surface, resolution rules, and the post-merge CI failures that recur every time — is the [`merge-upstream`](./.agents/skills/merge-upstream/SKILL.md) skill. Follow it rather than re-deriving the steps.
- **A fork edit that _relocates_ upstream code is the most dangerous kind.** When the fork moves a block into its own module, a later upstream fix to that block arrives as a conflict-free change to a region the fork no longer has — git keeps the "deletion" and the fix silently never lands. Nothing catches this: it typechecks, and upstream's regression test for it usually lives in the file the fork stopped using. A 2026-08 merge lost upstream's "no origin remote" bootstrap fallback exactly this way. Prefer wrapping over relocating, and when reviewing a merge, diff the upstream side of any relocated block by hand.
- **Never rebase the fork branches onto upstream.** `bkmain` and `expbkmain` are long-lived and shared; merging preserves the record of how each conflict was resolved, and rebasing re-inflicts every conflict and rewrites published history.
- **`git rerere` is enabled in this repo** (`rerere.enabled=true`), so a conflict resolved once is replayed automatically the next time the same hunk collides. Never resolve a conflict by discarding one side wholesale just to make it go away — a bad resolution gets replayed too. Verify what rerere auto-resolved before committing a merge.
- **Test upstream merges on `expbkmain` first**, never directly on `bkmain`. Reset `expbkmain` from `bkmain` so its conflicts are exactly the ones `bkmain` will see, verify at expbkt3.dev, then promote.

## What makes T3 Code special?

We have over 100,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, and OpenCode each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
  - In the Beknown fork this is a hard rule, not a preference: the dev server is shared by both T3 Code deployments, every agent session, branch databases, and self-hosted runners, and full-suite runs have OOM-crashed it. Never run a repo-wide build either — deployments install GitHub-built artifacts, so nothing needs building here.
  - The loop is: push the branch, open the PR, watch CI remotely with `gh pr checks <n> --watch` and `gh run view <id> --log-failed`, then push fixes from this box. The fork's deploy workflows run on GitHub-hosted `ubuntu-latest`, so they are real offload.
  - Check headroom with `free -g` and `uptime` before anything long. Under ~6G available or load above ~12, move the work to CI instead.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Merging a green PR into `expbkmain` needs no further ask, but it is not finished at
  merge: follow it through the deploy and report only once expbkt3 is serving it. See
  "Beknown fork and deployments". Merging to `bkmain` still needs a human.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
